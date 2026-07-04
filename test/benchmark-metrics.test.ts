/**
 * S-10 Benchmark 指标计算测试（graph-memory-pro v2.1.2 第五批）
 *
 * 测试 /workspace/src/benchmark/types.ts 导出的指标计算函数：
 * - computeP1 / computeP3 / computeMRR：排名指标数学正确性
 * - computeF1：token 级别 F1（基于 Set，重复 token 不计数）
 * - computeP99Latency：nearest-rank P99 算法
 * - computeAvgTokenEstimate：平均 token 消耗
 * - evaluateCase：单样本评测（hitAt1/hitAt3/reciprocalRank 计算逻辑）
 *
 * 边界情况：空数组、单元素、expectedNodeIds 为空。
 */

import { describe, it, expect } from "vitest";
import {
  computeP1,
  computeP3,
  computeMRR,
  computeF1,
  computeP99Latency,
  computeAvgTokenEstimate,
  evaluateCase,
} from "../src/benchmark/types.ts";
import type { CaseResult, BenchmarkCase } from "../src/benchmark/types.ts";
import type { RecallResult, GmNode } from "../src/types.ts";

// ─── 工厂函数（构造最小可用样本，避免冗长字面量） ────────────────

function makeCase(over: Partial<BenchmarkCase> & { id: string }): BenchmarkCase {
  return {
    dataset: "locomo",
    category: "single-hop",
    query: "",
    expectedAnswer: "",
    ...over,
  };
}

