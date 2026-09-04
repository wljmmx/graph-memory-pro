/**
 * L-1 关联矩阵 M + R-3 边际效用奖励（v2.1.2 第三批）
 *
 * 算法骨架（来自文章）：
 *
 *   query_vec → BatchNorm → (M @ vec + bias) → × gain × row_scale → 向量搜索
 *
 * 学习规则：Hebbian（强化正确）+ Momentum（平滑）+ Adam（自适应）
 *   - reward > 0：被使用的节点得分提升 → 增强 M 在该 query 方向的投影
 *   - reward < 0：未被使用 → 抑制
 *
 * R-3 边际效用奖励：
 *   - 找到与当前 query 相似的 N 个历史 query（语义邻域）
 *   - 在邻域上评估 M 更新的边际效用
 *   - 只在邻域整体提升时提交 M 更新（防过拟合到单一案例）
 *
 * 冷启动（G-6）：
 *   - 累计反馈数 < warmupFeedbacks 时，M = 单位矩阵（transform 直接返回原 vec）
 *   - 期间召回使用 BM25 + 向量混合（见 judge.ts getColdStartSearchWeights）
 *
 * 内存：N=1024 时 M = Float32Array(1024*1024) ≈ 4MB，可全内存驻留
 */

import type { GmConfig } from "../types.ts";

export interface AssociationMatrixConfig {
  enabled: boolean;
  learningRate: number;   // η，默认 0.01
  momentum: number;       // μ，默认 0.9
  adamBeta1: number;      // 默认 0.9
  adamBeta2: number;      // 默认 0.999
  /** 冷启动阈值（覆盖 cfg.warmup.warmupFeedbacks） */
  warmupFeedbacks: number;
}

export const DEFAULT_AM_CONFIG: AssociationMatrixConfig = {
  enabled: false,
  learningRate: 0.01,
  momentum: 0.9,
  adamBeta1: 0.9,
  adamBeta2: 0.999,
  warmupFeedbacks: 40,
};

/**
 * 学习曲线采样点（跨重启持久化，随 M 一起落盘）
 *
 * 用于 dashboard /api/association-matrix/history 时序展示。
 */
export interface LearningSample {
  /** epoch ms */
  timestamp: number;
  /** Adam 时间步 t */
  t: number;
  updatesApplied: number;
  updatesRejected: number;
  feedbackCount: number;
}

/** 关联矩阵 M 可视化数据 */
export interface AssociationMatrixVisual {
  /** 原始矩阵维度 N */
  dim: number;
  /** 降采样后的网格尺寸（grid × grid） */
  grid: number;
  /** 降采样后的矩阵值（grid*grid，行优先，每个 cell 为子块均值） */
  values: number[];
  /** 对角偏差：mean(|M[i,i] - 1|)，偏离单位矩阵的程度 */
  diagDeviation: number;
  /** 每行能量：行均方值（长度 = grid） */
  rowEnergy: number[];
  /** Frobenius 范数（降采样网格上计算） */
  frobenius: number;
  /** 与单位矩阵的接近度 ∈ [0,1]（1 = 完全单位矩阵） */
  identityRatio: number;
}

/** R-3 边际效用配置 */
export interface MarginalUtilityConfig {
  enabled: boolean;
  neighborhoodSize: number;   // N，默认 5
  minImprovement: number;     // 邻域整体提升阈值，默认 0.0（>=0 即提交）
}

export const DEFAULT_MU_CONFIG: MarginalUtilityConfig = {
  enabled: true,
  neighborhoodSize: 5,
  minImprovement: 0.0,
};

/** 历史样本（用于 R-3 邻域评估） */
interface HistorySample {
  queryEmbedding: Float32Array;
  /** 该 query 的反馈信号：used - unused 比例 ∈ [-1, 1] */
  reward: number;
  /** 当前 M 在该样本上的预测分数（transform 后与原向量的 cosine） */
  predictedScore: number;
  /** v2.6.0: 该样本被正向使用的节点 id（稀疏图共现潜在边信号） */
  usedNodeIds?: string[];
}

