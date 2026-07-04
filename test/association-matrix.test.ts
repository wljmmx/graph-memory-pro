/**
 * L-1 关联矩阵 M + R-3 边际效用奖励 单元测试（graph-memory-pro v2.1.2 第三批）
 *
 * 测试 /workspace/src/recaller/association-matrix.ts 导出的：
 *   - AssociationMatrix 类（构造、isEnabled、transform、updateBatchNormStats、
 *     updateWithMarginalUtility、serialize/deserialize、getStats）
 *   - createAssociationMatrix 工厂
 *
 * 注意：被测模块的实际签名与任务描述略有出入，测试以源码为准：
 *   - constructor(dim, amCfg?, muCfg?)：dim 为首个必填参数
 *   - getStats() 返回 { enabled, dim, t, updatesApplied, updatesRejected, historySize }
 *   - DEFAULT_MU_CONFIG.minImprovement = 0.0
 *   - createAssociationMatrix(dim, cfg?)
 */

import { describe, it, expect } from "vitest";
import type { GmConfig } from "../src/types.ts";
import {
  AssociationMatrix,
  createAssociationMatrix,
  DEFAULT_AM_CONFIG,
  DEFAULT_MU_CONFIG,
} from "../src/recaller/association-matrix.ts";

// ── 辅助：浮点数组比较 ──────────────────────────────────────

function vecEqual(a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > eps) return false;
  }
  return true;
}

function vecMaxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let maxDiff = 0;
  for (let i = 0; i < n; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  }
  return maxDiff;
}

// ─── 1. 构造与默认值 ───────────────────────────────────────

describe("AssociationMatrix 构造与默认值", () => {
  it("默认 enabled=false", () => {
    const am = new AssociationMatrix(4);
    expect(am.isEnabled()).toBe(false);
  });

  it("默认 dimensions=1024 且 M 为单位矩阵（行为验证）", () => {
    const am = new AssociationMatrix(1024, { enabled: true });
    expect(am.getStats().dim).toBe(1024);
    // 初值 M=I, bias=0, gain=1, rowScale=1, bn mean=0/var=1
    // → transform(v, hot) 仅 BatchNorm 1e-8 扰动，输出 ≈ 输入
    const vec = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) vec[i] = (i + 1) * 0.001;
    const out = am.transform(vec, 1000);
    expect(out).toHaveLength(1024);
    expect(vecMaxAbsDiff(out, vec)).toBeLessThan(1e-5);
  });

  it("M 初始为单位矩阵（serialize 直接检查对角线=1，其余=0）", () => {
    const am = new AssociationMatrix(4, { enabled: true });
    const data = JSON.parse(am.serialize());
    for (let i = 0; i < 4; i++) {
      expect(data.M[i * 4 + i]).toBeCloseTo(1, 6);
    }
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i !== j) expect(data.M[i * 4 + j]).toBe(0);
      }
    }
  });

  it("bias 初始全 0，gain/rowScale 初始全 1", () => {
    const am = new AssociationMatrix(4, { enabled: true });
    const data = JSON.parse(am.serialize());
    for (let i = 0; i < 4; i++) {
      expect(data.bias[i]).toBe(0);
      expect(data.gain[i]).toBe(1);
      expect(data.rowScale[i]).toBe(1);
    }
  });

  it("BatchNorm 运行统计初值：mean=0, var=1", () => {
    const am = new AssociationMatrix(4, { enabled: true });
    const data = JSON.parse(am.serialize());
    for (let i = 0; i < 4; i++) {
      expect(data.bnRunningMean[i]).toBe(0);
      expect(data.bnRunningVar[i]).toBe(1);
    }
  });

  it("DEFAULT_AM_CONFIG 默认值符合源码规格", () => {
    expect(DEFAULT_AM_CONFIG.enabled).toBe(false);
    expect(DEFAULT_AM_CONFIG.learningRate).toBe(0.01);
    expect(DEFAULT_AM_CONFIG.momentum).toBe(0.9);
    expect(DEFAULT_AM_CONFIG.adamBeta1).toBe(0.9);
    expect(DEFAULT_AM_CONFIG.adamBeta2).toBe(0.999);
    expect(DEFAULT_AM_CONFIG.warmupFeedbacks).toBe(100);
  });

  it("DEFAULT_MU_CONFIG 默认值符合源码规格", () => {
    expect(DEFAULT_MU_CONFIG.enabled).toBe(true);
    expect(DEFAULT_MU_CONFIG.neighborhoodSize).toBe(5);
    expect(DEFAULT_MU_CONFIG.minImprovement).toBe(0);
  });

  it("Partial 配置覆盖默认值（learningRate / warmupFeedbacks）", () => {
    const am = new AssociationMatrix(4, { enabled: true, learningRate: 0.05, warmupFeedbacks: 20 });
    // 通过 transform 冷启动边界验证 warmupFeedbacks=20
    const vec = new Float32Array([1, 2, 3, 4]);
    expect(vecEqual(am.transform(vec, 19), vec)).toBe(true); // 冷启动
    // learningRate 无法直接观测，但可确认构造不报错
    expect(am.isEnabled()).toBe(true);
  });
});

