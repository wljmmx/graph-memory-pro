/**
 * graph-memory-pro — 跨对话召回 (Neo4j 版)
 */

import type { Driver } from "neo4j-driver";
import { createHash } from "crypto";
import type { GmConfig, RecallResult, GmNode, GmEdge } from "../types.ts";
import type { EmbedFn } from "../engine/embed.ts";
import {
  searchNodes, vectorSearchWithScore,
  graphWalk,
  communityVectorSearchWithReps,
  saveVector, getVectorHash, computeEmbeddingHash,
  upsertFeedback,
} from "../store/store.ts";
import { personalizedPageRank } from "../graph/pagerank.ts";
import { logPhase, isTimingEnabled, printAllDistributions, resetAllDistributions } from "../timing.ts";
import { QueryCache } from "./query-cache.ts";
import { JudgeManager } from "./judge.ts";
import { AssociationMatrix } from "./association-matrix.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("recaller");

let _recallCallCount = 0;
const REPORT_INTERVAL = 50;

export class Recaller {
  private embed: EmbedFn | null = null;
  private timingCallCount = 0;
  // v2.1.2 第二批：I-1 QueryCache + I-2 JudgeManager
  private queryCache: QueryCache;
  private judgeManager: JudgeManager | null = null;
  // v2.1.2 第三批：L-1 关联矩阵 M
  private associationMatrix: AssociationMatrix | null = null;

  constructor(private driver: Driver, private cfg: GmConfig) {
    this.queryCache = new QueryCache(cfg.queryCache);
  }

  setEmbedFn(fn: EmbedFn): void { this.embed = fn; }

  /**
   * 设置 JudgeManager（由外部 index.ts 在 LLM 就绪后注入）
   * 若不调用则不启用 I-2 反馈
   */
  setJudgeManager(jm: JudgeManager): void { this.judgeManager = jm; }

  /** 暴露 QueryCache 给外部（健康检查/统计） */
  getQueryCache(): QueryCache { return this.queryCache; }
  /** 暴露 JudgeManager 给外部 */
  getJudgeManager(): JudgeManager | null { return this.judgeManager; }
  /** 暴露 AssociationMatrix 给外部（统计/持久化） */
  getAssociationMatrix(): AssociationMatrix | null { return this.associationMatrix; }

  /**
   * 设置关联矩阵 M（由 index.ts 在 embed 维度确定后注入）
   */
  setAssociationMatrix(am: AssociationMatrix): void { this.associationMatrix = am; }

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

    // v2.1.2 I-1: 历史查询缓存（精确匹配 → 直接返回）
    const cached = this.queryCache.get(query);
    if (cached) {
      logPhase("recall_cache_hit", 0, { query: query.slice(0, 50) });
      return cached;
    }

    // v2.3.1 性能优化: 入口处单次计算 queryEmbedding，复用给 recallPrecise / recallGeneralized / QueryCache。
    // 旧实现：embed 在 recallPrecise + recallGeneralized + QueryCache 相似匹配 共 3 处被调用，
    // 每次 ~1000ms，总计浪费 ~2000ms（实测 vec_embed 1000+ms × 3 = 3000ms）。
    let queryEmbedding: number[] | undefined;
    if (this.embed) {
      try {
        const tEmbed = Date.now();
        queryEmbedding = await this.embedOnce(query);
        logPhase("vec_embed", Date.now() - tEmbed, {
          dims: queryEmbedding.length,
          context: "recall_entry",
        });
      } catch {
        // embed 失败不影响主流程（FTS 仍可返回结果）
      }
    }

    // v2.3.1 性能优化: 两条召回路径并行执行（共享同一 queryEmbedding）。
    // 旧实现：串行 await recallPrecise → recallGeneralized，多耗费一个路径的时间。
    const [precise, generalized] = await Promise.all([
      this.recallPrecise(query, limit, queryEmbedding),
      this.recallGeneralized(query, limit, queryEmbedding),
    ]);
    const merged = this.mergeResults(precise, generalized);

    // v2.1.2 I-1: 缓存写入（复用已计算的 queryEmbedding 做相似匹配，不再重复 embed）
    if (queryEmbedding) {
      try {
        const similar = this.queryCache.getSimilar(queryEmbedding);
        if (similar) {
          logPhase("recall_cache_similar_hit", 0, {
            similarity: similar.similarity.toFixed(3),
          });
          // 这里不直接返回相似结果，因为已经做了完整召回
          // 相似命中仅作为统计，下次相同 query 时直接命中精确缓存
        }
      } catch {
        // 相似匹配失败不影响主流程
      }
    }
    this.queryCache.put(query, merged, queryEmbedding);

