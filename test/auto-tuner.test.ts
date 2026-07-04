/**
 * R-1 自主调优（EvolveMem）单元测试（graph-memory-pro v2.1.2 第五批）
 *
 * 测试 /workspace/src/evolution/auto-tuner.ts 导出的：
 *   - extractActionSpace / applyActionSpace / clampAction / ACTION_BOUNDS
 *   - AutoTuner 类（构造、setInitialAction、getCurrentAction、getTuneRound、
 *     getSnapshots、isEnabled、serialize/deserialize、runTuneCycle）
 *
 * runTuneCycle 测试通过 vi.mock 替换 auto-tuner 内部 import 的 runBenchmark，
 * 并 mock Recaller（getJudgeManager 返回 { getFeedbackCount: () => N }）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GmConfig } from "../src/types.ts";
import type { Recaller } from "../src/recaller/recall.ts";

// ── vi.mock 必须在 import 被测模块之前 ────────────────────────────
// auto-tuner.ts 内部 `import { runBenchmark, formatAggregateReport } from "../benchmark/runner.ts"`
// 这里把整个 runner 模块替换为 mock，确保测试不触发真实 benchmark 流程。
vi.mock("../src/benchmark/runner.ts", () => ({
  runBenchmark: vi.fn(),
  formatAggregateReport: vi.fn(() => "mock-summary"),
}));

import {
  extractActionSpace,
  applyActionSpace,
  clampAction,
  ACTION_BOUNDS,
  AutoTuner,
  type EvolveActionSpace,
} from "../src/evolution/auto-tuner.ts";
import { runBenchmark } from "../src/benchmark/runner.ts";

// 在 vi.mock 工厂外部拿到的 runBenchmark 即 mock 实例（同一模块实例）
const mockedRunBenchmark = vi.mocked(runBenchmark);

// ─── 工厂：构造最小可用样本 ─────────────────────────────────

function makeCfg(over: Partial<GmConfig> = {}): GmConfig {
  return {
    neo4j: { uri: "bolt://localhost", user: "neo4j", password: "x" },
    compactTurnCount: 6,
    recallMaxNodes: 6,
    recallMaxDepth: 2,
    freshTailCount: 10,
    dedupThreshold: 0.9,
    pagerankDamping: 0.85,
    pagerankIterations: 20,
    ...over,
  } as GmConfig;
}

/** mock Recaller：仅暴露 getJudgeManager().getFeedbackCount() */
function makeRecaller(feedbackCount: number): Recaller {
  return {
    getJudgeManager: () => ({ getFeedbackCount: () => feedbackCount }),
  } as unknown as Recaller;
}

beforeEach(() => {
  mockedRunBenchmark.mockReset();
});

// ─── 1. extractActionSpace ─────────────────────────────────

describe("extractActionSpace", () => {
  it("从 GmConfig 提取动作空间，字段映射正确", () => {
    const cfg = makeCfg({
      recallMaxNodes: 10,
      recallMaxDepth: 3,
      pagerankDamping: 0.9,
      pagerankIterations: 30,
      dedupThreshold: 0.95,
      freshTailCount: 15,
      compactTurnCount: 8,
    });
    const action = extractActionSpace(cfg);
    expect(action.recallMaxNodes).toBe(10);
    expect(action.recallMaxDepth).toBe(3);
    expect(action.pagerankDamping).toBe(0.9);
    expect(action.pagerankIterations).toBe(30);
    expect(action.dedupThreshold).toBe(0.95);
    expect(action.freshTailCount).toBe(15);
    expect(action.compactTurnCount).toBe(8);
    // vectorSearchTopK = recallMaxNodes * 2 = 20
    expect(action.vectorSearchTopK).toBe(20);
  });

  it("字段缺失时使用默认 fallback 值，且 vectorSearchTopK 默认 12", () => {
    // 全空对象（cast 绕过类型检查，模拟缺失字段场景）
    const cfg = {} as GmConfig;
    const action = extractActionSpace(cfg);
    expect(action.recallMaxNodes).toBe(6);
    expect(action.recallMaxDepth).toBe(2);
    expect(action.pagerankDamping).toBe(0.85);
    expect(action.pagerankIterations).toBe(20);
    expect(action.dedupThreshold).toBe(0.9);
    expect(action.freshTailCount).toBe(10);
    expect(action.compactTurnCount).toBe(6);
    // recallMaxNodes 为 undefined → vectorSearchTopK fallback 为 12
    expect(action.vectorSearchTopK).toBe(12);
  });

  it("recallMaxNodes 为 0 时（falsy）vectorSearchTopK 走 fallback 12", () => {
    const cfg = makeCfg({ recallMaxNodes: 0 });
    const action = extractActionSpace(cfg);
    // recallMaxNodes ?? 6 → 0（?? 只挡 null/undefined）
    expect(action.recallMaxNodes).toBe(0);
    // recallMaxNodes 为 0（falsy）→ vectorSearchTopK 走 else 分支 = 12
    expect(action.vectorSearchTopK).toBe(12);
  });
});

