/**
 * graph-memory-pro — HTTP CRUD 路由
 *
 * 安全修复 (2.1.0):
 * - 不再返回密码等敏感信息
 * - 密码只接受写入，不返回
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import {
  findById, searchNodes, getTopNodes, getNodesByType,
  getNodeCount, getEdgeCount, getEdgesForNodes,
  getFeedbackCount,
} from "../store/store.ts";
import { runMaintenance } from "../graph/maintenance.ts";
import {
  runIncrementalMaintenance,
  markDirty, getDirtyNodeIds, clearDirty,
} from "../graph/incremental-maintenance.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import type { Recaller } from "../recaller/recall.ts";

let _driver: Driver | null = null;
let _cfg: GmConfig | null = null;
let _llm: CompleteFn | null = null;
let _embed: EmbedFn | null = null;
let _recaller: Recaller | null = null;

export function initRoutes(
  driver: Driver,
  cfg: GmConfig,
  llm?: CompleteFn,
  embed?: EmbedFn,
  recaller?: Recaller,
): void {
  _driver = driver;
  _cfg = cfg;
  _llm = llm ?? null;
  _embed = embed ?? null;
  _recaller = recaller ?? null;
}

interface RouteHandler {
  method: "GET" | "POST" | "DELETE";
  path: string;
  handler: (params: any) => Promise<{ status: number; body: any }>;
}

export function getRoutes(): RouteHandler[] {
  return [
    { method: "GET", path: "/api/status", handler: handleStatus },
    { method: "GET", path: "/api/stats", handler: handleStats },
    { method: "GET", path: "/api/health", handler: handleHealth }, // v2.1.2 G-5
    { method: "GET", path: "/api/nodes/:id", handler: handleGetNode },
    { method: "GET", path: "/api/search", handler: handleSearch },
    { method: "GET", path: "/api/top", handler: handleTop },
    { method: "GET", path: "/api/nodes-by-type/:type", handler: handleNodesByType },
    { method: "POST", path: "/api/maintain", handler: handleMaintain },
    { method: "POST", path: "/api/staleness/refresh", handler: handleRefreshStaleness }, // v2.1.2 S-14
    // v2.2.0 P4: 增量维护
    { method: "POST", path: "/api/maintain/incremental", handler: handleIncrementalMaintain },
    { method: "POST", path: "/api/maintain/mark-dirty", handler: handleMarkDirty },
    { method: "GET", path: "/api/maintain/dirty-nodes", handler: handleGetDirtyNodes },
    { method: "DELETE", path: "/api/maintain/dirty-nodes", handler: handleClearDirty },
    // v2.2.0 P2-2: Prometheus 指标导出
    { method: "GET", path: "/api/metrics", handler: handleMetrics },
    // v2.2.0 P2-3: AutoTuner 状态查询
    { method: "GET", path: "/api/auto-tuner/state", handler: handleAutoTunerState },
    // v2.2.0 P2-4: 关联矩阵 M 状态查询
    { method: "GET", path: "/api/association-matrix/state", handler: handleAssociationMatrixState },
    // v2.3.0: 配置自检 — 验证 Neo4j/LLM/Embedding 连通性
    { method: "GET", path: "/api/doctor", handler: handleDoctor },
    // v2.3.0: LLM token 用量查询
    { method: "GET", path: "/api/usage", handler: handleUsage },
  ];
}

async function handleStatus(): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    await _driver.verifyConnectivity();
    return { status: 200, body: { status: "connected", version: "2.3.2" } };
  } catch (err: any) {
    return { status: 503, body: { status: "disconnected", error: err.message } };
  }
}

// v2.1.2 G-5: 图谱健康检查
async function handleHealth(): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const { healthCheck } = await import("../graph/maintenance.ts");
    const report = await healthCheck(_driver);
    // v2.3.2 阶段三: 追加连接池指标 + 熔断器状态
    const { getPoolMetrics } = await import("../store/db.ts");
    report.connectionPool = getPoolMetrics();
    const { getAllCircuitBreakers } = await import("../engine/circuit-breaker.ts");
    const breakers = getAllCircuitBreakers();
    const breakerStatus: Record<string, any> = {};
    for (const [name, breaker] of breakers) {
      breakerStatus[name] = breaker.getStatus();
    }
    report.circuitBreakers = breakerStatus;
    return { status: 200, body: report };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

// v2.1.2 S-14: 手动触发 staleness 重算
async function handleRefreshStaleness(): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const { computeStalenessScores } = await import("../graph/maintenance.ts");
    const result = await computeStalenessScores(_driver, {
      halfLifeDays: 90,
      threshold: _cfg?.staleness?.threshold ?? 0.7,
    });
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

async function handleStats(): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const [nodeCount, edgeCount] = await Promise.all([
      getNodeCount(_driver),
      getEdgeCount(_driver),
    ]);
    return { status: 200, body: { nodeCount, edgeCount } };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

async function handleGetNode(params: { id: string }): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const node = await findById(_driver, params.id);
    if (!node) return { status: 404, body: { error: "Node not found" } };
    return { status: 200, body: node };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

/** 安全解析整数参数 */
function safeParseInt(value: string | undefined, defaultValue: number, max?: number): number {
  const parsed = Number.parseInt(value ?? String(defaultValue), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return max ? Math.min(parsed, max) : parsed;
}

async function handleSearch(params: { query?: string; limit?: string }): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const q = params.query || "";
  const limit = safeParseInt(params.limit, 10, 50);
  if (!q.trim()) return { status: 400, body: { error: "query required" } };
  try {
    const nodes = await searchNodes(_driver, q, limit);
    const ids = nodes.map(n => n.id);
    const edges = await getEdgesForNodes(_driver, ids);
    return { status: 200, body: { nodes, edges } };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

async function handleTop(params: { limit?: string }): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const limit = safeParseInt(params.limit, 20, 100);
  try {
    const nodes = await getTopNodes(_driver, limit);
    return { status: 200, body: { nodes } };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

async function handleNodesByType(params: { type: string; limit?: string }): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const type = params.type.toUpperCase();
  if (!["TASK", "SKILL", "EVENT"].includes(type)) {
    return { status: 400, body: { error: `Invalid type: ${type}. Must be TASK, SKILL, or EVENT` } };
  }
  const limit = params.limit ? safeParseInt(params.limit, 10, 50) : undefined;
  try {
    const nodes = await getNodesByType(_driver, type, limit);
    return { status: 200, body: { type, nodes } };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

async function handleMaintain(): Promise<{ status: number; body: any }> {
  if (!_driver || !_cfg) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const result = await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined);
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

// ── v2.2.0 P4-2: 增量维护 HTTP 入口 ───────────────────────────

/**
 * POST /api/maintain/incremental
 *
 * 触发增量维护，仅处理 markDirty 标记的脏节点。
 * Body: { } （无参数）
 */
async function handleIncrementalMaintain(): Promise<{ status: number; body: any }> {
  if (!_driver || !_cfg) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const result = await runIncrementalMaintenance(
      _driver, _cfg,
      _llm ?? undefined, _embed ?? undefined,
    );
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

/**
 * POST /api/maintain/mark-dirty
 *
 * 标记节点为脏（自上次维护后变更）。
 * Body: { nodeIds: string[] }
 */
async function handleMarkDirty(params: any): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const nodeIds: string[] = Array.isArray(params?.nodeIds) ? params.nodeIds : [];
  if (nodeIds.length === 0) {
    return { status: 400, body: { error: "nodeIds is required and must be non-empty array" } };
  }
  try {
    await markDirty(_driver, nodeIds);
    return { status: 200, body: { marked: nodeIds.length } };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

/**
 * GET /api/maintain/dirty-nodes
 *
 * 返回当前所有脏节点 ID。
 */
async function handleGetDirtyNodes(): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const nodeIds = await getDirtyNodeIds(_driver);
    return { status: 200, body: { count: nodeIds.length, nodeIds } };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

/**
 * DELETE /api/maintain/dirty-nodes
 *
 * 清除脏节点标记。
 * Body: { nodeIds?: string[] } （不传则清除全部）
 */
async function handleClearDirty(params: any): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const nodeIds: string[] | undefined = Array.isArray(params?.nodeIds) ? params.nodeIds : undefined;
    await clearDirty(_driver, nodeIds);
    return { status: 200, body: { cleared: nodeIds?.length ?? "all" } };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
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
  const labels = `plugin="graph-memory-pro",version="2.3.2"`;

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
  } catch { /* breaker 指标获取失败不影响 metrics 输出 */ }

  return { status: 200, body: lines.join("\n") + "\n" };
}

// ── v2.2.0 P2-3: AutoTuner 状态查询 ───────────────────────────
//
// 返回持久化的 AutoTuner 状态（snapshots / currentAction / tuneRound）。
// 数据来源：~/.openclaw/graph-memory-pro/auto-tuner-state.json
async function handleAutoTunerState(): Promise<{ status: number; body: any }> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const statePath = join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".openclaw", "graph-memory-pro", "auto-tuner-state.json",
    );
    let raw = "";
    try {
      raw = await readFile(statePath, "utf-8");
    } catch {
      return {
        status: 200,
        body: {
          enabled: _cfg?.autoTuner?.enabled ?? false,
          available: false,
          reason: "no persisted state file (run gm_tune first)",
        },
      };
    }
    const parsed = JSON.parse(raw);
    return {
      status: 200,
      body: {
        enabled: _cfg?.autoTuner?.enabled ?? false,
        available: true,
        config: _cfg?.autoTuner ?? null,
        state: parsed,
      },
    };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

// ── v2.2.0 P2-4: 关联矩阵 M 状态查询 ───────────────────────────
//
// 返回内存中的 AssociationMatrix 统计信息（dim / t / applied / rejected / history）。
async function handleAssociationMatrixState(): Promise<{ status: number; body: any }> {
  const am = _recaller?.getAssociationMatrix();
  if (!am) {
    return {
      status: 200,
      body: {
        enabled: _cfg?.associationMatrix?.enabled ?? false,
        available: false,
        reason: "association matrix not initialized (set associationMatrix.enabled=true)",
      },
    };
  }
  try {
    const stats = am.getStats();
    return {
      status: 200,
      body: {
        enabled: true,
        available: true,
        config: _cfg?.associationMatrix ?? null,
        stats,
      },
    };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

// ── v2.3.0: 配置自检（gm_doctor）───────────────────────────
//
// 一次性验证 Neo4j / LLM / Embedding 三大依赖的连通性 + 配置完整性。
// 返回各项的 ok/warn/error 状态 + 诊断提示，便于用户排查配置问题。
// 设计参考 MySQL "SHOW STATUS" + 健康检查端点的组合。
async function handleDoctor(): Promise<{ status: number; body: any }> {
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
    } catch (err: any) {
      checks.push({
        name: "neo4j",
        status: "error",
        latencyMs: Date.now() - neo4jStart,
        detail: err.message,
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
    } catch (err: any) {
      checks.push({
        name: "graph_schema",
        status: "error",
        detail: err.message,
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
    } catch (err: any) {
      checks.push({
        name: "embedding",
        status: "error",
        latencyMs: Date.now() - embedStart,
        detail: err.message,
        hint: `Check embedding.model (must be embed model, not LLM model like qwen3.5:9b). Current: ${embedConfig.model ?? "unset"}`,
      });
    }
  }

  // 5. 反馈系统状态（JudgeManager 冷启动）
  const jm = _recaller?.getJudgeManager();
  if (jm) {
    const coldStart = jm.isColdStart();
    const feedbackCount = jm.getFeedbackCount();
    checks.push({
      name: "judge",
      status: coldStart ? "warn" : "ok",
      detail: `feedbackCount=${feedbackCount}, coldStart=${coldStart}`,
      hint: coldStart ? `Need ${_cfg?.judge?.judgeWarmupFeedbacks ?? 50} feedbacks to exit cold start` : undefined,
    });
  }

  // 汇总
  const errorCount = checks.filter(c => c.status === "error").length;
  const warnCount = checks.filter(c => c.status === "warn").length;
  const overallStatus = errorCount > 0 ? "error" : warnCount > 0 ? "warn" : "ok";

  return {
    status: errorCount > 0 ? 503 : 200,
    body: {
      status: overallStatus,
      version: "2.3.2",
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
async function handleUsage(): Promise<{ status: number; body: any }> {
  try {
    const { getUsageStats } = await import("../store/usage.ts");
    const stats = getUsageStats();
    return {
      status: 200,
      body: {
        version: "2.3.2",
        timestamp: new Date().toISOString(),
        ...stats,
      },
    };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}
