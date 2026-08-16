/**
 * graph-memory-pro — HTTP CRUD 路由
 *
 * 安全修复 (2.1.0):
 * - 不再返回密码等敏感信息
 * - 密码只接受写入，不返回
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig, NodeType, NodeStatus, GmNode } from "../types.ts";
import {
  findById, searchNodes, getTopNodes, getNodesByType,
  getNodeCount, getEdgeCount, getEdgesForNodes,
  getFeedbackCount,
  upsertNode,
  getAllCommunitySummaries, getCommunitySummary,
  graphWalk, nodesByCommunityIds, communityRepresentatives,
  getNodeFeedbackStats,
} from "../store/store.ts";
import { runMaintenance } from "../graph/maintenance.ts";
import {
  runIncrementalMaintenance,
  markDirty, getDirtyNodeIds, clearDirty,
} from "../graph/incremental-maintenance.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn, BatchEmbedFn } from "../engine/embed.ts";
import type { Recaller } from "../recaller/recall.ts";
import { VERSION } from "../version.ts";

let _driver: Driver | null = null;
let _cfg: GmConfig | null = null;
let _llm: CompleteFn | null = null;
let _embed: EmbedFn | null = null;
let _batchEmbed: BatchEmbedFn | null = null;
let _recaller: Recaller | null = null;

// v2.4.1: 异步 rebuild-all 任务存储（内存态）。长任务后台执行、请求立即返回，
// 避免同步长请求触发 Node 5 分钟 requestTimeout 或 openclaw 心跳判定插件不可达。
interface RebuildJob {
  id: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}
const rebuildJobs = new Map<string, RebuildJob>();

export function initRoutes(
  driver: Driver,
  cfg: GmConfig,
  llm?: CompleteFn,
  embed?: EmbedFn,
  recaller?: Recaller,
  batchEmbed?: BatchEmbedFn,
): void {
  _driver = driver;
  _cfg = cfg;
  _llm = llm ?? null;
  _embed = embed ?? null;
  _batchEmbed = batchEmbed ?? null;
  _recaller = recaller ?? null;
}

interface RouteHandler {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (params: any) => Promise<{ status: number; body: unknown }>;
}

export function getRoutes(): RouteHandler[] {
  return [
    { method: "GET", path: "/api/status", handler: handleStatus },
    { method: "GET", path: "/api/stats", handler: handleStats },
    { method: "GET", path: "/api/health", handler: handleHealth },
    { method: "GET", path: "/api/nodes/:id", handler: handleGetNode },
    { method: "POST", path: "/api/nodes", handler: handleCreateNode },
    { method: "PUT", path: "/api/nodes/:id", handler: handleUpdateNode },
    { method: "GET", path: "/api/search", handler: handleSearch },
    { method: "POST", path: "/api/recall", handler: handleRecall },
    { method: "GET", path: "/api/top", handler: handleTop },
    { method: "GET", path: "/api/nodes-by-type/:type", handler: handleNodesByType },
    { method: "GET", path: "/api/communities", handler: handleGetCommunities },
    { method: "GET", path: "/api/communities/:id/summary", handler: handleGetCommunitySummary },
    { method: "POST", path: "/api/maintain", handler: handleMaintain },
    { method: "POST", path: "/api/staleness/refresh", handler: handleRefreshStaleness },
    { method: "POST", path: "/api/maintain/incremental", handler: handleIncrementalMaintain },
    { method: "POST", path: "/api/maintain/mark-dirty", handler: handleMarkDirty },
    { method: "GET", path: "/api/maintain/dirty-nodes", handler: handleGetDirtyNodes },
    { method: "DELETE", path: "/api/maintain/dirty-nodes", handler: handleClearDirty },
    { method: "POST", path: "/api/reembed", handler: handleReembed },
    { method: "POST", path: "/api/feedback", handler: handleFeedback },
    { method: "POST", path: "/api/feedback/bootstrap", handler: handleFeedbackBootstrap },
    { method: "POST", path: "/api/benchmark", handler: handleBenchmark },
    { method: "POST", path: "/api/auto-tuner/tune", handler: handleAutoTunerTune },
    { method: "GET", path: "/api/metrics", handler: handleMetrics },
    { method: "GET", path: "/api/auto-tuner/state", handler: handleAutoTunerState },
    { method: "GET", path: "/api/association-matrix/state", handler: handleAssociationMatrixState },
    { method: "POST", path: "/api/association-matrix/save", handler: handleAssociationMatrixSave },
    { method: "POST", path: "/api/association-matrix/load", handler: handleAssociationMatrixLoad },
    { method: "GET", path: "/api/association-matrix/history", handler: handleAssociationMatrixHistory },
    { method: "GET", path: "/api/association-matrix/visual", handler: handleAssociationMatrixVisual },
    { method: "GET", path: "/api/doctor", handler: handleDoctor },
    { method: "GET", path: "/api/usage", handler: handleUsage },
    { method: "GET", path: "/api/config", handler: handleConfig },
    // ── 可视化接口 ──
    { method: "GET", path: "/api/graph/walk", handler: handleGraphWalk },
    { method: "POST", path: "/api/graph/walk", handler: handleGraphWalkPost },
    { method: "GET", path: "/api/nodes/:id/edges", handler: handleNodeEdges },
    { method: "GET", path: "/api/nodes/:id/feedback-stats", handler: handleNodeFeedbackStats },
    { method: "GET", path: "/api/communities/:id/nodes", handler: handleCommunityNodes },
    { method: "GET", path: "/api/communities/:id/representatives", handler: handleCommunityRepresentatives },
    { method: "GET", path: "/api/schema", handler: handleSchema },
    // ── 运维接口 ──
    { method: "POST", path: "/api/ops/circuit-breakers/reset", handler: handleResetCircuitBreakers },
    { method: "DELETE", path: "/api/ops/cache", handler: handleClearCache },
    { method: "POST", path: "/api/ops/reconnect", handler: handleReconnect },
    { method: "GET", path: "/api/ops/services", handler: handleServiceStatus },
    { method: "POST", path: "/api/extract/rebuild", handler: handleRebuildFromMessages },
    // v2.4.1: 批量重建全部会话（进程内并发 + 断点续传 + llm/heuristic 模式）
    // 异步化：POST 立即返回 202+jobId 后台执行，GET 查询进度，避免长请求超时被断开
    { method: "POST", path: "/api/extract/rebuild-all", handler: handleRebuildAll },
    { method: "GET", path: "/api/extract/rebuild-all/job/:id", handler: handleRebuildAllJob },
  ];
}

async function handleStatus(): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    await _driver.verifyConnectivity();
    return { status: 200, body: { status: "connected", version: VERSION } };
  } catch (err: unknown) {
    return { status: 503, body: { status: "disconnected", error: (err as Error).message } };
  }
}

/**
 * v2.4.1: 根据 Neo4j 中已存储的会话消息（:GmMessage）高性能重建三级节点。
 * POST /api/extract/rebuild
 * body: { sessionKey, concurrency?, pageSize?, writeBatchSize?, progressPath? }
 *   - concurrency:   LLM 并发窗口（默认 4，1–128）
 *   - pageSize:      读取分页大小（默认 2000）
 *   - writeBatchSize:合并写入批上限（默认 500）
 *   - progressPath:  进度文件路径；传入即启用断点续传 + 进度落盘，同路径再次调用续跑
 */
