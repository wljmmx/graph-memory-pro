/**
 * graph-memory-pro — Neo4j Knowledge Graph Memory Plugin
 *
 * Version: 2.3.2
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
import type { GmConfig } from "./src/types.ts";
import type { CompleteFn } from "./src/engine/llm.ts";
import type { EmbedFn } from "./src/engine/embed.ts";
import { createCompleteFn, createRuntimeCompleteFn } from "./src/engine/llm.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { initDriver, closeDriver, verifyWithRetry } from "./src/store/db.ts";
import { ensureSchema, getNodeCount, getEdgeCount, searchNodes, upsertNode, upsertEdge, batchUpsertNodes, batchUpsertEdges, findById } from "./src/store/store.ts";
import { Extractor } from "./src/extractor/extract.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { runMaintenance } from "./src/graph/maintenance.ts";
import { reEmbedNodes } from "./src/graph/reembed.ts";
import { initRoutes, getRoutes } from "./src/routes/crud.ts";
import { setTimingEnabled } from "./src/timing.ts";
import { getCircuitBreaker } from "./src/engine/circuit-breaker.ts";

// ─── 全局状态 ──────────────────────────────────────────

let _driver: Driver | null = null;
let _cfg: GmConfig | null = null;
let _llm: CompleteFn | null = null;
let _embed: EmbedFn | null = null;
let _extractor: Extractor | null = null;
let _recaller: Recaller | null = null;
let _extractorTimer: ReturnType<typeof setInterval> | null = null;
let _maintenanceTimer: ReturnType<typeof setInterval> | null = null;
// v2.3.2 S3: 后台 timer 重入保护 — 防止单次执行超过 interval 时下一次 tick 重叠执行
let _extractorRunning = false;
let _maintenanceRunning = false;
let _mcpServerHandle: { close(): Promise<void> } | null = null;

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

  // v2.3.2 阶段三: LLM 熔断器 — OPEN 时跳过整个 extract tick，减少 Ollama 压力
  const llmBreaker = getCircuitBreaker("llm");
  if (!llmBreaker.allow()) {
    if (process.env.GM_DEBUG) logger?.debug?.("[graph-memory-pro] llm circuit OPEN, skip extract tick");
    return;
  }

  let extracted = 0;
  const maxPairs = 3;
  const pairs = pendingMessages.slice(0, maxPairs);

  for (const pair of pairs) {
    try {
      const result = await extractor.extract(llm, pair.user, pair.assistant);
      llmBreaker.recordSuccess();
      if (result.nodes.length > 0) {
        extracted++;
        const now = Date.now();

        // v2.3.1 P0-3 性能优化: 批量 upsert 节点（UNWIND + MERGE）
        // 旧实现：循环中 N 次 upsertNode，每次 2-3 次 session.run
        // 新实现：单次 batchUpsertNodes，按 label 分组批量 MERGE
        const nodeIdMap = new Map<string, string>();
        const nodesToWrite: any[] = [];
        for (const enode of result.nodes) {
          const id = `auto-${now}-${Math.random().toString(36).slice(2, 8)}`;
          nodeIdMap.set(enode.name, id);
          nodesToWrite.push({
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
            embeddingModel: _cfg?.embedding?.model,
          });
        }
        try {
          await batchUpsertNodes(driver, nodesToWrite);
        } catch (e) {
          // v2.3.2 S2 稳定性修复: 批量失败时回退到逐条 upsert，保证部分成功（防数据丢失）
          // v2.3.2 S4: 传入 _cfg 以读取 archiveKeepCount 配置
          if (process.env.GM_DEBUG) logger?.debug?.(`  [graph-memory-pro] batchUpsertNodes failed, fallback to single upsert: ${e}`);
          await Promise.allSettled(nodesToWrite.map(n => upsertNode(driver, n, _cfg ?? undefined)));
        }

        // v2.3.1 P0-3: 批量 upsert 边（UNWIND + MERGE，按关系类型分组）
        const edgesToWrite: any[] = [];
        for (const eedge of result.edges) {
          const fromId = nodeIdMap.get(eedge.fromName);
          const toId = nodeIdMap.get(eedge.toName);
          if (!fromId || !toId) continue;
          edgesToWrite.push({
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
        }
        if (edgesToWrite.length > 0) {
          try {
            await batchUpsertEdges(driver, edgesToWrite);
          } catch (e) {
            // v2.3.2 S2: 批量边写入失败也回退到逐条 upsertEdge
            if (process.env.GM_DEBUG) logger?.debug?.(`  [graph-memory-pro] batchUpsertEdges failed, fallback to single upsert: ${e}`);
            await Promise.allSettled(edgesToWrite.map(e => upsertEdge(driver, e)));
          }
        }
      }
    } catch (err) {
      // v2.3.2 阶段三: extract 失败记录到 LLM 熔断器
      llmBreaker.recordFailure();
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
      keepAlive: Type.Optional(Type.String()),
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
      // v2.2.0 Tier 1/2/3
      tier: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)])),
      llmJudgeMaxNodes: Type.Optional(Type.Number({ default: 10 })),
      llmJudgeTimeoutMs: Type.Optional(Type.Number({ default: 8000 })),
      customStrategy: Type.Optional(Type.String()),
    })),
    feedback: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      retentionDays: Type.Optional(Type.Number({ default: 90 })),
    })),
    warmup: Type.Optional(Type.Object({
      warmupFeedbacks: Type.Optional(Type.Number({ default: 100 })),
      judgeWarmupFeedbacks: Type.Optional(Type.Number({ default: 50 })),
    })),
    // ── v2.1.2 第三批 在线学习 + 可进化嵌入 + 重要性评分 ────────
    associationMatrix: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      learningRate: Type.Optional(Type.Number({ default: 0.01 })),
      momentum: Type.Optional(Type.Number({ default: 0.9 })),
      adamBeta1: Type.Optional(Type.Number({ default: 0.9 })),
      adamBeta2: Type.Optional(Type.Number({ default: 0.999 })),
      warmupFeedbacks: Type.Optional(Type.Number({ default: 100 })),
    })),
    marginalUtility: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      neighborhoodSize: Type.Optional(Type.Number({ default: 5 })),
      minImprovement: Type.Optional(Type.Number({ default: 0.0 })),
    })),
    evolvableEmbedding: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      reembedOnContentChange: Type.Optional(Type.Boolean({ default: true })),
      archiveKeepCount: Type.Optional(Type.Number({ default: 3 })),
    })),
    importance: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      weights: Type.Optional(Type.Object({
        recency: Type.Optional(Type.Number({ default: 0.3 })),
        frequency: Type.Optional(Type.Number({ default: 0.3 })),
        centrality: Type.Optional(Type.Number({ default: 0.2 })),
        source: Type.Optional(Type.Number({ default: 0.2 })),
      })),
      recencyDecayDays: Type.Optional(Type.Number({ default: 30 })),
      frequencySaturation: Type.Optional(Type.Number({ default: 10 })),
    })),
    // ── v2.1.2 第四批 结构升级 + 冲突消解 + 嵌入版本 ────────────
    hierarchicalCommunity: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      depth: Type.Optional(Type.Union([
        Type.Literal(1),
        Type.Literal(2),
        Type.Literal(3),
      ])),
    })),
    conflictResolution: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      temporalPriority: Type.Optional(Type.Boolean({ default: true })),
      sourcePriority: Type.Optional(Type.Boolean({ default: true })),
      confidencePriority: Type.Optional(Type.Boolean({ default: true })),
    })),
    edgeWeights: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      strengthenFactor: Type.Optional(Type.Number({ default: 1.1 })),
      decayFactor: Type.Optional(Type.Number({ default: 0.95 })),
      minWeight: Type.Optional(Type.Number({ default: 0.1 })),
      maxWeight: Type.Optional(Type.Number({ default: 5.0 })),
    })),
    reverseMemory: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      recallThreshold: Type.Optional(Type.Number({ default: 10 })),
      stalenessPenalty: Type.Optional(Type.Number({ default: 0.1 })),
      importanceFloor: Type.Optional(Type.Number({ default: 0.2 })),
    })),
    // ── v2.1.2 第五批 Benchmark + 自主调优 ────────────
    benchmark: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      dataDir: Type.Optional(Type.String()),
      maxCases: Type.Optional(Type.Number({ default: 0 })),
      buildGraph: Type.Optional(Type.Boolean({ default: true })),
      caseTimeoutMs: Type.Optional(Type.Number({ default: 30_000 })),
    })),
    autoTuner: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      regressionThreshold: Type.Optional(Type.Number({ default: 0.02 })),
      stagnationThreshold: Type.Optional(Type.Number({ default: 5 })),
      maxRounds: Type.Optional(Type.Number({ default: 10 })),
      benchmarkMaxCases: Type.Optional(Type.Number({ default: 50 })),
      llmDiagnosis: Type.Optional(Type.Boolean({ default: true })),
      warmupFeedbacks: Type.Optional(Type.Number({ default: 100 })),
    })),
    // ── v2.2.0 MCP Server ────────────
    mcp: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      port: Type.Optional(Type.Number({ default: 7800 })),
      host: Type.Optional(Type.String({ default: "127.0.0.1" })),
      path: Type.Optional(Type.String({ default: "/mcp" })),
      authToken: Type.Optional(Type.String()),
      enabledTools: Type.Optional(Type.Array(Type.String())),
    })),
  }) as any),
  register(api: any) {
    const logger = api.logger ?? console;
    // v2.2.0 P2-1：把 SDK logger 注入到结构化日志模块
    try {
      const { setExternalLogger } = require("./src/logger.ts");
      setExternalLogger(api.logger ?? null);
    } catch {
      // logger 模块加载失败不影响主流程
    }

    // ── Gateway 启动时初始化 ──────────────────────
    api.on("gateway_start", async (event: any) => {
      // P0-2: 配置优先从 SDK 注入，移除 fs.readFileSync
      const eventCfg = event?.config ?? event?.pluginConfig ?? api.config;
      if (!eventCfg?.neo4j?.uri) {
        logger?.warn?.("[graph-memory-pro] No Neo4j config — plugin skipped");
        return;
      }
      const pluginConfig = eventCfg as GmConfig;

      // v2.2.0 fix: spread pluginConfig 保留全部 v2.1.2 扩展字段
      // 之前手动列举只复制了 13 个基础字段，导致 judge/associationMatrix 等
      // 全部 v2.1.2 配置被静默丢弃（judge 永远启用，associationMatrix 永远禁用）
      _cfg = {
        ...pluginConfig,
        compactTurnCount: pluginConfig.compactTurnCount ?? 6,
        recallMaxNodes: pluginConfig.recallMaxNodes ?? 6,
        recallMaxDepth: pluginConfig.recallMaxDepth ?? 2,
        freshTailCount: pluginConfig.freshTailCount ?? 10,
        dedupThreshold: pluginConfig.dedupThreshold ?? 0.90,
        pagerankDamping: pluginConfig.pagerankDamping ?? 0.85,
        pagerankIterations: pluginConfig.pagerankIterations ?? 20,
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
      //
      // 主会话本地模型优先策略（v2.2.1）：
      // - 若 SDK 提供 api.runtime.llm，则用主会话模型 provider 探测：
      //   * 本地模型（ollama/lmstudio/localai 等）→ 后续走主会话 runtime LLM
      //   * 云端模型 → 切换到插件配置的 llm（fallback）
      // - 否则回退到原有 createCompleteFn(_cfg.llm) 路径
      const runtimeLlm = api.runtime?.llm;
      if (runtimeLlm && typeof runtimeLlm.complete === "function") {
        _llm = createRuntimeCompleteFn(runtimeLlm, _cfg.llm, logger);
        logger?.info?.("[graph-memory-pro] LLM initialized via runtime (provider detection deferred to first call)");
      } else {
        _llm = createCompleteFn(_cfg.llm);
        if (_llm) {
          logger?.info?.("[graph-memory-pro] LLM initialized via plugin config (api.runtime.llm unavailable)");
        }
      }
      _embed = _cfg.embedding ? createEmbedFn(_cfg.embedding) : null;

      // 4. 初始化 Recaller / Extractor
      _recaller = new Recaller(driver, _cfg);
      if (_embed) _recaller.setEmbedFn(_embed);

      // v2.1.2 第二批 I-2：注入 JudgeManager
      if (_cfg.judge?.enabled !== false) {
        const { JudgeManager } = await import("./src/recaller/judge.ts");
        const { getFeedbackCount } = await import("./src/store/store.ts");
        const jm = new JudgeManager(_cfg.judge, _llm ?? undefined);
        // 从 DB 恢复累计反馈计数，避免 Gateway 重启后永久卡在冷启动期
        try {
          const persistedCount = await getFeedbackCount(driver);
          for (let i = 0; i < persistedCount; i++) jm.incrementFeedback();
          logger?.info?.(`[graph-memory-pro] judge enabled (warmup=${_cfg.judge?.judgeWarmupFeedbacks ?? 50}, persisted=${persistedCount})`);
        } catch (err) {
          logger?.warn?.(`[graph-memory-pro] judge feedback count restore failed: ${err}`);
        }
        _recaller.setJudgeManager(jm);
      }

      // v2.1.2 第三批 L-1：注入 AssociationMatrix（关联矩阵 M）
      if (_cfg.associationMatrix?.enabled === true) {
        const { createAssociationMatrix } = await import("./src/recaller/association-matrix.ts");
        const amDim = resolveEmbedDimension(_cfg);
        const am = createAssociationMatrix(amDim, _cfg);
        _recaller.setAssociationMatrix(am);
        logger?.info?.(`[graph-memory-pro] association-matrix enabled (dim=${amDim}, warmup=${_cfg.associationMatrix?.warmupFeedbacks ?? _cfg.warmup?.warmupFeedbacks ?? 100})`);
      }

      _extractor = new Extractor(driver);

      if (_cfg.timing?.enabled) {
        setTimingEnabled(true);
      }

      // 5. 初始化 HTTP 路由模块状态（P0-4: 路由通过 registerHttpRoute 注册，见下方）
      initRoutes(driver, _cfg, _llm ?? undefined, _embed ?? undefined, _recaller ?? undefined);

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
          // v2.3.2 S3: 重入保护 — 上一次 tick 仍在执行时跳过本次
          if (_extractorRunning) return;
          _extractorRunning = true;
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
          } finally {
            _extractorRunning = false;
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
          // v2.3.2 S3: 重入保护 — 上一次 tick 仍在执行时跳过本次
          if (_maintenanceRunning) return;
          _maintenanceRunning = true;
          try {
            logger?.info?.("[graph-memory-pro] background maintenance start");
            const result = await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined);
            logger?.info?.(`[graph-memory-pro] maintenance done: ${result.dedup.merged} merged, ${result.community.count} communities`);
          } catch (err) {
            logger?.warn?.(`[graph-memory-pro] maintenance error: ${err}`);
          } finally {
            _maintenanceRunning = false;
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
    // v2.3.2 阶段三: 配置热更新 — /api/reload 端点
    //
    // 从 SDK 重新读取配置，diff 后部分重建资源（driver/llm/embed/timer），
    // 其余配置原地合并（Object.assign）让 Recaller/JudgeManager 等持引用的组件自动生效。
    // 鉴权：通过 body.authToken 校验（与 mcp.authToken 一致），未配置 authToken 时允许本地访问。
    // ─────────────────────────────────────────────────────────────────
    api.registerHttpRoute({
      method: "POST",
      path: "/api/reload",
      handler: async (req: any) => {
        try {
          if (!_cfg) return { status: 503, body: { error: "plugin not initialized" } };

          const { checkReloadAuth, normalizeReloadConfig, diffConfigSegments } = await import("./src/routes/reload.ts");

          // 鉴权：若配置了 authToken，请求需携带匹配的 token
          const authResult = checkReloadAuth(_cfg, req?.body?.authToken ?? req?.headers?.["x-auth-token"]);
          if (!authResult.ok) {
            return { status: authResult.status!, body: { error: authResult.error } };
          }

          // 从 SDK 重新获取配置
          const newCfgRaw = api.config ?? {};
          if (!newCfgRaw?.neo4j?.uri) {
            return { status: 400, body: { error: "new config missing neo4j.uri" } };
          }
          const newCfg = normalizeReloadConfig(newCfgRaw);

          const applied: Record<string, boolean> = {};

          // diff: 检测各配置段是否变化（diff-based 部分重建）
          const diff = diffConfigSegments(_cfg, newCfg);

          // diff: neo4j 段变化 → 重建 driver
          if (diff.neo4j) {
            const driver = await getOrCreateDriver(newCfg, logger);
            if (driver) {
              _driver = driver;
              const embedDimension = resolveEmbedDimension(newCfg);
              try { await ensureSchema(driver, embedDimension); } catch (err) {
                logger?.warn?.(`[graph-memory-pro] reload schema init: ${err}`);
              }
              applied.neo4j = true;
            }
          }

          // diff: llm 段变化 → 重建 LLM
          if (diff.llm) {
            const runtimeLlm = api.runtime?.llm;
            if (runtimeLlm && typeof runtimeLlm.complete === "function") {
              _llm = createRuntimeCompleteFn(runtimeLlm, newCfg.llm, logger);
            } else {
              _llm = createCompleteFn(newCfg.llm);
            }
            applied.llm = true;
          }

          // diff: embedding 段变化 → 重建 embed
          if (diff.embedding) {
            _embed = newCfg.embedding ? createEmbedFn(newCfg.embedding) : null;
            applied.embedding = true;
          }

          // diff: background 间隔变化 → 重建 timer
          const bgChanged = diff.background;

          // 原地合并配置（Recaller/JudgeManager 持引用，自动生效）
          Object.assign(_cfg, newCfg);
          applied.inPlace = true;

          // 更新 Recaller 的 embed/judge 注入
          if (_recaller) {
            if (_embed) _recaller.setEmbedFn(_embed);
            if (diff.llm && _cfg.judge?.enabled !== false) {
              const { JudgeManager } = await import("./src/recaller/judge.ts");
              const jm = new JudgeManager(_cfg.judge, _llm ?? undefined);
              _recaller.setJudgeManager(jm);
            }
          }

          // 更新 routes 内部状态
          initRoutes(_driver!, _cfg, _llm ?? undefined, _embed ?? undefined, _recaller ?? undefined);

          // background 间隔变化 → 提示需重启 timer（timer 重建较重，标记但不自动执行）
          if (bgChanged) {
            applied.timers = false;
            logger?.info?.("[graph-memory-pro] background interval changed, restart plugin to apply timer changes");
          }

          // 失效熔断器（配置变化可能修复了下游问题，重置熔断器让其重试）
          const { resetAllCircuitBreakers } = await import("./src/engine/circuit-breaker.ts");
          resetAllCircuitBreakers();

          logger?.info?.(`[graph-memory-pro] config reloaded: ${JSON.stringify(applied)}`);
          return { status: 200, body: { applied, version: "2.3.2" } };
        } catch (err: any) {
          logger?.error?.(`[graph-memory-pro] reload failed: ${err}`);
          return { status: 500, body: { error: err.message } };
        }
      },
    });

    // ─────────────────────────────────────────────────────────────────
    // v2.2.0: MCP Server（对外暴露 13 个 tools，供 dashboard 调用）
    //
    // 通过 api.registerService 注册，复用宿主进程的 _driver/_cfg/_recaller。
    // 启用条件：cfg.mcp.enabled === true
    // ─────────────────────────────────────────────────────────────────
    if (_cfg?.mcp?.enabled === true) {
      api.registerService({
        name: "graph-memory-mcp",
        description: "MCP server exposing graph-memory-pro tools to dashboard / external clients",
        async start() {
          if (!_driver || !_cfg) return;
          try {
            const { startMcpServer } = await import("./src/mcp/server.ts");
            _mcpServerHandle = await startMcpServer(
              _driver, _cfg,
              _llm ?? undefined,
              _embed ?? undefined,
              _recaller ?? undefined,
            );
            logger?.info?.(`[graph-memory-pro] MCP server started (port=${_cfg.mcp?.port ?? 7800})`);
          } catch (err) {
            logger?.error?.(`[graph-memory-pro] MCP server start failed: ${err}`);
          }
        },
        async stop() {
          if (_mcpServerHandle) {
            try { await _mcpServerHandle.close(); } catch { /* ignore */ }
            _mcpServerHandle = null;
          }
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
            embeddingModel: _cfg?.embedding?.model,
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
          } catch {
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

          // v2.1.2 第三批：L-1 关联矩阵 M 统计
          const amStats = _recaller?.getAssociationMatrix()?.getStats();

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
            result.importance ? `重要性评分: scanned=${result.importance.scanned}, avg=${result.importance.avgScore.toFixed(3)}` : "",
            result.conflictResolution ? `冲突消解: scanned=${result.conflictResolution.scanned}, resolved=${result.conflictResolution.resolved} (合并=${result.conflictResolution.merged})` : "",
            result.edgeWeights && result.edgeWeights.scanned > 0 ? `边权重: 强化=${result.edgeWeights.strengthened}, 衰减=${result.edgeWeights.decayed}` : "",
            result.reverseMemory && (result.reverseMemory.watchlistAdded > 0 || result.reverseMemory.decayed > 0) ? `反向记忆: 衰减=${result.reverseMemory.decayed}, 恢复=${result.reverseMemory.watchlistRemoved}` : "",
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
            "",
            amStats ? "🧠 关联矩阵 M (L-1)" : "",
            amStats ? `维度: ${amStats.dim}` : "",
            amStats ? `时间步 t: ${amStats.t}` : "",
            amStats ? `已应用更新: ${amStats.updatesApplied}` : "",
            amStats ? `被拒更新: ${amStats.updatesRejected} (R-3 边际效用拒绝)` : "",
            amStats ? `历史样本: ${amStats.historySize}` : "",
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text", text }], details: { nodeCount, edgeCount, ...result, health: healthReport, cache: cacheStats, judge: judgeStats, associationMatrix: amStats } };
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
          // 传入 embeddingModel，避免清空所有节点的 embeddingModel 字段（G-4 修复）
          const result = await reEmbedNodes(_driver, _embed, 50, _cfg.embedding?.model);
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

    // v2.1.2 第五批 S-10: Benchmark 评测工具
    // Agent 触发标准评测（LoCoMo / LongMemEval），输出量化指标
    api.registerTool({
      name: "gm_benchmark",
      label: "Graph Memory Benchmark",
      description: "Run S-10 Benchmark evaluation (LoCoMo + LongMemEval) on the current graph memory. Outputs P@1 / P@3 / MRR / F1 / P99 latency / token consumption. Use to quantify recall quality before/after tuning.",
      parameters: Type.Object({
        datasets: Type.Optional(Type.Union([
          Type.Literal("all"),
          Type.Array(Type.String()),
        ])),
        maxCases: Type.Optional(Type.Number({ description: "Max cases per dataset (0 = all)" })),
        buildGraph: Type.Optional(Type.Boolean({ description: "Build graph from conversation history before evaluation (default true)" })),
      }),
      async execute(_callId: string, params: any) {
        if (!_recaller || !_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro not connected" }], details: {} };
        }
        try {
          const { runBenchmark, formatAggregateReport } = await import("./src/benchmark/runner.ts");
          const result = await runBenchmark(_recaller, _driver, _cfg, {
            datasets: params.datasets ?? "all",
            maxCases: params.maxCases ?? _cfg.benchmark?.maxCases ?? 0,
            buildGraph: params.buildGraph ?? _cfg.benchmark?.buildGraph ?? true,
            caseTimeoutMs: _cfg.benchmark?.caseTimeoutMs ?? 30_000,
            dataDir: _cfg.benchmark?.dataDir,
            llm: _llm ?? undefined,
            embedFn: _embed ?? undefined,
          });
          const text = formatAggregateReport(result);
          return { content: [{ type: "text", text }], details: result.aggregate };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Benchmark failed: ${err.message}` }], details: {} };
        }
      },
    });

    // v2.1.2 第五批 R-1: 自主调优（EvolveMem）工具
    // Agent 触发一次 EvolveMem 四步循环：EVALUATE → DIAGNOSE → PROPOSE → GUARD
    api.registerTool({
      name: "gm_tune",
      label: "Graph Memory Auto-Tune",
      description: "Run one EvolveMem auto-tuning cycle (R-1). Evaluates current config on benchmark, diagnoses failures via LLM/heuristic, proposes parameter adjustments, and guards against regressions. Requires benchmark + autoTuner enabled.",
      parameters: Type.Object({
        rounds: Type.Optional(Type.Number({ description: "Number of tune cycles to run (default 1, max bounded by config maxRounds)" })),
      }),
      async execute(_callId: string, params: any) {
        if (!_recaller || !_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro not connected" }], details: {} };
        }
        if (_cfg.autoTuner?.enabled !== true) {
          return { content: [{ type: "text", text: "AutoTuner disabled. Set autoTuner.enabled=true in config." }], details: {} };
        }
        try {
          const { AutoTuner } = await import("./src/evolution/auto-tuner.ts");
          // 持久化 AutoTuner 状态到本地文件，跨 gm_tune 调用保留 snapshots/bestMetrics
          // 修复 R-1 设计缺陷：旧实现每次新建 AutoTuner，导致 revert-on-regression 永不触发
          const { readFile, writeFile, mkdir } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const statePath = join(
            process.env.HOME || process.env.USERPROFILE || ".",
            ".openclaw", "graph-memory-pro", "auto-tuner-state.json",
          );
          const tuner = new AutoTuner(_cfg.autoTuner, _llm ?? undefined);
          tuner.setInitialAction(_cfg);
          // 尝试从持久化文件恢复状态
          try {
            const saved = await readFile(statePath, "utf-8");
            if (saved.trim()) tuner.deserialize(saved);
          } catch { /* 首次运行无状态文件 */ }

          const rounds = Math.max(1, Math.min(params.rounds ?? 1, _cfg.autoTuner?.maxRounds ?? 10));
          const results: any[] = [];
          for (let i = 0; i < rounds; i++) {
            const r = await tuner.runTuneCycle(_recaller, _driver, _cfg);
            results.push(r);
            if (!r.applied) break;
          }
          // 持久化最新状态
          try {
            await mkdir(join(statePath, "..").replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {});
            await writeFile(statePath, tuner.serialize()).catch(() => {});
          } catch { /* 持久化失败不影响调优结果 */ }

          const lines = [
            "🔧 EvolveMem Auto-Tuning",
            `Rounds executed: ${results.length}`,
            `Total tune rounds (persisted): ${tuner.getTuneRound()}`,
            `Snapshots: ${tuner.getSnapshots().length}`,
            "",
            ...results.map((r, i) =>
              `Round ${i + 1}: ${r.applied ? "applied" : "skipped"} — ${r.reason}${r.isImprovement ? " ✨ improvement" : ""}${r.metrics ? ` | P@1=${(r.metrics.p1 * 100).toFixed(1)}%` : ""}`,
            ),
            "",
            `Current action: ${JSON.stringify(tuner.getCurrentAction())}`,
            "",
            "⚠️ 注意：调优结果需手动应用到 GmConfig 并重启 Recaller 才生效。",
            "   可通过 applyActionSpace(cfg, tuner.getCurrentAction()) 生成新配置。",
          ];
          return { content: [{ type: "text", text: lines.join("\n") }], details: { rounds: results, finalAction: tuner.getCurrentAction(), totalRounds: tuner.getTuneRound(), snapshots: tuner.getSnapshots().length } };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Auto-tune failed: ${err.message}` }], details: {} };
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

// ─── v2.1.2 G-5 图谱健康（供 lcm-graph-extra dashboard 调用）─────────
// dashboard-snapshot.ts 的 resolveGraphHealth 通过 withGmProFallback('getGraphHealth', ...)
// 调用本函数。返回 dashboard 期望的 { status, nodeCount, relationshipCount, ... } 格式。
// 内部委托给 healthCheck(driver)，并根据 anomalies 数量推断 status。
export async function getGraphHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  nodeCount: number;
  relationshipCount: number;
  staleNodeCount: number;
  lastMaintenanceAt?: number;
  avgQueryLatencyMs?: number;
  errorRate?: number;
  details?: Record<string, unknown>;
}> {
  // 动态 import 避免循环依赖（getDriver 从 store/db re-export，但不在此模块作用域）
  const { getDriver } = await import('./src/store/db.js');
  const driver = getDriver();
  if (!driver) {
    return {
      status: 'unknown',
      nodeCount: 0,
      relationshipCount: 0,
      staleNodeCount: 0,
      details: { reason: 'driver not initialized' },
    };
  }
  const { healthCheck } = await import('./src/graph/maintenance.ts');
  const report = await healthCheck(driver);
  // 根据 anomalies 数量推断 status：
  // - 0 个异常 → healthy
  // - 1-2 个异常 → degraded
  // - >=3 个异常 → unhealthy
  const anomalyCount = report.anomalies.length;
  const status: 'healthy' | 'degraded' | 'unhealthy' =
    anomalyCount === 0 ? 'healthy' : (anomalyCount >= 3 ? 'unhealthy' : 'degraded');
  return {
    status,
    nodeCount: report.nodes.total,
    relationshipCount: report.edges.total,
    staleNodeCount: report.highStaleNodes,
    details: {
      anomalies: report.anomalies,
      isolatedNodes: report.isolatedNodes,
      communities: report.communities,
      avgPageRank: report.avgPageRank,
      nodes: report.nodes,
      edges: report.edges,
      topNodes: report.topNodes,
      timestamp: report.timestamp,
    },
  };
}
export type { GraphHealthReport } from './src/graph/maintenance/health.ts';

// ─── Additional re-exports for lcm-graph-extra (Layer 1 fix) ────
export { personalizedPageRank, computeGlobalPageRank } from "./src/graph/pagerank.js";
export { detectCommunities, summarizeCommunities, getCommunityPeers } from "./src/graph/community.js";
export { getVectorHash, computeEmbeddingHash } from "./src/store/store.js";
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

// ─── v2.1.2 第三批 在线学习 + 可进化嵌入 + 重要性评分 Re-exports ─────────
export { AssociationMatrix, createAssociationMatrix } from "./src/recaller/association-matrix.js";
export type { AssociationMatrixConfig, MarginalUtilityConfig } from "./src/recaller/association-matrix.js";
export { computeImportanceScores } from "./src/graph/maintenance.js";
export type { ImportanceConfig } from "./src/graph/maintenance.js";

// ─── v2.1.2 第四批 结构升级 + 冲突消解 + 嵌入版本 Re-exports ─────────
export { detectHierarchicalCommunities, drillDownCommunity } from "./src/graph/community.js";
export type { HierarchicalCommunityResult } from "./src/graph/community.js";
export { resolveConflicts, adjustEdgeWeights, applyReverseMemory } from "./src/graph/maintenance.js";
export type { ConflictResolutionConfig, EdgeWeightsConfig, ReverseMemoryConfig } from "./src/graph/maintenance.js";
export { detectAndMigrateEmbeddings } from "./src/graph/reembed.js";
export type { MigrationResult } from "./src/graph/reembed.js";

// ─── v2.1.2 第五批 Benchmark + 自主调优 Re-exports ─────────
export { runBenchmark, formatAggregateReport } from "./src/benchmark/runner.ts";
export type { BenchmarkOptions, BenchmarkRunResult } from "./src/benchmark/runner.ts";
export {
  computeP1, computeP3, computeMRR, computeF1, computeP99Latency, computeAvgTokenEstimate,
  evaluateCase, buildReport, formatReport,
} from "./src/benchmark/types.ts";
export type { BenchmarkCase, BenchmarkDataset, BenchmarkReport, CaseResult } from "./src/benchmark/types.ts";
export { loadAllDatasets, loadLoCoMo, loadLongMemEval, getBuiltinSampleDataset } from "./src/benchmark/datasets.ts";
export {
  AutoTuner, extractActionSpace, applyActionSpace, clampAction, ACTION_BOUNDS, DEFAULT_AUTOTUNER_CONFIG,
} from "./src/evolution/auto-tuner.ts";
export type {
  EvolveActionSpace, AutoTunerConfig, TuneCycleResult, DiagnosisResult, ConfigSnapshot,
} from "./src/evolution/auto-tuner.ts";