// ─── 2. isEnabled ────────────────────────────────────────

describe("isEnabled", () => {
  it("enabled=true 时返回 true", () => {
    const am = new AssociationMatrix(4, { enabled: true });
    expect(am.isEnabled()).toBe(true);
  });

  it("enabled=false 时返回 false", () => {
    const am = new AssociationMatrix(4, { enabled: false });
    expect(am.isEnabled()).toBe(false);
  });

  it("未传 enabled 时默认 false", () => {
    const am = new AssociationMatrix(4);
    expect(am.isEnabled()).toBe(false);
  });
});

// ─── 3. transform 冷启动 ─────────────────────────────────

describe("transform 冷启动", () => {
  it("feedbackCount < warmupFeedbacks 时返回原向量（identity）", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 10 });
    const vec = new Float32Array([1, 2, 3, 4]);
    const out = am.transform(vec, 5); // 5 < 10
    expect(vecEqual(out, vec)).toBe(true);
    // 输出是 Float32Array 拷贝（不是同一引用）
    expect(out).not.toBe(vec);
    expect(out).toBeInstanceOf(Float32Array);
  });

  it("feedbackCount = 0 时（冷启动）返回 identity", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 10 });
    const vec = new Float32Array([0.5, -0.5, 1.5, -1.5]);
    const out = am.transform(vec, 0);
    expect(vecEqual(out, vec)).toBe(true);
  });

  it("feedbackCount 恰好等于 warmupFeedbacks 时进入热启动（不再 identity）", () => {
    // 边界：feedbackCount >= warmupFeedbacks → 热启动
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 10 });
    const vec = new Float32Array([5, 5, 5, 5]);
    // 更新 BatchNorm 统计使运行均值偏离 0 → 热启动输出偏离输入
    am.updateBatchNormStats(vec);
    am.updateBatchNormStats(vec);
    am.updateBatchNormStats(vec);
    const out = am.transform(vec, 10); // 10 >= 10，热启动
    expect(vecEqual(out, vec)).toBe(false);
  });

  it("disabled 时即使 feedbackCount 足够大也返回 identity", () => {
    const am = new AssociationMatrix(4, { enabled: false, warmupFeedbacks: 1 });
    const vec = new Float32Array([1, 2, 3, 4]);
    const out = am.transform(vec, 1000);
    expect(vecEqual(out, vec)).toBe(true);
  });

  it("维度不匹配时回退 identity", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([1, 2, 3]); // 长度 3 ≠ dim 4
    const out = am.transform(vec, 100);
    expect(vecEqual(out, vec)).toBe(true);
  });
});

// ─── 4. transform 热启动 ─────────────────────────────────

