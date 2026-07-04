/**
 * graph-memory-pro — Neo4j Knowledge Graph Memory Plugin
 *
 * Version: 2.1.2
 *
 * 架构定位（A 方案）:
 *   - 不占用 slots（memory/contextEngine）
 *   - 不再使用 before_prompt_build 钩子（避免与 contextEngine 双注入）
 *   - 通过 registerMemoryCorpusSupplement 把图谱暴露给 memory-core 的 memory_search
 *   - 三元组提取 / 图谱维护通过 registerService 后台运行，不阻塞主流程
 *   - HTTP 路由通过 api.registerHttpRoute 注册
 *   - 保留专业工具：gm_record / gm_maintain / gm_reembed（gm_search/gm_stats 已合并）
 *
 * Latest OpenClaw Plugin SDK compliance:
 * - definePluginEntry from openclaw/plugin-sdk/plugin-entry
 * - api.config 用于配置加载（不读文件系统）
 * - api.logger 用于结构化日志
 * - api.registerHttpRoute / registerService / registerMemoryCorpusSupplement
 */

import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { Driver } from "neo4j-driver";
import type { GmConfig, GmNode, GmEdge } from "./src/types.ts";
import type { CompleteFn } from "./src/engine/llm.ts";
import type { EmbedFn } from "./src/engine/embed.ts";
import { createCompleteFn } from "./src/engine/llm.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { initDriver, closeDriver, verifyWithRetry, getDriver } from "./src/store/db.ts";
import { ensureSchema, getNodeCount, getEdgeCount, searchNodes, getEdgesForNodes, upsertNode, upsertEdge, findById } from "./src/store/store.ts";
import { Extractor } from "./src/extractor/extract.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { runMaintenance } from "./src/graph/maintenance.ts";
import { reEmbedNodes } from "./src/graph/reembed.ts";
import { initRoutes, getRoutes } from "./src/routes/crud.ts";
import { setTimingEnabled, printAllDistributions, resetAllDistributions } from "./src/timing.ts";

// ─── 全局状态 ──────────────────────────────────────────

let _driver: Driver | null = null;
let _cfg: GmConfig | null = null;
let _llm: CompleteFn | null = null;
let _embed: EmbedFn | null = null;
let _extractor: Extractor | null = null;
let _recaller: Recaller | null = null;
let _extractorTimer: ReturnType<typeof setInterval> | null = null;
let _maintenanceTimer: ReturnType<typeof setInterval> | null = null;

// ─── 辅助函数 ──────────────────────────────────────────

import { EMBEDDING_PRESETS } from "./src/types.ts";

function resolveEmbedDimension(cfg: any): number {
  // 1. 用户显式指定的维度
  if (cfg?.embedding?.dimensions && typeof cfg.embedding.dimensions === 'number') {
    return cfg.embedding.dimensions;
  }
  // 2. 按模型名匹配预设
  if (cfg?.embedding?.model) {
    const modelKey = Object.keys(EMBEDDING_PRESETS).find(k => cfg.embedding.model.includes(k) || k.includes(cfg.embedding.model));
    if (modelKey && EMBEDDING_PRESETS[modelKey].dimensions) {
      return EMBEDDING_PRESETS[modelKey].dimensions;
    }
  }
  // 3. 回退 1024
  return 1024;
}

async function getOrCreateDriver(cfg: GmConfig, logger: any): Promise<Driver | null> {
  try {
    const d = initDriver(cfg.neo4j);
    const ok = await verifyWithRetry(d);
    if (!ok) {
      logger?.warn?.("[graph-memory-pro] Neo4j connection failed — plugin disabled");
      closeDriver();
      return null;
    }
    return d;
  } catch (err) {
    logger?.warn?.(`[graph-memory-pro] Neo4j init failed: ${err}`);
    return null;
  }
}

/**
 * 后台三元组提取：从最近会话消息中提取实体/关系写入 Neo4j。
 * 移出 before_prompt_build 钩子以避免阻塞 prompt 构建。
 */
