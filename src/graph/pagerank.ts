/**
 * graph-memory-pro — PageRank (Neo4j GDS 2.12 OpenGDS)
 *
 * ✅ PPR & Global PR share a single in-memory projection
 */

import type { Driver, Session } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import { getSession } from "../store/db.ts";
import { logPhase } from "../timing.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("pagerank");

// v2.1.2: 新增 CAUSED_BY / LEADS_TO 因果边类型
const ALL_REL_TYPES = ["NEXT_SESSION", "CONTAINS", "MENTIONS", "USED_SKILL", "SOLVED_BY", "REQUIRES", "PATCHES", "CONFLICTS_WITH", "RELATES_TO", "CAUSED_BY", "LEADS_TO"];

// ✅ Shared projection config
const SHARED_GRAPH_NAME = "gm-shared";
let _cachedRelTypeHash: string | null = null;
let _cachedTimestamp = 0;
const PROJECTION_TTL_MS = 15 * 60 * 1000; // 15 min TTL

// v2.3.2 S1: 投影预热互斥锁 — 防止并发 recall 触发重复 drop/recreate
// 当 preheatProjection 正在执行时，后续调用复用同一 Promise，避免竞态
let _projectionInFlight: Promise<boolean> | null = null;

async function getExistingRelTypes(session: Session): Promise<string[]> {
  const result = await session.run(`
    MATCH (:Task|Skill|Event)-[r]->(:Task|Skill|Event)
    WHERE type(r) IN $types
    RETURN DISTINCT type(r) AS t
  `, { types: ALL_REL_TYPES });
  return result.records.map(r => r.get("t"));

}
/**
 * Compute a stable hash of the relation-type set (for change detection).
 */
function relTypeHash(types: string[]): string {
  return types.sort().join(",");
}

function buildRelProjection(existingTypes: string[]): string {
  if (existingTypes.length === 0) return "'*'";
  const parts = existingTypes.map(t => `${t}: {orientation: 'UNDIRECTED'}`);
  return `{${parts.join(", ")}}`;
}

/**
 * Ensure the shared projection exists and is fresh.
 * - Within TTL and GDS-side exists -> reuse
 * - TTL expired or struct changed -> drop + recreate
 *
 * v2.3.1 性能优化: 接受预计算的 existingTypes 参数，避免内部重复调用 getExistingRelTypes。
 * 旧实现：personalizedPageRank L113 调一次 + ensureSharedProjection 内部再调 1-2 次，
 * 每次都跑同一条 MATCH ... RETURN DISTINCT type(r)，浪费 1-2 次数据库往返（~10-20ms）。
 * 新实现：调用方一次性查询 types，传入复用，消除重复查询。
 */
async function ensureSharedProjection(
  session: Session,
  precomputedTypes?: string[],
): Promise<boolean> {
  const now = Date.now();
  const tEnsure = Date.now();

  // v2.3.1: 复用调用方预计算的 types，避免重复查询
  const currentTypes = precomputedTypes ?? await getExistingRelTypes(session);
  const currentHash = relTypeHash(currentTypes);

  // Fast path: within TTL and hash unchanged, check GDS-side existence
  if (_cachedRelTypeHash && (now - _cachedTimestamp) < PROJECTION_TTL_MS) {
    if (currentHash === _cachedRelTypeHash) {
      const checkResult = await session.run(`
        CALL gds.graph.exists($name)
        YIELD exists
        RETURN exists
      `, { name: SHARED_GRAPH_NAME });

      if (checkResult.records[0]?.get("exists") === true) {
        logPhase("ensure_projection", Date.now() - tEnsure, { cache: "hit" });
        return true;
      }
    }
    // hash changed or graph missing → fall through to recreate
  }

  if (currentTypes.length === 0) {
    logPhase("ensure_projection", Date.now() - tEnsure, { status: "no_types" });
    return false;
  }

  // Drop old and recreate
  try { await session.run(`CALL gds.graph.drop('${SHARED_GRAPH_NAME}')`); } catch {}

  const relProjection = buildRelProjection(currentTypes);
  await session.run(
    `CALL gds.graph.project('${SHARED_GRAPH_NAME}', ['Task', 'Skill', 'Event'], ${relProjection})`
  );
  _cachedTimestamp = now;
  _cachedRelTypeHash = currentHash;
  logPhase("ensure_projection", Date.now() - tEnsure, { status: "rebuilt" });
  return true;
}
export interface PPRResult {
  scores: Map<string, number>;
}

