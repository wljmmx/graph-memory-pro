/**
 * v2.8.x — Neo4j 2026.x 向量索引与检索参数
 *
 * 规格（用户提供）：
 *   - 2026.x 不再支持全局默认 HNSW 环境变量（`dbms.index.vector.default.*`）
 *   - HNSW/量化参数必须写在建索引的 `vectorConfig` 里，Provider 为 `vector-2.0`
 *   - **`efSearch` 是检索参数**，只写在 `db.index.vector.queryNodes(..., { efSearch: N })`；
 *     建索引阶段只有 `hnsw.efConstruction`，没有 efSearch
 *
 * 本文件锁定：
 *   ① 建索引优先用 vector-2.0 + vectorConfig（含 hnsw.m / hnsw.efConstruction /
 *      quantizationType / searchExpansionFactor），且**绝不**在 options 里出现 efSearch
 *   ② 新语法被拒时逐级回落到 indexConfig → 过程化 API
 *   ③ 检索时带 efSearch；旧版本不认识第 4 参时自动去掉重试（否则整个向量召回失效）
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildVectorCall, looksLikeUnsupportedOptions, runVectorQuery, DEFAULT_EF_SEARCH } from "../src/store/vector-query.ts";
import { ensureSchema } from "../src/store/schema.ts";
import { setCachedEdition } from "../src/store/db.ts";

describe("vector-query：检索参数 efSearch（v2.8.x）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("带 efSearch 时生成第 4 个检索参数，且不与索引参数混淆", () => {
    const call = buildVectorCall(
      { indexExpr: "$indexName", topKExpr: "toInteger($topK)", vecExpr: "$vec" },
      true,
    );
    expect(call).toContain("db.index.vector.queryNodes($indexName, toInteger($topK), $vec, { efSearch: toInteger($efSearch) })");
    expect(call).toContain("YIELD node, score");
    // efConstruction 属建索引参数，绝不能出现在检索语句里
    expect(call).not.toContain("efConstruction");
  });

  it("不带 efSearch 时生成三参形式（旧版本兼容）", () => {
    const call = buildVectorCall(
      { indexExpr: "'gm_community_embedding'", topKExpr: "toInteger($maxCommunities)", vecExpr: "$vec" },
      false,
    );
    expect(call).toContain("queryNodes('gm_community_embedding', toInteger($maxCommunities), $vec)");
    expect(call).not.toContain("efSearch");
  });

  it("runVectorQuery：正常路径带 efSearch 执行一次", async () => {
    const run = vi.fn(async () => ({ records: [] }));
    await runVectorQuery({ run } as never, { indexExpr: "$vec", topKExpr: "1", vecExpr: "$vec" }, "RETURN 1", { vec: [] }, 48);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain("efSearch");
    expect(run.mock.calls[0][1]).toMatchObject({ efSearch: 48 });
  });

  it("runVectorQuery：旧版本不认第 4 参 → 自动去掉重试（召回不失效）", async () => {
    let n = 0;
    const run = vi.fn(async (q: string) => {
      n++;
      if (n === 1) {
        const e = new Error("UnknownArgument: Unknown argument 'efSearch'") as Error & { code?: string };
        e.code = "Neo.ClientError.Statement.ArgumentError";
        throw e;
      }
      return { records: [] };
    });
    await runVectorQuery({ run } as never, { indexExpr: "$v", topKExpr: "1", vecExpr: "$vec" }, "RETURN 1", { vec: [] }, 48);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toContain("efSearch");
    expect(run.mock.calls[1][0]).not.toContain("efSearch");
  });

  it("runVectorQuery：**真实故障**（如索引缺失）不得被回落吞掉", async () => {
    const run = vi.fn(async () => {
      throw new Error("There is no such vector schema index: gm_node_embedding");
    });
    await expect(
      runVectorQuery({ run } as never, { indexExpr: "$v", topKExpr: "1", vecExpr: "$vec" }, "RETURN 1", { vec: [] }, 48),
    ).rejects.toThrow(/no such vector schema index/);
    // 关键：索引缺失不是"签名不兼容"，不应触发第二次请求
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("looksLikeUnsupportedOptions 只对参数签名类错误为真", () => {
    expect(looksLikeUnsupportedOptions(new Error("UnknownArgument: efSearch"))).toBe(true);
    expect(looksLikeUnsupportedOptions(new Error("Invalid input 'efSearch'"))).toBe(true);
    expect(looksLikeUnsupportedOptions(new Error("There is no such vector schema index: x"))).toBe(false);
    expect(looksLikeUnsupportedOptions(new Error("Embedding dimension mismatch"))).toBe(false);
  });

  it("efSearch 非法/<=0 → 不带该参数", async () => {
    for (const v of [0, -1, NaN]) {
      const run = vi.fn(async () => ({ records: [] }));
      await runVectorQuery({ run } as never, { indexExpr: "$v", topKExpr: "1", vecExpr: "$vec" }, "RETURN 1", { vec: [] }, v);
      expect(run.mock.calls[0][0]).not.toContain("efSearch");
    }
    expect(DEFAULT_EF_SEARCH).toBe(48);
  });
});

describe("ensureSchema：向量索引优先 vector-2.0 + vectorConfig（v2.8.x）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setCachedEdition(null); // 复位，避免影响其它用例
  });

  function fakeDriver() {
    const queries: string[] = [];
    const session = {
      async run(q: string) {
        queries.push(q);
        return { records: [] };
      },
      async close() { /* noop */ },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driver: any = { session: () => session };
    return { driver, queries };
  }

  it("首选建索引语句**不指定 indexProvider**（版本无关），且 HNSW 参数随 Enterprise 下发", async () => {
    setCachedEdition("Enterprise");
    const { driver, queries } = fakeDriver();
    await ensureSchema(driver, 1024);

    const createStmts = queries.filter((q) => q.includes("CREATE VECTOR INDEX"));
    expect(createStmts.length).toBeGreaterThan(0);

    const primary = createStmts.find((q) => q.includes("gm_node_embedding"))!;
    // 核心：不硬编码 provider（官方已把「显式指定 provider」标为废弃；
    // 且 2026.07+ 改用版本化命名 vector-2026.07 —— 硬编码会随版本过期）
    expect(primary).not.toContain("indexProvider");
    expect(primary).not.toContain("vector-2.0");
    expect(primary).not.toContain("vector-2026.07");
    // 参数走官方 indexConfig（反引号 vector.* 键）
    expect(primary).toContain("`vector.dimensions`");
    expect(primary).toContain("`vector.hnsw.ef_construction`");
    expect(primary).toContain("`vector.hnsw.m`");
    expect(primary).toContain("`vector.quantization.type`");
    expect(primary).toMatch(/`vector\.dimensions`:\s*1024/);
    // efSearch 属检索参数，绝不能出现在建索引语句里
    expect(primary).not.toContain("efSearch");
  });

  it("Community 版：仍用 vector-2.0 + vectorConfig（不含量化/HNSW 调优）", async () => {
    setCachedEdition("Community");
    const { driver, queries } = fakeDriver();
    await ensureSchema(driver, 1024);

    const primary = queries.filter((q) => q.includes("CREATE VECTOR INDEX") && q.includes("gm_node_embedding"))[0];
    expect(primary).not.toContain("indexProvider"); // 同样不硬编码 provider
    expect(primary).toContain("`vector.dimensions`");
    expect(primary).not.toContain("`vector.quantization.type`"); // Community 不量化
    expect(primary).not.toContain("efSearch");
  });

  it("语法被逐级拒绝时回落到 indexConfig（老环境不得因此没有向量索引）", async () => {
    setCachedEdition("Community");
    const queries: string[] = [];
    const session = {
      async run(q: string) {
        queries.push(q);
        // 拒绝一切**不指定 provider** 与 vectorConfig 的写法 → 应落到硬编码 provider 候选
        if (q.includes("CREATE VECTOR INDEX") && !q.includes("indexProvider")) {
          const e = new Error("No index provider specified") as Error & { code?: string };
          e.code = "Neo.ClientError.Statement.SyntaxError";
          throw e;
        }
        return { records: [] };
      },
      async close() { /* noop */ },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureSchema({ session: () => session } as any, 1024);

    const createStmts = queries.filter((q) => q.includes("CREATE VECTOR INDEX"));
    // 先试过「不指定 provider」的首选（这条会失败）
    expect(createStmts.some((q) => !q.includes("indexProvider"))).toBe(true);
    // 再落到硬编码版本化候选（vector-2026.07 优先于 vector-2.0）
    expect(createStmts.some((q) => q.includes("vector-2026.07"))).toBe(true);
  });
});