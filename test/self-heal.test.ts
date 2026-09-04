import { describe, it, expect } from "vitest";
import { cjkBigramSim, runSelfHeal, revertSelfHeal } from "../src/graph/maintenance/self-heal.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";

describe("cjkBigramSim (v2.6.0)", () => {
  it("完全相同 → 1，完全无关 → 0，部分重叠合理", () => {
    expect(cjkBigramSim("Redis缓存优化", "Redis缓存优化")).toBe(1);
    expect(cjkBigramSim("分布式系统", "数据库索引")).toBe(0);
    const half = cjkBigramSim("缓存优化方案", "缓存优化实践"); // 共享 bigram 应 >0
    expect(half).toBeGreaterThan(0);
  });
  it("空串/英文回落为 0 或退化安全", () => {
    expect(cjkBigramSim("", "abc")).toBe(0);
    expect(Number.isNaN(cjkBigramSim("ab", "ab"))).toBe(false);
  });
});

describe("runSelfHeal (v2.6.0)", () => {
  it("非稀疏图谱 → 不写任何边，edgesAdded=0", async () => {
    const driver = mockDriver() as any;
    // runSelfHeal 内部第 1 条查询是健康评分统计
    driver.queueResult([{ activeNodes: 100, inDegreeSum: 800, connectedNodes: 98, avgPageRank: 0.1, transitionalNodes: 0 }]);
    driver.queueResult([{ cnt: 2 }]);        // 孤立
    driver.queueResult([{ cnt: 3 }]);        // 高过时
    // 评分 > 阈值 → 无需再跑补边候选查询

    const result = await runSelfHeal(driver, { scoreThreshold: 60 });

    expect(result.sparse).toBe(false);
    expect(result.edgesAdded).toBe(0);
    expect(result.mergesApplied).toBe(0);
  });

  it("稀疏图 → 触发候选查询并补边，inferred 标记写入", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ activeNodes: 50, inDegreeSum: 10, connectedNodes: 5, avgPageRank: 0.002, transitionalNodes: 0 }]);
    driver.queueResult([{ cnt: 40 }]);       // 孤立 40/50
    driver.queueResult([{ cnt: 0 }]);
    // 补边候选（无既有边的相似节点对；nameB 与 nameA 共享中文 bigram，
    // 保证 cjk 融合后 fusedSim = 0.7*0.8 + 0.3*0.75 = 0.785 ≥ inferSimMin）
    driver.queueResult([{ idA: "n1", nameA: "缓存优化", typeA: "SKILL", idB: "n2", nameB: "缓存优化实践", typeB: "SKILL", sim: 0.8 }]);
    // 补边写入（MERGE）
    // 补边后候选查询会再跑一次（限制每节点上限），返回空
    driver.queueResult([]);
    // 孤立节点（含社区重连候选 / 合并候选）查询返回空
    driver.queueResult([]);
    driver.queueResult([]);

    const result = await runSelfHeal(driver, {
      scoreThreshold: 60, inferSimMin: 0.7, inferSimMax: 0.9,
      maxEdgesPerNode: 5, maxEdgesPerCycle: 50,
    });

    const calls = driver.getAllRunCalls();
    expect(result.sparse).toBe(true);
    expect(result.edgesAdded).toBeGreaterThan(0);
    // 至少一条 MERGE 建边且 SET inferred/source
    const mergeCall = calls.find(c => c.query.includes("MERGE") && c.query.includes("RELATES_TO"));
    expect(mergeCall).toBeTruthy();
    expect(mergeCall!.query).toContain("inferred");
    expect(mergeCall!.query).toContain("source");
  });

  it("revertSelfHeal 删除全部 self-heal 边并返回数量", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ removed: 7 }]);
    const res = await revertSelfHeal(driver);
    expect(res.removed).toBe(7);
    const calls = driver.getAllRunCalls();
    expect(calls[0].query).toContain("source: 'self-heal'");
    expect(calls[0].query).toContain("DELETE r");
  });
});