// ─── 2. applyActionSpace ───────────────────────────────────

describe("applyActionSpace", () => {
  it("应用动作回 GmConfig，参数被覆盖为动作值", () => {
    const cfg = makeCfg();
    const action: EvolveActionSpace = {
      recallMaxNodes: 12,
      recallMaxDepth: 4,
      pagerankDamping: 0.95,
      pagerankIterations: 50,
      dedupThreshold: 0.98,
      freshTailCount: 20,
      vectorSearchTopK: 30,
      compactTurnCount: 10,
    };
    const newCfg = applyActionSpace(cfg, action);
    expect(newCfg.recallMaxNodes).toBe(12);
    expect(newCfg.recallMaxDepth).toBe(4);
    expect(newCfg.pagerankDamping).toBe(0.95);
    expect(newCfg.pagerankIterations).toBe(50);
    expect(newCfg.dedupThreshold).toBe(0.98);
    expect(newCfg.freshTailCount).toBe(20);
    expect(newCfg.compactTurnCount).toBe(10);
  });

  it("其他配置字段（neo4j 等）被保留", () => {
    const cfg = makeCfg({ recallMaxNodes: 8 });
    const action = extractActionSpace(cfg);
    const newCfg = applyActionSpace(cfg, action);
    expect(newCfg.neo4j).toEqual(cfg.neo4j);
    // neo4j 字段引用应一致（浅拷贝）
    expect(newCfg.neo4j).toBe(cfg.neo4j);
  });

  it("返回新对象，修改新 cfg 不影响原 cfg", () => {
    const cfg = makeCfg();
    const action = extractActionSpace(cfg);
    const newCfg = applyActionSpace(cfg, action);
    newCfg.recallMaxNodes = 999;
    expect(cfg.recallMaxNodes).not.toBe(999);
  });
});

// ─── 3. clampAction ────────────────────────────────────────

describe("clampAction", () => {
  it("超出上限的值被裁剪到 max", () => {
    const clamped = clampAction({
      recallMaxNodes: 100,      // max 15
      recallMaxDepth: 10,      // max 4
      pagerankDamping: 1.5,     // max 0.95
      pagerankIterations: 999, // max 50
      dedupThreshold: 1.5,     // max 0.98
      freshTailCount: 100,     // max 20
      vectorSearchTopK: 100,   // max 30
      compactTurnCount: 50,   // max 12
    });
    expect(clamped.recallMaxNodes).toBe(15);
    expect(clamped.recallMaxDepth).toBe(4);
    expect(clamped.pagerankDamping).toBe(0.95);
    expect(clamped.pagerankIterations).toBe(50);
    expect(clamped.dedupThreshold).toBe(0.98);
    expect(clamped.freshTailCount).toBe(20);
    expect(clamped.vectorSearchTopK).toBe(30);
    expect(clamped.compactTurnCount).toBe(12);
  });

  it("低于下限的值被裁剪到 min", () => {
    const clamped = clampAction({
      recallMaxNodes: 0,      // min 3
      recallMaxDepth: 0,      // min 1
      pagerankDamping: 0.5,   // min 0.7
      pagerankIterations: 1, // min 10
      dedupThreshold: 0.5,   // min 0.8
      freshTailCount: 1,     // min 5
      vectorSearchTopK: 1,   // min 5
      compactTurnCount: 0,   // min 3
    });
    expect(clamped.recallMaxNodes).toBe(3);
    expect(clamped.recallMaxDepth).toBe(1);
    expect(clamped.pagerankDamping).toBe(0.7);
    expect(clamped.pagerankIterations).toBe(10);
    expect(clamped.dedupThreshold).toBe(0.8);
    expect(clamped.freshTailCount).toBe(5);
    expect(clamped.vectorSearchTopK).toBe(5);
    expect(clamped.compactTurnCount).toBe(3);
  });

  it("范围内的值不变", () => {
    const input = {
      recallMaxNodes: 8,        // 3-15
      pagerankDamping: 0.85,    // 0.7-0.95
      compactTurnCount: 6,     // 3-12
    };
    const clamped = clampAction(input);
    expect(clamped.recallMaxNodes).toBe(8);
    expect(clamped.pagerankDamping).toBe(0.85);
    expect(clamped.compactTurnCount).toBe(6);
  });

  it("边界值（恰好等于 min 或 max）不变", () => {
    const clamped = clampAction({
      recallMaxNodes: 3,        // = min
      recallMaxDepth: 4,        // = max
      pagerankDamping: 0.7,     // = min
      pagerankIterations: 50,  // = max
    });
    expect(clamped.recallMaxNodes).toBe(3);
    expect(clamped.recallMaxDepth).toBe(4);
    expect(clamped.pagerankDamping).toBe(0.7);
    expect(clamped.pagerankIterations).toBe(50);
  });

  it("Partial 输入：只裁剪提供的字段，未提供字段不出现在结果中", () => {
    const clamped = clampAction({ recallMaxNodes: 999 });
    expect(clamped.recallMaxNodes).toBe(15);
    expect(clamped).not.toHaveProperty("recallMaxDepth");
    expect(clamped).not.toHaveProperty("compactTurnCount");
  });
});

