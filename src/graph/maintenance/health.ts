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