    const totalMs = Date.now() - t0;
    logPhase("recall_total", totalMs, { nodes: merged.nodes.length, edges: merged.edges.length });

    if (this.timingCallCount % REPORT_INTERVAL === 0 && isTimingEnabled()) {
      log.info("timing distribution", { distribution: printAllDistributions() });
    }

    if (process.env.GM_DEBUG) {
      log.debug("recall completed", { precise: precise.nodes.length, generalized: generalized.nodes.length, total: merged.nodes.length, ms: totalMs.toFixed(1) });
    }

    return merged;
  }

  /**
   * v2.3.1 性能优化: embed 短时去重
   *
   * 并发相同 query 的 embed 调用复用同一 in-flight promise，避免并发重复请求 Ollama。
   * 注意：仅去重并发请求，不缓存结果（结果缓存由 QueryCache 负责）。
   * Map 在 promise 完成后立即清除该 key，防止内存泄漏。
   */
  private inFlightEmbeds = new Map<string, Promise<number[]>>();

  private async embedOnce(query: string): Promise<number[]> {
    if (!this.embed) throw new Error("embed not configured");
    const inflight = this.inFlightEmbeds.get(query);
    if (inflight) return inflight;
    const p = this.embed(query).finally(() => {
      this.inFlightEmbeds.delete(query);
    });
    this.inFlightEmbeds.set(query, p);
    return p;
  }

  /**
   * v2.1.2 第二批：处理一轮对话的反馈
   *
   * 调用时机：用户接收到 assistant 回复后
   * - I-2: 判断召回节点是否被使用
   * - I-3: 持久化反馈到 Neo4j
   *
   * @param query 用户原始查询
   * @param recalledNodes 召回的节点（来自 recall() 返回）
   * @param assistantReply assistant 回复内容
   * @param sessionId 会话 ID（可选）
   */
  async processFeedback(
    query: string,
    recalledNodes: GmNode[],
    assistantReply: string,
    sessionId?: string,
  ): Promise<void> {
    if (!this.judgeManager) return;

    try {
      // 把"持久化 + 计数 + M 更新"打包进 onFeedback 回调，
      // 这样无论同步/异步模式，反馈链路都会完整执行（修复旧实现的致命断裂缺陷）
      const feedback = await this.judgeManager.processTurn(
        query,
        recalledNodes,
        assistantReply,
        sessionId,
        async (fb) => {
          // I-3: 持久化反馈
          const feedbackId = `${createHash("md5").update(query + fb.timestamp + (sessionId ?? "")).digest("hex").slice(0, 16)}`;
          await upsertFeedback(this.driver, {
            id: feedbackId,
            query,
            recalledNodeIds: fb.recalledNodeIds,
            usedNodeIds: fb.usedNodeIds,
            unusedNodeIds: fb.unusedNodeIds,
            timestamp: fb.timestamp,
            sessionId,
            matchedBy: fb.matchedBy,
          });

          // 累计反馈计数（用于冷启动判断）
          this.judgeManager!.incrementFeedback();

          // v2.1.2 第三批 L-1 + R-3：用反馈信号更新关联矩阵 M
          // 仅在 M 启用且 embed 可用时触发（M 训练需要 query embedding）
          if (this.associationMatrix?.isEnabled() && this.embed) {
            try {
              await this.updateAssociationMatrix(query, fb.usedNodeIds, fb.unusedNodeIds);
            } catch (err) {
              if (process.env.GM_DEBUG) log.warn("M update failed", { error: String(err) });
            }
          }

          if (process.env.GM_DEBUG) {
            const coldStart = this.judgeManager!.isColdStart();
            log.debug("judge result", { used: fb.usedNodeIds.length, recalled: fb.recalledNodeIds.length, coldStart });
          }
        },
      );
      // feedback 在同步模式下有值（已通过回调处理），异步模式下为 null（回调已在后台执行）
      void feedback;
    } catch (err) {
      log.warn("feedback persistence failed", { error: String(err) });
    }
  }

  /**
   * v2.1.2 第三批：L-1 + R-3 更新关联矩阵 M
   *
   * @param query 用户查询
   * @param usedNodeIds 被使用的节点 id（正反馈）
   * @param unusedNodeIds 未被使用的节点 id（负反馈）
   */
  private async updateAssociationMatrix(
    query: string,
    usedNodeIds: string[],
    unusedNodeIds: string[],
  ): Promise<void> {
    if (!this.associationMatrix || !this.embed) return;

    // 计算 query embedding（与召回时一致的嵌入）
    const queryVec = await this.embed(query);
    if (!queryVec.length) return;

    // 计算奖励信号 ∈ [-1, 1]
    // 简化：reward = (used - unused) / total，正负方向 + 大小由反馈比例决定
    const total = usedNodeIds.length + unusedNodeIds.length;
    if (total === 0) return;
    const reward = (usedNodeIds.length - unusedNodeIds.length) / total;

    // R-3 边际效用更新（内部含邻域评估 + 拒绝逻辑）
    const result = this.associationMatrix.updateWithMarginalUtility(queryVec, reward);

    if (process.env.GM_DEBUG) {
      log.info("M update", { reward: reward.toFixed(3), applied: result.applied, gain: result.neighborhoodGain.toFixed(3) });
    }
  }

  private async recallPrecise(
    query: string,
    limit: number,
    precomputedVec?: number[],
  ): Promise<RecallResult> {
    const tPrecise = Date.now();

    // v2.3.1 性能优化: FTS 搜索 与 向量搜索 并行执行（无数据依赖）。
    // 旧实现串行：fts_search → vec_search，多耗费一次网络往返。
    const tFts = Date.now();
    const ftsPromise = searchNodes(this.driver, query, limit).then((nodes) => {
      logPhase("fts_search", Date.now() - tFts, { nodes: nodes.length });
      return nodes;
    });

    // 向量搜索路径（优先复用预计算向量）
    const vecSearchPromise = (async (): Promise<GmNode[]> => {
      if (!precomputedVec?.length && !this.embed) return [];
      try {
        let vec: number[];
        if (precomputedVec?.length) {
          vec = precomputedVec;
        } else {
          const tEmbed = Date.now();
          vec = await this.embed!(query);
          logPhase("vec_embed", Date.now() - tEmbed, {
            dims: vec.length,
            context: "recall_precise_fallback",
          });
        }

        if (!vec.length) return [];

        // v2.1.2 第三批 L-1：query_vec → M @ vec 变换
        let searchVec: number[] = vec;
        if (this.associationMatrix?.isEnabled()) {
          const fbCount = this.judgeManager?.getFeedbackCount() ?? 0;
          const transformed = this.associationMatrix.transform(vec, fbCount);
          searchVec = Array.from(transformed);
          this.associationMatrix.updateBatchNormStats(vec);
        }

        const tVecSearch = Date.now();
        const vecResults = await vectorSearchWithScore(this.driver, searchVec, limit);
        logPhase("vec_search", Date.now() - tVecSearch, { nodes: vecResults.length });
        return vecResults.map(v => v.node).slice(0, limit);
      } catch (e) {
        if (process.env.GM_DEBUG) log.warn("recall-precise vector search failed", { error: String(e) });
        return [];
      }
    })();

    // 并行执行 FTS + 向量搜索
    const [ftsNodes, vecNodes] = await Promise.all([ftsPromise, vecSearchPromise]);

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
      if (process.env.GM_DEBUG) log.warn("recall-precise PPR failed", { error: String(e) });
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

  private async recallGeneralized(
    query: string,
    limit: number,
    precomputedVec?: number[],
  ): Promise<RecallResult> {
    if (!this.embed && !precomputedVec?.length) {
      return { nodes: [], edges: [], tokenEstimate: 0 };
    }

    const tGen = Date.now();

    try {
      // v2.3.1 性能优化: 优先复用入口预计算的 queryEmbedding，避免重复 embed（~1000ms）
      let vec: number[];
      if (precomputedVec?.length) {
        vec = precomputedVec;
      } else {
        const tEmbed = Date.now();
        vec = await this.embed!(query);
        logPhase("vec_embed", Date.now() - tEmbed, {
          context: "recall_generalized_fallback",
        });
      }
      if (!vec.length) return { nodes: [], edges: [], tokenEstimate: 0 };

      // v2.3.1 性能优化: 合并 communityVectorSearch + communityRepresentatives 为单条 Cypher
      // 旧实现两步串行（两次网络往返），新实现单条 Cypher 一次完成，减少 ~5-20ms
      const tCommVec = Date.now();
      const commReps = await communityVectorSearchWithReps(this.driver, vec, 3);
      const communityCount = new Set(
        commReps.map(r => r.node.communityId).filter((id): id is string => !!id)
      ).size;
      logPhase("community_vec_reps", Date.now() - tCommVec, {
        communities: communityCount,
        reps: commReps.length,
      });
      const repNodes = commReps.map(r => r.node);
      if (!repNodes.length) return { nodes: [], edges: [], tokenEstimate: 0 };

      const repIds = repNodes.map(n => n.id);
      let pprScores: Map<string, number>;
      try {
        const tPpr = Date.now();
        const pprResult = await personalizedPageRank(this.driver, repIds, repIds, this.cfg);
        logPhase("ppr_compute", Date.now() - tPpr, { scores: pprResult.scores.size, context: "generalized" });
        pprScores = pprResult.scores;
      } catch (e) {
        if (process.env.GM_DEBUG) log.warn("recall-generalized PPR failed", { error: String(e) });
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
      if (process.env.GM_DEBUG) log.warn("recall-generalized failed", { error: String(e) });
      return { nodes: [], edges: [], tokenEstimate: 0 };
    }
  }

  private mergeResults(a: RecallResult, b: RecallResult): RecallResult {
    const tMerge = Date.now();

    const seen = new Set<string>();
    const nodes: GmNode[] = [];
    const edges = new Map<string, GmEdge>();

    for (const n of [...a.nodes, ...b.nodes]) {
      if (!seen.has(n.id)) {
        seen.add(n.id);

        // v2.1.2 S-14: 召回时过滤/降权过时节点
        // - state=superseded 且 filterSupersededInRecall=true → 跳过
        // - stalenessScore > threshold → 标记（仍保留，由 G-3 importance 二次排序时降权）
        if (this.cfg?.state?.filterSupersededInRecall && n.state === "superseded") {
          continue;
        }
        nodes.push(n);
      }
    }
    for (const e of [...a.edges, ...b.edges]) {
      edges.set(e.id, e);
    }

    // v2.1.2 S-14 + G-3: 综合排序
    //   - 高过时节点（stalenessScore > threshold）排到末尾
    //   - 同 staleness 等级按 score × importanceScore × (1 - stalenessScore) 降序
    //   - 旧版本（无 importanceScore）回退到 pagerank
    const stalenessThreshold = this.cfg?.staleness?.threshold ?? 0.7;
    nodes.sort((x, y) => {
      const sx = x.stalenessScore ?? 0;
      const sy = y.stalenessScore ?? 0;
      // 高过时节点排到末尾
      const xStale = sx > stalenessThreshold ? 1 : 0;
      const yStale = sy > stalenessThreshold ? 1 : 0;
      if (xStale !== yStale) return xStale - yStale;
      // G-3: importanceScore × (1 - stalenessScore) 加权排序
      const ix = x.importanceScore ?? 0;
      const iy = y.importanceScore ?? 0;
      const wx = ix * (1 - sx);
      const wy = iy * (1 - sy);
      // 优先 importance 加权；若均无 importanceScore → 回退 pagerank
      if (wx === 0 && wy === 0) return y.pagerank - x.pagerank;
      return wy - wx;
    });

    logPhase("merge_results", Date.now() - tMerge, { nodes: nodes.length, edges: edges.size });

    return { nodes, edges: Array.from(edges.values()), tokenEstimate: nodes.length * 40 + edges.size * 15 };
  }

  async syncEmbed(node: GmNode): Promise<void> {
    if (!this.embed) return;
    // v2.2.0 fix: 使用统一的 computeEmbeddingHash 格式 (md5(name|desc|content))
    // 之前单独用 md5(text) 与 upsertNode/reEmbedNodes 不一致，导致 R-4 误触发
    const hash = computeEmbeddingHash(node.name, node.description, node.content);
    const existingHash = await getVectorHash(this.driver, node.id);
    if (existingHash === hash) return;
    // 跳过已有 embedding 且 hash 匹配的节点，避免冗余查询
    if (node.embedding && Array.isArray(node.embedding) && node.embedding.length > 0 && existingHash === hash) return;
    try {
      const tSync = Date.now();
      // 嵌入文本使用截断格式（与 reEmbedNodes 一致），但 hash 使用全量格式
      const text = node.name + ": " + node.description + "\n" + node.content.slice(0, 500);
      const vec = await this.embed(text);
      logPhase("vec_embed", Date.now() - tSync, { context: "syncEmbed" });
      if (vec.length) await saveVector(this.driver, node.id, vec, hash, node.embeddingModel);
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