// ─── 4. ACTION_BOUNDS ──────────────────────────────────────

describe("ACTION_BOUNDS", () => {
  it("包含全部 8 个参数的 bounds", () => {
    const keys = Object.keys(ACTION_BOUNDS);
    expect(keys).toHaveLength(8);
    expect(keys).toEqual(
      expect.arrayContaining([
        "recallMaxNodes",
        "recallMaxDepth",
        "pagerankDamping",
        "pagerankIterations",
        "dedupThreshold",
        "freshTailCount",
        "vectorSearchTopK",
        "compactTurnCount",
      ]),
    );
  });

  it("每个参数都有 min 和 max 数值且 min <= max", () => {
    for (const [key, bounds] of Object.entries(ACTION_BOUNDS)) {
      expect(typeof bounds.min).toBe("number");
      expect(typeof bounds.max).toBe("number");
      expect(bounds.min).toBeLessThanOrEqual(bounds.max);
      // 确保 key 是 EvolveActionSpace 的合法字段
      expect([
        "recallMaxNodes", "recallMaxDepth", "pagerankDamping", "pagerankIterations",
        "dedupThreshold", "freshTailCount", "vectorSearchTopK", "compactTurnCount",
      ]).toContain(key);
    }
  });

  it("具体边界值与规格完全一致", () => {
    expect(ACTION_BOUNDS.recallMaxNodes).toEqual({ min: 3, max: 15 });
    expect(ACTION_BOUNDS.recallMaxDepth).toEqual({ min: 1, max: 4 });
    expect(ACTION_BOUNDS.pagerankDamping).toEqual({ min: 0.7, max: 0.95 });
    expect(ACTION_BOUNDS.pagerankIterations).toEqual({ min: 10, max: 50 });
    expect(ACTION_BOUNDS.dedupThreshold).toEqual({ min: 0.8, max: 0.98 });
    expect(ACTION_BOUNDS.freshTailCount).toEqual({ min: 5, max: 20 });
    expect(ACTION_BOUNDS.vectorSearchTopK).toEqual({ min: 5, max: 30 });
    expect(ACTION_BOUNDS.compactTurnCount).toEqual({ min: 3, max: 12 });
  });
});

// ─── 5. AutoTuner 构造与默认值 ─────────────────────────────

