/**
 * graph-memory-pro — benchmark 数据库隔离链路（v2.9.0 断链修复）
 *
 * 覆盖四个修复点：
 *   口② resolveBenchmarkDatabase：空串/缺失配置回落到 "benchmarks"（?? 不兜空串的坑）
 *   口③ ensureDatabase：Enterprise 下目标库不存在 → CREATE DATABASE + 等 online；
 *        已存在 → 跳过；Community/未知/空库名 → no-op
 *   口① withDatabase 空库名防御：Enterprise + 空串 → 不切换（静默落默认库的坑）
 *   口④（MCP withDatabase 包装）属集成路径，由现有 withDatabase 单测 + 类型检查覆盖
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockDriver } from "./helpers/neo4j-mock.ts";
import {
  setCachedEdition,
  withDatabase,
  getActiveDatabase,
  ensureDatabase,
} from "../src/store/db.ts";
import { resolveBenchmarkDatabase, DEFAULT_BENCHMARK_DATABASE } from "../src/benchmark/database.ts";
import type { GmConfig } from "../src/types.ts";

// ── 口② resolveBenchmarkDatabase ──────────────────────────

describe("resolveBenchmarkDatabase（口② 空串回落）", () => {
  it("1. benchmark.database 与 neo4j.database 均为空串 → 默认 benchmarks", () => {
    const cfg = {
      neo4j: { uri: "bolt://x", user: "u", password: "***", database: "" },
      benchmark: { database: "" },
    } as unknown as GmConfig;
    expect(resolveBenchmarkDatabase(cfg)).toBe(DEFAULT_BENCHMARK_DATABASE);
  });

  it("2. 显式 benchmark.database 优先", () => {
    const cfg = {
      neo4j: { database: "prod" },
      benchmark: { database: "my-bench" },
    } as unknown as GmConfig;
    expect(resolveBenchmarkDatabase(cfg)).toBe("my-bench");
  });

  it("3. benchmark.database 为空、neo4j.database 有值 → 用 neo4j.database", () => {
    const cfg = {
      neo4j: { database: "shared" },
      benchmark: { database: "" },
    } as unknown as GmConfig;
    expect(resolveBenchmarkDatabase(cfg)).toBe("shared");
  });

  it("4. 全缺失 → 默认 benchmarks", () => {
    const cfg = {} as unknown as GmConfig;
    expect(resolveBenchmarkDatabase(cfg)).toBe(DEFAULT_BENCHMARK_DATABASE);
  });
});

// ── 口③ ensureDatabase ────────────────────────────────────

describe("ensureDatabase（口③ 自动建库）", () => {
  const originalActive = getActiveDatabase();

  beforeEach(() => setCachedEdition("Enterprise"));
  afterEach(() => {
    setCachedEdition(null);
    vi.useRealTimers();
  });

  it("5. Enterprise + 库不存在 → CREATE DATABASE 并等待 online", async () => {
    const driver = mockDriver() as any;
    const session = driver.session();
    session.run = async (query: string) => {
      session.runCalls.push({ query, params: {} });
      if (query.startsWith("SHOW DATABASES YIELD name")) {
        return { records: [], summary: { counters: { upserts: () => 0 } } }; // 不存在
      }
      if (query.startsWith("CREATE DATABASE")) {
        return { records: [], summary: { counters: { upserts: () => 0 } } };
      }
      if (query.includes("currentStatus")) {
        return {
          records: [{ get: (k: string) => (k === "currentStatus" ? "online" : null) }],
          summary: { counters: { upserts: () => 0 } },
        };
      }
      return { records: [], summary: { counters: { upserts: () => 0 } } };
    };
    await ensureDatabase(driver, "benchmarks");
    const queries = session.runCalls.map((c: any) => c.query);
    expect(queries.some((q: string) => q.includes("CREATE DATABASE `benchmarks`"))).toBe(true);
  });

  it("6. Enterprise + 库已存在 → 不 CREATE", async () => {
    const driver = mockDriver() as any;
    const session = driver.session();
    session.run = async (query: string) => {
      session.runCalls.push({ query, params: {} });
      if (query.startsWith("SHOW DATABASES YIELD name")) {
        return {
          records: [{ get: (k: string) => (k === "name" ? "benchmarks" : null) }],
          summary: { counters: { upserts: () => 0 } },
        };
      }
      return { records: [], summary: { counters: { upserts: () => 0 } } };
    };
    await ensureDatabase(driver, "benchmarks");
    const queries = session.runCalls.map((c: any) => c.query);
    expect(queries.some((q: string) => q.includes("CREATE DATABASE"))).toBe(false);
  });

  it("7. Community → no-op（不查询、不建库）", async () => {
    setCachedEdition("Community");
    const driver = mockDriver() as any;
    const session = driver.session();
    session.run = async () => {
      throw new Error("Community 下不应发起任何查询");
    };
    await ensureDatabase(driver, "benchmarks");
    expect(session.runCalls.length).toBe(0);
  });

  it("8. 空库名 → no-op", async () => {
    const driver = mockDriver() as any;
    const session = driver.session();
    session.run = async () => {
      throw new Error("空库名下不应发起任何查询");
    };
    await ensureDatabase(driver, "");
    expect(session.runCalls.length).toBe(0);
  });

  it("9. CREATE 后 30s 未 online → 抛错（不静默）", async () => {
    vi.useFakeTimers();
    const driver = mockDriver() as any;
    const session = driver.session();
    session.run = async (query: string) => {
      session.runCalls.push({ query, params: {} });
      if (query.startsWith("SHOW DATABASES YIELD name")) {
        return { records: [], summary: { counters: { upserts: () => 0 } } };
      }
      if (query.startsWith("CREATE DATABASE")) {
        return { records: [], summary: { counters: { upserts: () => 0 } } };
      }
      if (query.includes("currentStatus")) {
        return {
          records: [{ get: (k: string) => (k === "currentStatus" ? "initializing" : null) }],
          summary: { counters: { upserts: () => 0 } },
        };
      }
      return { records: [], summary: { counters: { upserts: () => 0 } } };
    };
    const p = ensureDatabase(driver, "benchmarks");
    const assertion = p.then(
      () => {
        throw new Error("应当抛错而非成功");
      },
      (e: Error) => e,
    );
    // 推进 30 次 1s 等待
    for (let i = 0; i < 31; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    const err = await assertion;
    expect(String(err.message)).toContain("not online");
  });
});

// ── withDatabase 空库名防御（口③ 附带）────────────────────

describe("withDatabase 空库名防御", () => {
  const originalActive = getActiveDatabase();

  afterEach(() => setCachedEdition(null));

  it("10. Enterprise + 空库名 → 不切换激活库", async () => {
    setCachedEdition("Enterprise");
    let insideDb = "";
    await withDatabase("", async () => {
      insideDb = getActiveDatabase();
    });
    expect(insideDb).toBe(originalActive);
    expect(getActiveDatabase()).toBe(originalActive);
  });
});