describe("transform 热启动", () => {
  it("feedbackCount >= warmupFeedbacks 时应用 M 变换（输出与输入不同）", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 5 });
    const vec = new Float32Array([1, 2, 3, 4]);
    // 更新 BatchNorm 统计使运行均值偏离 0
    for (let k = 0; k < 10; k++) am.updateBatchNormStats(vec);
    const out = am.transform(vec, 100); // 热启动
    expect(vecEqual(out, vec)).toBe(false);
    expect(out).toHaveLength(4);
    expect(out).toBeInstanceOf(Float32Array);
  });

  it("热启动输出维度与输入一致", () => {
    const am = new AssociationMatrix(8, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    am.updateBatchNormStats(vec);
    const out = am.transform(vec, 10);
    expect(out).toHaveLength(8);
    expect(out).toBeInstanceOf(Float32Array);
  });

  it("M=I 且统计为初值时输出≈输入（仅 BatchNorm 1e-8 扰动）", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([1, 2, 3, 4]);
    const out = am.transform(vec, 10);
    // (v - 0)/sqrt(1 + 1e-8) * 1 * 1 ≈ v
    expect(vecMaxAbsDiff(out, vec)).toBeLessThan(1e-5);
  });
});

// ─── 5. updateBatchNormStats ─────────────────────────────

describe("updateBatchNormStats", () => {
  it("单次 EMA 更新符合公式：mean = 0.9*0 + 0.1*x", () => {
    const am = new AssociationMatrix(4, { enabled: true });
    const vec = new Float32Array([10, 10, 10, 10]);
    am.updateBatchNormStats(vec);
    const data = JSON.parse(am.serialize());
    // bnMomentum=0.9, initial mean=0 → 0.9*0 + 0.1*10 = 1
    expect(data.bnRunningMean[0]).toBeCloseTo(1, 6);
  });

  it("多次调用后统计量更新（mean 趋近输入值）", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([5, 5, 5, 5]);
    const data0 = JSON.parse(am.serialize());
    expect(data0.bnRunningMean[0]).toBe(0);
    // 多次调用 EMA → mean 趋近 5
    for (let k = 0; k < 20; k++) am.updateBatchNormStats(vec);
    const data1 = JSON.parse(am.serialize());
    for (let i = 0; i < 4; i++) {
      expect(data1.bnRunningMean[i]).toBeGreaterThan(4);
      expect(data1.bnRunningMean[i]).toBeLessThan(6);
    }
  });

  it("disabled 时不更新统计", () => {
    const am = new AssociationMatrix(4, { enabled: false });
    const vec = new Float32Array([5, 5, 5, 5]);
    am.updateBatchNormStats(vec);
    const data = JSON.parse(am.serialize());
    expect(data.bnRunningMean[0]).toBe(0);
  });

  it("维度不匹配时不更新", () => {
    const am = new AssociationMatrix(4, { enabled: true });
    const vec = new Float32Array([1, 2, 3]); // 长度 ≠ 4
    am.updateBatchNormStats(vec);
    const data = JSON.parse(am.serialize());
    expect(data.bnRunningMean[0]).toBe(0);
  });
});

// ─── 6. updateWithMarginalUtility ────────────────────────