describe("AutoTuner 构造与默认值", () => {
  it("默认构造 disabled，isEnabled()=false", () => {
    const t = new AutoTuner();
    expect(t.isEnabled()).toBe(false);
  });

  it("显式 enabled:true 时 isEnabled()=true", () => {
    const t = new AutoTuner({ enabled: true });
    expect(t.isEnabled()).toBe(true);
  });

  it("默认 currentAction 是初始动作空间（与 extractActionSpace 默认值一致）", () => {
    const t = new AutoTuner();
    expect(t.getCurrentAction()).toEqual({
      recallMaxNodes: 6,
      recallMaxDepth: 2,
      pagerankDamping: 0.85,
      pagerankIterations: 20,
      dedupThreshold: 0.9,
      freshTailCount: 10,
      vectorSearchTopK: 12,
      compactTurnCount: 6,
    });
  });

  it("getTuneRound() 初始为 0，getSnapshots() 初始为空数组", () => {
    const t = new AutoTuner();
    expect(t.getTuneRound()).toBe(0);
    expect(t.getSnapshots()).toEqual([]);
  });

  it("setInitialAction 后 getCurrentAction 返回从 cfg 提取的值", () => {
    const t = new AutoTuner();
    const cfg = makeCfg({
      recallMaxNodes: 9,
      recallMaxDepth: 3,
      pagerankDamping: 0.92,
      pagerankIterations: 25,
      dedupThreshold: 0.88,
      freshTailCount: 12,
      compactTurnCount: 7,
    });
    t.setInitialAction(cfg);
    const action = t.getCurrentAction();
    expect(action.recallMaxNodes).toBe(9);
    expect(action.recallMaxDepth).toBe(3);
    expect(action.pagerankDamping).toBe(0.92);
    expect(action.pagerankIterations).toBe(25);
    expect(action.dedupThreshold).toBe(0.88);
    expect(action.freshTailCount).toBe(12);
    expect(action.compactTurnCount).toBe(7);
    // vectorSearchTopK = 9 * 2 = 18
    expect(action.vectorSearchTopK).toBe(18);
  });

  it("getCurrentAction 返回拷贝，修改不影响内部状态", () => {
    const t = new AutoTuner();
    const action = t.getCurrentAction();
    action.recallMaxNodes = 999;
    expect(t.getCurrentAction().recallMaxNodes).toBe(6);
  });

  it("getSnapshots 返回拷贝，外部 push 不影响内部状态", () => {
    const t = new AutoTuner();
    const snaps = t.getSnapshots();
    snaps.push({
      version: 1,
      timestamp: 0,
      action: t.getCurrentAction(),
      metrics: { p1: 0, p3: 0, mrr: 0, f1: 0, p99: 0 },
      stable: true,
      tuneRound: 1,
    });
    expect(t.getSnapshots()).toEqual([]);
  });
});

// ─── 6. serialize / deserialize 往返一致性 ─────────────────

describe("serialize/deserialize", () => {
  it("serialize 返回合法 JSON 字符串", () => {
    const t = new AutoTuner();
    const json = t.serialize();
    expect(typeof json).toBe("string");
    // 能被 JSON.parse 解析
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty("currentAction");
    expect(parsed).toHaveProperty("snapshots");
    expect(parsed).toHaveProperty("tuneRound");
    expect(parsed).toHaveProperty("stagnationCount");
    expect(parsed).toHaveProperty("bestMetrics");
  });

  it("默认状态 round-trip：deserialize 后状态与原 tuner 一致", () => {
    const t = new AutoTuner();
    const json = t.serialize();

    const t2 = new AutoTuner({ enabled: true });
    t2.deserialize(json);
    expect(t2.getCurrentAction()).toEqual(t.getCurrentAction());
    expect(t2.getTuneRound()).toBe(t.getTuneRound());
    expect(t2.getSnapshots()).toEqual(t.getSnapshots());
  });

  it("修改状态后 serialize/deserialize 保持新状态", () => {
    const t = new AutoTuner({ enabled: true });
    t.setInitialAction(makeCfg({
      recallMaxNodes: 11,
      recallMaxDepth: 4,
      compactTurnCount: 9,
    }));
    const json = t.serialize();

    const t2 = new AutoTuner();
    t2.deserialize(json);
    expect(t2.getCurrentAction().recallMaxNodes).toBe(11);
    expect(t2.getCurrentAction().recallMaxDepth).toBe(4);
    expect(t2.getCurrentAction().compactTurnCount).toBe(9);
    // vectorSearchTopK = 11 * 2 = 22
    expect(t2.getCurrentAction().vectorSearchTopK).toBe(22);
  });

  it("deserialize 容错缺失字段（snapshots/tuneRound/stagnationCount/bestMetrics）", () => {
    const t = new AutoTuner({ enabled: true });
    // 仅含 currentAction 的最小 JSON
    t.deserialize(JSON.stringify({
      currentAction: {
        recallMaxNodes: 7,
        recallMaxDepth: 2,
        pagerankDamping: 0.85,
        pagerankIterations: 20,
        dedupThreshold: 0.9,
        freshTailCount: 10,
        vectorSearchTopK: 14,
        compactTurnCount: 6,
      },
    }));
    expect(t.getCurrentAction().recallMaxNodes).toBe(7);
    expect(t.getCurrentAction().vectorSearchTopK).toBe(14);
    expect(t.getSnapshots()).toEqual([]);
    expect(t.getTuneRound()).toBe(0);
  });

  it("两次 deserialize 互不影响（第二次覆盖第一次）", () => {
    const t = new AutoTuner();
    t.deserialize(JSON.stringify({
      currentAction: { ...t.getCurrentAction(), recallMaxNodes: 5 },
    }));
    expect(t.getCurrentAction().recallMaxNodes).toBe(5);
    t.deserialize(JSON.stringify({
      currentAction: { ...t.getCurrentAction(), recallMaxNodes: 13 },
    }));
    expect(t.getCurrentAction().recallMaxNodes).toBe(13);
  });
});

