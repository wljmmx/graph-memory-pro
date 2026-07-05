/**
 * graph-memory-pro v2.1.2 — 维护阶段函数单元测试
 *
 * 覆盖批次：
 *   第一批：S-14 过时检测 / G-5 健康检查
 *   第四批：G-2 冲突消解 / L-3 边权重 / L-4 反向记忆
 *
 * 被测模块：/workspace/src/graph/maintenance.ts
 * 测试基础设施：/workspace/test/helpers/neo4j-mock.ts（mockDriver / queueResult / getAllRunCalls）
 *
 * 策略：用 mockDriver 构造 driver，queueResult 预置返回数据，
 *       调用被测函数后用 getAllRunCalls 断言 Cypher，用返回值断言结果。
 */

import { describe, it, expect } from "vitest";
import {
  computeStalenessScores,
  healthCheck,
  resolveConflicts,
  adjustEdgeWeights,
  applyReverseMemory,
} from "../src/graph/maintenance.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";

// ── 辅助 ──────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** 返回 N 天前的毫秒时间戳 */
const daysAgo = (d: number): number => Date.now() - d * DAY_MS;

// ═══════════════════════════════════════════════════════════════
// S-14 过时检测 — computeStalenessScores
// ═══════════════════════════════════════════════════════════════

describe("computeStalenessScores (S-14)", () => {
  it("正常调用：scanned/updated/highStaleCount 返回正确", async () => {
    const driver = mockDriver() as any;
    // 两个新鲜节点（age≈0, 有入边, 非 knowledge 来源）→ score=0, highStaleCount=0
    driver.queueResult([
      { id: "n1", inDegree: 5 },
      { id: "n2", inDegree: 3 },
    ]);

    const result = await computeStalenessScores(driver);

    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.highStaleCount).toBe(0);
    // 1 次 scan + 2 次 SET = 3 次调用
    expect(driver.getAllRunCalls().length).toBe(3);
  });

  it("启发式评分：state=superseded → score=1.0", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ id: "n1", state: "superseded", inDegree: 5 }]);

    const result = await computeStalenessScores(driver);

    const calls = driver.getAllRunCalls();
    // call[0] = scan, call[1] = SET for n1
    expect(calls[1].params.score).toBe(1);
    expect(result.highStaleCount).toBe(1);
  });

  it("启发式评分：ageDays>365 → +0.8", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ id: "n1", updatedAt: daysAgo(400), inDegree: 5 }]);

    await computeStalenessScores(driver);

    const calls = driver.getAllRunCalls();
    // 400 天 > 365 → +0.8；inDegree>0 不加；source 非 knowledge 不减
    expect(calls[1].params.score).toBe(0.8);
  });

  it("启发式评分：inDegree=0 → +0.2", async () => {
    const driver = mockDriver() as any;
    // 不传 updatedAt → 取 now，ageDays=0 < 45 不加龄分；inDegree=0 +0.2
    driver.queueResult([{ id: "n1", inDegree: 0 }]);

    await computeStalenessScores(driver);

    const calls = driver.getAllRunCalls();
    expect(calls[1].params.score).toBe(0.2);
  });

  it("启发式评分：source=knowledge → -0.1（夹紧到 0）", async () => {
    const driver = mockDriver() as any;
    // ageDays=0、inDegree>0、source=knowledge → 0 - 0.1 = -0.1 → max(0,·)=0
    driver.queueResult([{ id: "n1", inDegree: 5, source: "knowledge" }]);

    await computeStalenessScores(driver);

    const calls = driver.getAllRunCalls();
    expect(calls[1].params.score).toBe(0);
  });

  it("Cypher 包含 SET n.stalenessScore", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ id: "n1", inDegree: 5 }]);

    await computeStalenessScores(driver);

    const calls = driver.getAllRunCalls();
    // 写回语句必须包含 SET n.stalenessScore
    expect(calls[1].query).toContain("SET n.stalenessScore");
  });
});

// ═══════════════════════════════════════════════════════════════
// G-5 图谱健康检查 — healthCheck
// ═══════════════════════════════════════════════════════════════

