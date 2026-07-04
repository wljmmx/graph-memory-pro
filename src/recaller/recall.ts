/**
 * graph-memory-pro — 跨对话召回 (Neo4j 版)
 */

import type { Driver } from "neo4j-driver";
import { createHash } from "crypto";
import type { GmConfig, RecallResult, GmNode, GmEdge } from "../types.ts";
import type { EmbedFn } from "../engine/embed.ts";
import {
  searchNodes, vectorSearchWithScore,
  graphWalk, communityRepresentatives,
  communityVectorSearch, nodesByCommunityIds,
  saveVector, getVectorHash,
} from "../store/store.ts";
import { getCommunityPeers } from "../graph/community.ts";
import { personalizedPageRank } from "../graph/pagerank.ts";
import { logPhase, isTimingEnabled, printAllDistributions, resetAllDistributions } from "../timing.ts";

let _recallCallCount = 0;
const REPORT_INTERVAL = 50;

export class Recaller {
  private embed: EmbedFn | null = null;
  private timingCallCount = 0;

  constructor(private driver: Driver, private cfg: GmConfig) {}

  setEmbedFn(fn: EmbedFn): void { this.embed = fn; }

  resetTiming(): void {
    _recallCallCount = 0;
    this.timingCallCount = 0;
    resetAllDistributions();
  }

  printDistribution(): string {
    return printAllDistributions();
  }

  async recall(query: string): Promise<RecallResult> {
    const limit = this.cfg.recallMaxNodes;
    const t0 = Date.now();
    _recallCallCount++;
    this.timingCallCount++;

    const precise = await this.recallPrecise(query, limit);
    const generalized = await this.recallGeneralized(query, limit);
    const merged = this.mergeResults(precise, generalized);

    const totalMs = Date.now() - t0;
    logPhase("recall_total", totalMs, { nodes: merged.nodes.length, edges: merged.edges.length });

    if (this.timingCallCount % REPORT_INTERVAL === 0 && isTimingEnabled()) {
      console.log(printAllDistributions());
    }

    if (process.env.GM_DEBUG) {
      console.log("[DEBUG] recall: " + precise.nodes.length + " precise + " + generalized.nodes.length + " generalized = " + merged.nodes.length + " total (" + totalMs.toFixed(1) + "ms)");
    }

    return merged;
  }

