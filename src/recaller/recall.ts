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
  getVectorHash, computeEmbeddingHash,
  upsertFeedback,
} from "../store/store.ts";
import { embedNode } from "../store/embed-helper.ts";
import { personalizedPageRank, preheatProjection } from "../graph/pagerank.ts";
import { logPhase, isTimingEnabled, printAllDistributions, resetAllDistributions } from "../timing.ts";
import { getCircuitBreaker } from "../engine/circuit-breaker.ts";
import { QueryCache } from "./query-cache.ts";
import { JudgeManager } from "./judge.ts";
import { AssociationMatrix } from "./association-matrix.ts";
import { temporalRecency, combineScore, computeChunkSimilarities } from "./rerank.ts";
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

  /**
   * v2.5.x: 心跳驱动恢复后热替换 driver，保持单例对象身份不变
   * （外部插件如 graph-adapter/lcm 复用本 Recaller，重建对象会使其引用失效）。
   * Recaller 不缓存 driver 派生状态，替换后所有查询即走新 driver。
   */
  setDriver(driver: Driver): void { this.driver = driver; }

  setEmbedFn(fn: EmbedFn): void { this.embed = fn; }

  /**
   * 运行时更新配置（由 AutoTuner 调参后热生效，无需重启 Gateway）
   * 仅更新召回相关参数，不影响已注入的 embed/judgeManager/associationMatrix
   */
  updateConfig(cfg: Partial<GmConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

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
    //
    // v2.3.1 P0-2: embed 与 preheatProjection 并行（两者无数据依赖）。
    // preheatProjection 预热共享 GDS 投影，避免后续 recallPrecise/recallGeneralized
    // 并行执行时各自独立触发 ensureSharedProjection（重复探测 ~80-150ms）。
    const embedPromise = (async (): Promise<number[] | undefined> => {
      if (!this.embed) return undefined;
      // v2.3.2 阶段三: embed 熔断器 — OPEN 时跳过 embed 重试链路（~9s），直接降级 FTS
      // v2.5.4: 专项参数：失败阈值 3（默认 5）、cooldown 15s（默认 60s）、时间窗口衰减 30s。
      //   之前默认 cooldown=60s 太长，Ollama 短暂 503 后会进入 60s 纯 FTS 召回期，
      //   导致社区/关联节点完全靠关键词匹配不到，graph-adapter 收到 0 节点报 error。
      const breaker = getCircuitBreaker("embed", {
        failureThreshold: 3,
        cooldownMs: 15_000,
        failureWindowMs: 30_000,
      });
      if (!breaker.allow()) {
        log?.warn?.("[recall] embed circuit OPEN, skip embed → FTS fallback");
        return undefined;
      }
      try {
        const tEmbed = Date.now();
        const vec = await this.embedOnce(query);
        breaker.recordSuccess();
        logPhase("vec_embed", Date.now() - tEmbed, {
          dims: vec.length,
          context: "recall_entry",
        });
        return vec;
      } catch {
        // embed 失败记录到熔断器，连续失败达阈值后 OPEN
        breaker.recordFailure();
        // embed 失败不影响主流程（FTS 仍可返回结果）
        return undefined;
      }
    })();

    // 预热 GDS 投影（与 embed 并行，但需等待完成后再进入两条路径，
    // 否则两条路径各自调用 personalizedPageRank 时仍会重复触发 ensureSharedProjection）
    const preheatPromise = preheatProjection(this.driver).catch(() => false);

    // 等待 embed + preheat 都完成（两者并行执行，总耗时 ≈ max(embed, preheat)）
    const [queryEmbedding] = await Promise.all([embedPromise, preheatPromise]);

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
    // opts.sync: 强制同步执行（供 gm_bootstrap 等需要确定性计数/冷启动判断的调用）
    opts?: { sync?: boolean },
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
              log.warn("M update failed", { error: String(err) });
            }
          }

          if (process.env.GM_DEBUG) {
            const coldStart = this.judgeManager!.isColdStart();
            log.debug("judge result", { used: fb.usedNodeIds.length, recalled: fb.recalledNodeIds.length, coldStart });
          }
        },
        opts?.sync ?? false,
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

    // v2.6.0: 传递 usedNodeIds 到历史样本池，供 M 维护稀疏图共现潜在边信号
    if (usedNodeIds.length > 0 && reward > 0) {
      this.associationMatrix.recordHistorySampleWithNodes(queryVec, reward, usedNodeIds);
    }

    // 记录学习曲线采样（跨重启持久化，供 /api/association-matrix/history 展示）
    if (result.applied) {
      const fbCount = this.judgeManager?.getFeedbackCount?.() ?? 0;
      this.associationMatrix.recordLearningSample(fbCount);
    }

    if (process.env.GM_DEBUG) {
      log.info("M update", { reward: reward.toFixed(3), applied: result.applied, gain: result.neighborhoodGain.toFixed(3) });
    }
  }

  /**
   * v2.5.3: 基于 get() 展开信号的轻量反馈处理（不依赖 agent_end / assistantReply）。
   *
   * 长任务场景：agent 执行多轮工具调用期间 agent_end 尚未触发，
   * 但 memory_search + get() 已经产生了明确的"使用"信号。
   * 此方法用 get() 命中节点作为确定性正反馈（used），
   * 召回但未被 get() 展开的节点作为负反馈（unused），
   * 直接更新 M 矩阵 + 持久化反馈 + 累计计数，跳过 judge 判定。
   *
   * @param query 触发召回的用户查询
   * @param recalledNodeIds 该 session 累计召回的去重节点
   * @param getNodeIds 通过 get() 展开过的节点（确定性"已使用"）
   * @param sessionId 会话 ID
   */
  async processGetBasedFeedback(
    query: string,
    recalledNodeIds: string[],
    getNodeIds: string[],
    sessionId?: string,
  ): Promise<void> {
    if (!this.associationMatrix?.isEnabled() || !this.embed) return;
    if (getNodeIds.length === 0) return;

    // get() 命中 = 确定性正反馈；召回但未展开 = 负反馈
    const usedSet = new Set(getNodeIds);
    const usedNodeIds = recalledNodeIds.filter(id => usedSet.has(id));
    // 若 recalledNodes 为空但 getNodeIds 有值（如 get() 未经过 search()），
    // 直接用 getNodeIds 作为 used
    const finalUsed = usedNodeIds.length > 0 ? usedNodeIds : getNodeIds;
    const unusedNodeIds = recalledNodeIds.filter(id => !usedSet.has(id));

    // 持久化反馈记录（与 processFeedback 链路一致）
    const timestamp = Date.now();
    const feedbackId = `${createHash("md5").update(query + timestamp + (sessionId ?? "")).digest("hex").slice(0, 16)}`;
    try {
      await upsertFeedback(this.driver, {
        id: feedbackId,
        query,
        recalledNodeIds,
        usedNodeIds: finalUsed,
        unusedNodeIds,
        timestamp,
        sessionId,
        matchedBy: "get-signal",
      });
    } catch (err) {
      log.warn("get-based feedback persistence failed", { error: String(err) });
    }

    // 累计反馈计数（用于冷启动判断）
    this.judgeManager?.incrementFeedback();

    // 直接更新 M（跳过 judge，因为 get() 是确定性信号）
    try {
      await this.updateAssociationMatrix(query, finalUsed, unusedNodeIds);
      log.debug("get-based M update", { used: finalUsed.length, unused: unusedNodeIds.length });
    } catch (err) {
      log.warn("get-based M update failed", { error: String(err) });
    }
  }

  private async recallPrecise(
    query: string,
    limit: number,
    precomputedVec?: number[],
  ): Promise<RecallResult> {
    const tPrecise = Date.now();

    // v2.4.0 点5: 多阶段检索 —— 先图关系筛选候选，再向量相似度排序
    if (this.cfg.recall?.multiStage && (precomputedVec?.length || this.embed)) {
      return this.recallMultiStage(query, limit, precomputedVec);
    }

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
        // v2.3.5 fix: recall 失败不再静默吞 — 去掉 GM_DEBUG 门槛，生产环境也能看到错误
        log.warn("recall-precise vector search failed", { error: String(e) });
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
        log.warn("recall-precise PPR failed", { error: String(e) });
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

  /**
   * v2.4.0 点5: 多阶段检索
   *
   * Stage 1（图关系筛选）：FTS 种子 → graphWalk 候选邻域，仅保留与查询在图上相关的节点；
   * Stage 2（向量相似度排序）：在候选集内用 query 向量做余弦相似度（支持分块向量），
   *   再结合时序新鲜度 / 重要性 / 过时惩罚综合重排，减少全局向量搜索带来的无关节点干扰。
   */
  private async recallMultiStage(
    query: string,
    limit: number,
    precomputedVec?: number[],
  ): Promise<RecallResult> {
    const tMulti = Date.now();

    // 获取 query 向量（优先复用入口预计算）
    let vec: number[];
    if (precomputedVec?.length) {
      vec = precomputedVec;
    } else {
      vec = await this.embed!(query);
    }
    if (!vec.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    // Stage 1: FTS 种子 → 图邻域候选
    const tFts = Date.now();
    const seeds = await searchNodes(this.driver, query, limit);
    logPhase("multi_stage_fts", Date.now() - tFts, { seeds: seeds.length });
    if (seeds.length === 0) return { nodes: [], edges: [], tokenEstimate: 0 };

    const seedIds = seeds.map(n => n.id);
    const tGw = Date.now();
    const walked = await graphWalk(this.driver, seedIds, this.cfg.recallMaxDepth);
    let candidates = walked.nodes;
    if (candidates.length === 0) {
      candidates = seeds;
    }
    logPhase("multi_stage_graph_filter", Date.now() - tGw, { candidates: candidates.length });

    // Stage 2: 候选集内向量相似度 + 综合重排
    const sims = computeChunkSimilarities(vec, candidates);
    const now = Date.now();
    const temporalWeight = this.cfg.recall?.temporalWeight ?? 0.3;
    const scored = candidates.map(n => {
      const structure = n.importanceScore ?? n.pagerank ?? 0;
      const score = combineScore({
        vectorSim: sims.get(n.id) ?? 0,
        importance: structure,
        pagerank: n.pagerank,
        staleness: n.stalenessScore ?? 0,
        recency: temporalRecency(n, now),
        temporalWeight,
      });
      return { node: n, score };
    });
    scored.sort((a, b) => b.score - a.score);

    const finalNodes = scored.slice(0, limit).map(s => s.node);
    const finalIds = new Set(finalNodes.map(n => n.id));
    const edges = (walked.edges ?? []).filter(e =>
      finalIds.has(e.fromId) && finalIds.has(e.toId)
    );

    logPhase("recall_multi_stage", Date.now() - tMulti, { finalNodes: finalNodes.length });
    return { nodes: finalNodes, edges, tokenEstimate: finalNodes.length * 50 + edges.length * 20 };
  }

  private async recallGeneralized(
    query: string,
    limit: number,
    precomputedVec?: number[],
  ): Promise<RecallResult> {
    // v2.5.4: 先判定「无向量可用」直接早退出，不进入 try 体，避免被 catch 捕获
    // 产生误导性 "recall-generalized failed" warn。这是正常降级路径，不应打 warn。
    //   情况1：未配置 embed 且入口也没预计算向量；
    //   情况2：embed 熔断器已 OPEN（入口返回了 undefined），此时不应再发起请求。
    if (!this.embed && !precomputedVec?.length) {
      return { nodes: [], edges: [], tokenEstimate: 0 };
    }
    if (!precomputedVec?.length) {
      const breaker = getCircuitBreaker("embed", {
        failureThreshold: 3,
        cooldownMs: 15_000,
        failureWindowMs: 30_000,
      });
      if (!breaker.allow()) {
        return { nodes: [], edges: [], tokenEstimate: 0 };
      }
    }

    const tGen = Date.now();

    try {
      // v2.3.1 性能优化: 优先复用入口预计算的 queryEmbedding，避免重复 embed（~1000ms）
      let vec: number[];
      if (precomputedVec?.length) {
        vec = precomputedVec;
      } else {
        // v2.5.4: 二次尝试 embed 前同样走专项熔断器（避免熔断器 OPEN 时这里再发请求打 Ollama）
        const breaker = getCircuitBreaker("embed", {
          failureThreshold: 3,
          cooldownMs: 15_000,
          failureWindowMs: 30_000,
        });
        if (!breaker.allow()) return { nodes: [], edges: [], tokenEstimate: 0 };
        const tEmbed = Date.now();
        try {
          vec = await this.embed!(query);
          breaker.recordSuccess();
        } catch (e) {
          breaker.recordFailure();
          throw e; // 交给外层统一 catch
        }
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
        log.warn("recall-generalized PPR failed", { error: String(e) });
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
      // v2.6.x 告警降噪：社区向量索引缺失是 schema 问题（由 community.ts 自愈 + 优雅降级，
      // 此处一般不触发；仅作防御性兜底），降为 debug 避免同秒多次误导性 warn。
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such vector schema index/i.test(msg) && msg.includes("gm_community_embedding")) {
        log.debug("recall-generalized skipped (community vector index missing — self-healing in progress)");
      } else {
        log.warn("recall-generalized failed", { error: msg });
      }
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
    // v2.4.0 点4: 引入时序权重 —— 结合节点新鲜度（temporalRecency）做时序衰减，
    //   避免过期（validTo 在过去 / superseded）或冲突（transitional）节点被错误排前。
    const stalenessThreshold = this.cfg?.staleness?.threshold ?? 0.7;
    const temporalWeight = this.cfg?.recall?.temporalWeight ?? 0.3;
    const now = Date.now();
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
      let base: number;
      if (wx === 0 && wy === 0) {
        base = 0;
      } else {
        base = wy - wx;
      }
      // v2.4.0 点4: 时序权重 —— 新鲜度加权，过期/冲突节点显著降权
      const rx = temporalRecency(x, now);
      const ry = temporalRecency(y, now);
      const temporalDiff = (ry - rx) * temporalWeight;
      // 顶点顺序：基础分（importance/过时）优先，同分时按时序新鲜度
      if (base !== 0) return base + temporalDiff;
      return temporalDiff !== 0 ? temporalDiff : y.pagerank - x.pagerank;
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
      // v2.4.0 点2/点6: 统一处理记忆切片长度与长文本分段嵌入
      await embedNode(this.driver, this.embed, node.id, {
        name: node.name,
        description: node.description,
        content: node.content,
        embeddingModel: node.embeddingModel,
      }, this.cfg);
      logPhase("vec_embed", Date.now() - tSync, { context: "syncEmbed" });
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
