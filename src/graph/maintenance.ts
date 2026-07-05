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
import { detectCommunities, detectHierarchicalCommunities, summarizeCommunities, type CommunityResult } from "./community.ts";
import { dedup, type DedupResult } from "./dedup.ts";
import { getSession } from "../store/db.ts";
import { mergeNodes, saveVector, computeEmbeddingHash } from "../store/store.ts";
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
      `MATCH (msg:ConversationMessage)-[:MENTIONS]->(a:Task|Skill|Event {status: 'active'})
       MATCH (msg)-[:MENTIONS]->(b:Task|Skill|Event {status: 'active'})
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
  importance?: { scanned: number; updated: number; avgScore: number };
  conflictResolution?: { scanned: number; resolved: number; superseded: number; merged: number };
  edgeWeights?: { scanned: number; strengthened: number; decayed: number };
  reverseMemory?: { watchlistAdded: number; watchlistRemoved: number; decayed: number };
  /** G-4 嵌入版本迁移结果（Phase 11，v2.1.2 第四批补全） */
  embeddingMigration?: { distribution: Map<string, number>; cleared: number; migrated: number };
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
      importance: undefined,
      conflictResolution: undefined,
      edgeWeights: undefined,
      reverseMemory: undefined,
      embeddingMigration: undefined,
      durationMs: 0,
    };
  }
  const start = Date.now();

  // Each phase is independently try-catched so one failure doesn't break the pipeline
  let dedupResult: DedupResult = { pairs: [], merged: 0 };
  let pagerankResult: GlobalPageRankResult = { scores: new Map(), topK: [] };
  let communityResult: CommunityResult = { labels: new Map(), communities: new Map(), count: 0 };
  let communitySummaries = 0;
  let importanceResult: { scanned: number; updated: number; avgScore: number } | undefined;
  let conflictResult: { scanned: number; resolved: number; superseded: number; merged: number } | undefined;
  let edgeWeightsResult: { scanned: number; strengthened: number; decayed: number } | undefined;
  let reverseMemoryResult: { watchlistAdded: number; watchlistRemoved: number; decayed: number } | undefined;
  let migrationResultValue: { distribution: Map<string, number>; cleared: number; migrated: number } | undefined;

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

    // ── Phase 3: Community Detection（v2.1.2 第四批：S-4 层次化社区）──
    try {
      if (cfg?.hierarchicalCommunity?.enabled !== false && (cfg?.hierarchicalCommunity?.depth ?? 3) >= 2) {
        // S-4: 层次化社区检测（内部调用 detectCommunities 作为 level 1）
        const hierResult = await detectHierarchicalCommunities(driver, cfg?.hierarchicalCommunity?.depth ?? 3);
        // 从层次结果中提取 level 1 作为 communityResult（向后兼容社区摘要等后续阶段）
        const level1Labels = new Map<string, string>();
        const level1Communities = new Map<string, string[]>();
        for (const [nodeId, h] of hierResult.hierarchy) {
          level1Labels.set(nodeId, h.level1);
          if (!level1Communities.has(h.level1)) level1Communities.set(h.level1, []);
          level1Communities.get(h.level1)!.push(nodeId);
        }
        communityResult = {
          labels: level1Labels,
          communities: level1Communities,
          count: hierResult.level1Count,
        };
        console.log(
          `[graph-memory-pro] hierarchical-community: L1=${hierResult.level1Count}, L2=${hierResult.level2Count}, L3=${hierResult.level3Count}`,
        );
      } else {
        communityResult = await detectCommunities(driver);
        console.log(`[graph-memory-pro] community: ${communityResult.count} communities`);
      }
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
      _lockTimestamp = Date.now();
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
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 7: G-3 重要性评分（v2.1.2 第三批） ──
    // 依赖：S-1 updatedAt / S-3 source / validatedCount / Phase 2 PageRank
    if (cfg?.importance?.enabled !== false) {
      try {
        importanceResult = await computeImportanceScores(driver, cfg?.importance);
        console.log(
          `[graph-memory-pro] importance: scanned ${importanceResult.scanned}, updated ${importanceResult.updated}, avg=${importanceResult.avgScore.toFixed(3)}`,
        );
      } catch (err) {
        console.warn(`[graph-memory-pro] importance compute failed: ${err}`);
      }
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 8: G-2 冲突消解（v2.1.2 第四批） ──
    // 依赖：S-13 state + S-14 staleness（检测）+ 本任务（消解）
    if (cfg?.conflictResolution?.enabled !== false) {
      try {
        conflictResult = await resolveConflicts(driver, cfg?.conflictResolution, embedFn, cfg?.embedding?.model);
        console.log(
          `[graph-memory-pro] conflict-resolution: scanned ${conflictResult.scanned}, resolved ${conflictResult.resolved} (superseded=${conflictResult.superseded}, merged=${conflictResult.merged})`,
        );
      } catch (err) {
        console.warn(`[graph-memory-pro] conflict resolution failed: ${err}`);
      }
    }
    _lockTimestamp = Date.now();

    // ── Phase 9: L-3 边权重调整（v2.1.2 第四批） ──
    // 依赖：I-2 裁判反馈（JUDGED 关系）+ 冷启动期（累计反馈 >= warmupFeedbacks）
    if (cfg?.edgeWeights?.enabled !== false) {
      try {
        edgeWeightsResult = await adjustEdgeWeights(driver, cfg?.edgeWeights, cfg?.warmup?.warmupFeedbacks ?? 100);
        if (edgeWeightsResult.scanned > 0) {
          console.log(
            `[graph-memory-pro] edge-weights: scanned ${edgeWeightsResult.scanned}, strengthened ${edgeWeightsResult.strengthened}, decayed ${edgeWeightsResult.decayed}`,
          );
        }
      } catch (err) {
        console.warn(`[graph-memory-pro] edge weight adjustment failed: ${err}`);
      }
    }
    _lockTimestamp = Date.now();

    // ── Phase 10: L-4 反向记忆项（v2.1.2 第四批） ──
    // 依赖：I-2 裁判反馈（节点使用/未使用计数）+ 冷启动期
    if (cfg?.reverseMemory?.enabled !== false) {
      try {
        reverseMemoryResult = await applyReverseMemory(driver, cfg?.reverseMemory, cfg?.warmup?.warmupFeedbacks ?? 100);
        if (reverseMemoryResult.watchlistAdded > 0 || reverseMemoryResult.decayed > 0) {
          console.log(
            `[graph-memory-pro] reverse-memory: watchlist +${reverseMemoryResult.watchlistAdded}/-${reverseMemoryResult.watchlistRemoved}, decayed ${reverseMemoryResult.decayed}`,
          );
        }
      } catch (err) {
        console.warn(`[graph-memory-pro] reverse memory failed: ${err}`);
      }
    }
    _lockTimestamp = Date.now();

    // ── Phase 11: G-4 嵌入版本迁移（v2.1.2 第四批） ──
    // 检测节点 embeddingModel 分布，若存在不一致（旧模型遗留）则触发重嵌入
    // 仅在配置了 embedding.model 且启用了 evolvableEmbedding 时执行
    if (cfg?.evolvableEmbedding?.enabled !== false && cfg?.embedding?.model && embedFn) {
      try {
        const { detectAndMigrateEmbeddings } = await import("./reembed.ts");
        const migrationResult = await detectAndMigrateEmbeddings(driver, embedFn, cfg.embedding.model);
        if (migrationResult.cleared > 0 || migrationResult.migrationTriggered) {
          console.log(
            `[graph-memory-pro] embedding-migration: model=${migrationResult.configuredModel}, needs=${migrationResult.needsMigration}, cleared ${migrationResult.cleared}, triggered=${migrationResult.migrationTriggered}`,
          );
        }
        migrationResultValue = {
          distribution: migrationResult.modelDistribution,
          cleared: migrationResult.cleared,
          migrated: migrationResult.needsMigration,
        };
      } catch (err) {
        console.warn(`[graph-memory-pro] embedding migration failed: ${err}`);
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
    importance: importanceResult,
    conflictResolution: conflictResult,
    edgeWeights: edgeWeightsResult,
    reverseMemory: reverseMemoryResult,
    embeddingMigration: migrationResultValue,
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

// ── G-3 重要性评分（v2.1.2 第三批新增）──────────────────────────

export interface ImportanceConfig {
  enabled?: boolean;
  /** 各分量权重（默认 0.3/0.3/0.2/0.2，需归一化） */
  weights?: {
    recency?: number;      // 时间衰减
    frequency?: number;    // 使用频率
    centrality?: number;  // 图中心性
    source?: number;       // 来源权重
  };
  /** recency 衰减周期（天，默认 30） */
  recencyDecayDays?: number;
  /** frequency 饱和阈值（默认 10 次） */
  frequencySaturation?: number;
}

const DEFAULT_IMPORTANCE_WEIGHTS = {
  recency: 0.3,
  frequency: 0.3,
  centrality: 0.2,
  source: 0.2,
};

/**
 * 计算节点重要性评分 importanceScore ∈ [0, 1]
 *
 * 公式：importanceScore = w1·recency + w2·frequency + w3·centrality + w4·source
 *   - recency:    1 - min(ageDays, decayDays) / decayDays   （30 天线性衰减）
 *   - frequency:  min(validatedCount / saturation, 1)         （10 次饱和）
 *   - centrality: pagerank / max(pagerank)                   （归一化）
 *   - source:     knowledge=1.0, experience=0.7, imported=0.5
 *
 * 与 stalenessScore 互补：
 *   - stalenessScore 衡量"是否过时"（越高越糟）
 *   - importanceScore 衡量"是否有价值"（越高越值得召回）
 *
 * 召回排序加权：score × importanceScore × (1 - stalenessScore)
 */
export async function computeImportanceScores(
  driver: Driver,
  cfg?: ImportanceConfig,
): Promise<{ scanned: number; updated: number; avgScore: number }> {
  const session = getSession(driver);
  const weights = {
    recency: cfg?.weights?.recency ?? DEFAULT_IMPORTANCE_WEIGHTS.recency,
    frequency: cfg?.weights?.frequency ?? DEFAULT_IMPORTANCE_WEIGHTS.frequency,
    centrality: cfg?.weights?.centrality ?? DEFAULT_IMPORTANCE_WEIGHTS.centrality,
    source: cfg?.weights?.source ?? DEFAULT_IMPORTANCE_WEIGHTS.source,
  };
  // 归一化权重，避免配置漂移
  const wSum = weights.recency + weights.frequency + weights.centrality + weights.source;
  const w = {
    recency: weights.recency / wSum,
    frequency: weights.frequency / wSum,
    centrality: weights.centrality / wSum,
    source: weights.source / wSum,
  };
  const decayDays = cfg?.recencyDecayDays ?? 30;
  const freqSat = cfg?.frequencySaturation ?? 10;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  try {
    // 先查询 max pagerank 用于 centrality 归一化
    const maxPrResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       RETURN max(n.pagerank) AS maxPr`,
    );
    const maxPr = maxPrResult.records[0]?.get("maxPr")?.toNumber?.() ?? 0;

    const result = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       RETURN n.id AS id,
              n.updatedAt AS updatedAt,
              n.validatedCount AS validatedCount,
              n.pagerank AS pagerank,
              n.source AS source`,
    );

    let updated = 0;
    let scoreSum = 0;
    for (const rec of result.records) {
      const id = rec.get("id");
      const updatedAt = rec.get("updatedAt")?.toNumber?.() ?? now;
      const validatedCount = rec.get("validatedCount")?.toNumber?.() ?? 0;
      const pagerank = rec.get("pagerank")?.toNumber?.() ?? 0;
      const source = rec.get("source") ?? "experience";

      const ageDays = Math.max(0, (now - updatedAt) / DAY_MS);
      const recency = Math.max(0, 1 - Math.min(ageDays, decayDays) / decayDays);
      const frequency = Math.min(validatedCount / freqSat, 1);
      const centrality = maxPr > 0 ? Math.max(0, Math.min(pagerank / maxPr, 1)) : 0;
      const sourceWeight = source === "knowledge" ? 1.0
        : source === "imported" ? 0.5
        : 0.7; // experience (默认)

      const score = w.recency * recency
        + w.frequency * frequency
        + w.centrality * centrality
        + w.source * sourceWeight;

      await session.run(
        `MATCH (n:Task|Skill|Event {id: $id})
         SET n.importanceScore = $score`,
        { id, score: Number(score.toFixed(3)) },
      );
      scoreSum += score;
      updated++;
    }

    const avgScore = updated > 0 ? scoreSum / updated : 0;
    return { scanned: updated, updated, avgScore };
  } finally {
    await session.close();
  }
}

// ── G-2 冲突消解（v2.1.2 第四批新增）──────────────────────────

export interface ConflictResolutionConfig {
  enabled?: boolean;
  /** 来源优先级权重：knowledge > experience > imported */
  sourcePriority?: boolean;
  /** 时态优先（validFrom 更新者胜出） */
  temporalPriority?: boolean;
  /** 置信度优先（validatedCount 高者胜出） */
  confidencePriority?: boolean;
}

/**
 * 冲突消解策略（A-TMA 三层故障模型的 Cognition + Action 层）
 *
 * 检测：S-13（state=transitional）+ S-14（stalenessScore 高）
 * 消解策略（按优先级，纯规则无 LLM 成本）：
 *   1. 时态优先：validFrom 更新的胜出，旧节点 state → superseded
 *   2. 来源优先：source=knowledge > experience > imported
 *   3. 置信度优先：validatedCount 高的胜出
 *   4. 合并：两节点可合并时（同 type + 名称相似），保留主节点合并描述
 *
 * 消解决策写入 GmDecision 节点（可追溯）
 */
export async function resolveConflicts(
  driver: Driver,
  cfg?: ConflictResolutionConfig,
  embedFn?: EmbedFn,
  embeddingModel?: string,
): Promise<{ scanned: number; resolved: number; superseded: number; merged: number }> {
  const session = getSession(driver);
  try {
    // 扫描 transitional 状态的节点对（潜在冲突）
    // 启发式：找到 name 相同但 state=transitional 的节点对
    const conflicts = await session.run(
      `MATCH (a:Task|Skill|Event), (b:Task|Skill|Event)
       WHERE a.name = b.name
         AND a.id < b.id
         AND (a.state = 'transitional' OR b.state = 'transitional'
              OR a.stalenessScore > 0.7 OR b.stalenessScore > 0.7)
         AND a.status = 'active' AND b.status = 'active'
       RETURN a.id AS aId, a.validFrom AS aValidFrom, a.source AS aSource,
              a.validatedCount AS aValidatedCount, a.stalenessScore AS aStaleness,
              a.content AS aContent, a.type AS aType,
              b.id AS bId, b.validFrom AS bValidFrom, b.source AS bSource,
              b.validatedCount AS bValidatedCount, b.stalenessScore AS bStaleness,
              b.content AS bContent, b.type AS bType
       LIMIT 100`,
    );

    let resolved = 0;
    let superseded = 0;
    let merged = 0;

    for (const rec of conflicts.records) {
      const aId = rec.get("aId");
      const bId = rec.get("bId");
      const aValidFrom = rec.get("aValidFrom")?.toNumber?.() ?? 0;
      const bValidFrom = rec.get("bValidFrom")?.toNumber?.() ?? 0;
      const aSource = rec.get("aSource") ?? "experience";
      const bSource = rec.get("bSource") ?? "experience";
      const aValidated = rec.get("aValidatedCount")?.toNumber?.() ?? 0;
      const bValidated = rec.get("bValidatedCount")?.toNumber?.() ?? 0;
      const aStaleness = rec.get("aStaleness")?.toNumber?.() ?? 0;
      const bStaleness = rec.get("bStaleness")?.toNumber?.() ?? 0;
      const aType = rec.get("aType");
      const bType = rec.get("bType");

      // 类型不同，不视为冲突
      if (aType !== bType) continue;

      // 决定胜者（winner）与败者（loser）
      let winnerId = aId;
      let loserId = bId;
      let decision = "temporal"; // 默认时态优先

      // 策略 1: 时态优先（validFrom 更新者胜出）
      if (cfg?.temporalPriority !== false) {
        if (bValidFrom > aValidFrom) {
          winnerId = bId;
          loserId = aId;
          decision = "temporal";
        } else if (aValidFrom > bValidFrom) {
          winnerId = aId;
          loserId = bId;
          decision = "temporal";
        } else {
          // validFrom 相同，进入策略 2
          // 策略 2: 来源优先
          const sourceRank = (s: string): number =>
            s === "knowledge" ? 3 : s === "experience" ? 2 : 1;
          if (cfg?.sourcePriority !== false && sourceRank(bSource) > sourceRank(aSource)) {
            winnerId = bId;
            loserId = aId;
            decision = "source";
          } else if (cfg?.sourcePriority !== false && sourceRank(aSource) > sourceRank(bSource)) {
            winnerId = aId;
            loserId = bId;
            decision = "source";
          } else {
            // 策略 3: 置信度优先
            if (cfg?.confidencePriority !== false && bValidated > aValidated * 1.5) {
              winnerId = bId;
              loserId = aId;
              decision = "confidence";
            } else if (cfg?.confidencePriority !== false && aValidated > bValidated * 1.5) {
              winnerId = aId;
              loserId = bId;
              decision = "confidence";
            } else {
              // 策略 4: 合并（同 type + 名相同 → 按 validatedCount 选择 winner，合并 content）
              // 修复旧实现 a 总是 winner 的偏向：比较 validatedCount/stalenessScore 综合选择
              const aScore = aValidated * (1 - aStaleness);
              const bScore = bValidated * (1 - bStaleness);
              const mergeWinnerId = bScore > aScore ? bId : aId;
              const mergeLoserId = bScore > aScore ? aId : bId;
              const mergedContent = [rec.get("aContent"), rec.get("bContent")]
                .filter(Boolean)
                .join("\n---\n");
              const mergeSetResult = await session.run(
                `MATCH (winner:Task|Skill|Event {id: $winnerId})
                 SET winner.content = $mergedContent,
                     winner.state = 'current',
                     winner.stalenessScore = 0.0
                 RETURN winner.name AS name, winner.description AS description`,
                { winnerId: mergeWinnerId, mergedContent },
              );
              await mergeNodes(driver, mergeWinnerId, mergeLoserId);
              if (embedFn) {
                const winnerName = mergeSetResult.records[0]?.get("name") ?? "";
                const winnerDesc = mergeSetResult.records[0]?.get("description") ?? "";
                const vec = await embedFn(mergedContent);
                if (vec && vec.length > 0) {
                  await saveVector(driver, mergeWinnerId, vec, computeEmbeddingHash(winnerName, winnerDesc, mergedContent), embeddingModel);
                }
              }
              merged++;
              resolved++;
              continue;
            }
          }
        }
      }

      // 时态/来源/置信度消解：败者标记为 superseded
      const finalWinner = winnerId;
      const finalLoser = loserId;

      // 失败者的边降权，但不物理删除（保留可追溯）
      await session.run(
        `MATCH (loser:Task|Skill|Event {id: $loserId}),
               (winner:Task|Skill|Event {id: $winnerId})
         SET loser.state = 'superseded',
             loser.validTo = timestamp(),
             loser.supersededBy = $winnerId,
             loser.stalenessScore = 1.0
         WITH loser
         MATCH (loser)-[r]->()
         WHERE NOT type(r) IN ['NEXT_SESSION', 'CONTAINS']
         SET r.weight = r.weight * 0.1`,
        { loserId: finalLoser, winnerId: finalWinner },
      );

      // 写入 GmDecision 节点（可追溯）
      await session.run(
        `CREATE (d:GmDecision {
           id: 'decision-' + toString(timestamp()) + '-' + toString(rand()),
           type: 'conflict-resolution',
           decision: $decision,
           winnerId: $winnerId,
           loserId: $loserId,
           timestamp: timestamp(),
           reason: $reason
         })`,
        {
          decision,
          winnerId: finalWinner,
          loserId: finalLoser,
          reason: `staleness: a=${aStaleness.toFixed(2)}, b=${bStaleness.toFixed(2)}; validated: a=${aValidated}, b=${bValidated}; source: a=${aSource}, b=${bSource}`,
        },
      );

      superseded++;
      resolved++;
    }

    return { scanned: conflicts.records.length, resolved, superseded, merged };
  } finally {
    await session.close();
  }
}

// ── L-3 边权重调整（v2.1.2 第四批新增）──────────────────────────

export interface EdgeWeightsConfig {
  enabled?: boolean;
  /** 被裁判标记为"有效"的边 weight 强化系数（默认 1.1） */
  strengthenFactor?: number;
  /** 未使用的边 weight 衰减系数（默认 0.95） */
  decayFactor?: number;
  /** weight 最小值（避免衰减到 0） */
  minWeight?: number;
  /** weight 最大值（避免强化过度） */
  maxWeight?: number;
}

/**
 * 根据裁判反馈调整边权重
 *
 * 规则：
 *   - 被裁判标记为"有效"的召回路径上的边 weight × strengthenFactor
 *   - 被裁判标记为"未使用"的召回路径上的边 weight × decayFactor
 *   - 与 GDS 投影协同：下一个维护周期重建投影时生效
 *   - 冷启动：累计反馈数 < warmupFeedbacks 时不调整
 */
export async function adjustEdgeWeights(
  driver: Driver,
  cfg?: EdgeWeightsConfig,
  warmupFeedbacks?: number,
): Promise<{ scanned: number; strengthened: number; decayed: number }> {
  // 冷启动检查
  const feedbackCount = await getFeedbackCountInternal(driver);
  if (feedbackCount < (warmupFeedbacks ?? 100)) {
    return { scanned: 0, strengthened: 0, decayed: 0 };
  }

  const session = getSession(driver);
  const strengthenFactor = cfg?.strengthenFactor ?? 1.1;
  const decayFactor = cfg?.decayFactor ?? 0.95;
  const minWeight = cfg?.minWeight ?? 0.1;
  const maxWeight = cfg?.maxWeight ?? 5.0;

  try {
    // 查询被使用节点与召回节点之间的边（强化）
    // 仅强化 used-used 节点对之间的边（修复旧实现 j2 未过滤 verdict 导致 used-unused 边也被强化的缺陷）
    const strengthenResult = await session.run(
      `MATCH (f:GmFeedback)-[j1:JUDGED {verdict: 'used'}]->(used:Task|Skill|Event)
       MATCH (f)-[j2:JUDGED {verdict: 'used'}]->(recalled:Task|Skill|Event)
       WHERE recalled.id <> used.id
       MATCH (used)-[r]-(recalled)
       WHERE NOT type(r) IN ['NEXT_SESSION', 'CONTAINS']
       WITH r, count(DISTINCT f) AS usageCount
       SET r.weight = CASE
         WHEN COALESCE(r.weight, 1.0) * $factor * (1 + usageCount * 0.05) > $max THEN $max
         ELSE COALESCE(r.weight, 1.0) * $factor * (1 + usageCount * 0.05)
       END,
       r.updatedAt = timestamp()
       RETURN count(DISTINCT r) AS strengthened`,
      { factor: strengthenFactor, max: maxWeight },
    );
    const strengthened = strengthenResult.records[0]?.get("strengthened")?.toNumber?.() ?? 0;

    // 衰减从未被使用的召回节点之间的边
    const decayResult = await session.run(
      `MATCH (f:GmFeedback)-[j:JUDGED {verdict: 'unused'}]->(unused:Task|Skill|Event)
       MATCH (unused)-[r]-()
       WHERE NOT type(r) IN ['NEXT_SESSION', 'CONTAINS']
         AND r.weight > $min
       WITH r, count(DISTINCT f) AS unusedCount
       SET r.weight = CASE
         WHEN COALESCE(r.weight, 1.0) * $factor < $min THEN $min
         ELSE COALESCE(r.weight, 1.0) * $factor
       END,
       r.updatedAt = timestamp()
       RETURN count(DISTINCT r) AS decayed`,
      { factor: decayFactor, min: minWeight },
    );
    const decayed = decayResult.records[0]?.get("decayed")?.toNumber?.() ?? 0;

    return {
      scanned: strengthened + decayed,
      strengthened,
      decayed,
    };
  } finally {
    await session.close();
  }
}

// ── L-4 反向记忆项（v2.1.2 第四批新增）──────────────────────────

export interface ReverseMemoryConfig {
  enabled?: boolean;
  /** 召回频次阈值（被召回 N 次但从未被标记为有效 → 进入观察列表） */
  recallThreshold?: number;
  /** 观察列表中节点的 stalenessScore 增量 */
  stalenessPenalty?: number;
  /** importanceScore 下限（低于此值 + 召回频次高 → 进入观察列表） */
  importanceFloor?: number;
}

/**
 * 反向记忆项：弱化"频繁召回但从未被裁判标记为有效"的节点
 *
 * 算法：
 *   - 查询每个节点的"召回频次 vs 有效频次"比值
 *   - 比值 > recallThreshold（召回 10 次以上但从未有效）→ stalenessScore += 0.1
 *   - 与 S-14 过时检测协同：stalenessScore 高的节点在召回时降权
 *   - 冷启动：累计反馈数 < warmupFeedbacks 时不调整
 */
export async function applyReverseMemory(
  driver: Driver,
  cfg?: ReverseMemoryConfig,
  warmupFeedbacks?: number,
): Promise<{ watchlistAdded: number; watchlistRemoved: number; decayed: number }> {
  // 冷启动检查
  const feedbackCount = await getFeedbackCountInternal(driver);
  if (feedbackCount < (warmupFeedbacks ?? 100)) {
    return { watchlistAdded: 0, watchlistRemoved: 0, decayed: 0 };
  }

  const session = getSession(driver);
  const recallThreshold = cfg?.recallThreshold ?? 10;
  const stalenessPenalty = cfg?.stalenessPenalty ?? 0.1;
  const importanceFloor = cfg?.importanceFloor ?? 0.2;

  try {
    // 查询频繁召回但从未有效的节点
    // 简化：JUDGED 关系中 recalledNodeIds 包含该节点，但 verdict=used 从未命中
    const candidates = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       OPTIONAL MATCH (f:GmFeedback)-[j:JUDGED {verdict: 'unused'}]->(n)
       WITH n, count(DISTINCT f) AS unusedCount
       WHERE unusedCount >= $threshold
         AND coalesce(n.importanceScore, 0) < $floor
       RETURN n.id AS id, n.stalenessScore AS staleness, n.importanceScore AS importance, unusedCount
       LIMIT 200`,
      { threshold: recallThreshold, floor: importanceFloor },
    );

    let decayed = 0;
    for (const rec of candidates.records) {
      const id = rec.get("id");
      const currentStaleness = rec.get("staleness")?.toNumber?.() ?? 0;
      const newStaleness = Math.min(1.0, currentStaleness + stalenessPenalty);

      await session.run(
        `MATCH (n:Task|Skill|Event {id: $id})
         SET n.stalenessScore = $newStaleness,
             n.state = CASE WHEN $newStaleness > 0.9 THEN 'transitional' ELSE n.state END`,
        { id, newStaleness },
      );
      decayed++;
    }

    // 移除观察列表：曾经被标记为有效 → 重置 stalenessScore
    const recovered = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active', state: 'transitional'})
       MATCH (f:GmFeedback)-[j:JUDGED {verdict: 'used'}]->(n)
       WHERE f.timestamp > n.updatedAt
       WITH DISTINCT n
       SET n.stalenessScore = 0.0,
           n.state = 'current'
       RETURN count(n) AS recovered`,
    );
    const watchlistRemoved = recovered.records[0]?.get("recovered")?.toNumber?.() ?? 0;

    return {
      watchlistAdded: decayed,
      watchlistRemoved,
      decayed,
    };
  } finally {
    await session.close();
  }
}

// ── 辅助函数 ──────────────────────────────────────

/** 查询反馈总数（冷启动计数） */
async function getFeedbackCountInternal(driver: Driver): Promise<number> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (f:GmFeedback) RETURN count(f) AS c",
    );
    return result.records[0]?.get("c")?.toNumber?.() ?? 0;
  } finally {
    await session.close();
  }
}