/**
 * 关联矩阵 M
 *
 * - M: N×N Float32Array（行优先：M[i*N + j]）
 * - bias / gain / rowScale: 长度 N
 * - 一阶矩 m、二阶矩 v（Adam 状态）
 */
export class AssociationMatrix {
  private readonly cfg: AssociationMatrixConfig;
  private readonly muCfg: MarginalUtilityConfig;
  private readonly dim: number;

  // 主参数
  private M: Float32Array;          // N×N
  private bias: Float32Array;        // N
  private gain: Float32Array;        // N，默认 1
  private rowScale: Float32Array;    // N，默认 1

  // Adam 状态（一阶/二阶矩）
  private mW: Float32Array;           // 同 M 维度
  private vW: Float32Array;
  private mBias: Float32Array;
  private vBias: Float32Array;
  private t = 0;                     // 时间步

  // BatchNorm 运行统计
  private bnRunningMean: Float32Array;
  private bnRunningVar: Float32Array;
  private readonly bnMomentum = 0.9;

  // R-3 历史样本池
  private history: HistorySample[] = [];
  private readonly historyMaxSize = 200;

  // v2.6.0: 稀疏信号滚动窗口（记录最近 gain 序列，上限 50）
  private recentGains: number[] = [];
  private readonly recentGainsMaxSize = 50;

  // 训练统计
  private updateCount = 0;
  private rejectedCount = 0;          // R-3 拒绝的更新数

  // 学习曲线采样（跨重启持久化）
  private learningHistory: LearningSample[] = [];
  private readonly learningHistoryMaxSize = 200;

  constructor(dim: number, amCfg?: Partial<AssociationMatrixConfig>, muCfg?: Partial<MarginalUtilityConfig>) {
    this.dim = dim;
    this.cfg = { ...DEFAULT_AM_CONFIG, ...amCfg };
    this.muCfg = { ...DEFAULT_MU_CONFIG, ...muCfg };
    this.M = createIdentityMatrix(dim);
    this.bias = new Float32Array(dim);
    this.gain = new Float32Array(dim).fill(1);
    this.rowScale = new Float32Array(dim).fill(1);
    this.mW = new Float32Array(dim * dim);
    this.vW = new Float32Array(dim * dim);
    this.mBias = new Float32Array(dim);
    this.vBias = new Float32Array(dim);
    this.bnRunningMean = new Float32Array(dim);
    this.bnRunningVar = new Float32Array(dim).fill(1);
  }

  /** 是否启用 */
  isEnabled(): boolean {
    return this.cfg.enabled;
  }

  /**
   * 是否处于冷启动期（G-6）
   * @param feedbackCount 当前累计反馈数
   */
  isColdStart(feedbackCount: number): boolean {
    return feedbackCount < this.cfg.warmupFeedbacks;
  }

  /**
   * 变换 query 向量
   *
   * 流程：BatchNorm → M @ vec + bias → × gain × rowScale
   *
   * 冷启动期：直接返回原 vec（M = I）
   *
   * @param vec 输入向量
   * @param feedbackCount 反馈计数（决定冷启动）
   * @returns 变换后的向量（与输入同维度，调用方需保证 vec 长度 = dim）
   */
  transform(vec: number[] | Float32Array, feedbackCount: number): Float32Array {
    // 冷启动或未启用：M = I，直接返回
    if (!this.cfg.enabled || this.isColdStart(feedbackCount)) {
      return Float32Array.from(vec);
    }

    const N = this.dim;
    if (vec.length !== N) {
      // 维度不匹配，回退 identity
      return Float32Array.from(vec);
    }

    // Step 1: BatchNorm（使用运行统计）
    const normalized = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const v = vec[i];
      const mean = this.bnRunningMean[i];
      const variance = this.bnRunningVar[i];
      normalized[i] = (v - mean) / Math.sqrt(variance + 1e-8);
    }