async function handleRebuildFromMessages(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  if (!_llm) return { status: 503, body: { error: "LLM not configured" } };
  const sessionKey = params.sessionKey;
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    return { status: 400, body: { error: "sessionKey is required (string)" } };
  }
  const concurrency = safeParseInt(params.concurrency as string, 4, 128);
  const pageSize = safeParseInt(params.pageSize as string, 2000, 20000);
  const writeBatchSize = safeParseInt(params.writeBatchSize as string, 500, 5000);
  const progressPath = typeof params.progressPath === "string" && params.progressPath.length > 0
    ? params.progressPath
    : undefined;
  // v2.4.1: 提取模式开关。mode=llm（默认，调用 LLM）；mode=heuristic（规则快速提取，不调 LLM，零成本）
  const mode = params.mode === "heuristic" ? "heuristic" : "llm";
  // v2.4.2: 增量重建。markProcessed=true：只处理未标记消息并打标记，新增消息在末尾也能及时处理。
  const markProcessed = params.markProcessed === true || params.markProcessed === "true" || params.markProcessed === 1;
  try {
    const { Extractor } = await import("../extractor/extract.ts");
    const extractor = new Extractor(_driver);
    const { rebuildSessionMessages } = await import("../services/extract-service.ts");
    // v2.4.1: 记录本次 rebuild 期间 LLM 的输出 token 数（判断 LLM 是否有真实输出）
    const llmBefore = await usageCompletionTokens();
    const result = await rebuildSessionMessages(
      extractor,
      _driver,
      _llm,
      _cfg,
      console,
      sessionKey,
      { concurrency, pageSize, writeBatchSize, progressPath, mode, markProcessed },
    );
    const llmOutputTokens = Math.max(0, (await usageCompletionTokens()) - llmBefore);
    return {
      status: 200,
      body: { ...result, mode, llmOutputTokens, llmHasOutput: llmOutputTokens > 0, message: "rebuild completed" },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/**
 * v2.4.1: 读取 extract 用途累计的 LLM 输出 token 数（completionTokens）。
 * 用于在 rebuild 接口返回里展示「本次调用期间 LLM 有没有真实输出」。
 */
async function usageCompletionTokens(): Promise<number> {
  try {
    const { getUsageStats } = await import("../store/usage.ts");
    return getUsageStats().byPurpose.extract?.completionTokens ?? 0;
  } catch {
    return 0;
  }
}

/**
 * v2.4.1: 批量重建全部会话。
 * POST /api/extract/rebuild-all
 * body: { mode?, sessionConcurrency?, concurrency?, limitSessions?, pageSize?, writeBatchSize?, progressPath? }
 *   - mode:              "llm"（默认，调用 LLM）| "heuristic"（规则快速提取，不调 LLM，零成本）
 *   - sessionConcurrency: 同时并发处理的 session 数（默认 2，本地 Ollama 勿过高）
 *   - concurrency:       单个 session 内 LLM 并发窗口（默认 4）
 *   - limitSessions:      最多处理 N 个 session（0=全部，默认 0）
 *   - pageSize:           读取分页大小（默认 2000）
 *   - writeBatchSize:     合并写入批上限（默认 500）
 *   - progressPath:       进度文件路径；传入即启用断点续传，同路径再次调用续跑
 */
async function handleRebuildAll(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const mode = params.mode === "heuristic" ? "heuristic" : "llm";
  // heuristic 模式不依赖 LLM；llm 模式必须配置 LLM
  if (mode === "llm" && !_llm) return { status: 503, body: { error: "LLM not configured (or use mode=heuristic)" } };
  const sessionConcurrency = safeParseInt(params.sessionConcurrency as string, 2, 64);
  const concurrency = safeParseInt(params.concurrency as string, 4, 128);
  const limitSessions = safeParseInt(params.limitSessions as string, 0, 100000);
  const pageSize = safeParseInt(params.pageSize as string, 2000, 20000);
  const writeBatchSize = safeParseInt(params.writeBatchSize as string, 500, 5000);
  const progressPath = typeof params.progressPath === "string" && params.progressPath.length > 0
    ? params.progressPath
    : undefined;
  // v2.4.1: 默认过滤内部记忆子会话，避免遍历数万个无产出的 active-memory 会话卡慢
  const includeMemorySessions = params.includeMemorySessions === true || params.includeMemorySessions === "true";
  // v2.4.2: 增量重建——只处理未标记消息并打标记，新增（末尾）时序消息能及时处理
  const markProcessed = params.markProcessed === true || params.markProcessed === "true" || params.markProcessed === 1;
  // v2.4.1: 自定义排除的 sessionKey 子串（覆盖默认的 active-memory/dreaming-narrative）
  // 支持 JSON 数组或逗号分隔字符串两种传参
  const excludeSessionKeySubstrings = Array.isArray(params.excludeSessionKeySubstrings)
    ? params.excludeSessionKeySubstrings.map(String)
    : typeof params.excludeSessionKeySubstrings === "string" && params.excludeSessionKeySubstrings.length > 0
      ? (params.excludeSessionKeySubstrings as string).split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

  // v2.4.1: 异步化——立即返回 202 + jobId，后台执行，避免同步长请求
  // 触发 Node 5 分钟 requestTimeout / openclaw 心跳判定插件不可达。
  const id = `rebuild-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job: RebuildJob = { id, status: "running", startedAt: Date.now() };
  rebuildJobs.set(id, job);

  void (async () => {
    try {
      const { Extractor } = await import("../extractor/extract.ts");
      const extractor = new Extractor(_driver!);
      const { rebuildAllSessions } = await import("../services/extract-service.ts");
      // v2.4.1: 记录本次 rebuild-all 期间 LLM 的输出 token 数（判断 LLM 是否有真实输出）
      const llmBefore = await usageCompletionTokens();
      const result = await rebuildAllSessions(
        extractor,
        _driver!,
        _llm,
        _cfg,
        console,
        { mode, sessionConcurrency, concurrency, limitSessions, pageSize, writeBatchSize, progressPath, includeMemorySessions, excludeSessionKeySubstrings, markProcessed },
      );
      const llmOutputTokens = Math.max(0, (await usageCompletionTokens()) - llmBefore);
      job.result = { ...result, llmOutputTokens, llmHasOutput: llmOutputTokens > 0 };
      job.status = "done";
      job.finishedAt = Date.now();
    } catch (err: unknown) {
      job.status = "failed";
      job.error = (err as Error).message;
      job.finishedAt = Date.now();
    }
  })();

  return {
    status: 202,
    body: { jobId: id, status: "running", message: "rebuild-all started; poll GET /api/extract/rebuild-all/job/:jobId" },
  };
}

// v2.4.1: 查询异步 rebuild-all 任务进度
async function handleRebuildAllJob(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const id = String(params.id ?? "");
  const job = rebuildJobs.get(id);
  if (!job) return { status: 404, body: { error: "rebuild job not found" } };
  const failed = (job.result as { failedSessions?: number } | undefined)?.failedSessions ?? 0;
  // 进行中/成功 → 200；部分失败 → 207；失败 → 500
  const status = job.status === "failed" ? 500 : failed > 0 ? 207 : 200;
  return {
    status,
    body: {
      jobId: job.id,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      ...(job.result ?? {}),
      ...(job.error ? { error: job.error } : {}),
    },
  };
}

// v2.1.2 G-5: 图谱健康检查
async function handleHealth(): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const { healthCheck } = await import("../graph/maintenance.ts");
    const report = await healthCheck(_driver);
    // v2.3.2 阶段三: 追加连接池指标 + 熔断器状态
    const { getPoolMetrics } = await import("../store/db.ts");
    report.connectionPool = getPoolMetrics();
    const { getAllCircuitBreakers } = await import("../engine/circuit-breaker.ts");
    const breakers = getAllCircuitBreakers();
    const breakerStatus: Record<string, unknown> = {};
    for (const [name, breaker] of breakers) {
      breakerStatus[name] = breaker.getStatus();
    }
    report.circuitBreakers = breakerStatus;
    return { status: 200, body: report };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// v2.1.2 S-14: 手动触发 staleness 重算
async function handleRefreshStaleness(): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const { computeStalenessScores } = await import("../graph/maintenance.ts");
    const result = await computeStalenessScores(_driver, {
      halfLifeDays: 90,
      threshold: _cfg?.staleness?.threshold ?? 0.7,
    });
    return { status: 200, body: result };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

async function handleStats(): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const [nodeCount, edgeCount] = await Promise.all([
      getNodeCount(_driver),
      getEdgeCount(_driver),
    ]);
    return { status: 200, body: { nodeCount, edgeCount } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

async function handleGetNode(params: { id: string }): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const node = await findById(_driver, params.id);
    if (!node) return { status: 404, body: { error: "Node not found" } };
    return { status: 200, body: node };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** 安全解析整数参数 */
function safeParseInt(value: string | undefined, defaultValue: number, max?: number): number {
  const parsed = Number.parseInt(value ?? String(defaultValue), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return max ? Math.min(parsed, max) : parsed;
}

async function handleSearch(params: { query?: string; limit?: string }): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const q = params.query || "";
  const limit = safeParseInt(params.limit, 10, 50);
  if (!q || !q.trim()) return { status: 400, body: { error: "query required" } };
  try {
    const nodes = await searchNodes(_driver, q, limit);
    const ids = nodes.map(n => n.id);
    const edges = await getEdgesForNodes(_driver, ids);
    return { status: 200, body: { nodes, edges } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

async function handleTop(params: { limit?: string }): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const limit = safeParseInt(params.limit, 20, 100);
  try {
    const nodes = await getTopNodes(_driver, limit);
    return { status: 200, body: { nodes } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

async function handleNodesByType(params: { type: string; limit?: string }): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const type = params.type.toUpperCase();
  if (!["TASK", "SKILL", "EVENT"].includes(type)) {
    return { status: 400, body: { error: `Invalid type: ${type}. Must be TASK, SKILL, or EVENT` } };
  }
  const limit = params.limit ? safeParseInt(params.limit, 10, 50) : undefined;
  try {
    const nodes = await getNodesByType(_driver, type, limit);
    return { status: 200, body: { type, nodes } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

async function handleMaintain(): Promise<{ status: number; body: unknown }> {
  if (!_driver || !_cfg) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const result = await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined);
    return { status: 200, body: result };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── v2.2.0 P4-2: 增量维护 HTTP 入口 ───────────────────────────

/**
 * POST /api/maintain/incremental
 *
 * 触发增量维护，仅处理 markDirty 标记的脏节点。
 * Body: { } （无参数）
 */
async function handleIncrementalMaintain(): Promise<{ status: number; body: unknown }> {
  if (!_driver || !_cfg) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const result = await runIncrementalMaintenance(
      _driver, _cfg,
      _llm ?? undefined, _embed ?? undefined,
    );
    return { status: 200, body: result };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/**
 * POST /api/maintain/mark-dirty
 *
 * 标记节点为脏（自上次维护后变更）。
 * Body: { nodeIds: string[] }
 */
async function handleMarkDirty(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const nodeIds: string[] = Array.isArray(params?.nodeIds) ? params.nodeIds as string[] : [];
  if (nodeIds.length === 0) {
    return { status: 400, body: { error: "nodeIds is required and must be non-empty array" } };
  }
  try {
    await markDirty(_driver, nodeIds);
    return { status: 200, body: { marked: nodeIds.length } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/**
 * GET /api/maintain/dirty-nodes
 *
 * 返回当前所有脏节点 ID。
 */
async function handleGetDirtyNodes(): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const nodeIds = await getDirtyNodeIds(_driver);
    return { status: 200, body: { count: nodeIds.length, nodeIds } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/**
 * DELETE /api/maintain/dirty-nodes
 *
 * 清除脏节点标记。
 * Body: { nodeIds?: string[] } （不传则清除全部）
 */
async function handleClearDirty(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const nodeIds: string[] | undefined = Array.isArray(params?.nodeIds) ? params.nodeIds as string[] : undefined;
    await clearDirty(_driver, nodeIds);
    return { status: 200, body: { cleared: nodeIds?.length ?? "all" } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── v2.2.0 P2-2: Prometheus 指标导出 ───────────────────────────
//
// 输出 Prometheus text exposition format，便于 Prometheus / Grafana 直接抓取。
// 指标覆盖：
//   - graph_memory_nodes_total
//   - graph_memory_edges_total
//   - graph_memory_feedback_total
//   - graph_memory_cache_hits_total / cache_misses_total / cache_size
//   - graph_memory_judge_cold_start (0/1)
//   - graph_memory_association_matrix_updates_applied / rejected
//   - graph_memory_up (1=driver ok)
//
// 所有指标均为 gauge（瞬时值），单位在 HELP 注释中标注。
async function handleMetrics(): Promise<{ status: number; body: string }> {
  if (!_driver) {
    return {
      status: 503,
      body: "# Neo4j not connected\ngraph_memory_up 0\n",
    };
  }

  const lines: string[] = [];
  const labels = `plugin="graph-memory-pro",version="${VERSION}"`;

  // 基础计数
  let nodeCount = 0;
  let edgeCount = 0;
  let feedbackCount = 0;
  try {
    [nodeCount, edgeCount] = await Promise.all([
      getNodeCount(_driver),
      getEdgeCount(_driver),
    ]);
  } catch { /* fallthrough with 0 */ }
  try {
    feedbackCount = await getFeedbackCount(_driver);
  } catch { /* fallthrough with 0 */ }

  lines.push("# HELP graph_memory_up Plugin availability (1=ok, 0=down).");
  lines.push("# TYPE graph_memory_up gauge");
  lines.push(`graph_memory_up{${labels}} 1`);

  lines.push("# HELP graph_memory_nodes_total Total nodes in the graph.");
  lines.push("# TYPE graph_memory_nodes_total gauge");
  lines.push(`graph_memory_nodes_total{${labels}} ${nodeCount}`);

  lines.push("# HELP graph_memory_edges_total Total edges in the graph.");
  lines.push("# TYPE graph_memory_edges_total gauge");
  lines.push(`graph_memory_edges_total{${labels}} ${edgeCount}`);

  lines.push("# HELP graph_memory_feedback_total Cumulative feedback records persisted.");
  lines.push("# TYPE graph_memory_feedback_total gauge");
  lines.push(`graph_memory_feedback_total{${labels}} ${feedbackCount}`);

  // 缓存统计（QueryCache）
  const cacheStats = _recaller?.getQueryCache()?.getStats();
  if (cacheStats) {
    lines.push("# HELP graph_memory_cache_size Current query cache entries.");
    lines.push("# TYPE graph_memory_cache_size gauge");
    lines.push(`graph_memory_cache_size{${labels}} ${cacheStats.size}`);

    lines.push("# HELP graph_memory_cache_capacity Query cache capacity.");
    lines.push("# TYPE graph_memory_cache_capacity gauge");
    lines.push(`graph_memory_cache_capacity{${labels}} ${cacheStats.capacity}`);

    // hitRate 是 toFixed(3) 的字符串（如 "0.123"），转回数字
    const hitRateNum = Number(cacheStats.hitRate);
    if (Number.isFinite(hitRateNum)) {
      lines.push("# HELP graph_memory_cache_hit_rate Query cache hit rate [0,1].");
      lines.push("# TYPE graph_memory_cache_hit_rate gauge");
      lines.push(`graph_memory_cache_hit_rate{${labels}} ${hitRateNum}`);

      lines.push("# HELP graph_memory_cache_hits_total Total query cache hits.");
      lines.push("# TYPE graph_memory_cache_hits_total gauge");
      lines.push(`graph_memory_cache_hits_total{${labels}} ${cacheStats.hits ?? 0}`);

      lines.push("# HELP graph_memory_cache_misses_total Total query cache misses.");
      lines.push("# TYPE graph_memory_cache_misses_total gauge");
      lines.push(`graph_memory_cache_misses_total{${labels}} ${cacheStats.misses ?? 0}`);

      lines.push("# HELP graph_memory_cache_similarity_hits Total similarity cache hits.");
      lines.push("# TYPE graph_memory_cache_similarity_hits gauge");
      lines.push(`graph_memory_cache_similarity_hits{${labels}} ${cacheStats.similarityHits ?? 0}`);
    }
  }

  // 反馈系统（JudgeManager）
  const jm = _recaller?.getJudgeManager();
  if (jm) {
    lines.push("# HELP graph_memory_judge_cold_start Judge in cold-start phase (1=yes, 0=no).");
    lines.push("# TYPE graph_memory_judge_cold_start gauge");
    lines.push(`graph_memory_judge_cold_start{${labels}} ${jm.isColdStart() ? 1 : 0}`);

    lines.push("# HELP graph_memory_judge_feedback_count Cumulative judged feedback.");
    lines.push("# TYPE graph_memory_judge_feedback_count gauge");
    lines.push(`graph_memory_judge_feedback_count{${labels}} ${jm.getFeedbackCount()}`);
  }

  // 关联矩阵 M（AssociationMatrix）
  const amStats = _recaller?.getAssociationMatrix()?.getStats();
  if (amStats) {
    lines.push("# HELP graph_memory_association_matrix_t M matrix time step t.");
    lines.push("# TYPE graph_memory_association_matrix_t gauge");
    lines.push(`graph_memory_association_matrix_t{${labels}} ${amStats.t}`);

    lines.push("# HELP graph_memory_association_matrix_dim M matrix dimension.");
    lines.push("# TYPE graph_memory_association_matrix_dim gauge");
    lines.push(`graph_memory_association_matrix_dim{${labels}} ${amStats.dim}`);

    lines.push("# HELP graph_memory_association_matrix_updates_applied Total accepted M updates.");
    lines.push("# TYPE graph_memory_association_matrix_updates_applied gauge");
    lines.push(`graph_memory_association_matrix_updates_applied{${labels}} ${amStats.updatesApplied}`);

    lines.push("# HELP graph_memory_association_matrix_updates_rejected Total rejected M updates (R-3 marginal utility).");
    lines.push("# TYPE graph_memory_association_matrix_updates_rejected gauge");
    lines.push(`graph_memory_association_matrix_updates_rejected{${labels}} ${amStats.updatesRejected}`);

    lines.push("# HELP graph_memory_association_matrix_history_size M training history samples.");
  lines.push("# TYPE graph_memory_association_matrix_history_size gauge");
  lines.push(`graph_memory_association_matrix_history_size{${labels}} ${amStats.historySize}`);

    // v2.4.0 P2-9: M 更新被 R-3 边际效用拒绝的比例
    const amDenom = amStats.updatesApplied + amStats.updatesRejected;
    lines.push("# HELP graph_memory_association_matrix_updates_rejected_ratio Fraction of M updates rejected by R-3 marginal utility [0,1].");
    lines.push("# TYPE graph_memory_association_matrix_updates_rejected_ratio gauge");
    lines.push(`graph_memory_association_matrix_updates_rejected_ratio{${labels}} ${amDenom ? amStats.updatesRejected / amDenom : 0}`);
  }

  // v2.3.0: LLM token 用量（进程累计）
  try {
    const { getUsageStats } = await import("../store/usage.ts");
    const usage = getUsageStats();
    lines.push("# HELP graph_memory_llm_calls_total Total LLM calls since process start.");
    lines.push("# TYPE graph_memory_llm_calls_total gauge");
    lines.push(`graph_memory_llm_calls_total{${labels}} ${usage.total.calls}`);

    lines.push("# HELP graph_memory_llm_tokens_total Total LLM tokens consumed (prompt + completion).");
    lines.push("# TYPE graph_memory_llm_tokens_total gauge");
    lines.push(`graph_memory_llm_tokens_total{${labels}} ${usage.total.totalTokens}`);

    lines.push("# HELP graph_memory_llm_prompt_tokens_total Total LLM prompt tokens.");
    lines.push("# TYPE graph_memory_llm_prompt_tokens_total gauge");
    lines.push(`graph_memory_llm_prompt_tokens_total{${labels}} ${usage.total.promptTokens}`);

    lines.push("# HELP graph_memory_llm_completion_tokens_total Total LLM completion tokens.");
    lines.push("# TYPE graph_memory_llm_completion_tokens_total gauge");
    lines.push(`graph_memory_llm_completion_tokens_total{${labels}} ${usage.total.completionTokens}`);
  } catch { /* usage 查询失败不影响 metrics 输出 */ }

  // v2.3.2 阶段三: 连接池指标
  try {
    const { getPoolMetrics } = await import("../store/db.ts");
    const pool = getPoolMetrics();
    lines.push("# HELP graph_memory_neo4j_pool_active_sessions Active Neo4j sessions (application layer).");
    lines.push("# TYPE graph_memory_neo4j_pool_active_sessions gauge");
    lines.push(`graph_memory_neo4j_pool_active_sessions{${labels}} ${pool.appActiveSessions}`);

    lines.push("# HELP graph_memory_neo4j_pool_total_sessions Total Neo4j sessions created (counter).");
    lines.push("# TYPE graph_memory_neo4j_pool_total_sessions counter");
    lines.push(`graph_memory_neo4j_pool_total_sessions{${labels}} ${pool.appTotalSessionsCreated}`);

    lines.push("# HELP graph_memory_neo4j_pool_max_size Max connection pool size.");
    lines.push("# TYPE graph_memory_neo4j_pool_max_size gauge");
    lines.push(`graph_memory_neo4j_pool_max_size{${labels}} ${pool.maxPoolSize}`);

    lines.push("# HELP graph_memory_neo4j_pool_driver_active Active connections reported by driver (reflection).");
    lines.push("# TYPE graph_memory_neo4j_pool_driver_active gauge");
    lines.push(`graph_memory_neo4j_pool_driver_active{${labels}} ${pool.driverActiveConnections ?? -1}`);
  } catch { /* pool 指标获取失败不影响 metrics 输出 */ }

  // v2.3.2 阶段三: 熔断器指标
  try {
    const { getAllCircuitBreakers } = await import("../engine/circuit-breaker.ts");
    const breakers = getAllCircuitBreakers();
    lines.push("# HELP graph_memory_circuit_breaker_state Circuit breaker state (0=closed, 1=open, 2=half_open).");
    lines.push("# TYPE graph_memory_circuit_breaker_state gauge");
    for (const [name, breaker] of breakers) {
      const stateNum = breaker.getState() === "closed" ? 0 : (breaker.getState() === "open" ? 1 : 2);
      lines.push(`graph_memory_circuit_breaker_state{${labels},target="${name}"} ${stateNum}`);
    }
    lines.push("# HELP graph_memory_circuit_breaker_failures_total Circuit breaker failure count.");
    lines.push("# TYPE graph_memory_circuit_breaker_failures_total counter");
    for (const [name, breaker] of breakers) {
      const status = breaker.getStatus();
      lines.push(`graph_memory_circuit_breaker_failures_total{${labels},target="${name}"} ${status.failureCount}`);
    }
    // v2.4.0 P2-9: 熔断器成功率（LLM/Embedding 等下游调用成功率，按 target 区分）
    lines.push("# HELP graph_memory_circuit_breaker_success_rate Circuit breaker success rate [0,1].");
    lines.push("# TYPE graph_memory_circuit_breaker_success_rate gauge");
    for (const [name, breaker] of breakers) {
      const status = breaker.getStatus();
      const total = status.successCount + status.failureCount;
      lines.push(`graph_memory_circuit_breaker_success_rate{${labels},target="${name}"} ${total ? status.successCount / total : 1}`);
    }
  } catch { /* breaker 指标获取失败不影响 metrics 输出 */ }

  // v2.4.0 P2-9: embed LRU 缓存命中率（LRU + QueryCache 一并覆盖，
  // QueryCache 命中率已在上面 cacheStats 段输出）
  try {
    const { getEmbedCacheStats } = await import("../engine/embed.ts");
    const embCache = getEmbedCacheStats();
    if (embCache.length) {
      lines.push("# HELP graph_memory_embed_cache_hits_total Embedding LRU cache hits (process cumulative).");
      lines.push("# TYPE graph_memory_embed_cache_hits_total counter");
      lines.push(`graph_memory_embed_cache_hits_total{${labels}} ${embCache.reduce((s, c) => s + c.hits, 0)}`);

      lines.push("# HELP graph_memory_embed_cache_misses_total Embedding LRU cache misses (process cumulative).");
      lines.push("# TYPE graph_memory_embed_cache_misses_total counter");
      lines.push(`graph_memory_embed_cache_misses_total{${labels}} ${embCache.reduce((s, c) => s + c.misses, 0)}`);

      lines.push("# HELP graph_memory_embed_cache_hit_rate Embedding LRU cache hit rate [0,1].");
      lines.push("# TYPE graph_memory_embed_cache_hit_rate gauge");
      for (const c of embCache) {
        lines.push(`graph_memory_embed_cache_hit_rate{${labels},target="${c.cacheKey}"} ${c.hitRate}`);
      }
    }
  } catch { /* embed cache 统计失败不影响 metrics 输出 */ }

  // v2.4.0 P2-9: 各阶段召回延迟分位数（P50/P95/P99）
  try {
    const { getAllLatencyMetrics } = await import("../timing.ts");
    const lat = getAllLatencyMetrics();
    if (lat.size) {
      lines.push("# HELP graph_memory_recall_latency_ms Recall latency percentiles per phase.");
      lines.push("# TYPE graph_memory_recall_latency_ms gauge");
      for (const [phase, m] of lat) {
        lines.push(`graph_memory_recall_latency_ms{${labels},phase="${phase}",quantile="0.5"} ${m.p50 ?? 0}`);
        lines.push(`graph_memory_recall_latency_ms{${labels},phase="${phase}",quantile="0.95"} ${m.p95 ?? 0}`);
        lines.push(`graph_memory_recall_latency_ms{${labels},phase="${phase}",quantile="0.99"} ${m.p99 ?? 0}`);
      }
    }
  } catch { /* latency 指标获取失败不影响 metrics 输出 */ }

  return { status: 200, body: lines.join("\n") + "\n" };
}

// ── v2.2.0 P2-3: AutoTuner 状态查询 ───────────────────────────
//
// 返回持久化的 AutoTuner 状态（snapshots / currentAction / tuneRound）。
// 数据来源：~/.openclaw/graph-memory-pro/auto-tuner-state.json
//
// v2.3.5: 明确区分三种状态：
//   - enabled=false: 配置未启用 autoTuner
//   - enabled=true + no state file: 已启用但尚未运行过调优（需手动触发 gm_tune）
//   - enabled=true + state file: 已启用且已运行过调优
// AutoTuner 是按需触发的（通过 gm_tune 工具或 POST /api/auto-tuner/tune），
// 不是后台常驻服务，因此 "enabled=true 但无 state" 是正常的初始状态。
async function handleAutoTunerState(): Promise<{ status: number; body: unknown }> {
  try {
    const enabled = _cfg?.autoTuner?.enabled === true;
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const statePath = join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".openclaw", "graph-memory-pro", "auto-tuner-state.json",
    );
    let raw = "";
    let hasState = false;
    try {
      raw = await readFile(statePath, "utf-8");
      hasState = !!(raw && raw.trim());
    } catch {
      hasState = false;
    }

    if (!hasState) {
      return {
        status: 200,
        body: {
          enabled,
          available: false,
          // v2.3.5: 根据配置状态给出更准确的说明
          reason: enabled
            ? "autoTuner enabled but no tuning has been run yet. Trigger via gm_tune tool or POST /api/auto-tuner/tune (on-demand, not a background service)."
            : "autoTuner disabled. Set autoTuner.enabled=true in config to enable.",
          config: _cfg?.autoTuner ?? null,
          // v2.3.5: 补充触发方式说明，便于 dashboard 引导用户
          triggerHint: enabled
            ? "Call gm_tune tool or POST /api/auto-tuner/tune to run a tune cycle."
            : null,
        },
      };
    }
    const parsed = JSON.parse(raw);
    return {
      status: 200,
      body: {
        enabled,
        available: true,
        config: _cfg?.autoTuner ?? null,
        state: parsed,
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── v2.2.0 P2-4: 关联矩阵 M 状态查询 ───────────────────────────
//
// 返回内存中的 AssociationMatrix 统计信息（dim / t / applied / rejected / history）。
//
// v2.3.5: 补充冷启动状态和数据来源说明，避免 "已启用但无数据" 被误判为异常。
// 关联矩阵 M 初始化为单位矩阵（M=I，transform 直接返回原 vec），需要满足：
//   1. 累计反馈数 >= warmupFeedbacks（默认 40）才退出冷启动期
//   2. 在召回过程中通过 gm_feedback / POST /api/feedback 提供反馈信号
//   3. updateWithMarginalUtility() 根据反馈信号更新 M
// 因此 "updatesApplied=0, historySize=0" 是启用初期的正常状态。
async function handleAssociationMatrixState(): Promise<{ status: number; body: unknown }> {
  const enabled = _cfg?.associationMatrix?.enabled === true;
  const am = _recaller?.getAssociationMatrix();
  if (!am) {
    return {
      status: 200,
      body: {
        enabled,
        available: false,
        reason: enabled
          ? "associationMatrix.enabled=true but matrix not injected into Recaller. Possible causes: self-init path didn't complete, or gateway_start re-injection failed."
          : "association matrix disabled. Set associationMatrix.enabled=true in config.",
        config: _cfg?.associationMatrix ?? null,
      },
    };
  }
  try {
    const stats = am.getStats();
    const warmupFeedbacks = _cfg?.associationMatrix?.warmupFeedbacks ?? _cfg?.warmup?.warmupFeedbacks ?? 40;
    const judgeManager = _recaller?.getJudgeManager();
    const feedbackCount = judgeManager?.getFeedbackCount?.() ?? 0;
    const isColdStart = stats.t === 0 && feedbackCount < warmupFeedbacks;
    // v2.3.6: 返回持久化文件路径（供 lcm-graph-extra 等外部调用方定位）
    const { getAssociationMatrixPath } = await import("../recaller/association-matrix-persist.ts");
    const persistPath = getAssociationMatrixPath();

    return {
      status: 200,
      body: {
        enabled: true,
        available: true,
        config: _cfg?.associationMatrix ?? null,
        stats,
        // v2.3.5: 补充冷启动 + 数据来源说明
        coldStart: isColdStart,
        feedbackCount,
        warmupFeedbacks,
        // v2.3.6: M 持久化相关信息
        persist: { path: persistPath, persisted: await (async () => {
          try {
            const stat = await import("node:fs/promises").then(m => m.stat(persistPath));
            return { exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
          } catch { return { exists: false }; }
        })() },
        hint: isColdStart
          ? `Cold start period: need ${warmupFeedbacks} feedbacks to exit (current=${feedbackCount}). M is identity matrix until then. Provide feedback via gm_feedback / POST /api/feedback.`
          : (stats.updatesApplied === 0
            ? "Warmup passed but no M updates applied yet. Updates happen during recall when feedback signals are provided."
            : "Active learning in progress."),
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── v2.3.6: 关联矩阵 M 持久化（手动保存 / 加载）──────────────
//
// 供运维与 lcm-graph-extra 对接：显式触发 M 落盘/恢复，路径可覆盖。
async function handleAssociationMatrixSave(params: { path?: string }): Promise<{ status: number; body: unknown }> {
  const am = _recaller?.getAssociationMatrix();
  if (!am) {
    return { status: 200, body: { ok: false, reason: "association matrix not injected into Recaller" } };
  }
  try {
    const { saveAssociationMatrix } = await import("../recaller/association-matrix-persist.ts");
    const saved = await saveAssociationMatrix(am, { path: params?.path });
    if (!saved) return { status: 200, body: { ok: false, reason: "association matrix disabled" } };
    return { status: 200, body: { ok: true, ...saved } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

async function handleAssociationMatrixLoad(params: { path?: string }): Promise<{ status: number; body: unknown }> {
  const am = _recaller?.getAssociationMatrix();
  if (!am) {
    return { status: 200, body: { ok: false, reason: "association matrix not injected into Recaller" } };
  }
  try {
    const { loadAssociationMatrix } = await import("../recaller/association-matrix-persist.ts");
    const loaded = await loadAssociationMatrix(am, { path: params?.path });
    return { status: 200, body: { ok: loaded, stats: am.getStats() } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── AM-5: 关联矩阵 M 学习曲线（跨重启持久化）────────────────
//
// 返回内存环形缓冲中的学习采样（timestamp / t / updatesApplied / updatesRejected / feedbackCount），
// 采样随 M 一起 serialize 落盘，因此重启后历史仍可追溯。
// 参数：?n={n} 返回最近 n 条（默认全部，上限 200）。
async function handleAssociationMatrixHistory(params: { n?: string }): Promise<{ status: number; body: unknown }> {
  const am = _recaller?.getAssociationMatrix();
  if (!am) return { status: 200, body: { available: false } };
  try {
    const n = params?.n ? safeParseInt(params.n, 200, 200) : undefined;
    const samples = am.getLearningHistory(n);
    return {
      status: 200,
      body: {
        available: true,
        count: samples.length,
        samples,
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── AM-6: 关联矩阵 M 可视化（降采样热力网格）────────────────
//
// 返回降采样后的矩阵网格 + 学习集中度标量（diagDeviation / rowEnergy / frobenius / identityRatio）。
// 参数：?max={grid} 目标网格尺寸（默认 64，最大 128）。降采样避免传输 1024×1024 全量矩阵。
async function handleAssociationMatrixVisual(params: { max?: string }): Promise<{ status: number; body: unknown }> {
  const am = _recaller?.getAssociationMatrix();
  if (!am) return { status: 200, body: { available: false } };
  try {
    const maxGrid = safeParseInt(params?.max, 64, 128);
    const visual = am.computeVisual(maxGrid);
    return { status: 200, body: { available: true, ...visual } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── v2.3.0: 配置自检（gm_doctor）───────────────────────────
//
// 一次性验证 Neo4j / LLM / Embedding 三大依赖的连通性 + 配置完整性。
// 返回各项的 ok/warn/error 状态 + 诊断提示，便于用户排查配置问题。
// 设计参考 MySQL "SHOW STATUS" + 健康检查端点的组合。
async function handleDoctor(): Promise<{ status: number; body: unknown }> {
  const checks: Array<{
    name: string;
    status: "ok" | "warn" | "error";
    latencyMs?: number;
    detail?: string;
    hint?: string;
  }> = [];

  // 1. Neo4j 连通性
  const neo4jStart = Date.now();
  if (!_driver) {
    checks.push({
      name: "neo4j",
      status: "error",
      detail: "driver not initialized",
      hint: "Check neo4j.uri/user/password in config",
    });
  } else {
    try {
      await _driver.verifyConnectivity();
      checks.push({
        name: "neo4j",
        status: "ok",
        latencyMs: Date.now() - neo4jStart,
      });
    } catch (err: unknown) {
      checks.push({
        name: "neo4j",
        status: "error",
        latencyMs: Date.now() - neo4jStart,
        detail: (err as Error).message,
        hint: `Check neo4j.uri (current: ${_cfg?.neo4j?.uri ?? "unset"})`,
      });
    }
  }

  // 2. 图谱基础计数（验证 schema 已初始化）
  if (_driver) {
    try {
      const [nodeCount, edgeCount] = await Promise.all([
        getNodeCount(_driver),
        getEdgeCount(_driver),
      ]);
      checks.push({
        name: "graph_schema",
        status: "ok",
        detail: `nodes=${nodeCount}, edges=${edgeCount}`,
      });
    } catch (err: unknown) {
      checks.push({
        name: "graph_schema",
        status: "error",
        detail: (err as Error).message,
        hint: "Schema may not be initialized; call ensureSchema(driver, dim) on startup",
      });
    }
  }

  // 3. LLM 连通性（仅探测配置是否就绪，不发起真实调用避免消耗 token）
  const llmConfig = _cfg?.llm;
  if (!llmConfig?.model && !llmConfig?.baseURL) {
    // 未配置 llm 时不报错，只标记 warn（可能依赖 api.runtime.llm 主会话）
    checks.push({
      name: "llm",
      status: "warn",
      detail: "no llm config (will use api.runtime.llm if available)",
      hint: "Set llm.model + llm.baseURL, or rely on OpenClaw primary session",
    });
  } else if (!_llm) {
    checks.push({
      name: "llm",
      status: "error",
      detail: "llm config present but CompleteFn not initialized",
      hint: "Check llm.baseURL format (Ollama: http://localhost:11434/v1, OpenAI: https://api.openai.com/v1)",
    });
  } else {
    checks.push({
      name: "llm",
      status: "ok",
      detail: `model=${llmConfig?.model ?? "default"}, baseURL=${llmConfig?.baseURL ?? "default"}`,
    });
  }

  // 4. Embedding 连通性（发起一次最小调用，验证模型可用 + 维度匹配）
  const embedConfig = _cfg?.embedding;
  if (!embedConfig?.baseURL) {
    checks.push({
      name: "embedding",
      status: "warn",
      detail: "no embedding config",
      hint: "Set embedding.baseURL + embedding.model for vector search",
    });
  } else if (!_embed) {
    checks.push({
      name: "embedding",
      status: "error",
      detail: "embedding config present but EmbedFn not initialized",
      hint: "Check embedding.baseURL (Ollama native API, no /v1 suffix)",
    });
  } else {
    const embedStart = Date.now();
    try {
      const vec = await _embed("gm_doctor probe");
      const expectedDim = embedConfig.dimensions;
      if (expectedDim && vec.length !== expectedDim) {
        checks.push({
          name: "embedding",
          status: "error",
          latencyMs: Date.now() - embedStart,
          detail: `dimension mismatch: expected ${expectedDim}, got ${vec.length}`,
          hint: `Model "${embedConfig.model}" returns ${vec.length}-dim, but config.dimensions=${expectedDim}. Update one of them.`,
        });
      } else {
        checks.push({
          name: "embedding",
          status: "ok",
          latencyMs: Date.now() - embedStart,
          detail: `model=${embedConfig.model}, dim=${vec.length}${expectedDim ? ` (expected=${expectedDim})` : ""}`,
        });
      }
    } catch (err: unknown) {
      checks.push({
        name: "embedding",
        status: "error",
        latencyMs: Date.now() - embedStart,
        detail: (err as Error).message,
        hint: `Check embedding.model (must be embed model, not LLM model like qwen3.5:9b). Current: ${embedConfig.model ?? "unset"}`,
      });
    }
  }

  // 5. 反馈系统状态（JudgeManager 冷启动）
  // v2.3.5: 若 judge 已启用但 _recaller 未初始化，明确报 error 而非静默跳过
  const judgeEnabled = _cfg?.judge?.enabled !== false;
  const jm = _recaller?.getJudgeManager();
  if (!jm) {
    if (judgeEnabled) {
      checks.push({
        name: "judge",
        status: "error",
        detail: "judge.enabled but JudgeManager not initialized (Recaller missing or not injected)",
        hint: "Check gateway_start re-injection logs; ensure initRoutes() was called with recaller.",
      });
    }
  } else {
    const coldStart = jm.isColdStart();
    const feedbackCount = jm.getFeedbackCount();
    checks.push({
      name: "judge",
      status: coldStart ? "warn" : "ok",
      detail: `feedbackCount=${feedbackCount}, coldStart=${coldStart}`,
      hint: coldStart ? `Need ${_cfg?.judge?.judgeWarmupFeedbacks ?? 50} feedbacks to exit cold start` : undefined,
    });
  }

  // v2.3.5: 6. Recaller 整体状态（doctor 之前不检查，导致 recaller 未初始化时无任何提示）
  if (_recaller) {
    checks.push({ name: "recaller", status: "ok", detail: "Recaller initialized" });
  } else {
    checks.push({
      name: "recaller",
      status: "error",
      detail: "Recaller not initialized",
      hint: "Check gateway_start hook or self-init path; ensure Recaller construction succeeded.",
    });
  }

  // v2.3.5: 7. AssociationMatrix 状态
  if (_cfg?.associationMatrix?.enabled === true) {
    const am = _recaller?.getAssociationMatrix();
    if (!am) {
      checks.push({
        name: "association_matrix",
        status: "error",
        detail: "associationMatrix.enabled=true but matrix not injected into Recaller",
        hint: "Check Recaller.setAssociationMatrix() call in gateway_start / startApiServerFromDriver.",
      });
    } else {
      const stats = am.getStats();
      const warmupFb = _cfg.associationMatrix.warmupFeedbacks ?? _cfg.warmup?.warmupFeedbacks ?? 40;
      const feedbackCount = jm?.getFeedbackCount() ?? 0;
      const isColdStart = feedbackCount < warmupFb;
      // v2.3.6: 检查 M 持久化文件是否存在
      const { getAssociationMatrixPath } = await import("../recaller/association-matrix-persist.ts");
      const persistPath = getAssociationMatrixPath();
      let persistExists = false;
      try {
        const { stat } = await import("node:fs/promises");
        persistExists = (await stat(persistPath)).isFile();
      } catch { /* 首次运行无文件 */ }
      checks.push({
        name: "association_matrix",
        status: isColdStart ? "warn" : "ok",
        detail: `dim=${stats.dim}, t=${stats.t}, updatesApplied=${stats.updatesApplied}, updatesRejected=${stats.updatesRejected}, historySize=${stats.historySize}, feedbackCount=${feedbackCount}/${warmupFb}, persisted=${persistExists} (${persistPath})`,
        hint: isColdStart
          ? `Cold start: need ${warmupFb} feedbacks (current=${feedbackCount}). M=identity until warmup.`
          : undefined,
      });
    }
  } else {
    checks.push({
      name: "association_matrix",
      status: "warn",
      detail: "associationMatrix disabled (set associationMatrix.enabled=true to enable)",
    });
  }

  // v2.3.5: 8. AutoTuner 配置状态（仅报告配置，不触发实际调优）
  if (_cfg?.autoTuner?.enabled === true) {
    checks.push({
      name: "auto_tuner",
      status: "ok",
      detail: `enabled, maxRounds=${_cfg.autoTuner.maxRounds ?? 10}, llmDiagnosis=${_cfg.autoTuner.llmDiagnosis ?? true} (on-demand: trigger via gm_tune)`,
    });
  } else {
    checks.push({
      name: "auto_tuner",
      status: "warn",
      detail: "autoTuner disabled (set autoTuner.enabled=true to enable on-demand tuning)",
    });
  }

  // v2.3.5: 9. AutoFeedback 自动反馈采集状态
  const autoFeedbackEnabled = _cfg?.autoFeedback?.enabled !== false;
  checks.push({
    name: "auto_feedback",
    status: autoFeedbackEnabled ? "ok" : "warn",
    detail: autoFeedbackEnabled
      ? "enabled (agent_end hook auto-collects feedback; no manual gm_feedback needed)"
      : "disabled (set autoFeedback.enabled=true, default true). Manual gm_feedback required.",
  });

  // 汇总
  const errorCount = checks.filter(c => c.status === "error").length;
  const warnCount = checks.filter(c => c.status === "warn").length;
  const overallStatus = errorCount > 0 ? "error" : warnCount > 0 ? "warn" : "ok";

  return {
    status: errorCount > 0 ? 503 : 200,
    body: {
      status: overallStatus,
      version: VERSION,
      timestamp: new Date().toISOString(),
      summary: {
        ok: checks.filter(c => c.status === "ok").length,
        warn: warnCount,
        error: errorCount,
        total: checks.length,
      },
      checks,
    },
  };
}

// ── v2.3.0: LLM token 用量查询 ───────────────────────────
//
// 返回进程级累计的 LLM token 用量，供成本监控。
// 数据来源：src/store/usage.ts（内存累计，重启清零）
//
// v2.3.5: 补充说明字段，避免 "全为 0" 被误判为异常。
// usage 为 0 的常见原因：
//   1. 进程刚启动，尚未触发任何 LLM 调用（extractor/recall/judge/maintain）
//   2. LLM 调用走了 api.runtime.llm 主会话路径，但主会话 provider 不返回 usage 字段
//   3. 配置的 llm.baseURL 指向的 provider 不返回 usage 字段（部分 Ollama 版本）
//
// v2.3.5 B3: byPurpose 维度现按真实用途分组（extract/judge/community/diagnose/...），
// 旧版（≤2.3.4）一律记为 "unknown"。仅 /api/usage 端点 200 返回，不返回 404。
async function handleUsage(): Promise<{ status: number; body: unknown }> {
  try {
    const { getUsageStats } = await import("../store/usage.ts");
    const stats = getUsageStats();
    const hasData = stats.total.calls > 0;
    // v2.4.1: 汇总 LLM 输出情况，便于直接判断「LLM 是否有输出」。
    // hasOutput = 累计 completionTokens > 0（LLM 确实吐出了文字）。
    // 注意：llm.ts 中 content 为空会先抛错不走 recordUsage，故 completionTokens>0 即证明有实质输出。
    const purposeSummary = Object.fromEntries(
      Object.entries(stats.byPurpose)
        .filter(([k]) => k !== "all")
        .map(([k, v]) => [k, { calls: v.calls, completionTokens: v.completionTokens, promptTokens: v.promptTokens }]),
    );
    const llm = {
      hasOutput: (stats.total.completionTokens ?? 0) > 0,
      calls: stats.total.calls,
      completionTokens: stats.total.completionTokens,
      promptTokens: stats.total.promptTokens,
      byPurpose: purposeSummary,
    };
    return {
      status: 200,
      body: {
        version: VERSION,
        timestamp: new Date().toISOString(),
        ...stats,
        llm,
        // v2.3.5: 说明字段，便于 dashboard 展示
        hint: hasData
          ? undefined
          : "No LLM calls recorded yet. Usage is in-memory and resets on restart. Calls are recorded when extractor/recall/judge/maintain services invoke LLM. If LLM is configured but returns no usage field, token counts may stay 0.",
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── 节点 CRUD ───────────────────────────────────────────────

/** POST /api/nodes — 创建/更新节点 */
async function handleCreateNode(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const { type, name, description, content } = params ?? {};
  if (!type || !name) {
    return { status: 400, body: { error: "type and name are required" } };
  }
  const nodeType = String(type).toUpperCase();
  if (!["TASK", "SKILL", "EVENT"].includes(nodeType)) {
    return { status: 400, body: { error: `Invalid type: ${type}. Must be TASK, SKILL, or EVENT` } };
  }
  try {
    const now = Date.now();
    const id = (params.id ?? `api-${now}-${Math.random().toString(36).slice(2, 8)}`) as string;
    await upsertNode(_driver, {
      id,
      type: nodeType as NodeType,
      name: String(name),
      description: String(description ?? ""),
      content: String(content ?? ""),
      status: "active",
      communityId: undefined,
      pagerank: 0,
      validatedCount: 0,
      createdAt: now,
      updatedAt: now,
      embeddingModel: _cfg?.embedding?.model,
    });
    return { status: 201, body: { id, message: "node created" } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** PUT /api/nodes/:id — 更新节点 */
async function handleUpdateNode(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const { id } = params ?? {};
  if (!id) return { status: 400, body: { error: "id is required" } };
  try {
    const existing = await findById(_driver, id as string);
    if (!existing) return { status: 404, body: { error: "Node not found" } };
    const now = Date.now();
    await upsertNode(_driver, {
      ...existing,
      name: (params.name as string | undefined) ?? existing.name,
      description: (params.description as string | undefined) ?? existing.description,
      content: (params.content as string | undefined) ?? existing.content,
      status: (params.status as NodeStatus | undefined) ?? existing.status,
      updatedAt: now,
      embeddingModel: _cfg?.embedding?.model,
    });
    return { status: 200, body: { id, message: "node updated" } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── Recall 查询 ─────────────────────────────────────────────

/** POST /api/recall — 图谱召回查询 */
async function handleRecall(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const query = params?.query;
  if (!query || !String(query).trim()) {
    return { status: 400, body: { error: "query is required" } };
  }
  if (!_recaller) {
    return { status: 503, body: { error: "Recaller not initialized" } };
  }
  try {
    const result = await _recaller.recall(String(query));
    return { status: 200, body: result };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── 社区查询 ────────────────────────────────────────────────

/** GET /api/communities — 所有社区摘要列表 */
async function handleGetCommunities(): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const summaries = await getAllCommunitySummaries(_driver);
    const list = Array.from(summaries.values());
    return { status: 200, body: { count: list.length, summaries: list } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** GET /api/communities/:id/summary — 指定社区摘要 */
async function handleGetCommunitySummary(params: { id: string }): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const summary = await getCommunitySummary(_driver, params.id);
    if (!summary) return { status: 404, body: { error: "Community not found" } };
    return { status: 200, body: summary };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── Re-embed 触发 ───────────────────────────────────────────

/** POST /api/reembed — 批量重新向量化 */
async function handleReembed(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_driver || !_cfg) return { status: 503, body: { error: "Neo4j not connected" } };
  if (!_embed) return { status: 503, body: { error: "Embedding engine not configured" } };
  try {
    const { reEmbedNodes } = await import("../graph/reembed.ts");
    const batchSize = (params?.batchSize ?? 50) as number;
    // v2.4.0: 可选 clear=true 时先清空当前数据库全部节点/边，配合重新导入获得正确时序
    if (params?.clear === true) {
      const { clearAllNodes } = await import("../store/nodes.ts");
      const cleared = await clearAllNodes(_driver);
      return { status: 200, body: { cleared, reEmbedded: 0, note: "database cleared; re-run import then reembed" } };
    }
    // v2.4.0: 传入 _batchEmbed，正式流程重嵌入工具启用批量嵌入（缓解 Ollama 503）
    const result = await reEmbedNodes(_driver, _embed, batchSize, _cfg.embedding?.model, undefined, _batchEmbed ?? undefined);
    return { status: 200, body: result };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── 反馈提交 ────────────────────────────────────────────────

/** POST /api/feedback — 提交召回反馈 */
async function handleFeedback(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const { query, recalledNodeIds, assistantReply, sessionId } = params ?? {};
  if (!query) return { status: 400, body: { error: "query is required" } };
  if (!_recaller) return { status: 503, body: { error: "Recaller not initialized" } };
  try {
    const ids: string[] = Array.isArray(recalledNodeIds) ? recalledNodeIds : [];
    const recalledNodes = (await Promise.all(
      ids.map(async (id: string) => {
        try { return await findById(_driver!, id); } catch { return null; }
      }),
    )).filter(Boolean) as GmNode[];

    await _recaller.processFeedback(
      String(query),
      recalledNodes,
      String(assistantReply ?? ""),
      sessionId as string | undefined,
    );

    const jm = _recaller.getJudgeManager();
    return {
      status: 200,
      body: {
        submitted: true,
        recalledCount: recalledNodes.length,
        feedbackCount: jm?.getFeedbackCount() ?? 0,
        coldStart: jm?.isColdStart() ?? true,
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── v2.3.5 B2: Bootstrap 反馈（用历史节点合成 warmup 反馈） ──────────────────
//
// 场景：图谱已有大量历史节点（如 506 条经验），但零反馈数据，
// 导致 JudgeManager / M 矩阵永久冷启动。
//
// 原理：对每个节点构造合成反馈：
//   - query = node.name
//   - recalledNodes = [node]
//   - assistantReply = node.description + " " + node.name
// Tier 1 启发式判定 node.name 出现在 reply 中 → 必然命中 → 计为 used
// 一次性喂入 N 条，快速突破冷启动。
//
// 风险控制：
//   - 仅在冷启动期使用（热启动后调用无意义）
//   - 合成数据 matchedBy 会是 "cold-start"/"heuristic"（无法区分真实/合成）
//   - 建议一次性使用，不要反复调用（会污染反馈统计）
async function handleFeedbackBootstrap(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  if (!_recaller) return { status: 503, body: { error: "Recaller not initialized" } };
  const maxNodes = Math.min(Math.max(safeParseInt(params?.maxNodes as string | undefined, 100, 500), 10), 500);
  try {
    const { getTopNodes } = await import("../store/store.ts");
    const nodes = await getTopNodes(_driver, maxNodes);
    if (nodes.length === 0) {
      return { status: 200, body: { bootstrapped: 0, reason: "no nodes in graph" } };
    }

    const jm = _recaller.getJudgeManager();
    const beforeCount = jm?.getFeedbackCount() ?? 0;
    const beforeColdStart = jm?.isColdStart() ?? true;

    let bootstrapped = 0;
    let failed = 0;
    for (const node of nodes) {
      try {
        // 合成反馈：节点名作为 query，description+name 作为 reply（启发式必然命中）
        const query = node.name;
        const reply = `${node.name} ${node.description ?? ""} ${node.content ?? ""}`.slice(0, 1000);
        await _recaller.processFeedback(query, [node], reply, "bootstrap");
        bootstrapped++;
      } catch {
        failed++;
      }
    }

    return {
      status: 200,
      body: {
        bootstrapped,
        failed,
        totalNodes: nodes.length,
        feedbackCountBefore: beforeCount,
        feedbackCountAfter: jm?.getFeedbackCount() ?? 0,
        coldStartBefore: beforeColdStart,
        coldStartAfter: jm?.isColdStart() ?? true,
        hint: "Bootstrap uses synthetic feedback (node name as both query and reply). Use once to exit cold start; do not call repeatedly.",
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── Benchmark 触发 ──────────────────────────────────────────

/** POST /api/benchmark — 运行评测 */
async function handleBenchmark(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_recaller || !_cfg) return { status: 503, body: { error: "Plugin not fully initialized" } };
  try {
    const { runBenchmark, formatAggregateReport } = await import("../benchmark/runner.ts");
    const result = await runBenchmark(_recaller, _driver, _cfg, {
      datasets: (params?.datasets ?? "all") as string[] | "all",
      maxCases: (params?.maxCases ?? _cfg.benchmark?.maxCases ?? 0) as number,
      buildGraph: (params?.buildGraph ?? _cfg.benchmark?.buildGraph ?? true) as boolean,
      caseTimeoutMs: _cfg.benchmark?.caseTimeoutMs ?? 30_000,
      dataDir: _cfg.benchmark?.dataDir,
      llm: _llm ?? undefined,
      embedFn: _embed ?? undefined,
    });
    return {
      status: 200,
      body: { report: formatAggregateReport(result), aggregate: result.aggregate },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── AutoTuner 触发 ──────────────────────────────────────────

/** POST /api/auto-tuner/tune — 触发一次自动调优 */
async function handleAutoTunerTune(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_recaller || !_cfg) return { status: 503, body: { error: "Plugin not fully initialized" } };
  if (_cfg.autoTuner?.enabled !== true) {
    return { status: 400, body: { error: "AutoTuner disabled. Set autoTuner.enabled=true in config." } };
  }
  try {
    const { AutoTuner } = await import("../evolution/auto-tuner.ts");
    const { readFile, writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const statePath = join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".openclaw", "graph-memory-pro", "auto-tuner-state.json",
    );
    const tuner = new AutoTuner(_cfg.autoTuner, _llm ?? undefined);
    tuner.setInitialAction(_cfg);
    try {
      const saved = await readFile(statePath, "utf-8");
      if (saved && saved.trim()) tuner.deserialize(saved);
    } catch { /* 首次运行无状态文件 */ }

    const rounds = Math.max(1, Math.min((params?.rounds ?? 1) as number, _cfg.autoTuner?.maxRounds ?? 10));
    const results: unknown[] = [];
    for (let i = 0; i < rounds; i++) {
      const r = await tuner.runTuneCycle(_recaller, _driver, _cfg);
      results.push(r);
      if (!r.applied) break;
    }
    try {
      await mkdir(join(statePath, "..").replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {});
      await writeFile(statePath, tuner.serialize()).catch(() => {});
    } catch { /* 持久化失败不影响调优结果 */ }

    return {
      status: 200,
      body: {
        rounds: results,
        finalAction: tuner.getCurrentAction(),
        totalRounds: tuner.getTuneRound(),
        snapshots: tuner.getSnapshots().length,
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ── 配置查询 ────────────────────────────────────────────────

/** GET /api/config — 返回当前运行配置（脱敏，不返回密码/token） */
async function handleConfig(): Promise<{ status: number; body: unknown }> {
  if (!_cfg) return { status: 503, body: { error: "Plugin not initialized" } };
  // 脱敏：移除密码和 token
  const safe = JSON.parse(JSON.stringify(_cfg));
  if (safe.neo4j) safe.neo4j.password = "***";
  if (safe.llm) safe.llm.apiKey = "***";
  if (safe.embedding) safe.embedding.apiKey = "***";
  if (safe.apiServer) safe.apiServer.authToken = "***";
  if (safe.mcp) safe.mcp.authToken = "***";
  return { status: 200, body: { version: VERSION, config: safe } };
}

// ═══════════════════════════════════════════════════════════════
//  可视化接口
// ═══════════════════════════════════════════════════════════════

/** GET /api/graph/walk?seedIds=id1,id2&depth=2&maxNodes=200 — 子图遍历 */
async function handleGraphWalk(params: { seedIds?: string; depth?: string; maxNodes?: string }): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const seedIdsStr = params.seedIds;
  if (!seedIdsStr) return { status: 400, body: { error: "seedIds is required (comma-separated)" } };
  const seedIds = seedIdsStr.split(",").map(s => s.trim()).filter(Boolean);
  if (seedIds.length === 0) return { status: 400, body: { error: "seedIds must contain at least one valid ID" } };
  const depth = safeParseInt(params.depth, 2, 5);
  const maxNodes = safeParseInt(params.maxNodes, 200, 1000);
  try {
    const result = await graphWalk(_driver, seedIds, depth, maxNodes);
    return { status: 200, body: result };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** POST /api/graph/walk — 子图遍历（POST 版，适合 seedIds 较多时） */
async function handleGraphWalkPost(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const seedIds: string[] = Array.isArray(params?.seedIds) ? params.seedIds as string[] : [];
  if (seedIds.length === 0) return { status: 400, body: { error: "seedIds must be a non-empty array" } };
  const depth = safeParseInt((params?.depth as number | string | undefined)?.toString(), 2, 5);
  const maxNodes = safeParseInt((params?.maxNodes as number | string | undefined)?.toString(), 200, 1000);
  try {
    const result = await graphWalk(_driver, seedIds, depth, maxNodes);
    return { status: 200, body: result };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** GET /api/nodes/:id/edges — 获取节点的所有关联边 */
async function handleNodeEdges(params: { id: string }): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const edges = await getEdgesForNodes(_driver, [params.id]);
    return { status: 200, body: { nodeId: params.id, edges } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** GET /api/nodes/:id/feedback-stats — 节点的反馈统计 */
async function handleNodeFeedbackStats(params: { id: string }): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const stats = await getNodeFeedbackStats(_driver, params.id);
    return { status: 200, body: { nodeId: params.id, ...stats } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** GET /api/communities/:id/nodes?limit=50 — 社区内节点列表 */
async function handleCommunityNodes(params: { id: string; limit?: string }): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const limit = safeParseInt(params.limit, 50, 500);
  try {
    const nodes = await nodesByCommunityIds(_driver, [params.id], limit);
    return { status: 200, body: { communityId: params.id, count: nodes.length, nodes } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** GET /api/communities/:id/representatives — 社区代表节点 */
async function handleCommunityRepresentatives(params: { id: string }): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const nodes = await communityRepresentatives(_driver, [params.id]);
    return { status: 200, body: { communityId: params.id, representatives: nodes } };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** GET /api/schema — 图谱 schema 自省（节点类型 + 边类型 + 索引） */
async function handleSchema(): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    // 查询节点标签和计数
    const { getActiveDatabase } = await import("../store/db.ts");
    const database = getActiveDatabase();
    // v2.4.1: 并发 → 串行 + executeQuery。
    //   修复：旧实现用同一 session 并发多次 session.run()，在 Neo4j 下同一 session 不允许在途
    //   并发事务，会抛 "Cannot have concurrent transactions on the same session"。
    //   driver.executeQuery 每次自动走独立隐式事务（autocommit），可安全串行多次调用；
    //   for...of await 消除并发在途查询。
    //   注：neo4j-driver v6 的 executeQuery 仅存在于 Driver 上（session.executeQuery 运行时不存在），
    //   故用 _driver.executeQuery 并显式传激活库名，保持与 getSession 的库绑定一致。
    //   标签/类型用反引号包裹，防止含特殊字符的标识符破坏 Cypher。
    const nodeTypes: { label: string; count: number }[] = [];
    const labelResult = await _driver.executeQuery(
      `CALL db.labels() YIELD label RETURN label`,
      {},
      { database },
    );
    for (const rec of labelResult.records) {
      const label = rec.get("label");
      const countResult = await _driver.executeQuery(
        `MATCH (n:\`${label}\`) RETURN count(n) AS cnt`,
        {},
        { database },
      );
      nodeTypes.push({ label, count: countResult.records[0]?.get("cnt")?.toNumber?.() ?? 0 });
    }

    const edgeTypes: { type: string; count: number }[] = [];
    const relResult = await _driver.executeQuery(
      `CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType`,
      {},
      { database },
    );
    for (const rec of relResult.records) {
      const type = rec.get("relationshipType");
      const countResult = await _driver.executeQuery(
        `MATCH ()-[r:\`${type}\`]->() RETURN count(r) AS cnt`,
        {},
        { database },
      );
      edgeTypes.push({ type, count: countResult.records[0]?.get("cnt")?.toNumber?.() ?? 0 });
    }

    return {
      status: 200,
      body: {
        nodeTypes: nodeTypes.filter(n => !n.label.startsWith("_")),
        edgeTypes: edgeTypes.filter(e => !e.type.startsWith("_")),
        indexingModels: _cfg?.embedding?.model ?? null,
        vectorDimension: _cfg?.embedding?.dimensions ?? null,
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// ═══════════════════════════════════════════════════════════════
//  运维接口
// ═══════════════════════════════════════════════════════════════

/** POST /api/ops/circuit-breakers/reset — 重置所有熔断器 */
async function handleResetCircuitBreakers(): Promise<{ status: number; body: unknown }> {
  try {
    const { getAllCircuitBreakers, resetAllCircuitBreakers } = await import("../engine/circuit-breaker.ts");
    const before = Array.from(getAllCircuitBreakers().entries()).map(([name, b]) => ({
      name, state: b.getState(), failureCount: b.getStatus().failureCount,
    }));
    resetAllCircuitBreakers();
    return {
      status: 200,
      body: {
        message: "all circuit breakers reset",
        resetCount: before.length,
        previousStates: before,
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** DELETE /api/ops/cache — 清空查询缓存 */
async function handleClearCache(): Promise<{ status: number; body: unknown }> {
  try {
    let cleared = 0;
    if (_recaller) {
      const cache = _recaller.getQueryCache();
      const stats = cache.getStats();
      cleared = stats.size;
      cache.clear();
    }
    const { resetRecallTiming } = await import("../recaller/recall.ts");
    resetRecallTiming();
    return {
      status: 200,
      body: {
        message: "cache cleared",
        entriesRemoved: cleared,
        recallTimingReset: true,
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** POST /api/ops/reconnect — 手动触发 Neo4j 重连 */
async function handleReconnect(): Promise<{ status: number; body: unknown }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const { verifyWithRetry } = await import("../store/db.ts");
    const ok = await verifyWithRetry(_driver);
    const { getPoolMetrics } = await import("../store/db.ts");
    const pool = getPoolMetrics();
    return {
      status: ok ? 200 : 503,
      body: {
        connected: ok,
        pool: pool,
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** GET /api/ops/services — 后台服务状态 */
async function handleServiceStatus(): Promise<{ status: number; body: unknown }> {
  // 从 index.ts 模块级变量推断服务状态
  // 这些变量在 index.ts 中声明，此处通过动态 import 读取
  try {
    const services: Array<{ name: string; status: string; detail?: unknown }> = [];

    // API server 本身正在响应请求，即为 running
    services.push({
      name: "api-server",
      status: "running",
    });

    // 检查 driver 状态
    if (_driver) {
      try {
        await _driver.verifyConnectivity();
        services.push({ name: "neo4j-driver", status: "connected" });
      } catch {
        services.push({ name: "neo4j-driver", status: "disconnected" });
      }
    } else {
      services.push({ name: "neo4j-driver", status: "not-initialized" });
    }

    // 检查 recaller
    services.push({
      name: "recaller",
      status: _recaller ? "initialized" : "not-initialized",
    });

    // 检查 LLM/Embedding
    services.push({ name: "llm", status: _llm ? "configured" : "not-configured" });
    services.push({ name: "embedding", status: _embed ? "configured" : "not-configured" });

    // v2.3.5: 自动反馈采集状态 + session 缓存统计
    const autoFeedbackEnabled = _cfg?.autoFeedback?.enabled !== false;
    let sessionCacheSize = 0;
    try {
      const { getSessionRecallCache } = await import("../recaller/session-recall-cache.ts");
      sessionCacheSize = getSessionRecallCache().size();
    } catch { /* 模块未加载 */ }
    services.push({
      name: "auto-feedback",
      status: autoFeedbackEnabled ? "enabled" : "disabled",
      detail: { sessionCacheSize, trackGetExpansion: _cfg?.autoFeedback?.trackGetExpansion !== false },
    });

    // 熔断器状态
    const { getAllCircuitBreakers } = await import("../engine/circuit-breaker.ts");
    const breakers = Array.from(getAllCircuitBreakers().entries()).map(([name, b]) => ({
      name,
      state: b.getState(),
      failureCount: b.getStatus().failureCount,
    }));
    services.push({ name: "circuit-breakers", status: "ok", detail: breakers });

    // 连接池
    const { getPoolMetrics } = await import("../store/db.ts");
    const pool = getPoolMetrics();
    services.push({ name: "connection-pool", status: "ok", detail: pool });

    return {
      status: 200,
      body: {
        version: VERSION,
        timestamp: new Date().toISOString(),
        services,
      },
    };
  } catch (err: unknown) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
