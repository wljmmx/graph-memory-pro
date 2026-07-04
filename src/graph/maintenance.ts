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