async function extractInBackground(
  extractor: Extractor | null,
  driver: Driver | null,
  llm: CompleteFn | null,
  logger: any,
  pendingMessages: Array<{ user: string; assistant: string }>,
): Promise<void> {
  if (!extractor || !driver || !llm || pendingMessages.length === 0) return;

  let extracted = 0;
  const maxPairs = 3;
  const pairs = pendingMessages.slice(0, maxPairs);

  for (const pair of pairs) {
    try {
      const result = await extractor.extract(llm, pair.user, pair.assistant);
      if (result.nodes.length > 0) {
        extracted++;
        const nodeIdMap = new Map<string, string>();
        for (const enode of result.nodes) {
          try {
            const now = Date.now();
            const id = `auto-${now}-${Math.random().toString(36).slice(2, 8)}`;
            nodeIdMap.set(enode.name, id);
            await upsertNode(driver, {
              id,
              type: enode.type,
              name: enode.name,
              description: enode.description,
              content: enode.content,
              status: "active",
              communityId: undefined,
              pagerank: 0,
              validatedCount: 0,
              createdAt: now,
              updatedAt: now,
            });
          } catch (e) {
            if (process.env.GM_DEBUG) logger?.debug?.(`  [graph-memory-pro] upsertNode failed: ${e}`);
          }
        }
        for (const eedge of result.edges) {
          try {
            const fromId = nodeIdMap.get(eedge.fromName);
            const toId = nodeIdMap.get(eedge.toName);
            if (!fromId || !toId) continue;
            const now = Date.now();
            await upsertEdge(driver, {
              id: `edge-${now}-${Math.random().toString(36).slice(2, 8)}`,
              type: eedge.type,
              fromId,
              toId,
              instruction: eedge.instruction,
              condition: eedge.condition,
              weight: 1,
              createdAt: now,
              updatedAt: now,
            });
          } catch (e) {
            if (process.env.GM_DEBUG) logger?.debug?.(`  [graph-memory-pro] upsertEdge failed: ${e}`);
          }
        }
      }
    } catch (err) {
      if (process.env.GM_DEBUG) logger?.debug?.(`  [graph-memory-pro] extract pair failed: ${err}`);
    }
  }
  if (extracted > 0) {
    logger?.info?.(`[graph-memory-pro] background extractor: ${extracted} turns processed`);
  }
}

// ─── Plugin Entry ──────────────────────────────────────

