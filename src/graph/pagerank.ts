/**
 * graph-memory-pro — PageRank (Neo4j GDS 2.12 OpenGDS)
 *
 * ✅ In-memory projection + TTL 缓存（OpenGDS 兼容方案）
 */

import type { Driver, Session } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import { getSession } from "../store/db.ts";

const ALL_REL_TYPES = ["USED_SKILL", "SOLVED_BY", "REQUIRES", "PATCHES", "CONFLICTS_WITH"];

// ✅ In-memory projection 缓存（TTL），OpenGDS 下最优方案
let _cachedGraphName: string | null = null;
let _cachedTimestamp = 0;
const PROJECTION_TTL_MS = 5 * 60 * 1000; // 5分钟过期

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

async function ensureProjection(session: Session, graphName: string): Promise<boolean> {
  // 检查 projection 是否存在且未过期
  const checkResult = await session.run(`
    CALL gds.graph.exists($name)
    YIELD exists
    RETURN exists
  `, { name: graphName });

  if (checkResult.records[0]?.get("exists") === true && Date.now() - _cachedTimestamp < PROJECTION_TTL_MS) {
    return true;
  }

  // Projection 不存在或已过期，重新创建
  try {
    const existingTypes = await getExistingRelTypes(session);
    if (existingTypes.length === 0) {
      return false;
    }

    // 先清理旧的（避免残留）
    try { await session.run(`CALL gds.graph.drop('${graphName}')`); } catch {}

    const relProjection = buildRelProjection(existingTypes);
    await session.run(
      `CALL gds.graph.project('${graphName}', ['Task', 'Skill', 'Event'], ${relProjection})`
    );
    _cachedTimestamp = Date.now();
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

    // 复用缓存或创建新投影
    if (_cachedGraphName && Date.now() - _cachedTimestamp < PROJECTION_TTL_MS) {
      const hasProjection = await ensureProjection(session, _cachedGraphName);
      if (hasProjection) {
        return runPPR(session, _cachedGraphName, seedIds, candidateIds, cfg);
      }
    }

    // 需要新建 projection
    const graphName = `gm-ppr-${Date.now()}`;
    _cachedGraphName = graphName;

    try {
      await ensureProjection(session, graphName);
      return runPPR(session, graphName, seedIds, candidateIds, cfg);
    } catch (gdsErr) {
      try { await session.run(`CALL gds.graph.drop('${graphName}')`); } catch {}
      _cachedGraphName = null;
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

    // 先清理旧的投影（避免残留）
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