describe("updateWithMarginalUtility", () => {
  it("reward > 0 且邻域提升达标 → applied=true", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([1, 0, 0, 0]);
    // 先记录一个正样本历史（history 空 → 直接应用，并记录样本）
    am.updateWithMarginalUtility(vec, 1.0);
    // 第二次：邻域相似度=1（同向量），reward=1 → neighborhoodGain=1 >= 0 → applied
    const r = am.updateWithMarginalUtility(vec, 1.0);
    expect(r.applied).toBe(true);
    // 应用时返回 neighborhoodGain = reward
    expect(r.neighborhoodGain).toBe(1.0);
  });

  it("reward < 0 且邻域下降 → applied=false（拒绝）", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([1, 0, 0, 0]);
    // 记录正样本历史
    am.updateWithMarginalUtility(vec, 1.0);
    // history 非空，调用 reward=-1
    // neighborhoodGain = avg(reward * similarity) = avg(-1 * 1) = -1 < minImprovement(0) → 拒绝
    const r = am.updateWithMarginalUtility(vec, -1.0);
    expect(r.applied).toBe(false);
    expect(r.neighborhoodGain).toBeLessThan(0);
  });

  it("冷启动期（history 为空）→ 直接应用，applied=true", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const r = am.updateWithMarginalUtility(vec, 0.8);
    expect(r.applied).toBe(true);
    // history 为空时跳过邻域评估，返回 neighborhoodGain = reward
    expect(r.neighborhoodGain).toBe(0.8);
    // 更新计数 +1
    expect(am.getStats().updatesApplied).toBe(1);
    // 历史样本被记录
    expect(am.getStats().historySize).toBe(1);
  });

  it("disabled 时返回 applied=false", () => {
    const am = new AssociationMatrix(4, { enabled: false });
    const vec = new Float32Array([1, 2, 3, 4]);
    const r = am.updateWithMarginalUtility(vec, 1.0);
    expect(r.applied).toBe(false);
    expect(r.neighborhoodGain).toBe(0);
  });

  it("维度不匹配时返回 applied=false", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([1, 2, 3]); // 长度 ≠ 4
    const r = am.updateWithMarginalUtility(vec, 1.0);
    expect(r.applied).toBe(false);
    expect(r.neighborhoodGain).toBe(0);
  });

  it("拒绝更新时 updatesRejected 递增", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([1, 0, 0, 0]);
    am.updateWithMarginalUtility(vec, 1.0); // history 空 → 应用
    const before = am.getStats().updatesRejected;
    am.updateWithMarginalUtility(vec, -1.0); // 被拒绝
    expect(am.getStats().updatesRejected).toBe(before + 1);
  });

  it("minImprovement 提高后，原本通过的更新可能被拒绝", () => {
    const am = new AssociationMatrix(
      4,
      { enabled: true, warmupFeedbacks: 1, learningRate: 0.01 },
      { enabled: true, neighborhoodSize: 5, minImprovement: 0.5 },
    );
    const vec = new Float32Array([1, 0, 0, 0]);
    am.updateWithMarginalUtility(vec, 1.0); // history 空 → 直接应用
    // 第二次：neighborhoodGain = avg(1.0 * 1.0) = 1.0 >= 0.5 → 通过
    const r1 = am.updateWithMarginalUtility(vec, 1.0);
    expect(r1.applied).toBe(true);
    // reward 较小：neighborhoodGain = avg(0.3 * 1.0) = 0.3 < 0.5 → 拒绝
    const r2 = am.updateWithMarginalUtility(vec, 0.3);
    expect(r2.applied).toBe(false);
  });
});

// ─── 7. serialize / deserialize ────────────────────────

