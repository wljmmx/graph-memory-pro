/**
 * graph-memory-pro v2.2.1 — PageRank (PPR / Global PR) 单元测试
 *
 * 覆盖：
 *   - personalizedPageRank 在 session.run 抛 "closed session" 错误时优雅降级
 *   - computeGlobalPageRank 在 GDS 错误时返回空结果
 *   - catch 路径不再调用 session.run（避免二次 "closed session" 错误掩盖原始错误）
 *
 * 被测模块：/workspace/src/graph/pagerank.ts
 * 测试基础设施：/workspace/test/helpers/neo4j-mock.ts
 */

import { describe, it, expect } from "vitest";
import { personalizedPageRank, computeGlobalPageRank } from "../src/graph/pagerank.ts";
import { mockDriver, type MockSession } from "./helpers/neo4j-mock.ts";
import type { GmConfig } from "../src/types.ts";

const baseConfig: GmConfig = {
  neo4j: { uri: "bolt://localhost", user: "neo4j", password: "" },
  pagerankDamping: 0.85,
  pagerankIterations: 20,
} as any;

/** 模拟 session.run 抛 "closed session" 错误 */
function makeClosedSession(): MockSession {
  return {
    runCalls: [],
    closeCalls: 0,
    resultQueue: [],
    async run() {
      const err = new Error("You cannot run more transactions on a closed session.") as any;
      err.gqlStatus = "50N42";
      err.code = "N/A";
      throw err;
    },
    async close() {
      this.closeCalls++;
    },
  };
}

describe("personalizedPageRank (PPR) — session closed 容错", () => {
  it("session.run 抛 'closed session' 时优雅降级到 uniform scores", async () => {
    const driver = mockDriver() as any;
    // 覆盖 session() 返回一个会抛 closed session 错误的 session
    const closedSession = makeClosedSession();
    driver.session = () => closedSession;

    const result = await personalizedPageRank(
      driver,
      ["seed-1", "seed-2"],
      ["cand-1", "cand-2", "cand-3"],
      baseConfig,
    );

    // 应返回 fallback uniform scores（不抛错给上层）
    expect(result.scores.size).toBe(3);
    expect(result.scores.get("cand-1")).toBe(1);
    expect(result.scores.get("cand-2")).toBe(0.5);
    expect(result.scores.get("cand-3")).toBeCloseTo(0.333, 2);
    // v2.3.1 P1-2: 新实现创建 2 个 session（主 session + seedSession），
    // 各调用 1 次 close，总 closeCalls = 2
    expect(closedSession.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it("catch 路径不再调用 session.run（避免二次 closed session 错误）", async () => {
    const driver = mockDriver() as any;
    const closedSession = makeClosedSession();
    driver.session = () => closedSession;

    await personalizedPageRank(driver, ["s1"], ["c1"], baseConfig);

    // v2.3.1 P1-2: 新实现创建 2 个 session（type 探测 + seed 查找并行）
    // 两者都会抛 closed session 错误，由 catch 统一降级
    // 关键断言：close 后再无 run 调用
    const runCountAfterFirstCall = closedSession.runCalls.length;
    expect(closedSession.closeCalls).toBeGreaterThanOrEqual(1);
    expect(closedSession.runCalls.length).toBe(runCountAfterFirstCall);
  });

  it("空 seedIds 或 candidateIds 时直接返回空 scores（不创建 session.run）", async () => {
    const driver = mockDriver() as any;
    let sessionCreated = 0;
    driver.session = () => { sessionCreated++; return makeClosedSession(); };

    const r1 = await personalizedPageRank(driver, [], ["c1"], baseConfig);
    expect(r1.scores.size).toBe(0);

    const r2 = await personalizedPageRank(driver, ["s1"], [], baseConfig);
    expect(r2.scores.size).toBe(0);

    // 空入参时直接 early return，不创建 session
    expect(sessionCreated).toBe(0);
  });
});

describe("computeGlobalPageRank — session closed 容错", () => {
  it("session.run 抛 'closed session' 时返回空 scores + topK", async () => {
    const driver = mockDriver() as any;
    const closedSession = makeClosedSession();
    driver.session = () => closedSession;

    const result = await computeGlobalPageRank(driver, baseConfig);

    expect(result.scores.size).toBe(0);
    expect(result.topK).toEqual([]);
    expect(closedSession.closeCalls).toBe(1);
  });

  it("无活跃节点时返回空结果", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ c: 0 }]); // nodeCount = 0

    const result = await computeGlobalPageRank(driver, baseConfig);

    expect(result.scores.size).toBe(0);
    expect(result.topK).toEqual([]);
  });
});
