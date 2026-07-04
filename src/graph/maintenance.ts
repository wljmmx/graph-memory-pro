/**
 * graph-memory-pro — 图谱维护
 *
 * ✅ 并发保护：模块级 mutex，含超时机制防止挂死
 * ✅ 每阶段独立 try-catch，单步失败不影响其他
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { computeGlobalPageRank, type GlobalPageRankResult } from "./pagerank.ts";
import { detectCommunities, summarizeCommunities, type CommunityResult } from "./community.ts";
import { dedup, type DedupResult } from "./dedup.ts";
import { getSession } from "../store/db.ts";
export interface RepairEdgeResult {
  relatesToCreated: number;
  messageCount: number;
}

/**
 * 从 MENTIONS 关系推导 RELATES_TO 共现边
 *
 * 同一消息同时 MENTIONS 了两个实体 → 实体间建 RELATES_TO。
 * 一条消息提到 N 个实体 => C(N,2) 条边。
 * 用 MERGE 避免重复。
 */
async function deriveRelatesFromMentions(
  driver: Driver,
): Promise<RepairEdgeResult> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (msg:ConversationMessage)-[:MENTIONS]->(a:Task|Skill|Event {status: active})
       MATCH (msg)-[:MENTIONS]->(b:Task|Skill|Event {status: active})
       WHERE a.id < b.id
       WITH a, b, count(DISTINCT msg) AS coOccur
       MERGE (a)-[r:RELATES_TO]->(b)
       SET r.weight = coOccur,
           r.fromId = a.id,
           r.toId = b.id,
           r.updatedAt = timestamp()
       WITH count(DISTINCT r) AS created
       RETURN created`
    );
    const created = result.records[0]?.get("created")?.toNumber?.() ?? 0;
    console.log(`[graph-memory-pro] repair relates_to: ${created} edges created`);
    return { relatesToCreated: created, messageCount: 0 };
  } finally {
    await session.close();
  }
}

export interface MaintenanceResult {
  dedup: DedupResult;
  pagerank: GlobalPageRankResult;
  community: CommunityResult;
  communitySummaries: number;
  durationMs: number;
}

// ─── 并发互斥锁（带超时重置） ──────────────────────────────
let _maintenanceRunning = false;
const LOCK_TIMEOUT_MS = 120_000; // 2 min lock max
let _lockTimestamp = 0;

function tryAcquireLock(): boolean {
  // Force-release if lock held beyond timeout
  if (_maintenanceRunning) {
    if (Date.now() - _lockTimestamp > LOCK_TIMEOUT_MS) {
      console.warn("[graph-memory-pro] maintenance lock stale, force-releasing");
      _maintenanceRunning = false;
    } else {
      return false;
    }
  }
  _maintenanceRunning = true;
  _lockTimestamp = Date.now();
  return true;
}

function releaseLock(): void {
  _maintenanceRunning = false;
  _lockTimestamp = 0;
}

export async function runMaintenance(
  driver: Driver, cfg: GmConfig, llm?: CompleteFn, embedFn?: EmbedFn,
): Promise<MaintenanceResult> {
  if (!tryAcquireLock()) {
    console.log("[graph-memory-pro] maintenance already running, skip");
    return {
      dedup: { pairs: [], merged: 0 },
      pagerank: { scores: new Map(), topK: [] },
      community: { labels: new Map(), communities: new Map(), count: 0 },
      communitySummaries: 0,
      durationMs: 0,
    };
  }
  const start = Date.now();

  // Each phase is independently try-catched so one failure doesn't break the pipeline
  let dedupResult: DedupResult = { pairs: [], merged: 0 };
  let pagerankResult: GlobalPageRankResult = { scores: new Map(), topK: [] };
  let communityResult: CommunityResult = { labels: new Map(), communities: new Map(), count: 0 };
  let communitySummaries = 0;

  try {
    // ── Phase 0: Derive RELATES_TO from MENTIONS co-occurrence ──
    try {
      const edgeResult = await deriveRelatesFromMentions(driver);
      console.log(`[graph-memory-pro] repair edges: ${edgeResult.relatesToCreated} created`);
    } catch (err) {
      console.warn(`[graph-memory-pro] repair edges failed: ${err}`);
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 1: Dedup ──
    try {
      dedupResult = await dedup(driver, cfg);
      console.log(`[graph-memory-pro] dedup: ${dedupResult.merged} merged, ${dedupResult.pairs.length} pairs`);
    } catch (err) {
      console.warn(`[graph-memory-pro] dedup failed: ${err}`);
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 2: PageRank ──
    try {
      pagerankResult = await computeGlobalPageRank(driver, cfg);
      console.log(`[graph-memory-pro] pagerank: ${pagerankResult.topK.length} topK`);
    } catch (err) {
      console.warn(`[graph-memory-pro] pagerank failed: ${err}`);
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 3: Community Detection ──
    try {
      communityResult = await detectCommunities(driver);
      console.log(`[graph-memory-pro] community: ${communityResult.count} communities`);
    } catch (err) {
      console.warn(`[graph-memory-pro] community failed: ${err}`);
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 4: Community Summaries (optional, needs LLM) ──
    if (llm && communityResult.communities.size > 0) {
      try {
        communitySummaries = await summarizeCommunities(driver, communityResult.communities, llm, embedFn);
        console.log(`[graph-memory-pro] community summaries: ${communitySummaries}`);
      } catch (err) {
        console.warn(`[graph-memory-pro] community summaries failed: ${err}`);
      }
    }

    // ── Phase 5: S-14 Staleness 重算（v2.1.2，默认开启） ──
    if (cfg?.staleness?.enabled !== false) {
      try {
        await computeStalenessScores(driver, {
          halfLifeDays: 90,
          threshold: cfg?.staleness?.threshold ?? 0.7,
        });
      } catch (err) {
        console.warn(`[graph-memory-pro] staleness compute failed: ${err}`);
      }
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 6: G-5 健康检查（v2.1.2，告警输出） ──
    if (cfg?.graphHealth?.enabled !== false) {
      try {
        const report = await healthCheck(driver);
        if (report.anomalies.length > 0 && cfg?.graphHealth?.alertOnAnomaly !== false) {
          console.warn(`[graph-memory-pro] health anomalies: ${report.anomalies.join("; ")}`);
        } else if (report.anomalies.length === 0) {
          console.log(`[graph-memory-pro] health: OK, ${report.nodes.active} active nodes, ${report.edges.total} edges`);
        }
      } catch (err) {
        console.warn(`[graph-memory-pro] health check failed: ${err}`);
      }
    }

  } finally {
    releaseLock();
  }

  return {
    dedup: dedupResult,
    pagerank: pagerankResult,
    community: communityResult,
    communitySummaries,
    durationMs: Date.now() - start,
  };
}

// ── S-14 过时检测（v2.1.2 新增）─────────────────────────────────

/**
 * 计算 stalenessScore（0=新鲜，1=完全过时）
 *
 * 启发式规则（heuristic 模式）：
 * - 90 天未更新 +0.3
 * - 6 个月未更新 +0.5
 * - 1 年未更新 +0.8
 * - state=superseded 直接 1.0
 * - 无入边（孤立）+0.2
 * - 来源为 knowledge 减 0.1（外部权威知识更稳定）
 *
 * @param halfLifeDays 衰减半周期，默认 90 天
 */
export async function computeStalenessScores(
  driver: Driver,
  opts?: { halfLifeDays?: number; threshold?: number },
): Promise<{ scanned: number; updated: number; highStaleCount: number }> {
  const session = getSession(driver);
  const halfLifeDays = opts?.halfLifeDays ?? 90;
  const threshold = opts?.threshold ?? 0.7;
  const now = Date.now();

  try {
    // 启发式：基于 updatedAt、入度、state、source 计算
    const result = await session.run(
      `MATCH (n:Task|Skill|Event)
       WHERE n.status = 'active'
       OPTIONAL MATCH (n)<-[r]-()
       WITH n, count(r) AS inDegree
       RETURN n.id AS id,
              n.updatedAt AS updatedAt,
              n.state AS state,
              n.source AS source,
              inDegree`,
    );

    let updated = 0;
    let highStaleCount = 0;
    for (const rec of result.records) {
      const id = rec.get("id");
      const updatedAt = rec.get("updatedAt")?.toNumber?.() ?? now;
      const state = rec.get("state");
      const source = rec.get("source");
      const inDegree = rec.get("inDegree")?.toNumber?.() ?? 0;

      let score = 0;
      if (state === "superseded") {
        score = 1.0;
      } else {
        const ageMs = now - updatedAt;
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        if (ageDays > 365) score += 0.8;
        else if (ageDays > 180) score += 0.5;
        else if (ageDays > 90) score += 0.3;
        else if (ageDays > halfLifeDays / 2) {
          // 半衰期线性插值
          score += 0.1 + 0.2 * (ageDays - halfLifeDays / 2) / (halfLifeDays / 2);
        }
        if (inDegree === 0) score += 0.2;
        if (source === "knowledge") score -= 0.1;
        score = Math.max(0, Math.min(1, score));
      }

      await session.run(
        `MATCH (n:Task|Skill|Event {id: $id})
         SET n.stalenessScore = $score`,
        { id, score: Number(score.toFixed(3)) },
      );
      if (score > threshold) highStaleCount++;
      updated++;
    }

    console.log(
      `[graph-memory-pro] staleness: scanned ${updated}, high-stale(>${threshold}) ${highStaleCount}`,
    );
    return { scanned: updated, updated, highStaleCount };
  } finally {
    await session.close();
  }
}

// ── G-5 图谱健康指标（v2.1.2 新增）───────────────────────────────

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
