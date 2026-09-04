// ── G-5 图谱健康指标（v2.1.2 新增）───────────────────────────────

import type { Driver } from "neo4j-driver";
import { getSession } from "../../store/db.ts";

export interface GraphHealthReport {
  timestamp: number;
  nodes: { total: number; active: number; superseded: number; transitional: number };
  edges: { total: number; byType: Record<string, number> };
  isolatedNodes: number;
  highStaleNodes: number;
  communities: number;
  avgPageRank: number;
  topNodes: Array<{ id: string; name: string; pagerank: number }>;
  anomalies: string[];
  // v2.3.2 阶段三: 可选的连接池与熔断器状态（由 routes 层追加）
  connectionPool?: unknown;
  circuitBreakers?: Record<string, unknown>;
}

/** v2.6.0: 图谱 0-100 健康评分 */
export interface GraphHealthScore {
  timestamp: number;
  score: number;              // 0-100
  dims: {
    connectivity: number;     // 0-1
    density: number;          // 0-1
    influence: number;        // 0-1
    freshness: number;        // 0-1
    conflictFree: number;     // 0-1
  };
  metrics: {
    activeNodes: number;
    totalEdges: number;
    isolatedNodes: number;
    isolatedRatio: number;
    avgDegree: number;
    avgPageRank: number;
    highStaleRatio: number;
    transitionalRatio: number;
  };
  sparse: boolean;            // score < 60 || isolatedRatio > 0.3
  anomalies: string[];
}

/**
 * v2.6.0: 计算图谱健康评分（0-100）。
 *
 * 五维加权：连通性 35% / 密度 25% / 影响力 20% / 时效性 10% / 冲突 10%
 *   - density 用对数刻度归一：min(1, log2(1+avgDegree)/log2(1+K))，K=8
 *
 * 稀疏判定：score < scoreThreshold(60) 或 isolatedRatio > 0.3
 *
 * @param driver Neo4j driver
 * @param scoreThreshold 稀疏评分阈值（默认 60）
 */
