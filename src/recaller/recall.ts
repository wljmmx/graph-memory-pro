/**
 * graph-memory-pro — 跨对话召回 (Neo4j 版)
 *
 * 双路径召回：精确路径（向量搜索） + 泛化路径（社区代表节点）
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

export class Recaller {
  private embed: EmbedFn | null = null;

  constructor(private driver: Driver, private cfg: GmConfig) {}

  setEmbedFn(fn: EmbedFn): void { this.embed = fn; }

  async recall(query: string): Promise<RecallResult> {
    const limit = this.cfg.recallMaxNodes;
    const t0 = Date.now();

    const precise = await this.recallPrecise(query, limit);
    const generalized = await this.recallGeneralized(query, limit);
    const merged = this.mergeResults(precise, generalized);

    if (process.env.GM_DEBUG) {
      if (process.env.GM_DEBUG) console.log(`  [DEBUG] recall: ${precise.nodes.length} precise + ${generalized.nodes.length} generalized = ${merged.nodes.length} total`);
    }

    return merged;
  }

  private async recallPrecise(query: string, limit: number): Promise<RecallResult> {
    // 路径1: 全文搜索
    const tFts = Date.now();
    const ftsNodes = await searchNodes(this.driver, query, limit);
    if (process.env.GM_DEBUG) console.log(`  [recall-precise] FTS: ${+(Date.now()-tFts).toFixed(1)}ms nodes=${ftsNodes.length}`);

    // 路径2: 向量搜索 (如果有embedding)
    let vecNodes: GmNode[] = [];
    if (this.embed) {
      try {
        const vec = await this.embed(query);
        if (vec.length) {
          const vecResults = await vectorSearchWithScore(this.driver, vec, limit);
          vecNodes = vecResults.map(v => v.node).slice(0, limit);
        }
      } catch {
        // 向量搜索失败，继续使用 FTS 结果
      }
    }

    // 合并去重
    const seen = new Set<string>();
    const nodes: GmNode[] = [];
    for (const n of [...vecNodes, ...ftsNodes]) {
      if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); }
    }

    if (!nodes.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    // 图遍历
    const nodeIds = nodes.slice(0, limit).map(n => n.id);
    const tGw = Date.now();
    const walked = await graphWalk(this.driver, nodeIds, this.cfg.recallMaxDepth);
    if (process.env.GM_DEBUG) console.log(`  [recall-precise] graphWalk: ${+(Date.now()-tGw).toFixed(1)}ms nodes=${walked.nodes.length}`);

    // PPR 排序
    const candidateIds = walked.nodes.map(n => n.id);
    let pprScores: Map<string, number>;
    try {
      const tPpr = Date.now();
      const pprResult = await personalizedPageRank(this.driver, nodeIds, candidateIds, this.cfg);
      if (process.env.GM_DEBUG) console.log(`  [recall-precise] PPR: ${+(Date.now()-tPpr).toFixed(1)}ms scores=${pprResult.scores.size}`);
      pprScores = pprResult.scores;
    } catch {
      pprScores = new Map();
    }

    const scored = walked.nodes.map(n => ({
      node: n,
      score: pprScores.get(n.id) ?? 0,
    }));
    scored.sort((a, b) => b.score - a.score);

    const finalNodes = scored.slice(0, limit).map(s => s.node);
    const edges = walked.edges.filter(e =>
      finalNodes.some(n => n.id === e.fromId) &&
      finalNodes.some(n => n.id === e.toId)
    );

    return { nodes: finalNodes, edges, tokenEstimate: finalNodes.length * 50 + edges.length * 20 };
  }

  private async recallGeneralized(query: string, limit: number): Promise<RecallResult> {
    if (!this.embed) return { nodes: [], edges: [], tokenEstimate: 0 };

    try {
      const vec = await this.embed(query);
      if (!vec.length) return { nodes: [], edges: [], tokenEstimate: 0 };

      // 按社区向量搜索
      const communityResults = await communityVectorSearch(this.driver, vec);
      const communityIds = communityResults.slice(0, 3).map(c => c.id);
      if (!communityIds.length) return { nodes: [], edges: [], tokenEstimate: 0 };

      const repNodes = await communityRepresentatives(this.driver, communityIds);
      if (!repNodes.length) return { nodes: [], edges: [], tokenEstimate: 0 };

      // PPR 排序
      const repIds = repNodes.map(n => n.id);
      let pprScores: Map<string, number>;
      try {
        const pprResult = await personalizedPageRank(this.driver, repIds, repIds, this.cfg);
        pprScores = pprResult.scores;
      } catch {
        pprScores = new Map();
      }

      const scored = repNodes.map(n => ({
        node: n,
        score: pprScores.get(n.id) ?? 0,
      }));
      scored.sort((a, b) => b.score - a.score);

      const finalNodes = scored.slice(0, limit).map(s => s.node);
      return { nodes: finalNodes, edges: [], tokenEstimate: finalNodes.length * 30 };
    } catch {
      return { nodes: [], edges: [], tokenEstimate: 0 };
    }
  }

  private mergeResults(a: RecallResult, b: RecallResult): RecallResult {
    const seen = new Set<string>();
    const nodes: GmNode[] = [];
    const edges = new Map<string, GmEdge>();

    for (const n of [...a.nodes, ...b.nodes]) {
      if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); }
    }
    for (const e of [...a.edges, ...b.edges]) {
      edges.set(e.id, e);
    }

    return { nodes, edges: Array.from(edges.values()), tokenEstimate: nodes.length * 40 + edges.size * 15 };
  }

  async syncEmbed(node: GmNode): Promise<void> {
    if (!this.embed) return;
    const hash = createHash("md5").update(node.content).digest("hex");
    const existingHash = await getVectorHash(this.driver, node.id);
    if (existingHash === hash) return;
    try {
      const text = `${node.name}: ${node.description}\n${node.content.slice(0, 500)}`;
      const vec = await this.embed(text);
      if (vec.length) await saveVector(this.driver, node.id, node.content, vec);
    } catch {}
  }
}
