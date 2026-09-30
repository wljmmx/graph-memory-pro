/**
 * v2.8.x — dedup 余弦查询的类型兼容（VECTOR vs LIST<FLOAT>）+ describeError 摘要
 *
 * 现场故障：maintenance Phase 1 报
 *   `dedup failed {"error":"Neo4jError: Float64Vector[0.0384…（截断 40008 字符）"}`
 *
 * 机制：旧实现的余弦计算是对 `LIST<FLOAT>` 做**下标索引**：
 *   `reduce(dot = 0.0, i IN range(0, size(va) - 1) | dot + va[i] * vb[i])`
 * Neo4j 2025+ 引入原生 VECTOR 类型后，被向量索引索引的属性可能以 VECTOR 物化
 * （驱动侧即 `Float64Vector`），此时 `size()` / `va[i]` 都不成立 → dedup 整段失败，
 * 且 Neo4j 把该值塞进错误消息（4 万字符），真正错误码被淹没。
 *
 * 两条修复合起来验证：
 *   ① dedup 优先用 `vector.similarity.cosine()`（对两种类型都成立），失败才回落下标版
 *   ② describeError 只取 `code + 截断后的 message`，不再 `String(err)` 全量倾泻
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { detectDuplicates } from "../src/graph/dedup.ts";
import { describeError } from "../src/logger.ts";

/** 可控会话：第 1 次匹配 failOn 的查询抛错，之后返回一行配对结果 */
function fakeDriver(opts: { failOn?: string; alwaysFail?: boolean } = {}) {
  const runCalls: { query: string; params: Record<string, unknown> }[] = [];
  let n = 0;
  const session = {
    runCalls,
    async run(query: string, params: Record<string, unknown> = {}) {
      runCalls.push({ query, params });
      n++;
      if (opts.alwaysFail || (opts.failOn && query.includes(opts.failOn) && n === 1)) {
        // 复刻真实报错：message 就是一整个向量字面量，另带错误码
        const e = new Error(`Float64Vector[${Array.from({ length: 1024 }, (_, i) => (i * 0.001).toFixed(9)).join(", ")}]`) as Error & { code?: string };
        e.code = "Neo.ClientError.Statement.TypeError";
        throw e;
      }
      return {
        records: [{
          get: (k: string) => ({ nodeA: "a", nameA: "A", nodeB: "b", nameB: "B", score: 0.95 } as Record<string, unknown>)[k],
        }],
        summary: {},
      };
    },
    async close() { /* noop */ },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const driver: any = { session: () => session };
  return { driver, runCalls };
}

const cfg = { dedupThreshold: 0.92 } as never;

describe("detectDuplicates — VECTOR / LIST 双类型兼容（v2.8.x）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("正常路径：使用内建 vector.similarity.cosine，不做下标索引", async () => {
    const { driver, runCalls } = fakeDriver();
    const pairs = await detectDuplicates(driver, cfg);

    expect(runCalls.length).toBe(1);
    expect(runCalls[0].query).toContain("vector.similarity.cosine");
    // 关键：不再出现对 embedding 的 size()/下标索引（那正是 VECTOR 类型下失败的原因）
    expect(runCalls[0].query).not.toContain("va[i]");
    expect(runCalls[0].query).not.toContain("size(va)");
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ nodeA: "a", nodeB: "b", similarity: 0.95 });
  });

  it("vector.similarity.cosine 不可用时回落下标版（老版本 Neo4j），行为不回归", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { driver, runCalls } = fakeDriver({ failOn: "vector.similarity.cosine" });

    const pairs = await detectDuplicates(driver, cfg);

    expect(runCalls.length).toBe(2);
    expect(runCalls[0].query).toContain("vector.similarity.cosine");
    // 回落路径必须是原下标实现（保持老版本兼容）
    expect(runCalls[1].query).toContain("va[i]");
    expect(runCalls[1].query).toContain("size(va) = size(vb)");
    expect(pairs).toHaveLength(1);
    warn.mockRestore();
  });

  it("两条路径都失败 → 抛出，且带可诊断的错误码（不是 4 万字符向量）", async () => {
    // alwaysFail：vector 路径与 listIndex 回落路径都抛错 → 必须向上抛（而非静默返回空）
    const { driver, runCalls } = fakeDriver({ alwaysFail: true });
    await expect(detectDuplicates(driver, cfg)).rejects.toThrow(/Float64Vector/);
    expect(runCalls.length).toBe(2); // 确实尝试了两条路径才放弃
  });
});

describe("describeError — 错误摘要而非全量倾泻（v2.8.x）", () => {
  it("优先暴露 code（Neo4j 错误码正是被 4 万字符向量淹没的那个）", () => {
    const e = new Error("Float64Vector[0.1, 0.2]") as Error & { code?: string };
    e.code = "Neo.ClientError.Statement.TypeError";
    const out = describeError(e);
    expect(out).toContain("Neo.ClientError.Statement.TypeError");
    expect(out).toContain("Float64Vector");
  });

  it("超长 message 被截断，不会淹没日志", () => {
    const e = new Error("x".repeat(40_000));
    const out = describeError(e);
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("truncated");
    expect(out).toContain("39600");
  });

  it("无 code 的普通 Error / 字符串 / null 都能安全摘要", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain")).toBe("plain");
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("null");
  });
});