    // Step 2: M @ vec + bias
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let sum = this.bias[i];
      const rowOffset = i * N;
      for (let j = 0; j < N; j++) {
        sum += this.M[rowOffset + j] * normalized[j];
      }
      // Step 3: × gain × rowScale
      out[i] = sum * this.gain[i] * this.rowScale[i];
    }
    return out;
  }

  /**
   * 更新 BatchNorm 运行统计（每次召回后调用）
   */
  updateBatchNormStats(vec: number[] | Float32Array): void {
    if (!this.cfg.enabled) return;
    if (vec.length !== this.dim) return;

    const m = this.bnMomentum;
    for (let i = 0; i < this.dim; i++) {
      // EMA 更新 mean
      this.bnRunningMean[i] = m * this.bnRunningMean[i] + (1 - m) * vec[i];
      // EMA 更新 var（用 (x-mean)^2 近似）
      const dev = vec[i] - this.bnRunningMean[i];
      this.bnRunningVar[i] = m * this.bnRunningVar[i] + (1 - m) * dev * dev;
    }
  }

  /**
   * 评估 M 在某个 (query, reward) 样本上的预测分数
   *
   * 简化定义：transform(query) 与原 query 的 cosine 相似度
   *   - reward > 0 表示该 query 应被增强 → 希望 cosine > 0
   *   - reward < 0 表示应被抑制
   *
   * 用于 R-3 邻域评估
   */
  evaluateSample(queryEmbedding: number[] | Float32Array): number {
    if (!this.cfg.enabled) return 0;
    const transformed = this.transform(queryEmbedding, Number.MAX_SAFE_INTEGER); // 强制走 M
    return cosineSim(transformed, queryEmbedding);
  }

  /**
   * 应用 Hebbian 梯度 + Adam 更新（P0-1 性能优化）
   *
   * 原理：Hebbian 梯度是 rank-1 外积
   *   gradM[i,j] = scale · normalized[j] · out[i] · gain[i] · rowScale[i]
   *             = rowFactor[i] · normalized[j]
   *   其中 scale = learningRate · reward，rowFactor[i] = scale · out[i] · gain[i] · rowScale[i]
   *
   * 原实现先 computeGrad 构造完整 N×N 梯度数组（N=1024 时 4MB），再 applyUpdate
   * 全量 Adam 更新，每次 feedback 均产生一次 4MB 分配 + 两遍 O(N²) 遍历。
   * 本实现利用 rank-1 结构，将 forward + 梯度 + Adam 合并为单遍 O(N²) 遍历，
   * 逐行直接更新 M，避免构造 gradM 数组（省去 4MB 分配与冗余传递），数学结果与原来完全一致。
   */
  private applyHebbianUpdate(queryVec: Float32Array, reward: number): void {
    this.t++;
    const N = this.dim;
    const { adamBeta1: b1, adamBeta2: b2 } = this.cfg;
    const eps = 1e-8;

    // Adam 校正系数
    const biasCorrection1 = 1 - Math.pow(b1, this.t);
    const biasCorrection2 = 1 - Math.pow(b2, this.t);

    // forward pass（已 normalize 的输入）
    const normalized = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const v = queryVec[i];
      normalized[i] = (v - this.bnRunningMean[i]) / Math.sqrt(this.bnRunningVar[i] + 1e-8);
    }
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let sum = this.bias[i];
      const rowOffset = i * N;
      for (let j = 0; j < N; j++) {
        sum += this.M[rowOffset + j] * normalized[j];
      }
      out[i] = sum * this.gain[i] * this.rowScale[i];
    }

    // Hebbian 更新：ΔM[i,j] = rowFactor[i] · normalized[j]（rank-1 外积）
    const scale = this.cfg.learningRate * reward;
    for (let i = 0; i < N; i++) {
      const rowOffset = i * N;
      const rowFactor = scale * out[i] * (this.gain[i] * this.rowScale[i]);

      // bias 梯度 g = rowFactor
      const gb = rowFactor;
      this.mBias[i] = b1 * this.mBias[i] + (1 - b1) * gb;
      this.vBias[i] = b2 * this.vBias[i] + (1 - b2) * gb * gb;
      const mbHat = this.mBias[i] / biasCorrection1;
      const vbHat = this.vBias[i] / biasCorrection2;
      this.bias[i] += this.cfg.learningRate * mbHat / (Math.sqrt(vbHat) + eps);
      if (this.bias[i] > 10) this.bias[i] = 10;
      if (this.bias[i] < -10) this.bias[i] = -10;

      // M 行更新：g[i,j] = rowFactor · normalized[j]
      for (let j = 0; j < N; j++) {
        const idx = rowOffset + j;
        const g = rowFactor * normalized[j];
        this.mW[idx] = b1 * this.mW[idx] + (1 - b1) * g;
        this.vW[idx] = b2 * this.vW[idx] + (1 - b2) * g * g;
        const mHat = this.mW[idx] / biasCorrection1;
        const vHat = this.vW[idx] / biasCorrection2;
        this.M[idx] += this.cfg.learningRate * mHat / (Math.sqrt(vHat) + eps);
        // 数值稳定：限制单步变化
        if (this.M[idx] > 10) this.M[idx] = 10;
        if (this.M[idx] < -10) this.M[idx] = -10;
      }
    }
  }

  /**
   * 记录一个历史样本（用于 R-3 邻域评估）
   */
  recordHistorySample(queryEmbedding: number[] | Float32Array, reward: number, usedNodeIds?: string[]): void {
    if (!this.cfg.enabled || !this.muCfg.enabled) return;
    const storedVec = Float32Array.from(queryEmbedding);
    const predictedScore = this.evaluateSample(storedVec);
    this.history.push({
      queryEmbedding: storedVec,
      reward,
      predictedScore,
      usedNodeIds,
    });
    if (this.history.length > this.historyMaxSize) {
      this.history.shift();
    }
  }

  /** v2.6.0: 带 usedNodeIds 的记录入口（供召回侧反馈链使用，等价于 recordHistorySample 带节点信息） */
  recordHistorySampleWithNodes(queryEmbedding: number[] | Float32Array, reward: number, usedNodeIds: string[]): void {
    this.recordHistorySample(queryEmbedding, reward, usedNodeIds);
  }

  /**
   * R-3 边际效用更新
   *
   * @param queryVec 当前 query 的 embedding
   * @param reward 反馈信号 ∈ [-1, 1]（used - unused 占比）
   * @returns 是否提交了更新（false = 被邻域评估拒绝）
   */
  updateWithMarginalUtility(
    queryVec: number[] | Float32Array,
    reward: number,
  ): { applied: boolean; neighborhoodGain: number } {
    if (!this.cfg.enabled) return { applied: false, neighborhoodGain: 0 };

    const vec = Float32Array.from(queryVec);
    if (vec.length !== this.dim) return { applied: false, neighborhoodGain: 0 };

    // v2.5.2: 防 NaN 污染。embed 层可能返回含 NaN 的向量（模型异常/输入异常），
    // 若不经检查直接传入 applyHebbianUpdate，NaN 会通过 Hebbian 梯度传播到整个 M，
    // 序列化时 JSON.stringify(NaN)→null，反序列化 Float32Array.from(null)→0，
    // 导致 M 全零矩阵（含对角 1 也被清零）。此处检查并跳过 NaN 向量。
    if (hasNaN(vec)) {
      // v2.5.2: 记录日志，避免静默丢弃学习信号
      console.warn(`[graph-memory-pro:association-matrix] NaN 向量被拦截，未提交 M 更新`, {
        vecLen: vec.length,
        reward,
        timestamp: Date.now(),
      });
      return { applied: false, neighborhoodGain: 0 };
    }

    // R-3: 先在邻域上评估
    if (this.muCfg.enabled && this.history.length > 0) {
      // 找最相似的 N 个历史样本
      const neighbors = findTopSimilar(vec, this.history, this.muCfg.neighborhoodSize);

      // 计算"如果应用更新"的邻域整体提升
      // 简化：用 reward 信号在邻域上的加权平均作为提升估计
      // reward > 0 → 邻域整体提升；reward < 0 → 抑制
      // 权重 = similarity（相似邻居权重更大，符合"邻域整体提升"语义）
      const neighborhoodGain = neighbors.length > 0
        ? neighbors.reduce((sum, s) => sum + reward * s.similarity, 0) / neighbors.length
        : reward;

      // v2.6.0: 记录本次 gain 到稀疏信号滚动窗口
      this.recentGains.push(neighborhoodGain);
      if (this.recentGains.length > this.recentGainsMaxSize) this.recentGains.shift();

      // 邻域整体提升未达阈值 → 拒绝更新（防过拟合）
      if (neighborhoodGain < this.muCfg.minImprovement) {
        this.rejectedCount++;
        // 仍记录样本，供下次评估
        this.recordHistorySample(vec, reward);
        return { applied: false, neighborhoodGain };
      }
    }

    // 应用更新（P0-1: 融合 Hebbian 梯度 + Adam，单遍 O(N²)，无 4MB 梯度分配）
    this.applyHebbianUpdate(vec, reward);
    this.updateCount++;

    // 记录样本
    this.recordHistorySample(vec, reward);
    return { applied: true, neighborhoodGain: reward };
  }

  /**
   * v2.6.0: 稀疏信号。
   * value = 最近 50 次更新中 neighborhoodGain < 0.1 的比例（0-1，越高越稀疏）。
   * 供自愈阶段/调优诊断消费；不直接写图。
   */
  getSparsitySignal(): { value: number; recentLowGainRatio: number } {
    if (this.recentGains.length === 0) return { value: 0, recentLowGainRatio: 0 };
    let low = 0;
    for (const g of this.recentGains) if (g < 0.1) low++;
    const ratio = low / this.recentGains.length;
    return { value: ratio, recentLowGainRatio: ratio };
  }

  /**
   * v2.6.0: 共现潜在边。
   * 统计历史样本中「reward>0 且 usedNodeIds 非空」的样本内节点对共现累积权重，
   * 返回权重最高的 maxK 对（自愈补边优先级信号，比纯相似度更可信）。
   */
  getCoUsedNodePairs(maxK: number): Array<{ a: string; b: string; reward: number }> {
    const weights = new Map<string, number>();
    const addPair = (x: string, y: string, w: number): void => {
      const key = x < y ? `${x}|${y}` : `${y}|${x}`;
      weights.set(key, (weights.get(key) ?? 0) + w);
    };
    for (const h of this.history) {
      if (h.reward <= 0 || !h.usedNodeIds || h.usedNodeIds.length < 2) continue;
      const ids = [...new Set(h.usedNodeIds)];
      const w = h.reward;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          addPair(ids[i], ids[j], w);
        }
      }
    }
    const sorted = Array.from(weights.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, maxK));
    return sorted.map(([key, w]) => {
      const [a, b] = key.split("|");
      return { a, b, reward: Math.round(w * 1000) / 1000 };
    });
  }

  /** 统计信息 */
  getStats() {
    return {
      enabled: this.cfg.enabled,
      dim: this.dim,
      t: this.t,
      updatesApplied: this.updateCount,
      updatesRejected: this.rejectedCount,
      historySize: this.history.length,
    };
  }

  /**
   * 记录一个学习曲线采样点。
   *
   * 调用时机：每次 M 更新提交（updateWithMarginalUtility applied=true）后由 Recaller
   * 传入当前反馈计数。采样保存在内存环形缓冲（上限 learningHistoryMaxSize），
   * 并随 serialize() 一起持久化，实现跨重启的历史可追溯。
   *
   * @param feedbackCount 当前累计反馈数（来自 JudgeManager）
   */
  recordLearningSample(feedbackCount: number): void {
    this.learningHistory.push({
      timestamp: Date.now(),
      t: this.t,
      updatesApplied: this.updateCount,
      updatesRejected: this.rejectedCount,
      feedbackCount,
    });
    if (this.learningHistory.length > this.learningHistoryMaxSize) {
      this.learningHistory.shift();
    }
  }

  /**
   * 返回学习曲线采样（时间正序）。
   *
   * @param n 返回最近 n 条；不传则返回全部
   */
  getLearningHistory(n?: number): LearningSample[] {
    const start = n && n > 0 && n < this.learningHistory.length
      ? this.learningHistory.length - n
      : 0;
    return this.learningHistory.slice(start);
  }

  /**
   * 计算轻量可视化数据（供 dashboard 热力网格展示）。
   *
   * 降采样：将 N×N 的 M 按块平均压缩到 grid×grid（默认 64，最大 128），
   * 避免直接序列化 1024×1024=4MB 数组。同时计算学习集中度标量：
   *   - diagDeviation：对角偏离单位矩阵程度，越大说明 M 已学习出非平凡映射
   *   - rowEnergy：每行均方能量，反映各维度被激活的强度
   *   - frobenius / identityRatio：整体规模与接近单位矩阵的程度
   *
   * @param maxGrid 目标网格尺寸上限（默认 64，最大 128）
   */
  computeVisual(maxGrid = 64): AssociationMatrixVisual {
    const N = this.dim;
    const grid = Math.max(2, Math.min(maxGrid, 128, N));
    const block = Math.floor(N / grid);
    const values: number[] = [];

    for (let gi = 0; gi < grid; gi++) {
      for (let gj = 0; gj < grid; gj++) {
        let sum = 0;
        let cnt = 0;
        const r0 = gi * block;
        const r1 = Math.min(N, r0 + block);
        const c0 = gj * block;
        const c1 = Math.min(N, c0 + block);
        for (let i = r0; i < r1; i++) {
          const rowOffset = i * N;
          for (let j = c0; j < c1; j++) {
            sum += this.M[rowOffset + j];
            cnt++;
          }
        }
        values.push(cnt > 0 ? sum / cnt : 0);
      }
    }

    // 对角偏差：mean(|M[i,i] - 1|)
    let diagSum = 0;
    for (let i = 0; i < N; i++) {
      diagSum += Math.abs(this.M[i * N + i] - 1);
    }
    const diagDeviation = N > 0 ? diagSum / N : 0;

    // 每行能量（降采样网格维度）
    const rowEnergy: number[] = [];
    let frob = 0;
    for (let gi = 0; gi < grid; gi++) {
      let rowSum = 0;
      for (let gj = 0; gj < grid; gj++) {
        const v = values[gi * grid + gj];
        rowSum += v * v;
        frob += v * v;
      }
      rowEnergy.push(Math.sqrt(rowSum / grid));
    }
    frob = Math.sqrt(frob);

    // 与单位矩阵接近度：基于对角偏差（0 → 1，偏差越大越接近 0）
    const identityRatio = Math.max(0, Math.min(1, 1 - diagDeviation / (diagDeviation + 1)));

    return {
      dim: N,
      grid,
      values,
      diagDeviation,
      rowEnergy,
      frobenius: frob,
      identityRatio,
    };
  }

  /**
   * 序列化为 JSON（用于持久化）
   *
   * 注意：M 矩阵 4MB，序列化较重，仅在 gm_maintain 周期性保存
   */
  serialize(): string {
    // v2.5.3: 写盘前防御 —— 若已学习过但 M 全 0（死锁），重置为单位矩阵，
    // 防止坏状态被持久化永久化。
    if (this.t > 0 && isAllZero(this.M)) {
      console.warn("[association-matrix] serialize: M 全 0（死锁），重置为单位矩阵");
      this.M = createIdentityMatrix(this.dim);
      this.mW = new Float32Array(this.dim * this.dim);
      this.vW = new Float32Array(this.dim * this.dim);
      this.mBias = new Float32Array(this.dim);
      this.vBias = new Float32Array(this.dim);
      this.t = 0;
      this.updateCount = 0;
    }
    return JSON.stringify({
      dim: this.dim,
      // v2.5.2: 序列化时把 NaN/Infinity 归一为 0，避免 JSON.stringify(NaN)→null，
      // 反序列化 Float32Array.from(null)→0 造成 M 全零矩阵（含对角被清零）。
      M: sanitizeForJson(this.M),
      bias: sanitizeForJson(this.bias),
      gain: sanitizeForJson(this.gain),
      rowScale: sanitizeForJson(this.rowScale),
      mW: sanitizeForJson(this.mW),
      vW: sanitizeForJson(this.vW),
      mBias: sanitizeForJson(this.mBias),
      vBias: sanitizeForJson(this.vBias),
      t: this.t,
      bnRunningMean: sanitizeForJson(this.bnRunningMean),
      bnRunningVar: sanitizeForJson(this.bnRunningVar),
      updateCount: this.updateCount,
      rejectedCount: this.rejectedCount,
      learningHistory: this.learningHistory,
    });
  }

  /** 反序列化 */
  deserialize(json: string): void {
    const data = JSON.parse(json);
    if (data.dim !== this.dim) {
      throw new Error(`dim mismatch: expected ${this.dim}, got ${data.dim}`);
    }
    // v2.5.3: fromJsonArray 对非数组数据返回 null，此处逐字段回退——
    // M 损坏 → 单位矩阵（保证可学习、不丢对角），其余 → 零阵。
    // 绝不静默接受全 0 矩阵（会进入 Adam 死锁且无法自愈）。
    const dim = this.dim;
    const M = fromJsonArray(data.M, dim * dim);
    this.M = M ?? createIdentityMatrix(dim);
    this.bias = fromJsonArray(data.bias, dim) ?? new Float32Array(dim);
    this.gain = fromJsonArray(data.gain, dim) ?? new Float32Array(dim).fill(1);
    this.rowScale = fromJsonArray(data.rowScale, dim) ?? new Float32Array(dim).fill(1);
    this.mW = fromJsonArray(data.mW, dim * dim) ?? new Float32Array(dim * dim);
    this.vW = fromJsonArray(data.vW, dim * dim) ?? new Float32Array(dim * dim);
    this.mBias = fromJsonArray(data.mBias, dim) ?? new Float32Array(dim);
    this.vBias = fromJsonArray(data.vBias, dim) ?? new Float32Array(dim);
    this.t = data.t ?? 0;
    this.bnRunningMean = fromJsonArray(data.bnRunningMean, dim) ?? new Float32Array(dim);
    this.bnRunningVar = data.bnRunningVar != null
      ? (fromJsonArray(data.bnRunningVar, dim) ?? new Float32Array(dim).fill(1))
      : new Float32Array(dim).fill(1);
    this.updateCount = data.updateCount ?? 0;
    this.rejectedCount = data.rejectedCount ?? 0;
    // 学习曲线采样（兼容旧文件无此字段）
    this.learningHistory = Array.isArray(data.learningHistory)
      ? data.learningHistory.slice(-this.learningHistoryMaxSize)
      : [];

    // v2.5.3: 死锁自愈 —— 已学习过（t>0）但 M 全 0 = 状态损坏
    // （曾因旧版 fromJsonArray 静默归零导致）。重置为单位矩阵并清空动量，
    // 否则零梯度 → Adam 动量恒 0 → 矩阵永远学不回来。
    if (this.t > 0 && isAllZero(this.M)) {
      console.warn("[association-matrix] deserialize: M 全 0（状态损坏），重置为单位矩阵并清空动量");
      this.M = createIdentityMatrix(dim);
      this.mW = new Float32Array(dim * dim);
      this.vW = new Float32Array(dim * dim);
      this.mBias = new Float32Array(dim);
      this.vBias = new Float32Array(dim);
      this.bias = new Float32Array(dim);
      this.gain = new Float32Array(dim).fill(1);
      this.rowScale = new Float32Array(dim).fill(1);
      this.t = 0;
      this.updateCount = 0;
      this.rejectedCount = 0;
    }
  }
}

