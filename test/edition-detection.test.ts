/**
 * graph-memory-pro — Neo4j 企业版识别与条件启用（v2.4.1）
 *
 * 覆盖：
 *   - getNeo4jEdition: 从 dbms.components() 解析 Enterprise/Community/未知
 *   - supportsMultipleDatabases / cachedEditionSupportsMultiDb: 多库能力判定
 *   - withDatabase: Community/未知 edition 下不切库（逻辑隔离兜底）；Enterprise 下正常切库
 *   - ensureSchema: Enterprise 启用精细 HNSW/量化参数；Community 用基础参数
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockDriver } from "./helpers/neo4j-mock.ts";
import {
  getNeo4jEdition,
  supportsMultipleDatabases,
  setCachedEdition,
  getCachedEdition,
  cachedEditionSupportsMultiDb,
  withDatabase,
  getActiveDatabase,
} from "../src/store/db.ts";
import { ensureSchema } from "../src/store/schema.ts";

// ── dbms.components() 返回不同 edition 的驱动 ──────────────

function driverWithEdition(edition: string | null) {
  const driver = mockDriver() as any;
  const session = driver.session();
  session.run = async (query: string) => {
    if (query.includes("dbms.components()")) {
      return {
        records: edition == null
          ? []
          : [{ get: (k: string) => (k === "edition" ? edition : null) }],
        summary: { counters: { upserts: () => 0 } },
      };
    }
    return { records: [], summary: { counters: { upserts: () => 0 } } };
  };
  return driver;
}

describe("getNeo4jEdition 版本代号检测", () => {
  it("1. Enterprise 返回 'Enterprise'", async () => {
    const driver = driverWithEdition("enterprise");
    expect(await getNeo4jEdition(driver)).toBe("Enterprise");
  });

  it("2. Community 返回 'Community'", async () => {
    const driver = driverWithEdition("community");
    expect(await getNeo4jEdition(driver)).toBe("Community");
  });

  it("3. 无记录（未知）返回 null", async () => {
    const driver = driverWithEdition(null);
    expect(await getNeo4jEdition(driver)).toBeNull();
  });

  it("4. 查询抛错时返回 null（不抛出）", async () => {
    const driver = mockDriver() as any;
    driver.session().run = async () => { throw new Error("dbms.components unavailable"); };
    await expect(getNeo4jEdition(driver)).resolves.toBeNull();
  });
});

describe("supportsMultipleDatabases / cachedEditionSupportsMultiDb", () => {
  it("5. 仅 Enterprise 支持多库", () => {
    expect(supportsMultipleDatabases("Enterprise")).toBe(true);
    expect(supportsMultipleDatabases("Community")).toBe(false);
    expect(supportsMultipleDatabases(null)).toBe(false);
  });

  it("6. 缓存 edition 控制 cachedEditionSupportsMultiDb", () => {
    setCachedEdition("Enterprise");
    expect(cachedEditionSupportsMultiDb()).toBe(true);
    setCachedEdition("Community");
    expect(cachedEditionSupportsMultiDb()).toBe(false);
  });
});

describe("withDatabase 企业版条件切库", () => {
  const originalActive = getActiveDatabase();

  afterEach(() => {
    setCachedEdition(null);
  });

  it("7. Enterprise 下切换数据库并恢复", async () => {
    setCachedEdition("Enterprise");
    let insideDb = "";
    await withDatabase("benchmarks", async () => {
      insideDb = getActiveDatabase();
    });
    expect(insideDb).toBe("benchmarks");
    expect(getActiveDatabase()).toBe(originalActive);
  });

  it("8. Community 下不切库（逻辑隔离兜底）", async () => {
    setCachedEdition("Community");
    let insideDb = "";
    await withDatabase("benchmarks", async () => {
      insideDb = getActiveDatabase();
    });
    expect(insideDb).toBe(originalActive);
    expect(getActiveDatabase()).toBe(originalActive);
  });

  it("9. 未知 edition 下不切库（保守处理）", async () => {
    setCachedEdition(null);
    let insideDb = "";
    await withDatabase("benchmarks", async () => {
      insideDb = getActiveDatabase();
    });
    expect(insideDb).toBe(originalActive);
  });
});

describe("ensureSchema 向量索引企业版条件参数", () => {
  afterEach(() => {
    setCachedEdition(null);
  });

  it("10. Enterprise 使用精细 HNSW/量化参数", async () => {
    setCachedEdition("Enterprise");
    const driver = mockDriver() as any;
    await ensureSchema(driver, 1024);
    const calls = driver.getAllRunCalls();
    const vectorCall = calls.find((c: any) => c.query.includes("CREATE VECTOR INDEX"));
    expect(vectorCall).toBeTruthy();
    expect(vectorCall.query).toContain("vector.quantization.type");
    expect(vectorCall.query).toContain("ef_construction");
    expect(vectorCall.query).toContain("ef_search");
  });

  it("11. Community 使用基础参数（不含精细化选项）", async () => {
    setCachedEdition("Community");
    const driver = mockDriver() as any;
    await ensureSchema(driver, 1024);
    const calls = driver.getAllRunCalls();
    const vectorCall = calls.find((c: any) => c.query.includes("CREATE VECTOR INDEX"));
    expect(vectorCall).toBeTruthy();
    expect(vectorCall.query).not.toContain("vector.quantization.type");
    expect(vectorCall.query).not.toContain("ef_construction");
  });

  it("12. 未知 edition 使用基础参数（保守）", async () => {
    setCachedEdition(null);
    const driver = mockDriver() as any;
    await ensureSchema(driver, 1024);
    const calls = driver.getAllRunCalls();
    const vectorCall = calls.find((c: any) => c.query.includes("CREATE VECTOR INDEX"));
    expect(vectorCall).toBeTruthy();
    expect(vectorCall.query).not.toContain("vector.quantization.type");
  });
});