export async function computeGraphHealthScore(driver: Driver, scoreThreshold = 60): Promise<GraphHealthScore> {
  const session = getSession(driver);
  try {
    const activeResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       OPTIONAL MATCH ()-[r]->(n)
       RETURN count(DISTINCT n) AS activeNodes,
              count(r) AS inDegreeSum,
              count(DISTINCT CASE WHEN r IS NOT NULL THEN n END) AS connectedNodes,
              avg(n.pagerank) AS avgPageRank,
              count(CASE WHEN n.state = 'transitional' THEN 1 END) AS transitionalNodes`,
    );
    const aRec = activeResult.records[0];
    const activeNodes = aRec.get("activeNodes")?.toNumber?.() ?? 0;

    // v2.6.0: 空图特殊处理 —— 无节点即无结构，score=0、sparse=true（自愈无可操作项，返回空结果）
    if (activeNodes === 0) {
      return {
        timestamp: Date.now(), score: 0,
        dims: { connectivity: 0, density: 0, influence: 0, freshness: 1, conflictFree: 1 },
        metrics: {
          activeNodes: 0, totalEdges: 0, isolatedNodes: 0, isolatedRatio: 0,
          avgDegree: 0, avgPageRank: 0, highStaleRatio: 0, transitionalRatio: 0,
        },
        sparse: true, anomalies: ["空图（无 active 节点）"],
      };
    }

    const inDegreeSum = aRec.get("inDegreeSum")?.toNumber?.() ?? 0;
    const connectedNodes = aRec.get("connectedNodes")?.toNumber?.() ?? 0;
    const avgPageRankRaw = aRec.get("avgPageRank")?.toNumber?.() ?? 0;
    const transitionalNodes = aRec.get("transitionalNodes")?.toNumber?.() ?? 0;

    // 孤立节点 = active 但不被任何边指向的节点（用 pagerank 近似出度，实为入边入度导向）
    // 为使 cross-type 计数一致，isolated 判定与 healthCheck 相同：无任何 (n)--(其他节点) 关系
    const isolatedResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE NOT (n)--(:Task|Skill|Event)
       RETURN count(n) AS cnt`,
    );
    const isolatedNodes = isolatedResult.records[0].get("cnt")?.toNumber?.() ?? 0;

    // 高过时节点数（与 healthCheck 阈值一致，staleness >= 0.7）
    const staleResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE n.stalenessScore >= 0.7
       RETURN count(n) AS cnt`,
    );
    const highStaleNodes = staleResult.records[0].get("cnt")?.toNumber?.() ?? 0;

    const isolatedRatio = activeNodes > 0 ? isolatedNodes / activeNodes : 0;
    const highStaleRatio = activeNodes > 0 ? highStaleNodes / activeNodes : 0;
    const transitionalRatio = activeNodes > 0 ? transitionalNodes / activeNodes : 0;
    const avgDegree = activeNodes > 0 ? inDegreeSum / activeNodes : 0;
    const K = 8;

    const connectivity = 1 - isolatedRatio;
    const density = Math.min(1, Math.log2(1 + avgDegree) / Math.log2(1 + K));
    const influence = activeNodes > 0 ? connectedNodes / activeNodes : 0;
    const freshness = 1 - highStaleRatio;
    const conflictFree = 1 - transitionalRatio;

    const score = Math.max(0, Math.min(100, Math.round(
      100 * (0.35 * connectivity + 0.25 * density + 0.20 * influence + 0.10 * freshness + 0.10 * conflictFree),
    )));

    const anomalies: string[] = [];
    if (score < scoreThreshold) anomalies.push(`评分 ${score} 低于阈值 ${scoreThreshold}`);
    if (isolatedRatio > 0.3) anomalies.push(`孤立节点比例过高 ${Math.round(isolatedRatio * 100)}% (>30%)`);

    return {
      timestamp: Date.now(),
      score,
      dims: { connectivity, density, influence, freshness, conflictFree },
      metrics: {
        activeNodes, totalEdges: inDegreeSum, isolatedNodes, isolatedRatio,
        avgDegree: Math.round(avgDegree * 100) / 100,
        avgPageRank: Math.round(avgPageRankRaw * 10000) / 10000,
        highStaleRatio: Math.round(highStaleRatio * 100) / 100,
        transitionalRatio: Math.round(transitionalRatio * 100) / 100,
      },
      sparse: score < scoreThreshold || isolatedRatio > 0.3,
      anomalies,
    };
  } finally {
    await session.close();
  }
}

/** v2.6.0: 落盘一次评分快照（GraphHealthMetric 节点，保留最近 N 条） */
export async function persistGraphHealthMetric(
  driver: Driver,
  score: GraphHealthScore,
  keep = 200,
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      `CREATE (:GraphHealthMetric {
         timestamp: $timestamp, score: $score,
         connectivity: $connectivity, density: $density,
         influence: $influence, freshness: $freshness, conflictFree: $conflictFree,
         activeNodes: $activeNodes, totalEdges: $totalEdges,
         isolatedNodes: $isolatedNodes, isolatedRatio: $isolatedRatio,
         avgDegree: $avgDegree, avgPageRank: $avgPageRank,
         highStaleRatio: $highStaleRatio, transitionalRatio: $transitionalRatio,
         sparse: $sparse
       })`,
      {
        timestamp: score.timestamp,
        score: score.score,
        connectivity: score.dims.connectivity,
        density: score.dims.density,
        influence: score.dims.influence,
        freshness: score.dims.freshness,
        conflictFree: score.dims.conflictFree,
        activeNodes: score.metrics.activeNodes,
        totalEdges: score.metrics.totalEdges,
        isolatedNodes: score.metrics.isolatedNodes,
        isolatedRatio: score.metrics.isolatedRatio,
        avgDegree: score.metrics.avgDegree,
        avgPageRank: score.metrics.avgPageRank,
        highStaleRatio: score.metrics.highStaleRatio,
        transitionalRatio: score.metrics.transitionalRatio,
        sparse: score.sparse,
      },
    );
    // 修剪：只保留最近 keep 条
    await session.run(
      `MATCH (m:GraphHealthMetric)
       WITH m ORDER BY m.timestamp DESC
       SKIP toInteger($keep)
       DELETE m`,
      { keep },
    );
  } finally {
    await session.close();
  }
}

/**
 * 图谱健康检查 — 综合统计 + 异常检测
 *
 * 异常检测项：
 * - 孤立节点比例 > 30% （孤儿过多）
 * - 高过时节点比例 > 30% （需触发主动遗忘）
 * - 平均 pagerank < 0.01 （图谱太稀疏）
 * - transitional 状态节点数 > 0 （存在未消解的冲突）
 */
export async function healthCheck(driver: Driver): Promise<GraphHealthReport> {
  const session = getSession(driver);
  const anomalies: string[] = [];

  try {
    // 节点统计
    const nodeStats = await session.run(
      `MATCH (n:Task|Skill|Event)
       RETURN count(n) AS total,
              count(CASE WHEN n.status = 'active' THEN 1 END) AS active,
              count(CASE WHEN n.state = 'superseded' THEN 1 END) AS superseded,
              count(CASE WHEN n.state = 'transitional' THEN 1 END) AS transitional`,
    );
    const nodeRec = nodeStats.records[0];
    const totalNodes = nodeRec.get("total")?.toNumber?.() ?? 0;
    const activeNodes = nodeRec.get("active")?.toNumber?.() ?? 0;
    const supersededNodes = nodeRec.get("superseded")?.toNumber?.() ?? 0;
    const transitionalNodes = nodeRec.get("transitional")?.toNumber?.() ?? 0;

    // 边统计
    const edgeStats = await session.run(
      `MATCH (:Task|Skill|Event)-[r]->(:Task|Skill|Event)
       WHERE NOT type(r) IN ['NEXT_SESSION', 'CONTAINS', 'MENTIONS']
       RETURN type(r) AS type, count(r) AS cnt`,
    );
    const byType: Record<string, number> = {};
    let totalEdges = 0;
    for (const rec of edgeStats.records) {
      const t = rec.get("type");
      const c = rec.get("cnt")?.toNumber?.() ?? 0;
      byType[t] = c;
      totalEdges += c;
    }

    // 孤立节点
    const isolatedResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE NOT (n)--(:Task|Skill|Event)
       RETURN count(n) AS cnt`,
    );
    const isolatedNodes = isolatedResult.records[0].get("cnt")?.toNumber?.() ?? 0;

    // 高过时节点
    const staleResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE n.stalenessScore >= 0.7
       RETURN count(n) AS cnt`,
    );
    const highStaleNodes = staleResult.records[0].get("cnt")?.toNumber?.() ?? 0;

    // 社区数
    const communityResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE n.communityId IS NOT NULL
       RETURN count(DISTINCT n.communityId) AS cnt`,
    );
    const communities = communityResult.records[0].get("cnt")?.toNumber?.() ?? 0;

    // PageRank 统计 + topK
    const prResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       RETURN n.id AS id, n.name AS name, n.pagerank AS pr
       ORDER BY n.pagerank DESC
       LIMIT 10`,
    );
    const topNodes: Array<{ id: string; name: string; pagerank: number }> = [];
    let prSum = 0;
    for (const rec of prResult.records) {
      const id = rec.get("id");
      const name = rec.get("name") ?? "";
      const pr = rec.get("pr")?.toNumber?.() ?? 0;
      topNodes.push({ id, name, pagerank: pr });
      prSum += pr;
    }
    const avgPageRank = activeNodes > 0 ? prSum / activeNodes : 0;

    // ── 异常检测 ──
    const isolatedRatio = activeNodes > 0 ? isolatedNodes / activeNodes : 0;
    if (isolatedRatio > 0.3) {
      anomalies.push(`孤立节点比例过高 ${Math.round(isolatedRatio * 100)}% (>30%)`);
    }
    const staleRatio = activeNodes > 0 ? highStaleNodes / activeNodes : 0;
    if (staleRatio > 0.3) {
      anomalies.push(`高过时节点比例过高 ${Math.round(staleRatio * 100)}% (>30%，建议触发主动遗忘`);
    }
    if (avgPageRank < 0.01 && activeNodes > 10) {
      anomalies.push(`平均 PageRank 过低 ${avgPageRank.toFixed(4)} (<0.01，图谱过于稀疏)`);
    }
    if (transitionalNodes > 0) {
      anomalies.push(`存在 ${transitionalNodes} 个 transitional 状态节点（冲突待消解）`);
    }

    return {
      timestamp: Date.now(),
      nodes: {
        total: totalNodes,
        active: activeNodes,
        superseded: supersededNodes,
        transitional: transitionalNodes,
      },
      edges: { total: totalEdges, byType },
      isolatedNodes,
      highStaleNodes,
      communities,
      avgPageRank,
      topNodes,
      anomalies,
    };
  } finally {
    await session.close();
  }
}