// ── 辅助函数 ──────────────────────────────────────

/** v2.5.3: 判断 Float32Array 是否全 0（死锁检测用） */
function isAllZero(arr: ArrayLike<number>): boolean {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] !== 0) return false;
  }
  return true;
}

/** v2.5.2: 检查数组是否含 NaN（含 Infinity 一并处理），用于防污染入 M */
function hasNaN(arr: ArrayLike<number>): boolean {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) return true;
  }
  return false;
}

/** v2.5.2: 序列化前把 NaN/Infinity 归一为 0，避免 JSON 序列化产生 null 破坏矩阵 */
function sanitizeForJson(arr: ArrayLike<number>): number[] {
  const out = new Array<number>(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/**
 * v2.5.3: 从 JSON 数据构建 Float32Array。
 * 兼容旧文件中的 null（NaN→JSON null）与缺失值，统一归一为 0。
 * 若 data 不是数组（字段缺失/损坏/被截断），返回 null 交由调用方回退，
 * 绝不静默返回全 0 —— 全 0 矩阵会让学习进入死锁且无法自愈。
 */
function fromJsonArray(data: unknown, expectedLen: number): Float32Array | null {
  if (!Array.isArray(data)) return null;
  const out = new Float32Array(expectedLen);
  const n = Math.min(data.length, expectedLen);
  for (let i = 0; i < n; i++) {
    const v = data[i];
    out[i] = typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  return out;
}

function createIdentityMatrix(dim: number): Float32Array {
  const m = new Float32Array(dim * dim);
  for (let i = 0; i < dim; i++) {
    m[i * dim + i] = 1;
  }
  return m;
}

function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length ?? 0;
  if (n === 0 || b.length !== n) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 在历史样本池中找到与 queryVec 最相似的 N 个
 */
function findTopSimilar(
  queryVec: Float32Array,
  pool: HistorySample[],
  n: number,
): Array<{ sample: HistorySample; similarity: number }> {
  const scored = pool.map(s => ({
    sample: s,
    similarity: cosineSim(queryVec, s.queryEmbedding),
  }));
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, n);
}

/**
 * 从 GmConfig 构造 AssociationMatrix
 */
export function createAssociationMatrix(
  dim: number,
  cfg?: GmConfig,
): AssociationMatrix {
  const amCfg = cfg?.associationMatrix;
  const muCfg = cfg?.marginalUtility;
  const warmupFeedbacks = amCfg?.warmupFeedbacks ?? cfg?.warmup?.warmupFeedbacks ?? 40;

  return new AssociationMatrix(
    dim,
    {
      enabled: amCfg?.enabled ?? false,
      learningRate: amCfg?.learningRate,
      momentum: amCfg?.momentum,
      adamBeta1: amCfg?.adamBeta1,
      adamBeta2: amCfg?.adamBeta2,
      warmupFeedbacks,
    },
    {
      enabled: muCfg?.enabled ?? true,
      neighborhoodSize: muCfg?.neighborhoodSize,
      minImprovement: muCfg?.minImprovement,
    },
  );
}