describe("serialize / deserialize", () => {
  it("serialize 返回合法 JSON 字符串", () => {
    const am = new AssociationMatrix(4, { enabled: true });
    const json = am.serialize();
    expect(typeof json).toBe("string");
    const data = JSON.parse(json);
    expect(data).toHaveProperty("dim");
    expect(data).toHaveProperty("M");
    expect(data).toHaveProperty("bias");
    expect(data).toHaveProperty("gain");
    expect(data).toHaveProperty("rowScale");
    expect(data).toHaveProperty("mW");
    expect(data).toHaveProperty("vW");
    expect(data).toHaveProperty("mBias");
    expect(data).toHaveProperty("vBias");
    expect(data).toHaveProperty("t");
    expect(data).toHaveProperty("bnRunningMean");
    expect(data).toHaveProperty("bnRunningVar");
    expect(data).toHaveProperty("updateCount");
    expect(data).toHaveProperty("rejectedCount");
  });

  it("往返一致性：deserialize 后 serialize 等于原 serialize", () => {
    const am1 = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([1, 2, 3, 4]);
    // 制造状态变化
    am1.updateBatchNormStats(vec);
    am1.updateBatchNormStats(vec);
    am1.updateWithMarginalUtility(vec, 1.0);
    const json1 = am1.serialize();

    const am2 = new AssociationMatrix(4, { enabled: true });
    am2.deserialize(json1);
    const json2 = am2.serialize();

    expect(json2).toBe(json1);
  });

  it("deserialize 后可观察状态一致（transform 输出 + 持久化统计字段）", () => {
    const am1 = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([1, 2, 3, 4]);
    am1.updateBatchNormStats(vec);
    am1.updateWithMarginalUtility(vec, 0.5);
    const out1 = am1.transform(vec, 100);

    const am2 = new AssociationMatrix(4, { enabled: true });
    am2.deserialize(am1.serialize());
    const out2 = am2.transform(vec, 100);

    expect(vecEqual(out2, out1, 1e-6)).toBe(true);
    // 持久化的统计字段一致（historySize 不被序列化，不比较）
    const s1 = am1.getStats();
    const s2 = am2.getStats();
    expect(s2.t).toBe(s1.t);
    expect(s2.updatesApplied).toBe(s1.updatesApplied);
    expect(s2.updatesRejected).toBe(s1.updatesRejected);
    expect(s2.dim).toBe(s1.dim);
  });

  it("dim 不匹配时 deserialize 抛错", () => {
    const am1 = new AssociationMatrix(4, { enabled: true });
    const am2 = new AssociationMatrix(8, { enabled: true });
    expect(() => am2.deserialize(am1.serialize())).toThrow(/dim mismatch/);
  });

  it("deserialize 容错缺失 bnRunningMean/bnRunningVar（走 fallback）", () => {
    const am = new AssociationMatrix(4, { enabled: true });
    const minimal = JSON.stringify({
      dim: 4,
      M: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      bias: [0, 0, 0, 0],
      gain: [1, 1, 1, 1],
      rowScale: [1, 1, 1, 1],
      mW: new Array(16).fill(0),
      vW: new Array(16).fill(0),
      mBias: [0, 0, 0, 0],
      vBias: [0, 0, 0, 0],
      t: 0,
    });
    am.deserialize(minimal);
    // bnRunningMean/bnRunningVar 走 fallback：mean=0, var=1
    const data = JSON.parse(am.serialize());
    expect(data.bnRunningMean[0]).toBe(0);
    expect(data.bnRunningVar[0]).toBe(1);
    // updateCount/rejectedCount 缺失时 fallback 0
    expect(data.updateCount).toBe(0);
    expect(data.rejectedCount).toBe(0);
  });

  it("两次 deserialize 互不影响（第二次覆盖第一次）", () => {
    const am = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec = new Float32Array([1, 2, 3, 4]);
    am.updateBatchNormStats(vec);
    am.updateWithMarginalUtility(vec, 1.0);
    const json1 = am.serialize();

    // 第二个矩阵制造不同状态
    const amOther = new AssociationMatrix(4, { enabled: true, warmupFeedbacks: 1 });
    const vec2 = new Float32Array([4, 3, 2, 1]);
    for (let k = 0; k < 5; k++) amOther.updateBatchNormStats(vec2);
    amOther.updateWithMarginalUtility(vec2, 0.9);
    amOther.updateWithMarginalUtility(vec2, 0.9);
    const json2 = amOther.serialize();

    expect(json1).not.toBe(json2);

    const target = new AssociationMatrix(4, { enabled: true });
    target.deserialize(json1);
    expect(target.serialize()).toBe(json1);
    target.deserialize(json2);
    expect(target.serialize()).toBe(json2);
  });
});

// ─── 8. createAssociationMatrix 工厂 ────────────────────

