/**
 * v2.8.x — 清空库能力的提交粒度
 *
 * 回答：「re-embed 工具的清空库能力，是否一条条记录处理的？是否有快速全量处理直接清空表？」
 *
 * 结论（本文件锁定）：
 *   - 清空**本来就是单条 Cypher 全量批量**，不是逐条：
 *       · clearAllNodes      → `MATCH (n) DETACH DELETE n`
 *       · 模型迁移清空向量   → `SET n.embedding = null, n.embeddingHash = null`（一条语句）
 *   - 但「一条语句」= **单个超大事务**。图规模上万时事务状态会撑爆事务内存
 *     （dbms.memory.transaction.total.max → OutOfMemoryError）。
 *     故改为官方推荐的分批提交 `CALL { … } IN TRANSACTIONS OF n ROWS`，语义不变，
 *     并保留单语句回落（老版本 Neo4j）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { clearAllNodes } from "../src/store/nodes.ts";

/** 可控会话：记录查询；第 1 次（分批版）可选抛错以触发回落 */
function fakeDriver(opts: { failBatched?: boolean } = {}) {
  const runCalls: string[] = [];
  let n = 0;
  const session = {
    async run(query: string) {
      runCalls.push(query);
      n++;
      if (opts.failBatched && n === 1) {
        const e = new Error("Invalid input 'IN TRANSACTIONS'") as Error & { code?: string };
        e.code = "Neo.ClientError.Statement.SyntaxError";
        throw e;
      }
      return { records: [{ get: () => ({ toNumber: () => 42 }) }], summary: {} };
    },
    async close() { /* noop */ },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const driver: any = { session: () => session };
  return { driver, runCalls };
}

describe("clearAllNodes — 分批提交（v2.8.x）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("优先使用 IN TRANSACTIONS 分批删除（避免单个超大事务）", async () => {
    const { driver, runCalls } = fakeDriver();
    const cleared = await clearAllNodes(driver);

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toContain("IN TRANSACTIONS OF 10000 ROWS");
    expect(runCalls[0]).toContain("DETACH DELETE n");
    // 语义不变：仍返回删除总数
    expect(cleared).toBe(42);
  });

  it("分批语法不支持时回落到单语句（行为与旧实现一致），并留痕", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { driver, runCalls } = fakeDriver({ failBatched: true });

    const cleared = await clearAllNodes(driver);

    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]).toContain("IN TRANSACTIONS");
    expect(runCalls[1]).toBe("MATCH (n) DETACH DELETE n RETURN count(n) AS c");
    expect(cleared).toBe(42);
    warn.mockRestore();
  });
});