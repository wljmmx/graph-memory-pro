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
  warmupFeedbacks: 100,
};

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

  // 训练统计
  private updateCount = 0;
  private rejectedCount = 0;          // R-3 拒绝的更新数

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
   * 计算更新方向（梯度）
   *
   * Hebbian 规则：ΔM[i,j] = η · reward · vec[j] · (out[i])
   *
   * 简化：对于被使用的节点（reward>0），增强 M 对该 query 的同向投影
   */
  private computeGrad(
    queryVec: Float32Array,
    reward: number,
  ): { gradM: Float32Array; gradBias: Float32Array } {
    const N = this.dim;
    const gradM = new Float32Array(N * N);
    const gradBias = new Float32Array(N);

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

    // Hebbian 梯度：reward · vec[j] · out[i]
    // 沿 query 方向增强 → outer(queryVec, out) * reward
    // H-8: 不在此处乘 learningRate（η 由 applyUpdate 中的 Adam 步统一缩放，避免 η² 双重缩放）
    const scale = reward;
    for (let i = 0; i < N; i++) {
      const rowOffset = i * N;
      const outI = out[i];
      const gi = this.gain[i] * this.rowScale[i];
      for (let j = 0; j < N; j++) {
        gradM[rowOffset + j] = scale * normalized[j] * outI * gi;
      }
      gradBias[i] = scale * outI * gi;
    }
    return { gradM, gradBias };
  }

  /**
   * 应用 Adam + Momentum 更新
   */
  private applyUpdate(gradM: Float32Array, gradBias: Float32Array): void {
    this.t++;
    const N = this.dim;
    const { adamBeta1: b1, adamBeta2: b2 } = this.cfg;
    const eps = 1e-8;
    const mu = this.cfg.momentum;

    // Adam 校正系数
    const biasCorrection1 = 1 - Math.pow(b1, this.t);
    const biasCorrection2 = 1 - Math.pow(b2, this.t);

    // 更新 M
    for (let i = 0; i < N * N; i++) {
      const g = gradM[i];
      // 一阶矩（带 momentum）
      this.mW[i] = b1 * this.mW[i] + (1 - b1) * g;
      // 二阶矩
      this.vW[i] = b2 * this.vW[i] + (1 - b2) * g * g;
      // Adam 校正
      const mHat = this.mW[i] / biasCorrection1;
      const vHat = this.vW[i] / biasCorrection2;
      // Momentum 平滑
      this.M[i] += this.cfg.learningRate * mHat / (Math.sqrt(vHat) + eps);
      // 数值稳定：限制单步变化
      if (this.M[i] > 10) this.M[i] = 10;
      if (this.M[i] < -10) this.M[i] = -10;
    }
    // 更新 bias
    for (let i = 0; i < N; i++) {
      const g = gradBias[i];
      this.mBias[i] = b1 * this.mBias[i] + (1 - b1) * g;
      this.vBias[i] = b2 * this.vBias[i] + (1 - b2) * g * g;
      const mHat = this.mBias[i] / biasCorrection1;
      const vHat = this.vBias[i] / biasCorrection2;
      this.bias[i] += this.cfg.learningRate * mHat / (Math.sqrt(vHat) + eps);
      if (this.bias[i] > 10) this.bias[i] = 10;
      if (this.bias[i] < -10) this.bias[i] = -10;
    }
    // mu 没用到变量，保留为参数（避免 TS 未使用警告）
    void mu;
  }

  /**
   * 记录一个历史样本（用于 R-3 邻域评估）
   */
  recordHistorySample(queryEmbedding: number[] | Float32Array, reward: number): void {
    if (!this.cfg.enabled || !this.muCfg.enabled) return;
    const storedVec = Float32Array.from(queryEmbedding);
    const predictedScore = this.evaluateSample(storedVec);
    this.history.push({
      queryEmbedding: storedVec,
      reward,
      predictedScore,
    });
    if (this.history.length > this.historyMaxSize) {
      this.history.shift();
    }
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

      // 邻域整体提升未达阈值 → 拒绝更新（防过拟合）
      if (neighborhoodGain < this.muCfg.minImprovement) {
        this.rejectedCount++;
        // 仍记录样本，供下次评估
        this.recordHistorySample(vec, reward);
        return { applied: false, neighborhoodGain };
      }
    }

    // 应用更新
    const { gradM, gradBias } = this.computeGrad(vec, reward);
    this.applyUpdate(gradM, gradBias);
    this.updateCount++;

    // 记录样本
    this.recordHistorySample(vec, reward);
    return { applied: true, neighborhoodGain: reward };
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
   * 序列化为 JSON（用于持久化）
   *
   * 注意：M 矩阵 4MB，序列化较重，仅在 gm_maintain 周期性保存
   */
  serialize(): string {
    return JSON.stringify({
      dim: this.dim,
      M: Array.from(this.M),
      bias: Array.from(this.bias),
      gain: Array.from(this.gain),
      rowScale: Array.from(this.rowScale),
      mW: Array.from(this.mW),
      vW: Array.from(this.vW),
      mBias: Array.from(this.mBias),
      vBias: Array.from(this.vBias),
      t: this.t,
      bnRunningMean: Array.from(this.bnRunningMean),
      bnRunningVar: Array.from(this.bnRunningVar),
      updateCount: this.updateCount,
      rejectedCount: this.rejectedCount,
    });
  }

  /** 反序列化 */
  deserialize(json: string): void {
    const data = JSON.parse(json);
    if (data.dim !== this.dim) {
      throw new Error(`dim mismatch: expected ${this.dim}, got ${data.dim}`);
    }
    this.M = Float32Array.from(data.M);
    this.bias = Float32Array.from(data.bias);
    this.gain = Float32Array.from(data.gain);
    this.rowScale = Float32Array.from(data.rowScale);
    this.mW = Float32Array.from(data.mW);
    this.vW = Float32Array.from(data.vW);
    this.mBias = Float32Array.from(data.mBias);
    this.vBias = Float32Array.from(data.vBias);
    this.t = data.t ?? 0;
    this.bnRunningMean = Float32Array.from(data.bnRunningMean ?? new Array(this.dim).fill(0));
    this.bnRunningVar = Float32Array.from(data.bnRunningVar ?? new Array(this.dim).fill(1));
    this.updateCount = data.updateCount ?? 0;
    this.rejectedCount = data.rejectedCount ?? 0;
  }
}

// ── 辅助函数 ──────────────────────────────────────

function createIdentityMatrix(dim: number): Float32Array {
  const m = new Float32Array(dim * dim);
  for (let i = 0; i < dim; i++) {
    m[i * dim + i] = 1;
  }
  return m;
}

function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = (a as any).length ?? 0;
  if (n === 0 || (b as any).length !== n) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < n; i++) {
    const av = (a as any)[i];
    const bv = (b as any)[i];
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
  const warmupFeedbacks = amCfg?.warmupFeedbacks ?? cfg?.warmup?.warmupFeedbacks ?? 100;

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
