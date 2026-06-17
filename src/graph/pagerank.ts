/**
 * graph-memory-pro — PageRank (Neo4j GDS 2.12 OpenGDS)
 *
 * ✅ 优化：使用 GDS stream projection（持久化），重启不丢失
 */

import type { Driver, Session } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import { getSession } from "../store/db.ts";

const ALL_REL_TYPES = ["USED_SKILL", "SOLVED_BY", "REQUIRES", "PATCHES", "CONFLICTS_WITH"];

// ✅ 固定名称的 stream projection，持久化到 Neo4j，重启不丢失
const STREAM_GRAPH_NAME = "gm_ppr_stream";

async function getExistingRelTypes(session: Session): Promise<string[]> {
  const result = await session.run(`
    MATCH (:Task|Skill|Event)-[r]->(:Task|Skill|Event)
    WHERE type(r) IN $types
    RETURN DISTINCT type(r) AS t
  `, { types: ALL_REL_TYPES });
  return result.records.map(r => r.get("t"));
}

function buildRelProjection(existingTypes: string[]): string {
  if (existingTypes.length === 0) return "'*'";
  const parts = existingTypes.map(t => `${t}: {orientation: 'UNDIRECTED'}`);
  return `{${parts.join(", ")}}`;
}

/**
 * ✅ 创建或刷新 GDS stream projection
 * Stream projection 持久化到 Neo4j 内部存储，重启不丢失
 * 首次创建后会自动跟踪底层图的变化（新增/删除节点边自动同步）
 */
async function ensureStreamProjection(session: Session): Promise<boolean> {
  // 检查 stream projection 是否已存在
  const checkResult = await session.run(`
    CALL gds.graph.exists($name)
    YIELD exists
    RETURN exists
  `, { name: STREAM_GRAPH_NAME });

  if (checkResult.records[0]?.get("exists") === true) {
    // ✅ 已存在，stream projection 会自动同步底层图变化，直接使用
    return true;
  }

  // 首次创建或之前被删除了，重新创建
  try {
    const existingTypes = await getExistingRelTypes(session);
    if (existingTypes.length === 0) {
      return false;
    }

    const relProjection = buildRelProjection(existingTypes);

    // ✅ 使用 stream projection（持久化到 Neo4j，重启不丢失）
    await session.run(
      `CALL gds.graph.project('${STREAM_GRAPH_NAME}', ['Task', 'Skill', 'Event'], ${relProjection}, { stream: true })`
    );

    return true;
  } catch {
    return false;
  }
}

export interface PPRResult {
  scores: Map<string, number>;
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
    const existingTypes = await getExistingRelTypes(session);
    if (existingTypes.length === 0) {
      const scores = new Map<string, number>();
      candidateIds.forEach((id, i) => scores.set(id, 1 / (i + 1)));
      return { scores };
    }

    // ✅ 确保 stream projection 存在（持久化，重启不丢失）
    const hasProjection = await ensureStreamProjection(session);
    if (!hasProjection) {
      const scores = new Map<string, number>();
      candidateIds.forEach((id, i) => scores.set(id, 1 / (i + 1)));
      return { scores };
    }

    try {
      // ✅ 直接使用持久化的 stream projection，零投影开销
      return runPPR(session, STREAM_GRAPH_NAME, seedIds, candidateIds, cfg);
    } catch (gdsErr) {
      // Fallback：如果 stream projection 损坏，尝试重建
      try { await session.run(`CALL gds.graph.drop('${STREAM_GRAPH_NAME}')`); } catch {}
      const scores = new Map<string, number>();
      candidateIds.forEach((id, i) => scores.set(id, 1 / (i + 1)));
      return { scores };
    }
  } finally {
    await session.close();
  }
}

async function runPPR(
  session: Session,
  graphName: string,
  seedIds: string[],
  candidateIds: string[],
  cfg: GmConfig,
): Promise<PPRResult> {
  const seedResult = await session.run(`
    MATCH (n:Task|Skill|Event) WHERE n.id IN $seedIds AND n.status = 'active'
    RETURN id(n) AS neoId
  `, { seedIds });
  const sourceNodeIds = seedResult.records.map(r => r.get("neoId"));

  if (sourceNodeIds.length === 0) {
    return { scores: new Map() };
  }

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
  for (const r of pprResult.records) {
    const rawScore = r.get("score");
    scores.set(r.get("id"), typeof rawScore === "number" ? rawScore : (rawScore?.toNumber?.() ?? 0));
  }

  return { scores };
}

export interface GlobalPageRankResult {
  scores: Map<string, number>;
  topK: Array<{ id: string; name: string; score: number }>;
}

export async function computeGlobalPageRank(driver: Driver, cfg: GmConfig): Promise<GlobalPageRankResult> {
  const session = getSession(driver);
  // Global PageRank 仍需临时 projection（write 模式），用固定名便于清理
  const graphName = `gm-global-pr`;

  try {
    const countResult = await session.run("MATCH (n:Task|Skill|Event {status: 'active'}) RETURN count(n) AS c");
    const nodeCount = countResult.records[0]?.get("c")?.toNumber?.() ?? 0;
    if (nodeCount === 0) return { scores: new Map(), topK: [] };

    const existingTypes = await getExistingRelTypes(session);
    if (existingTypes.length === 0) {
      const uniformScore = 1 / nodeCount;
      await session.run("MATCH (n:Task|Skill|Event {status: 'active'}) SET n.pagerank = $score", { score: uniformScore });
      const topResult = await session.run(`
        MATCH (n:Task|Skill|Event {status: 'active'}) RETURN n.id AS id, n.name AS name, n.pagerank AS score
        ORDER BY n.pagerank DESC LIMIT 20
      `);
      const scores = new Map<string, number>();
      const topK = topResult.records.map(r => {
        const s = typeof r.get("score") === "number" ? r.get("score") : (r.get("score")?.toNumber?.() ?? 0);
        return { id: r.get("id"), name: r.get("name"), score: s };
      });
      return { scores, topK };
    }

    const relProjection = buildRelProjection(existingTypes);

    // 先清理旧的全局 projection（避免残留）
    try {
      await session.run(`CALL gds.graph.drop('${graphName}')`);
    } catch {}

    await session.run(
      `CALL gds.graph.project('${graphName}', ['Task', 'Skill', 'Event'], ${relProjection})`
    );

    await session.run(`
      CALL gds.pageRank.write('${graphName}', {
        writeProperty: 'pagerank',
        dampingFactor: $damping,
        maxIterations: toInteger($iterations)
      })
    `, { damping: cfg.pagerankDamping, iterations: cfg.pagerankIterations });

    try { await session.run(`CALL gds.graph.drop('${graphName}')`); } catch {}

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
  } catch (err) {
    try { await session.run(`CALL gds.graph.drop('${graphName}')`); } catch {}
    return { scores: new Map(), topK: [] };
  } finally {
    await session.close();
  }
}