/**
 * v2.3.1 性能优化: 预热共享 GDS 投影
 *
 * 在 recall() 入口调用一次，避免 recallPrecise 和 recallGeneralized
 * 并行执行时各自独立触发 ensureSharedProjection（重复探测 ~80-150ms）。
 *
 * 调用后全局 _cachedRelTypeHash + _cachedTimestamp 被设置，
 * 后续 personalizedPageRank 内部的 ensureSharedProjection 直接命中 fast path。
 *
 * v2.3.2 S1 稳定性修复: 加互斥锁 — 并发 recall 时复用同一 in-flight Promise，
 * 防止两条路径同时触发 drop/recreate 导致 gds.pageRank.stream 执行期间图被删除。
 *
 * @returns true 表示投影就绪可用
 */
export async function preheatProjection(driver: Driver): Promise<boolean> {
  // v2.3.2 S1: 如果已有预热线程在执行，复用它（防并发 drop/recreate 竞态）
  if (_projectionInFlight) return _projectionInFlight;

  _projectionInFlight = (async () => {
    const session = getSession(driver);
    try {
      const existingTypes = await getExistingRelTypes(session);
      if (existingTypes.length === 0) return false;
      return await ensureSharedProjection(session, existingTypes);
    } catch {
      // 预热失败不影响主流程，personalizedPageRank 内部会重试
      return false;
    } finally {
      try { await session.close(); } catch {}
    }
  })().finally(() => {
    _projectionInFlight = null;
  });

  return _projectionInFlight;
}

export async function personalizedPageRank(
  driver: Driver,
  seedIds: string[],
  candidateIds: string[],
  cfg: GmConfig,
): Promise<PPRResult> {
  if (!seedIds.length || !candidateIds.length) {
    return { scores: new Map() };
  }

  const session = getSession(driver);
  try {
    // v2.3.1 P1-2 性能优化: type 探测 与 seed 查找 并行（无数据依赖）
    // 旧实现串行：getExistingRelTypes → ensureSharedProjection → runPPR(seed lookup) → ppr.stream
    // 新实现：type 探测 与 seed 查找 并行执行，省一次串行往返
    const seedSession = getSession(driver);
    const typesPromise = getExistingRelTypes(session);
    const seedLookupPromise = (async () => {
      try {
        const tSeed = Date.now();
        const seedResult = await seedSession.run(`
          MATCH (n:Task|Skill|Event) WHERE n.id IN $seedIds AND n.status = 'active'
          RETURN id(n) AS neoId
        `, { seedIds });
        logPhase("ppr_seed_lookup", Date.now() - tSeed, { seeds: seedResult.records.length });
        return seedResult.records.map(r => r.get("neoId"));
      } finally {
        try { await seedSession.close(); } catch {}
      }
    })();

    const [existingTypes, sourceNodeIds] = await Promise.all([typesPromise, seedLookupPromise]);

    if (existingTypes.length === 0 || sourceNodeIds.length === 0) {
      const scores = new Map<string, number>();
      candidateIds.forEach((id, i) => scores.set(id, 1 / (i + 1)));
      return { scores };
    }

    // Ensure shared projection exists（复用已查询的 types，不再重复查询）
    const hasProjection = await ensureSharedProjection(session, existingTypes);
    if (!hasProjection) {
      const scores = new Map<string, number>();
      candidateIds.forEach((id, i) => scores.set(id, 1 / (i + 1)));
      return { scores };
    }

    // seed 已在并行阶段查到，直接执行 GDS pageRank.stream
    return await runPPRWithSeeds(session, SHARED_GRAPH_NAME, sourceNodeIds, candidateIds, cfg);
  } catch (gdsErr) {
    // GDS error 或 session 已失效（如 driver 被并发关闭）：
    // invalidate cache and fallback to uniform scores
    _cachedRelTypeHash = null;
    _cachedTimestamp = 0;
    // 不在 catch 路径中复用原 session（可能已 closed，session.run 会抛
    // "You cannot run more transactions on a closed session" 二次错误，掩盖原始错误）。
    // GDS 图会在下次 ensureSharedProjection 时自动 drop+recreate，无需在此清理。
    log.warn("personalizedPageRank failed, fallback to uniform scores", {
      error: String(gdsErr),
      seedCount: seedIds.length,
      candidateCount: candidateIds.length,
    });
    const scores = new Map<string, number>();
    candidateIds.forEach((id, i) => scores.set(id, 1 / (i + 1)));
    return { scores };
  } finally {
    // finally 中 session.close() 在已 closed session 上不会抛错（driver 内部 no-op）
    try { await session.close(); } catch {}
  }
}

/**
 * v2.3.1 P1-2: 执行 GDS pageRank.stream（seed 查找已在外部并行完成）
 */