describe("healthCheck (G-5)", () => {
  it("返回 nodes/edges/anomalies 字段", async () => {
    const driver = mockDriver() as any;
    // 6 次查询依次返回：nodeStats / edgeStats / isolated / stale / community / pr
    driver.queueResults([
      [{ total: 5, active: 5, superseded: 0, transitional: 0 }],
      [{ type: "RELATES_TO", cnt: 10 }],
      [{ cnt: 1 }],
      [{ cnt: 1 }],
      [{ cnt: 2 }],
      [{ id: "n1", name: "node1", pr: 0.5 }],
    ]);

    const report = await healthCheck(driver);

    expect(report.nodes).toBeDefined();
    expect(report.nodes.total).toBe(5);
    expect(report.nodes.active).toBe(5);
    expect(report.edges).toBeDefined();
    expect(report.edges.total).toBe(10);
    expect(report.edges.byType["RELATES_TO"]).toBe(10);
    expect(report.anomalies).toBeDefined();
    expect(Array.isArray(report.anomalies)).toBe(true);
    // isolated/stale 比例均为 1/5=0.2 < 0.3，无异常
    expect(report.anomalies).toEqual([]);
  });

  it("异常检测：孤立节点 > 阈值 → anomalies 含孤立告警", async () => {
    const driver = mockDriver() as any;
    // active=10, isolated=5 → 比例 0.5 > 0.3 触发告警
    driver.queueResults([
      [{ total: 10, active: 10, superseded: 0, transitional: 0 }],
      [],
      [{ cnt: 5 }],
      [{ cnt: 0 }],
      [{ cnt: 0 }],
      [],
    ]);

    const report = await healthCheck(driver);

    expect(report.isolatedNodes).toBe(5);
    // 源码告警文案为中文"孤立节点比例过高"
    expect(report.anomalies.some((a: string) => a.includes("孤立"))).toBe(true);
  });

  it("正常情况无异常", async () => {
    const driver = mockDriver() as any;
    driver.queueResults([
      [{ total: 3, active: 3, superseded: 0, transitional: 0 }],
      [{ type: "RELATES_TO", cnt: 5 }],
      [{ cnt: 0 }],
      [{ cnt: 0 }],
      [{ cnt: 1 }],
      [{ id: "n1", name: "node1", pr: 0.5 }],
    ]);

    const report = await healthCheck(driver);

    // isolated=0/3=0, stale=0/3=0, avgPr≈0.167, transitional=0 → 无任何异常
    expect(report.anomalies).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// G-2 冲突消解 — resolveConflicts
// ═══════════════════════════════════════════════════════════════

describe("resolveConflicts (G-2)", () => {
  it("策略 1 时态优先：bValidFrom > aValidFrom → b 胜出", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{
      aId: "a", aValidFrom: 1000, aSource: "experience",
      aValidatedCount: 5, aStaleness: 0, aContent: "A", aType: "Task",
      bId: "b", bValidFrom: 2000, bSource: "experience",
      bValidatedCount: 5, bStaleness: 0, bContent: "B", bType: "Task",
    }]);

    const result = await resolveConflicts(driver);

    expect(result.scanned).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.superseded).toBe(1);
    expect(result.merged).toBe(0);

    const calls = driver.getAllRunCalls();
    // call[0] = scan, call[1] = SET superseded, call[2] = CREATE GmDecision
    expect(calls[1].params.loserId).toBe("a");
    expect(calls[1].params.winnerId).toBe("b");
  });

  it("策略 2 来源优先：bSource=knowledge > aSource=experience → b 胜出", async () => {
    const driver = mockDriver() as any;
    // validFrom 相同 → 跳过时态；source rank knowledge(3) > experience(2)
    driver.queueResult([{
      aId: "a", aValidFrom: 1000, aSource: "experience",
      aValidatedCount: 5, aStaleness: 0, aContent: "A", aType: "Task",
      bId: "b", bValidFrom: 1000, bSource: "knowledge",
      bValidatedCount: 5, bStaleness: 0, bContent: "B", bType: "Task",
    }]);

    const result = await resolveConflicts(driver);

    expect(result.superseded).toBe(1);
    const calls = driver.getAllRunCalls();
    expect(calls[1].params.loserId).toBe("a");
    expect(calls[1].params.winnerId).toBe("b");
  });

  it("策略 3 置信度优先：bValidated > aValidated * 1.5 → b 胜出", async () => {
    const driver = mockDriver() as any;
    // validFrom、source 均相同 → 跳过策略 1/2；20 > 10*1.5=15
    driver.queueResult([{
      aId: "a", aValidFrom: 1000, aSource: "experience",
      aValidatedCount: 10, aStaleness: 0, aContent: "A", aType: "Task",
      bId: "b", bValidFrom: 1000, bSource: "experience",
      bValidatedCount: 20, bStaleness: 0, bContent: "B", bType: "Task",
    }]);

    const result = await resolveConflicts(driver);

    expect(result.superseded).toBe(1);
    const calls = driver.getAllRunCalls();
    expect(calls[1].params.loserId).toBe("a");
    expect(calls[1].params.winnerId).toBe("b");
  });

  it("策略 4 合并：按 validatedCount × (1 - staleness) 选择 winner", async () => {
    const driver = mockDriver() as any;
    // validFrom/source 相同、置信度未达 1.5x → 进入合并
    // aScore = 10 * (1 - 0.5) = 5;  bScore = 12 * (1 - 0.1) = 10.8 → b 胜出
    driver.queueResult([{
      aId: "a", aValidFrom: 1000, aSource: "experience",
      aValidatedCount: 10, aStaleness: 0.5, aContent: "A", aType: "Task",
      bId: "b", bValidFrom: 1000, bSource: "experience",
      bValidatedCount: 12, bStaleness: 0.1, bContent: "B", bType: "Task",
    }]);

    const result = await resolveConflicts(driver);

    expect(result.merged).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.superseded).toBe(0);

    const calls = driver.getAllRunCalls();
    // 合并路径：call[0]=scan, call[1]=merge Cypher, 之后 continue 无 GmDecision
    expect(calls.length).toBe(2);
    expect(calls[1].params.winnerId).toBe("b");
    expect(calls[1].params.loserId).toBe("a");
    expect(calls[1].params.totalValidated).toBe(22);
    expect(calls[1].params.mergedContent).toContain("A");
    expect(calls[1].params.mergedContent).toContain("B");
  });

  it("类型不同不视为冲突", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{
      aId: "a", aValidFrom: 1000, aSource: "experience",
      aValidatedCount: 5, aStaleness: 0, aContent: "A", aType: "Task",
      bId: "b", bValidFrom: 2000, bSource: "experience",
      bValidatedCount: 5, bStaleness: 0, bContent: "B", bType: "Skill",
    }]);

    const result = await resolveConflicts(driver);

    expect(result.scanned).toBe(1);
    expect(result.resolved).toBe(0);
    expect(result.superseded).toBe(0);
    expect(result.merged).toBe(0);
    // 仅 scan 调用，无消解写回
    expect(driver.getAllRunCalls().length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// L-3 边权重调整 — adjustEdgeWeights
// ═══════════════════════════════════════════════════════════════

describe("adjustEdgeWeights (L-3)", () => {
  it("冷启动期（feedbackCount < warmupFeedbacks）→ 跳过，返回 0", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ c: 5 }]); // feedbackCount = 5 < 100

    const result = await adjustEdgeWeights(driver, undefined, 100);

    expect(result.scanned).toBe(0);
    expect(result.strengthened).toBe(0);
    expect(result.decayed).toBe(0);
    // 仅 1 次 feedback count 查询
    expect(driver.getAllRunCalls().length).toBe(1);
  });

  it("热启动：strengthen 查询 j2 含 verdict='used' 过滤（修复点）", async () => {
    const driver = mockDriver() as any;
    driver.queueResults([
      [{ c: 200 }],          // feedbackCount = 200 >= 100，进入热启动
      [{ strengthened: 3 }], // strengthen 查询返回
      [{ decayed: 2 }],      // decay 查询返回
    ]);

    const result = await adjustEdgeWeights(driver, undefined, 100);

    expect(result.strengthened).toBe(3);
    expect(result.decayed).toBe(2);
    expect(result.scanned).toBe(5);

    const calls = driver.getAllRunCalls();
    // call[0] = feedback count, call[1] = strengthen, call[2] = decay
    // 修复点：j2 必须带 verdict='used' 过滤（避免 used-unused 边被强化）
    expect(calls[1].query).toContain("j2:JUDGED {verdict: 'used'}");
  });

  it("Cypher 含 verdict='used' 过滤", async () => {
    const driver = mockDriver() as any;
    driver.queueResults([
      [{ c: 200 }],
      [{ strengthened: 3 }],
      [{ decayed: 2 }],
    ]);

    await adjustEdgeWeights(driver, undefined, 100);

    const calls = driver.getAllRunCalls();
    const strengthenQuery = calls[1].query;
    // j1 与 j2 都应带 verdict='used'
    expect(strengthenQuery).toContain("j1:JUDGED {verdict: 'used'}");
    expect(strengthenQuery).toContain("j2:JUDGED {verdict: 'used'}");
  });
});

