/**
 * graph-memory-pro v2.4.1 — 流程作用域隔离测试（Neo4j Community / 单库场景）
 *
 * 背景：Neo4j Community 版不支持多数据库（withDatabase 无法物理隔离），
 *       两个流程的隔离完全依赖"逻辑隔离"：
 *         - 生产流程（production）：查询排除 :Benchmark 标签节点，写生产 M
 *         - benchmark 流程（benchmark）：查询命中 :Benchmark 节点，写独立 benchmark M
 *
 * 本测试验证在单库（模拟 Community）下，withFlowScope 开关能否正确驱动
 * 各查询函数生成含/不含 Benchmark 排除的 Cypher，从而保证数据互不污染。
 *
 * 被测模块：
 *   - src/store/db.ts      ：withFlowScope / setFlowScope / getFlowScope
 *   - src/store/nodes.ts   ：searchNodes / vectorSearchWithScore / graphWalk /
 *                            getNodeCount / getNodesByType / getTopNodes
 * 测试基础设施：/workspace/test/helpers/neo4j-mock.ts（mockDriver / queueResult / getAllRunCalls）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setFlowScope, getFlowScope, withFlowScope } from "../src/store/db.ts";
import {
  searchNodes,
  vectorSearchWithScore,
  graphWalk,
  getNodeCount,
  getNodesByType,
  getTopNodes,
} from "../src/store/store.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";

// 每个用例前强制回到生产作用域，避免模块级状态跨用例污染
beforeEach(() => {
  setFlowScope("production");
});

afterEach(() => {
  setFlowScope("production");
});

// ═══════════════════════════════════════════════════════════════
// withFlowScope 开关本身
// ═══════════════════════════════════════════════════════════════

describe("withFlowScope 流程作用域开关（单库）", () => {
  it("1. 默认作用域为 production", () => {
    setFlowScope("production");
    expect(getFlowScope()).toBe("production");
  });

  it("2. withFlowScope 执行期间切换为 benchmark，结束后恢复 production", async () => {
    setFlowScope("production");
    let during: string | null = null;
    await withFlowScope("benchmark", async () => {
      during = getFlowScope();
    });
    expect(during).toBe("benchmark");
    expect(getFlowScope()).toBe("production");
  });

  it("3. 异常时也恢复原作用域（finally 保证）", async () => {
    setFlowScope("production");
    await withFlowScope("benchmark", async () => {
      throw new Error("boom");
    }).catch(() => {});
    expect(getFlowScope()).toBe("production");
  });
});

// ═══════════════════════════════════════════════════════════════
// searchNodes — 文本检索
// ═══════════════════════════════════════════════════════════════

describe("searchNodes FULLTEXT 查询（作用域）", () => {
  it("1. production 作用域：Cypher 含 NOT n:Benchmark", async () => {
    const driver = mockDriver() as any;
    setFlowScope("production");
    await searchNodes(driver, "hello", 10);

    const calls = driver.getAllRunCalls();
    expect(calls.length).toBeGreaterThan(0);
    // 4 个 fulltext 索引并行，每个都应含排除谓词
    for (const c of calls) {
      expect(c.query).toContain("NOT n:Benchmark");
    }
  });

  it("2. benchmark 作用域：Cypher 不含 Benchmark 排除（评测命中 benchmark 节点）", async () => {
    const driver = mockDriver() as any;
    setFlowScope("benchmark");
    await searchNodes(driver, "hello", 10);

    const calls = driver.getAllRunCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.query).not.toContain("Benchmark");
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// vectorSearchWithScore — 向量检索
// ═══════════════════════════════════════════════════════════════

describe("vectorSearchWithScore 向量查询（作用域）", () => {
  it("1. production 作用域：Cypher 含 NOT node:Benchmark", async () => {
    const driver = mockDriver() as any;
    setFlowScope("production");
    // 合并索引路径成功（mock 默认返回空 → 单 session 命中）
    await vectorSearchWithScore(driver, [0.1, 0.2], 5);

    const calls = driver.getAllRunCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].query).toContain("NOT node:Benchmark");
  });

  it("2. benchmark 作用域：Cypher 不含 Benchmark 排除", async () => {
    const driver = mockDriver() as any;
    setFlowScope("benchmark");
    await vectorSearchWithScore(driver, [0.1, 0.2], 5);

    const calls = driver.getAllRunCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].query).not.toContain("Benchmark");
  });
});

// ═══════════════════════════════════════════════════════════════
// graphWalk — 图遍历
// ═══════════════════════════════════════════════════════════════

describe("graphWalk 图遍历（作用域）", () => {
  it("1. production 作用域：两端均排除 Benchmark", async () => {
    const driver = mockDriver() as any;
    setFlowScope("production");
    await graphWalk(driver, ["seed-1"], 2);

    const calls = driver.getAllRunCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].query).toContain("NOT start:Benchmark");
    expect(calls[0].query).toContain("NOT end:Benchmark");
  });

  it("2. benchmark 作用域：不含 Benchmark 排除", async () => {
    const driver = mockDriver() as any;
    setFlowScope("benchmark");
    await graphWalk(driver, ["seed-1"], 2);

    const calls = driver.getAllRunCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].query).not.toContain("Benchmark");
  });
});

// ═══════════════════════════════════════════════════════════════
// 统计 / 管理接口
// ═══════════════════════════════════════════════════════════════

describe("统计与管理接口（作用域）", () => {
  it("1. getNodeCount：production 排除，benchmark 不排除", async () => {
    const driver = mockDriver() as any;

    setFlowScope("production");
    await getNodeCount(driver);
    expect(driver.getAllRunCalls()[0].query).toContain("NOT n:Benchmark");

    setFlowScope("benchmark");
    await getNodeCount(driver);
    const benchCall = driver.getAllRunCalls()[1];
    expect(benchCall.query).not.toContain("Benchmark");
  });

  it("2. getTopNodes：production 排除，benchmark 不排除", async () => {
    const driver = mockDriver() as any;

    setFlowScope("production");
    await getTopNodes(driver, 10);
    expect(driver.getAllRunCalls()[0].query).toContain("NOT n:Benchmark");

    setFlowScope("benchmark");
    await getTopNodes(driver, 10);
    expect(driver.getAllRunCalls()[1].query).not.toContain("Benchmark");
  });

  it("3. getNodesByType：production 排除，benchmark 不排除", async () => {
    const driver = mockDriver() as any;

    setFlowScope("production");
    await getNodesByType(driver, "TASK", 10);
    expect(driver.getAllRunCalls()[0].query).toContain("NOT n:Benchmark");

    setFlowScope("benchmark");
    await getNodesByType(driver, "TASK", 10);
    expect(driver.getAllRunCalls()[1].query).not.toContain("Benchmark");
  });
});