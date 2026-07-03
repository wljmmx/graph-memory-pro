import fs from 'fs';
const code = `/**
 * graph-memory-pro — 图谱维护
 *
 * 调用时机：session_end（finalize 之后）
 * 执行顺序：去重 → 全局 PageRank → 社区检测 → 社区描述
 *
 * ✅ 并发保护：模块级 mutex 防止 session_end 和 gm_maintain 同时执行
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { computeGlobalPageRank, type GlobalPageRankResult } from "./pagerank.ts";
import { detectCommunities, summarizeCommunities, type CommunityResult } from "./community.ts";
import { dedup, type DedupResult } from "./dedup.ts";

export interface MaintenanceResult {
  dedup: DedupResult;
  pagerank: GlobalPageRankResult;
  community: CommunityResult;
  communitySummaries: number;
  durationMs: number;
}

// ─── 并发互斥锁 ────────────────────────────────────────────
let _maintenanceRunning = false;

function tryAcquireLock(): boolean {
  if (_maintenanceRunning) return false;
  _maintenanceRunning = true;
  return true;
}

function releaseLock(): void {
  _maintenanceRunning = false;
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
  try {
    const dedupResult = await dedup(driver, cfg);
    const pagerankResult = await computeGlobalPageRank(driver, cfg);
    const communityResult = await detectCommunities(driver);

    let communitySummaries = 0;
    if (llm && communityResult.communities.size > 0) {
      try {
        communitySummaries = await summarizeCommunities(driver, communityResult.communities, llm, embedFn);
      } catch {}
    }

    return {
      dedup: dedupResult,
      pagerank: pagerankResult,
      community: communityResult,
      communitySummaries,
      durationMs: Date.now() - start,
    };
  } finally {
    releaseLock();
  }
}
`;
const { resolve } = await import('node:path');
const targetPath = resolve(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw', 'workspace', 'main', 'workfiles', 'graph-memory-pro', 'src', 'graph', 'maintenance.ts');
fs.writeFileSync(targetPath, code);
console.log('Written maintenance.ts, size=' + code.length);