// ─── 7. runTuneCycle 冷启动拒绝 ────────────────────────────

describe("runTuneCycle 冷启动拒绝", () => {
  it("feedbackCount < warmupFeedbacks 时返回 applied:false 且 reason 含 'cold start'", async () => {
    const t = new AutoTuner({ enabled: true, warmupFeedbacks: 100 });
    const recaller = makeRecaller(50); // 50 < 100

    const result = await t.runTuneCycle(recaller, null, makeCfg());

    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/cold start/);
    // tuneRound 不应递增（冷启动在递增之前 return）
    expect(result.tuneRound).toBe(0);
    expect(t.getTuneRound()).toBe(0);
    // benchmark 不应被调用
    expect(mockedRunBenchmark).not.toHaveBeenCalled();
  });

  it("feedbackCount 为 0 时（getJudgeManager 返回 count=0）也被冷启动拦截", async () => {
    const t = new AutoTuner({ enabled: true, warmupFeedbacks: 100 });
    const recaller = makeRecaller(0);

    const result = await t.runTuneCycle(recaller, null, makeCfg());

    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/cold start/);
    expect(mockedRunBenchmark).not.toHaveBeenCalled();
  });

  it("getJudgeManager 返回 null 时（feedbackCount 视为 0）被冷启动拦截", async () => {
    const t = new AutoTuner({ enabled: true, warmupFeedbacks: 100 });
    const recaller = { getJudgeManager: () => null } as unknown as Recaller;

    const result = await t.runTuneCycle(recaller, null, makeCfg());

    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/cold start/);
  });

  it("冷启动 reason 中包含具体 feedback 数值与阈值", async () => {
    const t = new AutoTuner({ enabled: true, warmupFeedbacks: 100 });
    const recaller = makeRecaller(30);

    const result = await t.runTuneCycle(recaller, null, makeCfg());

    expect(result.reason).toContain("30");
    expect(result.reason).toContain("100");
  });
});

// ─── 8. runTuneCycle disabled ──────────────────────────────

describe("runTuneCycle disabled", () => {
  it("disabled 时返回 applied:false 且 reason='auto-tuner disabled'", async () => {
    const t = new AutoTuner(); // enabled 默认 false
    const recaller = makeRecaller(9999);

    const result = await t.runTuneCycle(recaller, null, makeCfg());

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("auto-tuner disabled");
    expect(result.tuneRound).toBe(0);
    // benchmark 不应被调用
    expect(mockedRunBenchmark).not.toHaveBeenCalled();
  });

  it("disabled 检查优先于冷启动（即使 feedback 不足也不走 cold start）", async () => {
    // enabled=false 但 feedbackCount 远低于 warmupFeedbacks
    const t = new AutoTuner({ enabled: false, warmupFeedbacks: 100 });
    const recaller = makeRecaller(1);

    const result = await t.runTuneCycle(recaller, null, makeCfg());

    // 应返回 disabled，而非 cold start
    expect(result.reason).toBe("auto-tuner disabled");
    expect(result.reason).not.toMatch(/cold start/);
  });

  it("显式 enabled:false 时同样被拦截", async () => {
    const t = new AutoTuner({ enabled: false });
    const recaller = makeRecaller(9999);

    const result = await t.runTuneCycle(recaller, null, makeCfg());

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("auto-tuner disabled");
  });
});