describe("createAssociationMatrix 工厂", () => {
  function makeCfg(over: Partial<GmConfig> = {}): GmConfig {
    return {
      neo4j: { uri: "bolt://localhost", user: "neo4j", password: "x" },
      ...over,
    } as GmConfig;
  }

  it("从 cfg.associationMatrix.enabled 提取 enabled", () => {
    const cfg = makeCfg({ associationMatrix: { enabled: true } });
    const am = createAssociationMatrix(4, cfg);
    expect(am.isEnabled()).toBe(true);
  });

  it("未配置 associationMatrix 时 enabled 默认 false", () => {
    const am = createAssociationMatrix(4, makeCfg());
    expect(am.isEnabled()).toBe(false);
  });

  it("未提供 cfg 时返回默认（enabled=false）", () => {
    const am = createAssociationMatrix(4);
    expect(am.isEnabled()).toBe(false);
    expect(am.getStats().dim).toBe(4);
  });

  it("warmupFeedbacks 优先取 associationMatrix.warmupFeedbacks", () => {
    const cfg = makeCfg({
      associationMatrix: { enabled: true, warmupFeedbacks: 30 },
      warmup: { warmupFeedbacks: 50 },
    });
    const am = createAssociationMatrix(4, cfg);
    const vec = new Float32Array([1, 2, 3, 4]);
    // 更新 BatchNorm 使热启动输出偏离输入
    am.updateBatchNormStats(vec);
    am.updateBatchNormStats(vec);
    // feedbackCount=29 < 30 → 冷启动 → identity
    expect(vecEqual(am.transform(vec, 29), vec)).toBe(true);
    // feedbackCount=30 >= 30 → 热启动（输出偏离）；若 fallback 到 50 则 30<50 应为 identity
    expect(vecEqual(am.transform(vec, 30), vec)).toBe(false);
    // feedbackCount=49 仍 >= 30 → 热启动
    expect(vecEqual(am.transform(vec, 49), vec)).toBe(false);
  });

  it("associationMatrix.warmupFeedbacks 缺失时 fallback 到 warmup.warmupFeedbacks", () => {
    const cfg = makeCfg({
      associationMatrix: { enabled: true },
      warmup: { warmupFeedbacks: 50 },
    });
    const am = createAssociationMatrix(4, cfg);
    const vec = new Float32Array([1, 2, 3, 4]);
    am.updateBatchNormStats(vec);
    // feedbackCount=49 < 50 → 冷启动 → identity
    expect(vecEqual(am.transform(vec, 49), vec)).toBe(true);
    // feedbackCount=50 >= 50 → 热启动
    expect(vecEqual(am.transform(vec, 50), vec)).toBe(false);
  });

  it("两者都缺失时 warmupFeedbacks 默认 100", () => {
    const cfg = makeCfg({ associationMatrix: { enabled: true } });
    const am = createAssociationMatrix(4, cfg);
    const vec = new Float32Array([1, 2, 3, 4]);
    am.updateBatchNormStats(vec);
    // feedbackCount=99 < 100 → 冷启动
    expect(vecEqual(am.transform(vec, 99), vec)).toBe(true);
    // feedbackCount=100 >= 100 → 热启动
    expect(vecEqual(am.transform(vec, 100), vec)).toBe(false);
  });

  it("marginalUtility 配置被提取（neighborhoodSize / minImprovement 生效）", () => {
    const cfg = makeCfg({
      associationMatrix: { enabled: true },
      marginalUtility: { enabled: true, neighborhoodSize: 3, minImprovement: 0.2 },
    });
    const am = createAssociationMatrix(4, cfg);
    const vec = new Float32Array([1, 0, 0, 0]);
    am.updateWithMarginalUtility(vec, 1.0); // history 空 → 直接应用
    // 第二次：neighborhoodGain = avg(1.0 * 1.0) = 1.0 >= 0.2 → 通过
    expect(am.updateWithMarginalUtility(vec, 1.0).applied).toBe(true);
    // reward=0.1 → neighborhoodGain = 0.1 < 0.2 → 拒绝
    expect(am.updateWithMarginalUtility(vec, 0.1).applied).toBe(false);
  });

  it("marginalUtility.enabled 默认 true（未配置时 recordHistorySample 生效）", () => {
    const cfg = makeCfg({ associationMatrix: { enabled: true } });
    const am = createAssociationMatrix(4, cfg);
    const vec = new Float32Array([1, 0, 0, 0]);
    am.updateWithMarginalUtility(vec, 1.0); // 直接应用
    // muCfg.enabled 默认 true → recordHistorySample 记录样本 → historySize=1
    // （若 muCfg.enabled=false 则 recordHistorySample 提前返回，historySize=0）
    expect(am.getStats().historySize).toBe(1);
  });

  it("marginalUtility.enabled=false 时跳过邻域评估且不记录历史样本", () => {
    const cfg = makeCfg({
      associationMatrix: { enabled: true },
      marginalUtility: { enabled: false },
    });
    const am = createAssociationMatrix(4, cfg);
    const vec = new Float32Array([1, 0, 0, 0]);
    am.updateWithMarginalUtility(vec, 1.0);
    // muCfg.enabled=false → recordHistorySample 提前返回 → historySize=0
    expect(am.getStats().historySize).toBe(0);
    // 邻域评估被跳过 → 即使 reward<0 也直接应用
    const r = am.updateWithMarginalUtility(vec, -1.0);
    expect(r.applied).toBe(true);
    expect(r.neighborhoodGain).toBe(-1.0);
    expect(am.getStats().historySize).toBe(0);
  });
});