  private async recallPrecise(query: string, limit: number): Promise<RecallResult> {
    const tPrecise = Date.now();

    const tFts = Date.now();
    const ftsNodes = await searchNodes(this.driver, query, limit);
    logPhase("fts_search", Date.now() - tFts, { nodes: ftsNodes.length });

    let vecNodes: GmNode[] = [];
    if (this.embed) {
      try {
        const tEmbed = Date.now();
        const vec = await this.embed(query);
        logPhase("vec_embed", Date.now() - tEmbed, { dims: vec.length });

        if (vec.length) {
          const tVecSearch = Date.now();
          const vecResults = await vectorSearchWithScore(this.driver, vec, limit);
          logPhase("vec_search", Date.now() - tVecSearch, { nodes: vecResults.length });
          vecNodes = vecResults.map(v => v.node).slice(0, limit);
        }
      } catch (e) {
        if (process.env.GM_DEBUG) console.log("[recall-precise] vector search failed: " + e);
      }
    }

    const seen = new Set<string>();
    const nodes: GmNode[] = [];
    for (const n of [...vecNodes, ...ftsNodes]) {
      if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); }
    }

    if (!nodes.length) {
      logPhase("recall_precise", Date.now() - tPrecise, { early_exit: true });
      return { nodes: [], edges: [], tokenEstimate: 0 };
    }

    const nodeIds = nodes.slice(0, limit).map(n => n.id);
    const tGw = Date.now();
    const walked = await graphWalk(this.driver, nodeIds, this.cfg.recallMaxDepth);
    logPhase("graph_walk", Date.now() - tGw, { nodes: walked.nodes.length, edges: walked.edges.length });

    // Fallback: if graphWalk returned nothing, use seed nodes directly
    let candidateNodes = walked.nodes;
    if (candidateNodes.length === 0) {
      candidateNodes = nodes.slice(0, limit);
      logPhase("graph_walk", Date.now() - tGw, { fallback: true, nodes: candidateNodes.length });
    }
    const candidateIds = candidateNodes.map(n => n.id);
    let pprScores: Map<string, number>;
    try {
      const tPpr = Date.now();
      const pprResult = await personalizedPageRank(this.driver, nodeIds, candidateIds, this.cfg);
      logPhase("ppr_compute", Date.now() - tPpr, { scores: pprResult.scores.size });
      pprScores = pprResult.scores;
    } catch (e) {
      if (process.env.GM_DEBUG) console.log("[recall-precise] PPR failed: " + e);
      pprScores = new Map();
    }

    const scored = candidateNodes.map(n => ({
      node: n,
      score: pprScores.get(n.id) ?? 0,
    }));
    scored.sort((a, b) => b.score - a.score);

    const finalNodes = scored.slice(0, limit).map(s => s.node);
    const edges = walked.edges.filter(e =>
      finalNodes.some(n => n.id === e.fromId) &&
      finalNodes.some(n => n.id === e.toId)
    );

    logPhase("recall_precise", Date.now() - tPrecise, { finalNodes: finalNodes.length });
    return { nodes: finalNodes, edges, tokenEstimate: finalNodes.length * 50 + edges.length * 20 };
  }

  private async recallGeneralized(query: string, limit: number): Promise<RecallResult> {
    if (!this.embed) return { nodes: [], edges: [], tokenEstimate: 0 };

    const tGen = Date.now();

    try {
      const tEmbed = Date.now();
      const vec = await this.embed(query);
      logPhase("vec_embed", Date.now() - tEmbed, { context: "generalized" });
      if (!vec.length) return { nodes: [], edges: [], tokenEstimate: 0 };

      const tCommVec = Date.now();
      const communityResults = await communityVectorSearch(this.driver, vec);
      logPhase("community_vec_search", Date.now() - tCommVec, { communities: communityResults.length });
      const communityIds = communityResults.slice(0, 3).map(c => c.id);
      if (!communityIds.length) return { nodes: [], edges: [], tokenEstimate: 0 };

      const tReps = Date.now();
      const repNodes = await communityRepresentatives(this.driver, communityIds);
      logPhase("community_reps", Date.now() - tReps, { reps: repNodes.length });
      if (!repNodes.length) return { nodes: [], edges: [], tokenEstimate: 0 };

      const repIds = repNodes.map(n => n.id);
      let pprScores: Map<string, number>;
      try {
        const tPpr = Date.now();
        const pprResult = await personalizedPageRank(this.driver, repIds, repIds, this.cfg);
        logPhase("ppr_compute", Date.now() - tPpr, { scores: pprResult.scores.size, context: "generalized" });
        pprScores = pprResult.scores;
      } catch (e) {
        if (process.env.GM_DEBUG) console.log("[recall-generalized] PPR failed: " + e);
        pprScores = new Map();
      }

      const scored = repNodes.map(n => ({
        node: n,
        score: pprScores.get(n.id) ?? 0,
      }));
      scored.sort((a, b) => b.score - a.score);

      const finalNodes = scored.slice(0, limit).map(s => s.node);
      logPhase("recall_generalized", Date.now() - tGen, { finalNodes: finalNodes.length });
      return { nodes: finalNodes, edges: [], tokenEstimate: finalNodes.length * 30 };
    } catch (e) {
      if (process.env.GM_DEBUG) console.log("[recall-generalized] failed: " + e);
      return { nodes: [], edges: [], tokenEstimate: 0 };
    }
  }

  private mergeResults(a: RecallResult, b: RecallResult): RecallResult {
    const tMerge = Date.now();

    const seen = new Set<string>();
    const nodes: GmNode[] = [];
    const edges = new Map<string, GmEdge>();

    for (const n of [...a.nodes, ...b.nodes]) {
      if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); }
    }
    for (const e of [...a.edges, ...b.edges]) {
      edges.set(e.id, e);
    }

    logPhase("merge_results", Date.now() - tMerge, { nodes: nodes.length, edges: edges.size });

    return { nodes, edges: Array.from(edges.values()), tokenEstimate: nodes.length * 40 + edges.size * 15 };
  }

  async syncEmbed(node: GmNode): Promise<void> {
    if (!this.embed) return;
    // 构造实际用于嵌入的文本
    const text = node.name + ": " + node.description + "\n" + node.content.slice(0, 500);
    // 基于嵌入文本计算 hash，确保与 saveVector 一致
    const hash = createHash("md5").update(text).digest("hex");
    const existingHash = await getVectorHash(this.driver, node.id);
    if (existingHash === hash) return;
    // 跳过已有 embedding 且 hash 匹配的节点，避免冗余查询
    if (node.embedding && Array.isArray(node.embedding) && node.embedding.length > 0 && existingHash === hash) return;
    try {
      const tSync = Date.now();
      const vec = await this.embed(text);
      logPhase("vec_embed", Date.now() - tSync, { context: "syncEmbed" });
      if (vec.length) await saveVector(this.driver, node.id, text, vec);
    } catch {}
  }
}

export function printRecallDistribution(): string {
  return printAllDistributions();
}

export function resetRecallTiming(): void {
  _recallCallCount = 0;
  resetAllDistributions();
}