function makeNode(over: Partial<GmNode> & { id: string }): GmNode {
  return {
    type: "TASK",
    name: over.id,
    description: "",
    content: "",
    status: "active",
    pagerank: 0,
    validatedCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function makeResult(over: Partial<CaseResult> & { caseId: string }): CaseResult {
  return {
    dataset: "locomo",
    category: "single-hop",
    hitAt1: false,
    hitAt3: false,
    reciprocalRank: 0,
    f1: 0,
    latencyMs: 0,
    tokenEstimate: 0,
    recalledNodes: 0,
    ...over,
  };
}

function makeRecallResult(nodes: GmNode[], tokenEstimate = 100): RecallResult {
  return { nodes, edges: [], tokenEstimate };
}

// ═══════════════════════════════════════════════════════════════
// computeP1（P@1 = sum(hitAt1) / N）
// ═══════════════════════════════════════════════════════════════

describe("computeP1", () => {
  it("空数组返回 0", () => {
    expect(computeP1([])).toBe(0);
  });

  it("全部命中返回 1", () => {
    const results = [
      makeResult({ caseId: "c1", hitAt1: true }),
      makeResult({ caseId: "c2", hitAt1: true }),
      makeResult({ caseId: "c3", hitAt1: true }),
    ];
    expect(computeP1(results)).toBe(1);
  });

  it("半数命中返回 0.5", () => {
    const results = [
      makeResult({ caseId: "c1", hitAt1: true }),
      makeResult({ caseId: "c2", hitAt1: false }),
      makeResult({ caseId: "c3", hitAt1: true }),
      makeResult({ caseId: "c4", hitAt1: false }),
    ];
    expect(computeP1(results)).toBe(0.5);
  });

  it("单元素命中返回 1", () => {
    expect(computeP1([makeResult({ caseId: "c1", hitAt1: true })])).toBe(1);
  });

  it("单元素未命中返回 0", () => {
    expect(computeP1([makeResult({ caseId: "c1", hitAt1: false })])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// computeP3（P@3 = sum(hitAt3) / N）
// ═══════════════════════════════════════════════════════════════

describe("computeP3", () => {
  it("空数组返回 0", () => {
    expect(computeP3([])).toBe(0);
  });

  it("全部命中返回 1", () => {
    const results = [
      makeResult({ caseId: "c1", hitAt3: true }),
      makeResult({ caseId: "c2", hitAt3: true }),
    ];
    expect(computeP3(results)).toBe(1);
  });

  it("1/4 命中返回 0.25", () => {
    const results = [
      makeResult({ caseId: "c1", hitAt3: false }),
      makeResult({ caseId: "c2", hitAt3: false }),
      makeResult({ caseId: "c3", hitAt3: false }),
      makeResult({ caseId: "c4", hitAt3: true }),
    ];
    expect(computeP3(results)).toBe(0.25);
  });

  it("单元素命中返回 1", () => {
    expect(computeP3([makeResult({ caseId: "c1", hitAt3: true })])).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// computeMRR（MRR = avg(1/rank)，未命中 reciprocalRank=0）
// ═══════════════════════════════════════════════════════════════

describe("computeMRR", () => {
  it("空数组返回 0", () => {
    expect(computeMRR([])).toBe(0);
  });

  it("全部 rank=1 返回 1", () => {
    const results = [
      makeResult({ caseId: "c1", reciprocalRank: 1 }),
      makeResult({ caseId: "c2", reciprocalRank: 1 }),
    ];
    expect(computeMRR(results)).toBe(1);
  });

  it("全部未命中（reciprocalRank=0）返回 0", () => {
    const results = [
      makeResult({ caseId: "c1", reciprocalRank: 0 }),
      makeResult({ caseId: "c2", reciprocalRank: 0 }),
    ];
    expect(computeMRR(results)).toBe(0);
  });

  it("混合排名：ranks=[1, 2, 0, 3] → (1 + 0.5 + 0 + 1/3) / 4", () => {
    const results = [
      makeResult({ caseId: "c1", reciprocalRank: 1 }),       // rank 1
      makeResult({ caseId: "c2", reciprocalRank: 0.5 }),      // rank 2
      makeResult({ caseId: "c3", reciprocalRank: 0 }),         // 未命中
      makeResult({ caseId: "c4", reciprocalRank: 1 / 3 }),     // rank 3
    ];
    // sum = 1 + 0.5 + 0 + 1/3 = 11/6
    // MRR = (11/6) / 4 = 11/24 ≈ 0.45833
    expect(computeMRR(results)).toBeCloseTo(11 / 24, 5);
  });

  it("单元素 rank=1 返回 1", () => {
    expect(computeMRR([makeResult({ caseId: "c1", reciprocalRank: 1 })])).toBe(1);
  });

  it("单元素未命中返回 0", () => {
    expect(computeMRR([makeResult({ caseId: "c1", reciprocalRank: 0 })])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// computeF1（token 级 F1，基于 Set，重复 token 不计数）
// ═══════════════════════════════════════════════════════════════

describe("computeF1", () => {
  it("空 expected 返回 0", () => {
    expect(computeF1("", "hello world")).toBe(0);
  });

  it("空 actual 返回 0", () => {
    expect(computeF1("hello world", "")).toBe(0);
  });

  it("完全相同返回 1", () => {
    expect(computeF1("Alice works at ACME", "Alice works at ACME")).toBe(1);
  });

  it("无重叠返回 0", () => {
    // expected={alice, works, at, acme}, actual={bob, studies, in, mit}
    // common=0 → F1=0
    expect(computeF1("Alice works at ACME", "Bob studies in MIT")).toBe(0);
  });

  it("部分重叠：precision=recall=1/4 → F1=0.25", () => {
    // expected={alice, works, at, acme}, actual={bob, studies, at, mit}
    // common=1 ("at"), precision=1/4, recall=1/4
    // F1 = 2*0.25*0.25/(0.25+0.25) = 0.25
    expect(computeF1("Alice works at ACME", "Bob studies at MIT")).toBeCloseTo(0.25, 5);
  });

  it("重复 token 不被计数（Set 去重）：'cat cat cat' vs 'cat dog'", () => {
    // expectedTokens=[cat,cat,cat] → Set{cat} (size 1)
    // actualTokens=[cat,dog] → Set{cat,dog} (size 2)
    // common=1, precision=1/2=0.5, recall=1/1=1
    // F1 = 2*0.5*1/(0.5+1) = 1/1.5 = 2/3 ≈ 0.6667
    // 若按原始计数（不去重）recall 应为 1/3，F1≈0.4；此处验证 Set 行为
    expect(computeF1("cat cat cat", "cat dog")).toBeCloseTo(2 / 3, 5);
  });

  it("两侧均有重复 token：'hello hello world' vs 'hello world world'", () => {
    // 两侧 Set 均为 {hello, world}，common=2，P=R=1，F1=1
    expect(computeF1("hello hello world", "hello world world")).toBe(1);
  });

  it("标点符号被去除：'Alice!' 与 'Alice' 视为相同", () => {
    // tokenize 去掉非 \w / 中文 / 空白字符
    expect(computeF1("Alice!", "Alice")).toBe(1);
  });

  it("大小写不敏感：'ALICE' 与 'alice' 视为相同", () => {
    expect(computeF1("ALICE", "alice")).toBe(1);
  });

  it("中文 token 支持（空格分词）", () => {
    // tokenize 保留 \u4e00-\u9fa5
    // expected="你好 世界" → {你好, 世界}
    // actual="你好 测试" → {你好, 测试}
    // common=1, P=1/2, R=1/2, F1=0.5
    expect(computeF1("你好 世界", "你好 测试")).toBeCloseTo(0.5, 5);
  });
});

// ═══════════════════════════════════════════════════════════════
// computeP99Latency（nearest-rank：ceil(N*0.99)-1，clamp 到 [0, N-1]）
// ═══════════════════════════════════════════════════════════════

describe("computeP99Latency", () => {
  it("空数组返回 0", () => {
    expect(computeP99Latency([])).toBe(0);
  });

  it("单元素返回该元素", () => {
    // idx = ceil(1*0.99)-1 = 0
    expect(computeP99Latency([makeResult({ caseId: "c1", latencyMs: 42 })])).toBe(42);
  });

  it("N=100 时返回 index 98 的值（即第 99 小，=99）", () => {
    // 构造乱序 latency 1..100，排序后 [1,2,...,100]
    // idx = ceil(100*0.99) - 1 = ceil(99) - 1 = 98
    // latencies[98] = 99
    const order = Array.from({ length: 100 }, (_, i) => i + 1);
    // 打乱顺序以验证内部排序
    const shuffled = [...order].reverse();
    const results = shuffled.map((ms, i) =>
      makeResult({ caseId: `c${i}`, latencyMs: ms }),
    );
    expect(computeP99Latency(results)).toBe(99);
  });

  it("N=100 不返回 index 99（非 P100）——验证 off-by-one 修复", () => {
    // 旧实现 Math.floor(N*0.99) 在 N=100 时会返回 index 99（=100，即 P100）
    // 新实现返回 index 98（=99），即真正的 P99
    const results = Array.from({ length: 100 }, (_, i) =>
      makeResult({ caseId: `c${i}`, latencyMs: i + 1 }),
    );
    expect(computeP99Latency(results)).toBe(99);   // 非 100
    expect(computeP99Latency(results)).not.toBe(100);
  });

  it("N=10 时返回 index 9 的值（即最大值）", () => {
    // idx = ceil(10*0.99) - 1 = ceil(9.9) - 1 = 10 - 1 = 9
    // latencies[9] = 第 10 个 = 100
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult({ caseId: `c${i}`, latencyMs: (i + 1) * 10 }),
    );
    // sorted = [10,20,...,100], index 9 = 100
    expect(computeP99Latency(results)).toBe(100);
  });

  it("N=2 时返回 index 1（较大值）", () => {
    // idx = ceil(2*0.99) - 1 = ceil(1.98) - 1 = 2 - 1 = 1
    const results = [
      makeResult({ caseId: "c1", latencyMs: 10 }),
      makeResult({ caseId: "c2", latencyMs: 20 }),
    ];
    expect(computeP99Latency(results)).toBe(20);
  });

  it("输入乱序时仍按升序排序后取值", () => {
    const results = [
      makeResult({ caseId: "c1", latencyMs: 500 }),
      makeResult({ caseId: "c2", latencyMs: 100 }),
      makeResult({ caseId: "c3", latencyMs: 300 }),
    ];
    // N=3, idx = ceil(3*0.99)-1 = ceil(2.97)-1 = 3-1 = 2
    // sorted = [100, 300, 500], index 2 = 500
    expect(computeP99Latency(results)).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════
// computeAvgTokenEstimate（平均值）
// ═══════════════════════════════════════════════════════════════

describe("computeAvgTokenEstimate", () => {
  it("空数组返回 0", () => {
    expect(computeAvgTokenEstimate([])).toBe(0);
  });

  it("计算平均值：[100, 200, 300] → 200", () => {
    const results = [
      makeResult({ caseId: "c1", tokenEstimate: 100 }),
      makeResult({ caseId: "c2", tokenEstimate: 200 }),
      makeResult({ caseId: "c3", tokenEstimate: 300 }),
    ];
    expect(computeAvgTokenEstimate(results)).toBe(200);
  });

  it("单元素返回该值", () => {
    expect(computeAvgTokenEstimate([makeResult({ caseId: "c1", tokenEstimate: 42 })])).toBe(42);
  });

  it("非整数平均值保持浮点：[1, 2] → 1.5", () => {
    const results = [
      makeResult({ caseId: "c1", tokenEstimate: 1 }),
      makeResult({ caseId: "c2", tokenEstimate: 2 }),
    ];
    expect(computeAvgTokenEstimate(results)).toBe(1.5);
  });
});

// ═══════════════════════════════════════════════════════════════
// evaluateCase（单样本评测）
// ═══════════════════════════════════════════════════════════════

describe("evaluateCase", () => {
  it("命中 rank 1：hitAt1=true, hitAt3=true, reciprocalRank=1", () => {
    const tc = makeCase({
      id: "c1",
      expectedNodeIds: ["n1", "n2"],
    });
    const recall = makeRecallResult([
      makeNode({ id: "n1", name: "Alice", description: "works at ACME" }),
      makeNode({ id: "n3", name: "Bob", description: "" }),
    ]);
    const r = evaluateCase(tc, recall, 50);
    expect(r.caseId).toBe("c1");
    expect(r.hitAt1).toBe(true);
    expect(r.hitAt3).toBe(true);
    expect(r.reciprocalRank).toBe(1);
    expect(r.latencyMs).toBe(50);
    expect(r.tokenEstimate).toBe(100);
    expect(r.recalledNodes).toBe(2);
  });

  it("命中 rank 2：hitAt1=false, hitAt3=true, reciprocalRank=0.5", () => {
    const tc = makeCase({
      id: "c2",
      expectedNodeIds: ["n2"],
    });
    const recall = makeRecallResult([
      makeNode({ id: "n1", name: "X", description: "" }),
      makeNode({ id: "n2", name: "Y", description: "" }),
    ]);
    const r = evaluateCase(tc, recall, 10);
    expect(r.hitAt1).toBe(false);
    expect(r.hitAt3).toBe(true);
    expect(r.reciprocalRank).toBe(0.5);
  });

  it("命中 rank 3：hitAt1=false, hitAt3=true, reciprocalRank=1/3", () => {
    const tc = makeCase({ id: "c3", expectedNodeIds: ["n3"] });
    const recall = makeRecallResult([
      makeNode({ id: "n1", name: "A", description: "" }),
      makeNode({ id: "n2", name: "B", description: "" }),
      makeNode({ id: "n3", name: "C", description: "" }),
    ]);
    const r = evaluateCase(tc, recall, 0);
    expect(r.hitAt1).toBe(false);
    expect(r.hitAt3).toBe(true);
    expect(r.reciprocalRank).toBeCloseTo(1 / 3, 5);
  });

  it("命中 rank 4：hitAt1=false, hitAt3=false, reciprocalRank=0.25", () => {
    const tc = makeCase({ id: "c4", expectedNodeIds: ["n4"] });
    const recall = makeRecallResult([
      makeNode({ id: "n1", name: "A", description: "" }),
      makeNode({ id: "n2", name: "B", description: "" }),
      makeNode({ id: "n3", name: "C", description: "" }),
      makeNode({ id: "n4", name: "D", description: "" }),
    ]);
    const r = evaluateCase(tc, recall, 0);
    expect(r.hitAt1).toBe(false);
    expect(r.hitAt3).toBe(false);
    expect(r.reciprocalRank).toBe(0.25);
  });

  it("未命中：所有 hit=false, reciprocalRank=0", () => {
    const tc = makeCase({ id: "c5", expectedNodeIds: ["nX"] });
    const recall = makeRecallResult([
      makeNode({ id: "n1", name: "A", description: "" }),
      makeNode({ id: "n2", name: "B", description: "" }),
    ]);
    const r = evaluateCase(tc, recall, 0);
    expect(r.hitAt1).toBe(false);
    expect(r.hitAt3).toBe(false);
    expect(r.reciprocalRank).toBe(0);
  });

  it("expectedNodeIds 为空：不触发命中判定，reciprocalRank=0", () => {
    const tc = makeCase({ id: "c6" });  // expectedNodeIds 默认 undefined → []
    const recall = makeRecallResult([
      makeNode({ id: "n1", name: "A", description: "" }),
    ]);
    const r = evaluateCase(tc, recall, 0);
    expect(r.hitAt1).toBe(false);
    expect(r.hitAt3).toBe(false);
    expect(r.reciprocalRank).toBe(0);
  });

  it("expectedNodeIds 显式为空数组：同样不命中", () => {
    const tc = makeCase({ id: "c7", expectedNodeIds: [] });
    const recall = makeRecallResult([
      makeNode({ id: "n1", name: "A", description: "" }),
    ]);
    const r = evaluateCase(tc, recall, 0);
    expect(r.hitAt1).toBe(false);
    expect(r.hitAt3).toBe(false);
    expect(r.reciprocalRank).toBe(0);
  });

  it("召回节点为空：不命中，recalledNodes=0", () => {
    const tc = makeCase({ id: "c8", expectedNodeIds: ["n1"] });
    const recall = makeRecallResult([], 0);
    const r = evaluateCase(tc, recall, 5);
    expect(r.hitAt1).toBe(false);
    expect(r.hitAt3).toBe(false);
    expect(r.reciprocalRank).toBe(0);
    expect(r.recalledNodes).toBe(0);
    expect(r.tokenEstimate).toBe(0);
  });

  it("首个命中后 break，后续命中不影响 reciprocalRank", () => {
    // expectedNodeIds=[n2, n1]，recalled=[n1, n2]
    // 第一个 recalled 是 n1（在 expected 中）→ rank 1，break
    // 即使 n2 也在 expected，不影响结果
    const tc = makeCase({ id: "c9", expectedNodeIds: ["n2", "n1"] });
    const recall = makeRecallResult([
      makeNode({ id: "n1", name: "A", description: "" }),
      makeNode({ id: "n2", name: "B", description: "" }),
    ]);
    const r = evaluateCase(tc, recall, 0);
    expect(r.hitAt1).toBe(true);
    expect(r.reciprocalRank).toBe(1);
  });

  it("F1 由 expectedAnswer 与召回节点文本（name: description）计算", () => {
    const tc = makeCase({
      id: "c10",
      expectedAnswer: "Alice works at ACME",
      expectedNodeIds: ["n1"],
    });
    // actualText = "Alice: works at ACME"
    // tokenize(expected)={alice, works, at, acme}
    // tokenize(actual)={alice, works, at, acme}（冒号被去除）
    // → F1=1
    const recall = makeRecallResult([
      makeNode({ id: "n1", name: "Alice", description: "works at ACME" }),
    ]);
    const r = evaluateCase(tc, recall, 0);
    expect(r.f1).toBe(1);
  });

  it("F1 部分匹配：expectedAnswer 与节点文本部分重叠", () => {
    const tc = makeCase({
      id: "c11",
      expectedAnswer: "Alice works at ACME",
    });
    // actualText = "Bob: studies at MIT"
    // common=1 ("at"), P=R=1/4, F1=0.25
    const recall = makeRecallResult([
      makeNode({ id: "n1", name: "Bob", description: "studies at MIT" }),
    ]);
    const r = evaluateCase(tc, recall, 0);
    expect(r.f1).toBeCloseTo(0.25, 5);
  });

  it("F1 与 computeF1 独立调用结果一致（多节点拼接）", () => {
    const tc = makeCase({
      id: "c12",
      expectedAnswer: "deploy service with docker",
    });
    const nodes = [
      makeNode({ id: "n1", name: "deploy", description: "use docker compose" }),
      makeNode({ id: "n2", name: "service", description: "backend api" }),
    ];
    const recall = makeRecallResult(nodes, 250);
    const r = evaluateCase(tc, recall, 30);

    // 复现 evaluateCase 内部 actualText 构造
    const expectedActualText = nodes
      .map(n => `${n.name}: ${n.description ?? ""}`)
      .join(" ");
    expect(r.f1).toBe(computeF1(tc.expectedAnswer, expectedActualText));
    expect(r.tokenEstimate).toBe(250);
    expect(r.latencyMs).toBe(30);
  });

  it("透传 caseId / dataset / category", () => {
    const tc = makeCase({
      id: "case-xyz",
      dataset: "longmemeval",
      category: "multi-hop",
    });
    const r = evaluateCase(tc, makeRecallResult([], 0), 0);
    expect(r.caseId).toBe("case-xyz");
    expect(r.dataset).toBe("longmemeval");
    expect(r.category).toBe("multi-hop");
  });
});

// ═══════════════════════════════════════════════════════════════
// 边界情况汇总
// ═══════════════════════════════════════════════════════════════

describe("边界情况", () => {
  it("所有 compute* 函数对空数组返回 0", () => {
    expect(computeP1([])).toBe(0);
    expect(computeP3([])).toBe(0);
    expect(computeMRR([])).toBe(0);
    expect(computeP99Latency([])).toBe(0);
    expect(computeAvgTokenEstimate([])).toBe(0);
  });

  it("单元素数组：各 compute* 返回该元素的对应贡献", () => {
    const one = [makeResult({
      caseId: "solo",
      hitAt1: true,
      hitAt3: true,
      reciprocalRank: 1,
      latencyMs: 77,
      tokenEstimate: 88,
    })];
    expect(computeP1(one)).toBe(1);
    expect(computeP3(one)).toBe(1);
    expect(computeMRR(one)).toBe(1);
    expect(computeP99Latency(one)).toBe(77);
    expect(computeAvgTokenEstimate(one)).toBe(88);
  });

  it("evaluateCase expectedNodeIds 缺省（undefined）时按空数组处理", () => {
    const tc: BenchmarkCase = {
      id: "no-expected",
      dataset: "locomo",
      category: "open-domain",
      query: "q",
      expectedAnswer: "",
      // expectedNodeIds 故意不提供
    };
    const r = evaluateCase(tc, makeRecallResult([makeNode({ id: "n1" })]), 0);
    expect(r.hitAt1).toBe(false);
    expect(r.hitAt3).toBe(false);
    expect(r.reciprocalRank).toBe(0);
  });
});
