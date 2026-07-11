/**
 * 测试 src/timing.ts — 延迟分布统计
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LatencyDistribution,
  recordPhaseTiming,
  printPhaseDistribution,
  printAllDistributions,
  resetAllDistributions,
  setTimingEnabled,
  isTimingEnabled,
  logPhase,
} from "../src/timing.ts";

describe("LatencyDistribution", () => {
  it("初始 count 为 0", () => {
    const ld = new LatencyDistribution();
    expect(ld.count).toBe(0);
  });

  it("record 增加样本", () => {
    const ld = new LatencyDistribution();
    ld.record(10);
    ld.record(20);
    expect(ld.count).toBe(2);
  });

  it("超过 maxSamples 时移除最旧样本", () => {
    const ld = new LatencyDistribution([10, 50], 3);
    ld.record(5);
    ld.record(15);
    ld.record(25);
    ld.record(35); // 应移除 5
    expect(ld.count).toBe(3);
  });

  it("reset 清空样本", () => {
    const ld = new LatencyDistribution();
    ld.record(10);
    ld.reset();
    expect(ld.count).toBe(0);
  });

  it("histogram 正确分桶", () => {
    const ld = new LatencyDistribution([5, 10, 20]);
    ld.record(3);
    ld.record(8);
    ld.record(25);
    const hist = ld.histogram();
    expect(hist["<=5ms"]).toBe(1);
    expect(hist["<=10ms"]).toBe(1);
    expect(hist["<=20ms"]).toBe(0);
    expect(hist[">last"]).toBe(1);
  });

  it("percentile 空样本返回 null", () => {
    const ld = new LatencyDistribution();
    expect(ld.percentile(50)).toBeNull();
  });

  it("percentile 计算正确（P50/P90/P99）", () => {
    const ld = new LatencyDistribution();
    // 10 samples: 1..10
    for (let i = 1; i <= 10; i++) ld.record(i);
    expect(ld.percentile(50)).toBe(5);   // ceil(10*0.5)-1 = 4, sorted[4]=5
    expect(ld.percentile(90)).toBe(9);   // ceil(10*0.9)-1 = 8, sorted[8]=9
    expect(ld.percentile(99)).toBe(10);  // ceil(10*0.99)-1 = 9, sorted[9]=10
  });

  it("percentileSummary 返回格式化字符串", () => {
    const ld = new LatencyDistribution();
    for (let i = 1; i <= 10; i++) ld.record(i);
    const summary = ld.percentileSummary();
    expect(summary).toContain("P50=");
    expect(summary).toContain("P90=");
    expect(summary).toContain("P95=");
    expect(summary).toContain("P99=");
    expect(summary).toContain("n=10");
  });
});

describe("recordPhaseTiming / printPhaseDistribution", () => {
  beforeEach(() => {
    resetAllDistributions();
  });

  afterEach(() => {
    resetAllDistributions();
  });

  it("recordPhaseTiming 记录到对应 phase", () => {
    recordPhaseTiming("recall_total", 100);
    const report = printPhaseDistribution("recall_total");
    expect(report).toContain("recall_total");
    expect(report).toContain("n=1");
  });

  it("printPhaseDistribution 空 phase 返回 'no samples'", () => {
    const report = printPhaseDistribution("vec_embed");
    expect(report).toContain("no samples");
  });

  it("resetAllDistributions 清空所有采集器", () => {
    recordPhaseTiming("recall_total", 100);
    resetAllDistributions();
    const report = printPhaseDistribution("recall_total");
    expect(report).toContain("no samples");
  });
});

describe("isTimingEnabled / setTimingEnabled", () => {
  afterEach(() => {
    setTimingEnabled(false);
  });

  it("默认关闭", () => {
    setTimingEnabled(false);
    expect(isTimingEnabled()).toBe(false);
  });

  it("setTimingEnabled(true) 开启", () => {
    setTimingEnabled(true);
    expect(isTimingEnabled()).toBe(true);
  });

  it("GM_DEBUG 环境变量时也开启", () => {
    setTimingEnabled(false);
    const oldDebug = process.env.GM_DEBUG;
    process.env.GM_DEBUG = "1";
    expect(isTimingEnabled()).toBe(true);
    if (oldDebug === undefined) delete process.env.GM_DEBUG;
    else process.env.GM_DEBUG = oldDebug;
  });
});

describe("logPhase", () => {
  afterEach(() => {
    setTimingEnabled(false);
    resetAllDistributions();
  });

  it("timing 关闭时不记录", () => {
    setTimingEnabled(false);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logPhase("recall_total", 50);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("timing 开启时记录并输出", () => {
    setTimingEnabled(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logPhase("recall_total", 50);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("recall_total"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("50.0ms"));
    spy.mockRestore();
  });

  it("带 ctx 时记录额外字段", () => {
    setTimingEnabled(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logPhase("recall_precise", 30, { nodes: 5 });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("nodes=5"));
    spy.mockRestore();
  });
});