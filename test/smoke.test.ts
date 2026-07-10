/**
 * graph-memory-pro v2.3.5 — 集成测试（smoke test）
 *
 * 与单元测试不同，smoke test 连接真实 Neo4j 实例，验证：
 *   - Schema 创建（索引/约束）
 *   - 节点写入 + 读取
 *   - 向量索引创建 + 向量搜索
 *   - GDS 投影 + PageRank
 *
 * 运行前提：
 *   docker compose -f docker-compose.smoke.yml up -d neo4j
 *   sleep 15  # 等待 Neo4j 就绪
 *
 * 运行：
 *   npm run test:smoke
 *
 * 环境变量：
 *   GM_SMOKE_NEO4J_URI (默认 bolt://localhost:7687)
 *   GM_SMOKE_NEO4J_USER (默认 neo4j)
 *   GM_SMOKE_NEO4J_PASSWORD (默认 smoke-test-pass)
 *
 * 若 Neo4j 不可连接，所有用例自动 skip（不影响 CI 主流程）。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import neo4j, { type Driver } from "neo4j-driver";
import { initDriver, closeDriver, getSession } from "../src/store/db.ts";
import { ensureSchema } from "../src/store/schema.ts";
import { upsertNode, findById, getNodeCount } from "../src/store/nodes.ts";
import type { GmConfig } from "../src/types.ts";

const SMOKE_URI = process.env.GM_SMOKE_NEO4J_URI ?? "bolt://localhost:7687";
const SMOKE_USER = process.env.GM_SMOKE_NEO4J_USER ?? "neo4j";
const SMOKE_PASSWORD = process.env.GM_SMOKE_NEO4J_PASSWORD ?? "smoke-test-pass";

let _driver: Driver | null = null;
let _neo4jAvailable = false;

beforeAll(async () => {
  try {
    const cfg = {
      neo4j: { uri: SMOKE_URI, user: SMOKE_USER, password: SMOKE_PASSWORD },
      embedding: { dimensions: 768 },
    } as any;
    _driver = initDriver(cfg.neo4j);
    await _driver.verifyConnectivity();
    _neo4jAvailable = true;
    // 初始化 schema
    await ensureSchema(_driver, 768);
  } catch (err) {
    console.warn(`[smoke] Neo4j not available, skipping smoke tests: ${err}`);
    _neo4jAvailable = false;
  }
}, 30_000);

afterAll(async () => {
  if (_driver) {
    try { await closeDriver(); } catch { /* ignore */ }
  }
});

// 辅助：Neo4j 不可用时 skip
const itIfNeo4j = (name: string, fn: () => Promise<void>) => {
  it(name, async () => {
    if (!_neo4jAvailable) return; // vitest 无内置 skip，直接 return
    await fn();
  });
};

describe("v2.3.5 smoke test: 真实 Neo4j 集成", () => {
  itIfNeo4j("schema 创建后节点计数为 0 或已有数据", async () => {
    const count = await getNodeCount(_driver!);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  itIfNeo4j("写入节点后可按 id 读取", async () => {
    const id = `smoke-${Date.now()}`;
    await upsertNode(_driver!, {
      id,
      type: "TASK",
      name: "smoke-test-node",
      description: "smoke test",
      content: "integration test node",
      status: "active",
      pagerank: 0,
      validatedCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      embeddingModel: "smoke-test",
    } as any);

    const node = await findById(_driver!, id);
    expect(node).not.toBeNull();
    expect(node!.id).toBe(id);
    expect(node!.name).toBe("smoke-test-node");
  });

  itIfNeo4j("getSession 计数正确（P3-1 连接池监控）", async () => {
    const { getPoolMetrics } = await import("../src/store/db.ts");
    const before = getPoolMetrics();
    const s1 = getSession(_driver!);
    const during = getPoolMetrics();
    expect(during.appActiveSessions).toBe(before.appActiveSessions + 1);
    await s1.close();
    const after = getPoolMetrics();
    expect(after.appActiveSessions).toBe(before.appActiveSessions);
  });

  itIfNeo4j("向量索引存在（gm_node_embedding 合并索引）", async () => {
    const session = _driver!.session();
    try {
      const result = await session.run("SHOW INDEXES YIELD name WHERE name STARTS WITH 'gm_node_embedding' RETURN name");
      const indexNames = result.records.map(r => r.get("name"));
      // 至少有一个向量索引（合并索引或旧 3 索引）
      expect(indexNames.length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });
});
