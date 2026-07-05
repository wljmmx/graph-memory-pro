/**
 * graph-memory-pro — 图谱维护
 *
 * ✅ 并发保护：模块级 mutex，含超时机制防止挂死
 * ✅ 每阶段独立 try-catch，单步失败不影响其他
 *
 * 拆分说明（v2.1.2 重构）：
 *   - 本文件保留主入口 runMaintenance + 模块级锁 + Phase 0 边推导
 *   - 各 Phase 子任务拆分到 ./maintenance/*.ts 子模块
 *   - 通过 barrel 重新导出，保持向后兼容（外部 import 路径不变）
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { computeGlobalPageRank, type GlobalPageRankResult } from "./pagerank.ts";
import { detectCommunities, detectHierarchicalCommunities, summarizeCommunities, type CommunityResult } from "./community.ts";
import { dedup, type DedupResult } from "./dedup.ts";
import { getSession } from "../store/db.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("maintenance");

// ── 子模块函数 import（用于 runMaintenance 编排） ───────────────
import { computeStalenessScores } from "./maintenance/staleness.ts";
import { healthCheck } from "./maintenance/health.ts";
import { computeImportanceScores } from "./maintenance/importance.ts";
import { resolveConflicts } from "./maintenance/conflict.ts";
import { adjustEdgeWeights } from "./maintenance/edge-weights.ts";
import { applyReverseMemory } from "./maintenance/reverse-memory.ts";

// ── Barrel：重新导出子模块公共 API（保持向后兼容） ──────────────
export { computeStalenessScores } from "./maintenance/staleness.ts";
export { healthCheck, type GraphHealthReport } from "./maintenance/health.ts";
export { computeImportanceScores, type ImportanceConfig } from "./maintenance/importance.ts";
export { resolveConflicts, type ConflictResolutionConfig } from "./maintenance/conflict.ts";
export { adjustEdgeWeights, type EdgeWeightsConfig } from "./maintenance/edge-weights.ts";
export { applyReverseMemory, type ReverseMemoryConfig } from "./maintenance/reverse-memory.ts";

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
    log.info("repair relates_to: edges created", { edges: created });
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
      log.warn("maintenance lock stale, force-releasing");
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
    log.info("maintenance already running, skip");
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
      log.info("repair edges: created", { created: edgeResult.relatesToCreated });
    } catch (err) {
      log.warn("repair edges failed", { error: String(err) });
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 1: Dedup ──
    try {
      dedupResult = await dedup(driver, cfg);
      log.info("dedup: merged", { merged: dedupResult.merged, pairs: dedupResult.pairs.length });
    } catch (err) {
      log.warn("dedup failed", { error: String(err) });
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 2: PageRank ──
    try {
      pagerankResult = await computeGlobalPageRank(driver, cfg);
      log.info("pagerank: topK", { topK: pagerankResult.topK.length });
    } catch (err) {
      log.warn("pagerank failed", { error: String(err) });
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
        log.info(
          "hierarchical-community",
          { L1: hierResult.level1Count, L2: hierResult.level2Count, L3: hierResult.level3Count },
        );
      } else {
        communityResult = await detectCommunities(driver);
        log.info("community: communities", { communities: communityResult.count });
      }
    } catch (err) {
      log.warn("community failed", { error: String(err) });
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 4: Community Summaries (optional, needs LLM) ──
    if (llm && communityResult.communities.size > 0) {
      try {
        communitySummaries = await summarizeCommunities(driver, communityResult.communities, llm, embedFn);
        log.info("community summaries", { count: communitySummaries });
      } catch (err) {
        log.warn("community summaries failed", { error: String(err) });
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
        log.warn("staleness compute failed", { error: String(err) });
      }
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 6: G-5 健康检查（v2.1.2，告警输出） ──
    if (cfg?.graphHealth?.enabled !== false) {
      try {
        const report = await healthCheck(driver);
        if (report.anomalies.length > 0 && cfg?.graphHealth?.alertOnAnomaly !== false) {
          log.warn("health anomalies", { anomalies: report.anomalies });
        } else if (report.anomalies.length === 0) {
          log.info("health: OK", { activeNodes: report.nodes.active, edges: report.edges.total });
        }
      } catch (err) {
        log.warn("health check failed", { error: String(err) });
      }
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 7: G-3 重要性评分（v2.1.2 第三批） ──
    // 依赖：S-1 updatedAt / S-3 source / validatedCount / Phase 2 PageRank
    if (cfg?.importance?.enabled !== false) {
      try {
        importanceResult = await computeImportanceScores(driver, cfg?.importance);
        log.info(
          "importance",
          {
            scanned: importanceResult.scanned,
            updated: importanceResult.updated,
            avg: importanceResult.avgScore.toFixed(3),
          },
        );
      } catch (err) {
        log.warn("importance compute failed", { error: String(err) });
      }
    }
    _lockTimestamp = Date.now(); // refresh lock

    // ── Phase 8: G-2 冲突消解（v2.1.2 第四批） ──
    // 依赖：S-13 state + S-14 staleness（检测）+ 本任务（消解）
    if (cfg?.conflictResolution?.enabled !== false) {
      try {
        conflictResult = await resolveConflicts(driver, cfg?.conflictResolution);
        log.info(
          "conflict-resolution",
          {
            scanned: conflictResult.scanned,
            resolved: conflictResult.resolved,
            superseded: conflictResult.superseded,
            merged: conflictResult.merged,
          },
        );
      } catch (err) {
        log.warn("conflict resolution failed", { error: String(err) });
      }
    }
    _lockTimestamp = Date.now();

    // ── Phase 9: L-3 边权重调整（v2.1.2 第四批） ──
    // 依赖：I-2 裁判反馈（JUDGED 关系）+ 冷启动期（累计反馈 >= warmupFeedbacks）
    if (cfg?.edgeWeights?.enabled !== false) {
      try {
        edgeWeightsResult = await adjustEdgeWeights(driver, cfg?.edgeWeights, cfg?.warmup?.warmupFeedbacks ?? 100);
        if (edgeWeightsResult.scanned > 0) {
          log.info(
            "edge-weights",
            {
              scanned: edgeWeightsResult.scanned,
              strengthened: edgeWeightsResult.strengthened,
              decayed: edgeWeightsResult.decayed,
            },
          );
        }
      } catch (err) {
        log.warn("edge weight adjustment failed", { error: String(err) });
      }
    }
    _lockTimestamp = Date.now();

    // ── Phase 10: L-4 反向记忆项（v2.1.2 第四批） ──
    // 依赖：I-2 裁判反馈（节点使用/未使用计数）+ 冷启动期
    if (cfg?.reverseMemory?.enabled !== false) {
      try {
        reverseMemoryResult = await applyReverseMemory(driver, cfg?.reverseMemory, cfg?.warmup?.warmupFeedbacks ?? 100);
        if (reverseMemoryResult.watchlistAdded > 0 || reverseMemoryResult.decayed > 0) {
          log.info(
            "reverse-memory",
            {
              watchlistAdded: reverseMemoryResult.watchlistAdded,
              watchlistRemoved: reverseMemoryResult.watchlistRemoved,
              decayed: reverseMemoryResult.decayed,
            },
          );
        }
      } catch (err) {
        log.warn("reverse memory failed", { error: String(err) });
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
          log.info(
            "embedding-migration",
            {
              model: migrationResult.configuredModel,
              needs: migrationResult.needsMigration,
              cleared: migrationResult.cleared,
              triggered: migrationResult.migrationTriggered,
            },
          );
        }
        migrationResultValue = {
          distribution: migrationResult.modelDistribution,
          cleared: migrationResult.cleared,
          migrated: migrationResult.needsMigration,
        };
      } catch (err) {
        log.warn("embedding migration failed", { error: String(err) });
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
