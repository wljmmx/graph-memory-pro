/**
 * graph-memory-pro v2.1.2 — 软替换 + 可进化嵌入单元测试
 *
 * 覆盖批次：
 *   第一批 S-2 软替换（mergeNodes Phase 6）
 *   第三批 R-4 可进化嵌入（upsertNode）
 *
 * 被测模块：/workspace/src/store/store.ts
 * 测试基础设施：/workspace/test/helpers/neo4j-mock.ts（mockDriver / queueResult / getAllRunCalls）
 *
 * 策略：用 mockDriver 构造 driver，queueResult 预置返回数据，
 *       调用 upsertNode / mergeNodes 后用 getAllRunCalls 断言 Cypher 与参数。
 */

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { upsertNode, mergeNodes } from "../src/store/store.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";
import type { GmNode } from "../src/types.ts";

// ── 辅助 ──────────────────────────────────────────────────────

/** 计算 content hash（与 store.ts 内 newContentHash 计算方式一致：md5(name|description|content)） */
function contentHash(node: Pick<GmNode, "name" | "description" | "content">): string {
  return createHash("md5")
    .update(`${node.name}|${node.description}|${node.content}`)
    .digest("hex");
}

/** 构造 GmNode（默认值 + 部分覆盖） */
function makeNode(overrides: Partial<GmNode> = {}): GmNode {
  return {
    id: "test-node",
    type: "TASK",
    name: "test-name",
    description: "test-desc",
    content: "test-content",
    status: "active",
    pagerank: 0,
    validatedCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// R-4 可进化嵌入 — upsertNode
// ═══════════════════════════════════════════════════════════════

describe("upsertNode R-4 可进化嵌入", () => {
  it("1. 新节点（无旧节点记录）：不触发归档，正常 MERGE", async () => {
    const driver = mockDriver() as any;
    // 新实现：单条 Cypher 用 OPTIONAL MATCH 读旧节点，old 为 null → 跳过归档分支
    driver.queueResult([]);

    const node = makeNode({ id: "new-node-1" });
    await upsertNode(driver, node);

    const calls = driver.getAllRunCalls();
    // 单条 Cypher（OPTIONAL MATCH + CASE WHEN + MERGE）
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("OPTIONAL MATCH");
    expect(calls[0].query).toContain("MERGE");
    // 不应出现单独的归档 SET（n.embedding = null）
    expect(calls[0].query).not.toContain("n.embedding = null");
    // evolvableApplied=false → newContentHash = contentHash(node)
    expect(calls[0].params.newContentHash).toBe(contentHash(node));
  });

  it("2. 旧节点 + content 相同（hash 相同）：不触发归档", async () => {
    const driver = mockDriver() as any;
    const node = makeNode({ id: "node-same", content: "same-content" });
    const sameHash = contentHash(node);
    driver.queueResult([{
      embeddingHash: sameHash,
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: "m1",
      embeddingHistory: [],
    }]);

    await upsertNode(driver, node);

    const calls = driver.getAllRunCalls();
    // 单条 Cypher，无单独归档 SET
    expect(calls).toHaveLength(1);
    expect(calls[0].query).not.toContain("n.embedding = null");
    // hash 相同 → evolvableApplied=false → 写入新 hash（=旧 hash）
    expect(calls[0].params.newContentHash).toBe(sameHash);
  });

  it("3. 旧节点 + content 变化 + 旧 embedding 存在：归档并清空 embedding", async () => {
    const driver = mockDriver() as any;
    const node = makeNode({ id: "node-changed", content: "new-content-v2" });
    driver.queueResult([{
      embeddingHash: "old-different-hash",
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: "old-model",
      embeddingHistory: [],
    }]);

    await upsertNode(driver, node);

    const calls = driver.getAllRunCalls();
    // 新实现：单条 Cypher 同时处理归档和 MERGE（OPTIONAL MATCH + CASE WHEN + MERGE）
    expect(calls).toHaveLength(1);

    // 归档逻辑在服务端 CASE WHEN 中完成，客户端断言 Cypher 结构
    expect(calls[0].query).toContain("OPTIONAL MATCH");
    expect(calls[0].query).toContain("CASE");
    expect(calls[0].query).toContain("MERGE");
    expect(calls[0].query).toContain("newHistory");
    // 新 hash 写入
    expect(calls[0].params.newContentHash).toBe(contentHash(node));
    expect(calls[0].params.id).toBe("node-changed");
    // archivedAt 参数存在（>0）
    expect(calls[0].params.archivedAt).toBeGreaterThan(0);
  });

  it("4. 旧节点 + content 变化 + 无旧 embedding：不触发归档", async () => {
    const driver = mockDriver() as any;
    const node = makeNode({ id: "node-no-emb", content: "changed-content" });
    driver.queueResult([{
      embeddingHash: "old-hash",
      embedding: null,        // 无旧嵌入
      embeddingModel: null,
      embeddingHistory: [],
    }]);

    await upsertNode(driver, node);

    const calls = driver.getAllRunCalls();
    // 单条 Cypher，无单独归档 SET（因 oldEmbedding 为 null 不满足归档条件）
    expect(calls).toHaveLength(1);
    expect(calls[0].query).not.toContain("n.embedding = null");
    // evolvableApplied=false → 写入新 hash
    expect(calls[0].params.newContentHash).toBe(contentHash(node));
  });

  it("5. embeddingHistory 归档保留最近 3 条（archiveKeepCount=3）", async () => {
    const driver = mockDriver() as any;
    const node = makeNode({ id: "node-trim", content: "fresh-content" });
    driver.queueResult([{
      embeddingHash: "old-hash",
      embedding: [0.9, 0.8],
      embeddingModel: "old-model",
      // 已有 3 条历史（最旧 → 最新）
      embeddingHistory: [
        { embedding: [1, 2], embeddingModel: "m1", embeddingHash: "h1", archivedAt: 1000 },
        { embedding: [3, 4], embeddingModel: "m2", embeddingHash: "h2", archivedAt: 2000 },
        { embedding: [5, 6], embeddingModel: "m3", embeddingHash: "h3", archivedAt: 3000 },
      ],
    }]);

    await upsertNode(driver, node);

    const calls = driver.getAllRunCalls();
    // 单条 Cypher，归档在服务端 CASE WHEN 中完成
    expect(calls).toHaveLength(1);
    // 服务端 trim 到 3 条：Cypher 含 [..3] 切片
    expect(calls[0].query).toContain("newHistory");
    expect(calls[0].query).toContain("[..3]");
    // archivedAt 参数存在
    expect(calls[0].params.archivedAt).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// S-2 软替换 — mergeNodes Phase 6
// ═══════════════════════════════════════════════════════════════

describe("mergeNodes Phase 6 软替换 (S-2)", () => {
  /** 找到 Phase 6 软替换 Cypher（含 "merge.state = 'superseded'"） */
  const findPhase6 = (calls: any[]) =>
    calls.find((c) => c.query.includes("merge.state = 'superseded'"));

  it("1. Cypher 含 SET merge.state = 'superseded'", async () => {
    const driver = mockDriver() as any;
    // Phase 1 / Phase 3 均返回空，跳过 Phase 2 / Phase 4 循环
    driver.queueResult([]);
    driver.queueResult([]);

    await mergeNodes(driver, "keep-1", "merge-1");

    const calls = driver.getAllRunCalls();
    const phase6 = findPhase6(calls);
    expect(phase6).toBeDefined();
    expect(phase6.query).toContain("SET merge.state = 'superseded'");
  });

  it("2. Cypher 含 SET merge.validTo = timestamp()", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([]);
    driver.queueResult([]);

    await mergeNodes(driver, "keep-1", "merge-1");

    const calls = driver.getAllRunCalls();
    const phase6 = findPhase6(calls);
    expect(phase6).toBeDefined();
    expect(phase6.query).toContain("merge.validTo = timestamp()");
  });

  it("3. Cypher 含 SET merge.supersededBy = $keepId", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([]);
    driver.queueResult([]);

    await mergeNodes(driver, "keep-1", "merge-1");

    const calls = driver.getAllRunCalls();
    const phase6 = findPhase6(calls);
    expect(phase6).toBeDefined();
    expect(phase6.query).toContain("merge.supersededBy = $keepId");
    // 参数正确传入
    expect(phase6.params.keepId).toBe("keep-1");
    expect(phase6.params.mergeId).toBe("merge-1");
  });

  it("4. Cypher 含 SET r.weight = 0.1（边降权）", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([]);
    driver.queueResult([]);

    await mergeNodes(driver, "keep-1", "merge-1");

    const calls = driver.getAllRunCalls();
    const phase6 = findPhase6(calls);
    expect(phase6).toBeDefined();
    expect(phase6.query).toContain("SET r.weight = 0.1");
  });

  it("5. 不含 DETACH DELETE（非物理删除）", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([]);
    driver.queueResult([]);

    await mergeNodes(driver, "keep-1", "merge-1");

    const calls = driver.getAllRunCalls();
    // 整个 mergeNodes 调用链中不应出现物理删除语句
    const allQueries = calls.map((c) => c.query).join("\n");
    expect(allQueries).not.toContain("DETACH DELETE");
    // Phase 6 单独验证
    const phase6 = findPhase6(calls);
    expect(phase6).toBeDefined();
    expect(phase6.query).not.toContain("DETACH DELETE");
    expect(phase6.query).not.toContain("DELETE merge");
  });
});