async function runPPRWithSeeds(
  session: Session,
  graphName: string,
  sourceNodeIds: any[],
  candidateIds: string[],
  cfg: GmConfig,
): Promise<PPRResult> {
  const tPprFn = Date.now();

  const tCompute = Date.now();
  const pprResult = await session.run(`
    CALL gds.pageRank.stream($graphName, {
      dampingFactor: $damping,
      maxIterations: toInteger($iterations),
      sourceNodes: $sourceNodes
    })
    YIELD nodeId, score
    WITH gds.util.asNode(nodeId) AS node, score
    WHERE node.id IN $candidateIds AND node.status = 'active'
    RETURN node.id AS id, score
    ORDER BY score DESC
  `, {
    graphName,
    damping: cfg.pagerankDamping,
    iterations: cfg.pagerankIterations,
    sourceNodes: sourceNodeIds,
    candidateIds,
  });

  const scores = new Map<string, number>();
  logPhase("ppr_compute", Date.now() - tCompute, { gds_scores: pprResult.records.length });
  for (const r of pprResult.records) {
    const rawScore = r.get("score");
    scores.set(r.get("id"), typeof rawScore === "number" ? rawScore : (rawScore?.toNumber?.() ?? 0));
  }

  logPhase("ppr_total", Date.now() - tPprFn, { scores: scores.size });
  return { scores };
}

/**
 * 保留旧 runPPR 函数签名以兼容外部调用（内部转调 runPPRWithSeeds）
 * v2.3.1: 内部个性化 PageRank 已直接使用 runPPRWithSeeds，此函数仅保留向后兼容
 */
async function runPPR(
  session: Session,
  graphName: string,
  seedIds: string[],
  candidateIds: string[],
  cfg: GmConfig,
): Promise<PPRResult> {
  const tSeed = Date.now();
  const seedResult = await session.run(`
    MATCH (n:Task|Skill|Event) WHERE n.id IN $seedIds AND n.status = 'active'
    RETURN id(n) AS neoId
  `, { seedIds });
  logPhase("ppr_seed_lookup", Date.now() - tSeed, { seeds: seedResult.records.length });
  const sourceNodeIds = seedResult.records.map(r => r.get("neoId"));

  if (sourceNodeIds.length === 0) {
    return { scores: new Map() };
  }

  return await runPPRWithSeeds(session, graphName, sourceNodeIds, candidateIds, cfg);
}
// 标记 runPPR 为保留函数（防止 lint 误报未使用）
void runPPR;

export interface GlobalPageRankResult {
  scores: Map<string, number>;
  topK: Array<{ id: string; name: string; score: number }>;
}

export async function computeGlobalPageRank(driver: Driver, cfg: GmConfig): Promise<GlobalPageRankResult> {
  const session = getSession(driver);

  try {
    const countResult = await session.run("MATCH (n:Task|Skill|Event {status: 'active'}) RETURN count(n) AS c");
    const nodeCount = countResult.records[0]?.get("c")?.toNumber?.() ?? 0;
    if (nodeCount === 0) return { scores: new Map(), topK: [] };

    const existingTypes = await getExistingRelTypes(session);
    if (existingTypes.length === 0) {
      const uniformScore = 1 / nodeCount;
      await session.run("MATCH (n:Task|Skill|Event {status: 'active'}) SET n.pagerank = $score", { score: uniformScore });
      return await readTopK(session);
    }

    // Reuse shared projection instead of creating a new one each time
    const hasProjection = await ensureSharedProjection(session);
    if (!hasProjection) {
      const uniformScore = 1 / nodeCount;
      await session.run("MATCH (n:Task|Skill|Event {status: 'active'}) SET n.pagerank = $score", { score: uniformScore });
      return await readTopK(session);
    }

    // Global PR write mode - reuse shared projection
    await session.run(`
      CALL gds.pageRank.write('${SHARED_GRAPH_NAME}', {
        writeProperty: 'pagerank',
        dampingFactor: $damping,
        maxIterations: toInteger($iterations)
      })
    `, { damping: cfg.pagerankDamping, iterations: cfg.pagerankIterations });

    return await readTopK(session);
  } catch (err) {
    // 不在 catch 路径中复用原 session（可能已 closed，session.run 会抛
    // "You cannot run more transactions on a closed session" 二次错误，掩盖原始错误）。
    log.warn("computeGlobalPageRank failed", { error: String(err) });
    _cachedRelTypeHash = null;
    _cachedTimestamp = 0;
    return { scores: new Map(), topK: [] };
  } finally {
    try { await session.close(); } catch {}
  }
}

async function readTopK(session: Session): Promise<GlobalPageRankResult> {
  const topResult = await session.run(`
    MATCH (n:Task|Skill|Event {status: 'active'}) RETURN n.id AS id, n.name AS name, n.pagerank AS score
    ORDER BY n.pagerank DESC LIMIT 20
  `);

  const scores = new Map<string, number>();
  const topK: Array<{ id: string; name: string; score: number }> = [];
  for (const r of topResult.records) {
    const raw = r.get("score");
    const score = typeof raw === "number" ? raw : (raw?.toNumber?.() ?? 0);
    scores.set(r.get("id"), score);
    topK.push({ id: r.get("id"), name: r.get("name"), score });
  }
  return { scores, topK };
}