export default definePluginEntry({
  id: "graph-memory-pro",
  name: "Graph Memory Pro",
  description: "Neo4j knowledge graph memory engine for OpenClaw",
  configSchema: buildJsonPluginConfigSchema(Type.Object({
    neo4j: Type.Object({
      uri: Type.String({ default: "bolt://localhost:37687" }),
      user: Type.String({ default: "neo4j" }),
      password: Type.String({ default: "" }),
    }),
    compactTurnCount: Type.Optional(Type.Number({ default: 6 })),
    recallMaxNodes: Type.Optional(Type.Number({ default: 6 })),
    recallMaxDepth: Type.Optional(Type.Number({ default: 2 })),
    freshTailCount: Type.Optional(Type.Number({ default: 10 })),
    dedupThreshold: Type.Optional(Type.Number({ default: 0.90 })),
    pagerankDamping: Type.Optional(Type.Number({ default: 0.85 })),
    pagerankIterations: Type.Optional(Type.Number({ default: 20 })),
    llm: Type.Optional(Type.Object({
      apiKey: Type.Optional(Type.String()),
      baseURL: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
    })),
    embedding: Type.Optional(Type.Object({
      apiKey: Type.Optional(Type.String()),
      baseURL: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      dimensions: Type.Optional(Type.Number({ default: 1024 })),
      keepAlive: Type.Optional(Type.String()),
    })),
    timing: Type.Optional(Type.Object({
      enabled: Type.Boolean({ default: false }),
      maxSamples: Type.Optional(Type.Number({ default: 1000 })),
      reportEveryN: Type.Optional(Type.Number({ default: 50 })),
    })),
    background: Type.Optional(Type.Object({
      extractorIntervalMs: Type.Optional(Type.Number({ default: 60_000 })),
      maintenanceIntervalMs: Type.Optional(Type.Number({ default: 6 * 3600_000 })),
    })),
    // ── v2.1.2 第一批 Schema 升级 + 监控基础 ────────────
    temporal: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      defaultSource: Type.Optional(Type.Union([
        Type.Literal("experience"),
        Type.Literal("knowledge"),
        Type.Literal("imported"),
      ])),
    })),
    state: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      filterSupersededInRecall: Type.Optional(Type.Boolean({ default: false })),
    })),
    staleness: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      threshold: Type.Optional(Type.Number({ default: 0.7 })),
      mode: Type.Optional(Type.Union([
        Type.Literal("heuristic"),
        Type.Literal("llm"),
      ])),
    })),
    causalEdges: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      extract: Type.Optional(Type.Boolean({ default: true })),
    })),
    graphHealth: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      alertOnAnomaly: Type.Optional(Type.Boolean({ default: true })),
    })),
    // ── v2.1.2 第二批 反馈闭环 + 冷启动 ────────────
    queryCache: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      maxSize: Type.Optional(Type.Number({ default: 100 })),
      ttlMs: Type.Optional(Type.Number({ default: 30 * 60 * 1000 })),
      similarityThreshold: Type.Optional(Type.Number({ default: 0.95 })),
    })),
    judge: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      asyncMode: Type.Optional(Type.Boolean({ default: true })),
      judgeWarmupFeedbacks: Type.Optional(Type.Number({ default: 50 })),
      heuristicMatch: Type.Optional(Type.Union([
        Type.Literal("id"),
        Type.Literal("name"),
        Type.Literal("both"),
      ])),
    })),
    feedback: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      retentionDays: Type.Optional(Type.Number({ default: 90 })),
    })),
    warmup: Type.Optional(Type.Object({
      warmupFeedbacks: Type.Optional(Type.Number({ default: 100 })),
      judgeWarmupFeedbacks: Type.Optional(Type.Number({ default: 50 })),
    })),
  }) as any),
  register(api: any) {
    const logger = api.logger ?? console;

    // ── Gateway 启动时初始化 ──────────────────────
    api.on("gateway_start", async (event: any) => {
      // P0-2: 配置优先从 SDK 注入，移除 fs.readFileSync
      const eventCfg = event?.config ?? event?.pluginConfig ?? api.config;
      if (!eventCfg?.neo4j?.uri) {
        logger?.warn?.("[graph-memory-pro] No Neo4j config — plugin skipped");
        return;
      }
      const pluginConfig = eventCfg as GmConfig;

      _cfg = {
        neo4j: pluginConfig.neo4j,
        compactTurnCount: pluginConfig.compactTurnCount ?? 6,
        recallMaxNodes: pluginConfig.recallMaxNodes ?? 6,
        recallMaxDepth: pluginConfig.recallMaxDepth ?? 2,
        freshTailCount: pluginConfig.freshTailCount ?? 10,
        dedupThreshold: pluginConfig.dedupThreshold ?? 0.90,
        pagerankDamping: pluginConfig.pagerankDamping ?? 0.85,
        pagerankIterations: pluginConfig.pagerankIterations ?? 20,
        llm: pluginConfig.llm,
        embedding: pluginConfig.embedding,
        timing: pluginConfig.timing,
      };

      // 1. 连接 Neo4j
      const driver = await getOrCreateDriver(_cfg, logger);
      if (!driver) return;
      _driver = driver;

      // 2. 初始化 Schema
      try {
        const embedDimension = resolveEmbedDimension(pluginConfig);
        await ensureSchema(driver, embedDimension);
      } catch (err) {
        logger?.warn?.(`[graph-memory-pro] Schema init: ${err}`);
      }

      // 3. 初始化 LLM / Embedding
      _llm = createCompleteFn(_cfg.llm);
      _embed = _cfg.embedding ? createEmbedFn(_cfg.embedding) : null;

      // 4. 初始化 Recaller / Extractor
      _recaller = new Recaller(driver, _cfg);
      if (_embed) _recaller.setEmbedFn(_embed);

      // v2.1.2 第二批 I-2：注入 JudgeManager
      if (_cfg.judge?.enabled !== false) {
        const { JudgeManager } = await import("./src/recaller/judge.ts");
        const jm = new JudgeManager(_cfg.judge, _llm ?? undefined);
        _recaller.setJudgeManager(jm);
        logger?.info?.(`[graph-memory-pro] judge enabled (warmup=${_cfg.judge?.judgeWarmupFeedbacks ?? 50})`);
      }

      _extractor = new Extractor(driver);

      if (_cfg.timing?.enabled) {
        setTimingEnabled(true);
      }

      // 5. 初始化 HTTP 路由模块状态（P0-4: 路由通过 registerHttpRoute 注册，见下方）
      initRoutes(driver, _cfg, _llm ?? undefined, _embed ?? undefined);

      logger?.info?.("[graph-memory-pro] initialized");
    });

    // ── Gateway 停止时清理 ──────────────────────
    api.on("gateway_stop", async () => {
      if (_extractorTimer) { clearInterval(_extractorTimer); _extractorTimer = null; }
      if (_maintenanceTimer) { clearInterval(_maintenanceTimer); _maintenanceTimer = null; }
      closeDriver();
      _driver = null;
      _cfg = null;
      _llm = null;
      _embed = null;
      _recaller = null;
      _extractor = null;
    });

    // ─────────────────────────────────────────────────────────────────
    // P0-1: 移除 before_prompt_build 钩子
    //
    // 上下文注入完全由 contextEngine（lcm-graph-extra）的 assemble() 负责：
    //   - lcm-graph-extra 通过 Re-exports API 调用 Recaller
    //   - 返回 systemPromptAddition 注入
    //
    // graph-memory-pro 不再主动注入上下文，避免双注入冲突。
    // ─────────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────────
    // P0-3: 三元组提取改为后台服务
    //
    // 通过 api.registerService 注册，周期性消费待提取消息队列。
    // 注意：graph-memory-pro 作为无槽位插件，不直接接入 OpenClaw 会话消息流，
    // 因此这里通过 lcm-graph-extra 的 afterTurn 钩子写入的"待提取队列"
    // （~/.openclaw/graph-memory-pro/extract-queue.jsonl）来传递消息对。
    // 如果该队列为空，后台服务空转。
    // ─────────────────────────────────────────────────────────────────
    api.registerService({
      name: "graph-memory-extractor",
      description: "Background triplet extraction from conversation messages",
      async start() {
        const interval = _cfg?.background?.extractorIntervalMs ?? 60_000;
        _extractorTimer = setInterval(async () => {
          if (!_driver || !_extractor || !_llm) return;
          try {
            // 从队列文件读取待提取消息对（由 lcm-graph-extra 写入）
            const { readFile } = await import('node:fs/promises');
            const { join } = await import('node:path');
            const queuePath = join(
              process.env.HOME || process.env.USERPROFILE || '.',
              '.openclaw', 'graph-memory-pro', 'extract-queue.jsonl'
            );
            let queueContent = '';
            try {
              queueContent = await readFile(queuePath, 'utf-8');
            } catch {
              // 队列文件不存在时静默返回
              return;
            }
            if (!queueContent.trim()) return;

            const lines = queueContent.split('\n').filter(Boolean);
            const pairs: Array<{ user: string; assistant: string }> = [];
            for (const line of lines) {
              try {
                const item = JSON.parse(line);
                if (item.user && item.assistant) pairs.push(item);
              } catch { /* 跳过损坏行 */ }
            }

            if (pairs.length === 0) return;
            await extractInBackground(_extractor, _driver, _llm, logger, pairs);

            // 清空队列文件（保留空文件）
            const { writeFile, mkdir } = await import('node:fs/promises');
            const { dirname } = await import('node:path');
            await mkdir(dirname(queuePath), { recursive: true }).catch(() => {});
            await writeFile(queuePath, '').catch(() => {});
          } catch (err) {
            logger?.warn?.(`[graph-memory-pro] extractor tick failed: ${err}`);
          }
        }, interval);
      },
      async stop() {
        if (_extractorTimer) { clearInterval(_extractorTimer); _extractorTimer = null; }
      },
    });

    // ─────────────────────────────────────────────────────────────────
    // P0-4 / P1-2: 图谱维护改为后台周期服务
    //
    // 不再使用 session_end 钩子（会阻塞会话结束），改为周期性运行。
    // ─────────────────────────────────────────────────────────────────
    api.registerService({
      name: "graph-memory-maintenance",
      description: "Background graph maintenance (dedup + PageRank + community)",
      async start() {
        const interval = _cfg?.background?.maintenanceIntervalMs ?? 6 * 3600_000;
        // 启动后延迟 5 分钟执行第一次，避免与初始化竞争
        const initialDelay = 5 * 60_000;
        const runOnce = async () => {
          if (!_driver || !_cfg) return;
          try {
            logger?.info?.("[graph-memory-pro] background maintenance start");
            const result = await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined);
            logger?.info?.(`[graph-memory-pro] maintenance done: ${result.dedup.merged} merged, ${result.community.count} communities`);
          } catch (err) {
            logger?.warn?.(`[graph-memory-pro] maintenance error: ${err}`);
          }
        };
        setTimeout(runOnce, initialDelay);
        _maintenanceTimer = setInterval(runOnce, interval);
      },
      async stop() {
        if (_maintenanceTimer) { clearInterval(_maintenanceTimer); _maintenanceTimer = null; }
      },
    });

    // ─────────────────────────────────────────────────────────────────
    // P0-4: HTTP 路由通过 api.registerHttpRoute 注册
    //
    // 之前 initRoutes() 只初始化模块状态，路由从未注册到 Gateway。
    // ─────────────────────────────────────────────────────────────────
    const routes = getRoutes();
    for (const route of routes) {
      api.registerHttpRoute({
        method: route.method,
        path: route.path,
        handler: async (req: any) => {
          const result = await route.handler(req?.params ?? req?.query ?? {});
          return { status: result.status, body: result.body };
        },
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // P1-1: 注册为 memory-core 的语料补充
    //
    // 让 memory_search 工具能搜索到 Neo4j 图谱节点，无需另建 gm_search。
    // ─────────────────────────────────────────────────────────────────
    api.registerMemoryCorpusSupplement({
      async search(query: string, opts?: { limit?: number }) {
        if (!_driver) return [];
        try {
          const limit = Math.min(opts?.limit ?? 5, 20);
          const nodes = await searchNodes(_driver, query, limit);
          return nodes.map(n => ({
            id: n.id,
            content: `[${n.type}] ${n.name}: ${n.description}\n${n.content ?? ''}`,
            metadata: {
              source: "graph-memory-pro",
              type: n.type,
              pagerank: n.pagerank,
              validatedCount: n.validatedCount,
            },
          }));
        } catch {
          return [];
        }
      },
      async read(id: string) {
        if (!_driver) return null;
        try {
          return await findById(_driver, id);
        } catch {
          return null;
        }
      },
    });

    // ── 注册 Agent 工具 ───────────────────────────
    // P1-4: 移除 gm_search（已通过 registerMemoryCorpusSupplement 由 memory_search 覆盖）
    //       移除 gm_stats（合并到 gm_maintain 输出）

    // gm_record: 手动记录知识到图谱
    api.registerTool({
      name: "gm_record",
      label: "Graph Memory Record",
      description: "手动记录一条知识到 Graph Memory Pro 图谱中。当你发现重要的技能、经验或事件时使用。节点类型: SKILL(技能/方案) / TASK(任务/需求) / EVENT(事件/错误)",
      parameters: Type.Object({
        type: Type.String({ description: "节点类型: SKILL / TASK / EVENT" }),
        name: Type.String({ description: "节点英文名" }),
        description: Type.String({ description: "描述" }),
        content: Type.String({ description: "详细内容" }),
      }),
      async execute(_callId: string, params: { type: string; name: string; description: string; content: string }) {
        if (!_driver) {
          return { content: [{ type: "text", text: "Graph Memory Pro 未连接" }], details: {} };
        }
        try {
          const p = params;
          const now = Date.now();
          const id = `manual-${now}-${Math.random().toString(36).slice(2, 8)}`;
          const nodeType = p.type.toUpperCase();
          if (!["TASK", "SKILL", "EVENT"].includes(nodeType)) {
            return { content: [{ type: "text", text: `无效的节点类型: ${p.type}` }], details: {} };
          }
          await upsertNode(_driver, {
            id,
            type: nodeType as any,
            name: p.name,
            description: p.description,
            content: p.content,
            status: "active",
            communityId: undefined,
            pagerank: 0,
            validatedCount: 0,
            createdAt: now,
            updatedAt: now,
          });
          return { content: [{ type: "text", text: `已记录知识节点: ${id}` }], details: { id } };
        } catch (err: any) {
          return { content: [{ type: "text", text: `记录失败: ${err.message}` }], details: {} };
        }
      },
    });

    // gm_maintain: 手动触发维护（含统计输出）
    api.registerTool({
      name: "gm_maintain",
      label: "Graph Memory Maintain",
      description: "手动触发 Graph Memory Pro 图谱维护（去重 + PageRank + 社区检测 + 过时检测 + 健康检查）并返回统计信息",
      parameters: Type.Object({}),
      async execute() {
        if (!_driver || !_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro 未连接" }], details: {} };
        }
        try {
          const [nodeCount, edgeCount] = await Promise.all([
            getNodeCount(_driver),
            getEdgeCount(_driver),
          ]);
          const result = await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined);

          // v2.1.2 G-5: 维护后追加健康报告
          let healthReport: any = null;
          try {
            const { healthCheck } = await import("./src/graph/maintenance.ts");
            healthReport = await healthCheck(_driver);
          } catch (err: any) {
            // 健康检查失败不影响主流程
          }

          // v2.1.2 第二批：缓存 + 反馈统计
          const cacheStats = _recaller?.getQueryCache()?.getStats();
          const judgeStats = _recaller?.getJudgeManager()
            ? {
                feedbackCount: _recaller.getJudgeManager()!.getFeedbackCount(),
                coldStart: _recaller.getJudgeManager()!.isColdStart(),
              }
            : null;

          const text = [
            "📊 Graph Memory Pro 统计",
            `节点总数: ${nodeCount}`,
            `关系总数: ${edgeCount}`,
            "",
            "✅ 维护完成",
            `去重合并: ${result.dedup.merged} 个`,
            `PageRank: ${result.pagerank.topK.length} 个节点已排序`,
            `社区: ${result.community.count} 个社区`,
            `社区摘要: ${result.communitySummaries} 个`,
            `耗时: ${result.durationMs}ms`,
            "",
            healthReport ? "🏥 图谱健康" : "",
            healthReport ? `活跃节点: ${healthReport.nodes.active}/${healthReport.nodes.total}` : "",
            healthReport ? `孤立节点: ${healthReport.isolatedNodes}` : "",
            healthReport ? `高过时节点: ${healthReport.highStaleNodes}` : "",
            healthReport ? `社区数: ${healthReport.communities}` : "",
            healthReport ? `平均 PageRank: ${healthReport.avgPageRank.toFixed(4)}` : "",
            healthReport && healthReport.anomalies.length > 0
              ? `⚠️ 异常: ${healthReport.anomalies.join("; ")}`
              : (healthReport ? "✅ 无异常" : ""),
            "",
            cacheStats ? "💾 查询缓存" : "",
            cacheStats ? `容量: ${cacheStats.size}/${cacheStats.capacity}` : "",
            cacheStats ? `命中率: ${cacheStats.hitRate}` : "",
            cacheStats ? `相似命中: ${cacheStats.similarityHits}` : "",
            "",
            judgeStats ? "📋 反馈系统" : "",
            judgeStats ? `累计反馈: ${judgeStats.feedbackCount}` : "",
            judgeStats ? `冷启动期: ${judgeStats.coldStart ? "是（仅启发式规则）" : "否（已启用 LLM）"}` : "",
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text", text }], details: { nodeCount, edgeCount, ...result, health: healthReport, cache: cacheStats, judge: judgeStats } };
        } catch (err: any) {
          return { content: [{ type: "text", text: `维护失败: ${err.message}` }], details: {} };
        }
      },
    });

    // gm_reembed: 批量重新向量化
    api.registerTool({
      name: "gm_reembed",
      label: "Graph Memory Re-Embed",
      description: "Batch re-embed all active nodes that are missing an embedding vector (only processes status=active with empty/null embedding)",
      parameters: Type.Object({}),
      async execute() {
        if (!_driver || !_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro not connected" }], details: {} };
        }
        if (!_embed) {
          return { content: [{ type: "text", text: "Embedding engine not configured" }], details: {} };
        }
        try {
          const result = await reEmbedNodes(_driver, _embed);
          const lines = [
            "Re-Embed done",
            `Scanned: ${result.totalScanned} nodes`,
            `Embedded: ${result.reEmbedded} nodes`,
            `Failed: ${result.failed}`,
            `Skipped: ${result.skipped}`,
            `Duration: ${result.durationMs}ms`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }], details: result };
        } catch (err) {
          return { content: [{ type: "text", text: "Re-Embed failed: " + String(err) }], details: {} };
        }
      },
    });

    // v2.1.2 第二批 I-2/I-3: 反馈提交工具
    // Agent 在收到 assistant 回复后调用，记录哪些召回节点被实际使用
    api.registerTool({
      name: "gm_feedback",
      label: "Graph Memory Feedback",
      description: "Submit feedback on which recalled nodes were actually used in the assistant reply. Triggers I-2 heuristic judge + I-3 persistence.",
      parameters: Type.Object({
        query: Type.String({ description: "Original user query" }),
        recalledNodeIds: Type.Array(Type.String(), { description: "Node IDs returned by recall" }),
        assistantReply: Type.String({ description: "Assistant's reply content" }),
        sessionId: Type.Optional(Type.String()),
      }),
      async execute(_callId: string, params: any) {
        if (!_driver || !_recaller) {
          return { content: [{ type: "text", text: "Graph Memory Pro not connected" }], details: {} };
        }
        try {
          // 加载召回的节点（用于裁判判断）
          const { findById } = await import("./src/store/store.ts");
          const driver = _driver;
          const recalledNodes = (await Promise.all(
            (params.recalledNodeIds as string[]).map(id => findById(driver, id)),
          )).filter(Boolean) as any[];

          // 调用 Recaller.processFeedback（I-2 判断 + I-3 持久化）
          await _recaller.processFeedback(
            params.query,
            recalledNodes,
            params.assistantReply,
            params.sessionId,
          );

          const jm = _recaller.getJudgeManager();
          const text = [
            "✅ Feedback submitted",
            `Recalled: ${recalledNodes.length} nodes`,
            `Cold start: ${jm?.isColdStart() ? "yes (heuristic only)" : "no"}`,
            `Total feedbacks: ${jm?.getFeedbackCount() ?? 0}`,
          ].join("\n");
          return { content: [{ type: "text", text }], details: { submitted: true } };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Feedback failed: ${err.message}` }], details: {} };
        }
      },
    });

  },
});

// ─── Re-exports for lcm-graph-extra ─────────────────────────
export { ensureSchema, searchNodes, getEdgesForNodes, getTopNodes, getNodeCount, getEdgeCount } from "./src/store/store.js";
export { upsertNode, upsertEdge, mergeNodes, findById } from "./src/store/store.js";
export { Recaller } from "./src/recaller/recall.js";
export { getDriver } from "./src/store/db.js";
export { runMaintenance } from "./src/graph/maintenance.js";
export { Extractor, extractTriplets } from "./src/extractor/extract.ts";

// ─── Additional re-exports for lcm-graph-extra (Layer 1 fix) ────
export { personalizedPageRank, computeGlobalPageRank } from "./src/graph/pagerank.js";
export { detectCommunities, summarizeCommunities, getCommunityPeers } from "./src/graph/community.js";
export { getVectorHash } from "./src/store/store.js";
export { dedup } from "./src/graph/dedup.js";
export type { GmConfig, NodeType, EdgeType, NodeStatus, GmNode, GmEdge, RecallResult, EmbeddingConfig } from "./src/types.js";
export { createEmbedFn } from "./src/engine/embed.js";
export { setTimingEnabled, printAllDistributions, resetAllDistributions, LatencyDistribution } from "./src/timing.js";
export type { EmbedFn } from "./src/engine/embed.js";

// ─── v2.1.2 第二批 反馈闭环 + 冷启动 Re-exports ─────────────────────────
export { upsertFeedback, getFeedbackCount, getNodeFeedbackStats } from "./src/store/store.js";
export type { GmFeedback } from "./src/store/store.js";
export { QueryCache } from "./src/recaller/query-cache.js";
export { JudgeManager, isMatrixColdStart, getColdStartSearchWeights } from "./src/recaller/judge.js";
export type { JudgeConfig, JudgeResult, JudgeFeedback, WarmupConfig } from "./src/recaller/judge.js";