// ═══════════════════════════════════════════════════════════════
// L-4 反向记忆项 — applyReverseMemory
// ═══════════════════════════════════════════════════════════════

describe("applyReverseMemory (L-4)", () => {
  it("冷启动期跳过", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ c: 5 }]); // feedbackCount = 5 < 100

    const result = await applyReverseMemory(driver, undefined, 100);

    expect(result.watchlistAdded).toBe(0);
    expect(result.watchlistRemoved).toBe(0);
    expect(result.decayed).toBe(0);
    expect(driver.getAllRunCalls().length).toBe(1);
  });

  it("热启动：unusedCount >= 10 且 importanceScore < 0.2 → stalenessScore += 0.1", async () => {
    const driver = mockDriver() as any;
    driver.queueResults([
      [{ c: 200 }],  // feedbackCount = 200 >= 100
      // 候选：unusedCount=15 >= 10, importance=0.1 < 0.2, staleness=0.3
      [{ id: "n1", staleness: 0.3, importance: 0.1, unusedCount: 15 }],
      [],                // SET 调用（不读 records，吃掉一个队列槽位）
      [{ recovered: 0 }], // recovered 查询
    ]);

    const result = await applyReverseMemory(driver, undefined, 100);

    expect(result.decayed).toBe(1);
    expect(result.watchlistAdded).toBe(1);

    const calls = driver.getAllRunCalls();
    // call[0]=feedback count, call[1]=candidates, call[2]=SET, call[3]=recovered
    expect(calls[2].params.id).toBe("n1");
    // 0.3 + 0.1 = 0.4
    expect(calls[2].params.newStaleness).toBeCloseTo(0.4, 5);
  });
});
