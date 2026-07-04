/**
 * graph-memory-pro — Neo4j Knowledge Graph Memory Plugin
 *
 * Version: 2.1.0 (Fixed Edition)
 *
 * BUGFIXES:
 * - CHARS_PER_TOKEN: fixed from literal *** to 4
 * - embed.ts: removed fragile dynamic import("openai"), uses raw fetch
 * - llm.ts: added retry logic (ported from V1)
 * - store.ts: removed APOC dependency, uses native Cypher
 * - crud.ts: no longer exposes passwords in responses
 * - hooks: uses before_prompt_build (modern, not deprecated before_agent_start)
 *
 * Latest OpenClaw Plugin SDK compliance:
 * - definePluginEntry from openclaw/plugin-sdk/plugin-entry
 * - registerTool for agent tools
 * - registerHttpRoute for REST API
 * - before_prompt_build hook for context injection
 * - session_end hook for maintenance
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
import { ensureSchema, getTopNodes, getNodeCount, getEdgeCount, getSessionMessages, searchNodes, getEdgesForNodes } from "./src/store/store.ts";
import { getSession } from "./src/store/db.ts";
import { Extractor } from "./src/extractor/extract.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { assembleContext } from "./src/format/assemble.ts";
import { runMaintenance } from "./src/graph/maintenance.ts";
import { reEmbedNodes } from "./src/graph/reembed.ts";
import { initRoutes, getRoutes } from "./src/routes/crud.ts";
import { sanitizeToolUseResultPairing } from "./src/format/transcript-repair.ts";
import { setTimingEnabled, printAllDistributions, resetAllDistributions } from "./src/timing.ts";

// ─── 全局状态 ──────────────────────────────────────────

let _driver: Driver | null = null;
let _cfg: GmConfig | null = null;
let _llm: CompleteFn | null = null;
let _embed: EmbedFn | null = null;
let _extractor: Extractor | null = null;
let _recaller: Recaller | null = null;

// ─── 辅助函数 ──────────────────────────────────────────

import { EMBEDDING_PRESETS } from "./src/types.ts";

function resolveEmbedDimension(cfg: any): number {
  // 1. User-explicit dimension in config
  if (cfg?.embedding?.dimensions && typeof cfg.embedding.dimensions === 'number') {
    return cfg.embedding.dimensions;
  }
  // 2. Match by model name from presets
  if (cfg?.embedding?.model) {
    const modelKey = Object.keys(EMBEDDING_PRESETS).find(k => cfg.embedding.model.includes(k) || k.includes(cfg.embedding.model));
    if (modelKey && EMBEDDING_PRESETS[modelKey].dimensions) {
      return EMBEDDING_PRESETS[modelKey].dimensions;
    }
  }
  // 3. Fallback 1024
  return 1024;
}

async function getOrCreateDriver(cfg: GmConfig): Promise<Driver | null> {
  try {
    const d = initDriver(cfg.neo4j);
    const ok = await verifyWithRetry(d);
    if (!ok) {
      console.warn("[graph-memory-pro] Neo4j connection failed — plugin disabled");
      closeDriver();
      return null;
    }
    return d;
  } catch (err) {
    console.warn(`[graph-memory-pro] Neo4j init failed: ${err}`);
    return null;
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
  }) as any),
  register(api) {
    // ── Gateway 启动时初始化 ──────────────────────
    api.on("gateway_start", async (event) => {
      // 优先从 event 中获取配置，回退到文件读取
      let pluginConfig: GmConfig | undefined;
      const eventCfg = (event as any)?.config ?? (event as any)?.pluginConfig;
      if (eventCfg?.neo4j?.uri) {
        pluginConfig = eventCfg as GmConfig;
      } else {
        // 回退：从 openclaw.json 读取
        try {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const configPath = join(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw', 'openclaw.json');
          const rawCfg = JSON.parse(readFileSync(configPath, 'utf-8'));
          const entryCfg = rawCfg?.plugins?.entries?.['graph-memory-pro'];
          pluginConfig = (entryCfg?.config ?? entryCfg) as GmConfig | undefined;
        } catch (err) {
          console.warn(`[graph-memory-pro] Failed to read config: ${err}`);
        }
      }
      if (!pluginConfig?.neo4j?.uri) {
        console.warn("[graph-memory-pro] No Neo4j config — plugin skipped");
        return;
      }

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
      const driver = await getOrCreateDriver(_cfg);
      if (!driver) return;
      _driver = driver;

      // 2. 初始化 Schema
      try {
        // 解析 embedding 维度用于向量索引创建
      const embedDimension = resolveEmbedDimension(pluginConfig);
      await ensureSchema(driver, embedDimension);
      } catch (err) {
        console.warn(`[graph-memory-pro] Schema init: ${err}`);
      }

      // 3. 初始化 LLM / Embedding
      _llm = createCompleteFn(_cfg.llm);
      _embed = _cfg.embedding ? createEmbedFn(_cfg.embedding) : null;

      // 4. 初始化 Recaller / Extractor
      _recaller = new Recaller(driver, _cfg);
      if (_embed) _recaller.setEmbedFn(_embed);
      _extractor = new Extractor(driver);

      // Set timing enabled based on config
      if (_cfg.timing?.enabled) {
        setTimingEnabled(true);
      }

      // 5. 初始化 HTTP 路由
      initRoutes(driver, _cfg, _llm ?? undefined, _embed ?? undefined);

      console.log("[graph-memory-pro] initialized");
    });

    // ── Gateway 停止时清理 ──────────────────────
    api.on("gateway_stop", async () => {
      closeDriver();
      _driver = null;
      _cfg = null;
      _llm = null;
      _embed = null;
      _recaller = null;
      _extractor = null;
    });

    // ── Prompt 构建前注入知识图谱上下文 ──────────
    api.on("before_prompt_build", async (event) => {
      if (!_driver || !_cfg) return;

      // event 只有 prompt 和 messages 属性
      const messages = (event.messages ?? []) as Array<{ role: string; content: unknown }>;
      const tokenBudget = 32768;
      const tail = messages.slice(-_cfg.freshTailCount * 2);

      try {
        // ── 动态选择 LLM 进行三元组提取 ──
        // 主会话使用 ollama/ollama-256k 时，优先使用当前会话的模型
        // 否则使用配置的 fallback (qwen3.6:27b)
        let extractLlm: CompleteFn | null = null;

        // 检查是否使用本地 ollama（通过消息内容推断）
        extractLlm = _llm;

        // 提取三元组
        if (extractLlm && _extractor) {
          let extracted = 0;
          for (let i = 0; i < tail.length && extracted < 10; i += 2) {
            const userMsg = tail[i];
            const asstMsg = tail[i + 1];
            if (!userMsg || !asstMsg) continue;
            if (typeof userMsg.content !== "string" || typeof asstMsg.content !== "string") continue;
            try {
              const result = await _extractor.extract(extractLlm, userMsg.content, asstMsg.content);
              if (result.nodes.length > 0) extracted++;
            } catch {}
          }
          if (process.env.GM_DEBUG && extracted > 0) {
            console.log(`  [graph-memory-pro] extracted ${extracted} turns`);
          }
        }

        // 召回知识图谱
        if (_recaller) {
          // 使用最近消息作为查询
          const lastUserMsg = [...tail].reverse().find(m => m.role === "user" && typeof m.content === "string");
          const query = lastUserMsg ? (lastUserMsg.content as string).slice(0, 500) : "";

          if (query) {
            const recallResult = await _recaller.recall(query);

            // 在插入完节点之后同步 embedding
            for (const node of recallResult.nodes) {
              if (_embed) await _recaller.syncEmbed(node).catch(() => {});
            }

            // 组装上下文
            const context = await assembleContext(_driver, {
              tokenBudget,
              activeNodes: recallResult.nodes.filter(n => n.status === "active"),
              activeEdges: recallResult.edges,
              recalledNodes: [],
              recalledEdges: [],
            });

            if (context.xml) {
              // prependSystemContext 必须是 string 类型
              return {
                prependSystemContext: context.systemPrompt + "\n\n" + context.xml,
              };
            }
          }
        }
      } catch (err) {
        if (process.env.GM_DEBUG) {
          console.log(`  [graph-memory-pro] prompt hook error: ${err}`);
        }
      }
    });

    // ── Session 结束时维护 ────────────────────────
    api.on("session_end", async () => {
      if (!_driver || !_cfg) return;
      try {
        await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined);
      } catch (err) {
        if (process.env.GM_DEBUG) {
          console.log(`  [graph-memory-pro] maintenance error: ${err}`);
        }
      }
    });

    // ── 注册 Agent 工具 ───────────────────────────
    // gm_search: 搜索知识图谱
    api.registerTool({
      name: "gm_search",
      label: "Graph Memory Search",
      description: "在 Graph Memory Pro 中搜索知识节点。支持按关键词搜索知识图谱中的技能(SKILL)、任务(TASK)、事件(EVENT)节点",
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词" }),
        limit: Type.Optional(Type.Number({ default: 10, description: "返回结果数量上限" })),
      }),
      async execute(_callId, params) {
        if (!_driver) {
          return { content: [{ type: "text", text: "Graph Memory Pro 未连接" }], details: {} };
        }
        try {
          const p = params as { query: string; limit?: number };
          const q = p.query;
          const limit = Math.min(p.limit || 10, 50);
          const nodes = await searchNodes(_driver, q, limit);
          const ids = nodes.map(n => n.id);
          const edges = await getEdgesForNodes(_driver, ids);
          const text = [
            `找到 ${nodes.length} 个节点，${edges.length} 条关系`,
            ...nodes.map(n => `- [${n.type}] ${n.name}: ${n.description} (得分: ${n.pagerank.toFixed(3)})`),
          ].join("\n");
          return { content: [{ type: "text", text }], details: { nodeCount: nodes.length, edgeCount: edges.length } };
        } catch (err: any) {
          return { content: [{ type: "text", text: `搜索失败: ${err.message}` }], details: {} };
        }
      },
    });

    // gm_record: 手动记录知识
    api.registerTool({
      name: "gm_record",
      label: "Graph Memory Record",
      description: "手动记录一条知识到 Graph Memory Pro 图谱中。当你发现重要的技能、经验或事件时使用",
      parameters: Type.Object({
        type: Type.String({ description: "节点类型: SKILL(技能/方案) / TASK(任务/需求) / EVENT(事件/错误)" }),
        name: Type.String({ description: "节点英文名" }),
        description: Type.String({ description: "描述" }),
        content: Type.String({ description: "详细内容" }),
      }),
      async execute(_callId, params) {
        if (!_driver) {
          return { content: [{ type: "text", text: "Graph Memory Pro 未连接" }], details: {} };
        }
        try {
          const p = params as { type: string; name: string; description: string; content: string };
          const { upsertNode } = await import("./src/store/store.ts");
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

    // gm_stats: 查看图谱统计
    api.registerTool({
      name: "gm_stats",
      label: "Graph Memory Stats",
      description: "查看 Graph Memory Pro 知识图谱的统计信息，包括节点数、关系数等",
      parameters: Type.Object({}),
      async execute() {
        if (!_driver) {
          return { content: [{ type: "text", text: "Graph Memory Pro 未连接" }], details: {} };
        }
        try {
          const [nodeCount, edgeCount] = await Promise.all([
            getNodeCount(_driver),
            getEdgeCount(_driver),
          ]);
          const text = [
            "📊 Graph Memory Pro 统计",
            `节点总数: ${nodeCount}`,
            `关系总数: ${edgeCount}`,
          ].join("\n");
          return { content: [{ type: "text", text }], details: { nodeCount, edgeCount } };
        } catch (err: any) {
          return { content: [{ type: "text", text: `获取统计失败: ${err.message}` }], details: {} };
        }
      },
    });

    // gm_maintain: 手动触发维护
    api.registerTool({
      name: "gm_maintain",
      label: "Graph Memory Maintain",
      description: "手动触发 Graph Memory Pro 图谱维护（去重 + PageRank + 社区检测）",
      parameters: Type.Object({}),
      async execute() {
        if (!_driver || !_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro 未连接" }], details: {} };
        }
        try {
          const result = await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined);
          const text = [
            "✅ 维护完成",
            `去重合并: ${result.dedup.merged} 个`,
            `PageRank: ${result.pagerank.topK.length} 个节点已排序`,
            `社区: ${result.community.count} 个社区`,
            `社区摘要: ${result.communitySummaries} 个`,
            `耗时: ${result.durationMs}ms`,
          ].join("\n");
          return { content: [{ type: "text", text }], details: result };
        } catch (err: any) {
          return { content: [{ type: "text", text: `维护失败: ${err.message}` }], details: {} };
        }
      },
    });

    // gm_reembed: batch re-embed nodes missing embedding vectors
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
