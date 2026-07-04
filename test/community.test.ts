/**
 * graph-memory-pro v2.1.2 — 第四批 S-4 层次化社区检测单元测试
 *
 * 被测模块：/workspace/src/graph/community.ts
 * 测试基础设施：/workspace/test/helpers/neo4j-mock.ts
 *
 * 覆盖：
 *   - detectCommunities：正常调用 + Cypher 断言（CALL gds.labelPropagation）
 *   - detectHierarchicalCommunities：depth=1/3、层次调用链、hierarchy 字段完整性
 *   - clusterRepresentatives（间接）：Union-Find 贪心合并 + sqrt 目标簇数
 *   - drillDownCommunity：level=1 / level=2 钻取
 */

import { describe, it, expect } from "vitest";
import {
  detectCommunities,
  detectHierarchicalCommunities,
  drillDownCommunity,
} from "../src/graph/community.ts";
import { mockDriver, type MockDriver } from "./helpers/neo4j-mock.ts";

// ── 辅助：给 mock session 补上 beginTransaction ──────────────────────
//
// updateCommunities（被 detectCommunities 调用）使用 session.beginTransaction()
// 开启事务，而 neo4j-mock.ts 的 MockSession 未提供该方法。
// 由于 mockDriver.session() 返回单例 session，只需增强一次即可覆盖所有后续
// getSession(driver) 调用。tx.run 仅记录 Cypher 调用，不消耗 resultQueue。

function augmentTx(driver: MockDriver): void {
  const session = driver.session() as any;
  if (!session.beginTransaction) {
    session.beginTransaction = () => ({
      run: async (query: string, params: Record<string, any> = {}) => {
        session.runCalls.push({ query, params });
        return { records: [], summary: { counters: { upserts: () => 0 } } };
      },
      commit: async () => {},
      rollback: async () => {},
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// detectCommunities
// ═══════════════════════════════════════════════════════════════

describe("detectCommunities", () => {
  it("正常调用：返回 labels/communities/count", async () => {
    const driver = mockDriver();
    augmentTx(driver);
    driver.queueResults([
      // 1. count query → 3 active nodes
      [{ c: 3 }],
      // 2. getExistingRelTypes → MENTIONS, USED_SKILL
      [{ t: "MENTIONS" }, { t: "USED_SKILL" }],
      // 3. gds.graph.project
      [],
      // 4. labelPropagation.stream → n1/n2 同社区, n3 单独
      [
        { id: "n1", rawCommunityId: "10" },
        { id: "n2", rawCommunityId: "10" },
        { id: "n3", rawCommunityId: "20" },
      ],
      // 5. gds.graph.drop (try)
      [],
    ]);

    const result = await detectCommunities(driver as any);

    // 按社区规模降序重命名：10(size2)→c-1, 20(size1)→c-2
    expect(result.count).toBe(2);
    expect(result.labels.size).toBe(3);
    expect(result.labels.get("n1")).toBe("c-1");
    expect(result.labels.get("n2")).toBe("c-1");
    expect(result.labels.get("n3")).toBe("c-2");
    expect(result.communities.size).toBe(2);
    expect(result.communities.get("c-1")).toEqual(["n1", "n2"]);
    expect(result.communities.get("c-2")).toEqual(["n3"]);
  });

  it("Cypher 含 CALL gds.labelPropagation", async () => {
    const driver = mockDriver();
    augmentTx(driver);
    driver.queueResults([
      [{ c: 1 }],
      [{ t: "MENTIONS" }],
      [],
      [{ id: "n1", rawCommunityId: "10" }],
      [],
    ]);

    await detectCommunities(driver as any);

    const calls = driver.getAllRunCalls();
    const lpCall = calls.find(c => c.query.includes("gds.labelPropagation"));
    expect(lpCall).toBeDefined();
    expect(lpCall!.query).toContain("CALL gds.labelPropagation");
  });
});

// ═══════════════════════════════════════════════════════════════
// detectHierarchicalCommunities
// ═══════════════════════════════════════════════════════════════

describe("detectHierarchicalCommunities", () => {
  it("depth=3：返回 hierarchy map + level1Count/level2Count/level3Count", async () => {
    const driver = mockDriver();
    augmentTx(driver);
    driver.queueResults([
      // ── Level 1: detectCommunities (5 calls) ──
      [{ c: 4 }],                              // count
      [{ t: "MENTIONS" }],                     // rel types
      [],                                       // graph.project
      [                                         // labelPropagation.stream: 4 nodes → 4 社区
        { id: "n1", rawCommunityId: "10" },
        { id: "n2", rawCommunityId: "20" },
        { id: "n3", rawCommunityId: "30" },
        { id: "n4", rawCommunityId: "40" },
      ],
      [],                                       // gds.graph.drop
      // ── Level 2: clusterRepresentatives edge query ──
      [                                         // 跨社区边（按权重降序）
        { fromId: "n1", toId: "n2", weight: 10 },
        { fromId: "n3", toId: "n4", weight: 5 },
        { fromId: "n1", toId: "n3", weight: 1 },
      ],
      // ── updateHierarchicalFields(topicId): 2 groups (h-1, h-2) ──
      [],
      [],
      // ── Level 3: clusterRepresentatives edge query ──
      [],                                       // 社区 id 非真实节点 → 无边
      // ── updateHierarchicalFields(domainId): 2 groups ──
      [],
      [],
    ]);

    const result = await detectHierarchicalCommunities(driver as any, 3);

    // Level 1: 4 原始社区
    expect(result.level1Count).toBe(4);
    // Level 2: targetCount=floor(sqrt(4))=2 → 合并后 2 个主题
    expect(result.level2Count).toBe(2);
    // Level 3: 无跨主题边 → 2 个领域（各成一簇）
    expect(result.level3Count).toBe(2);
    // hierarchy map 覆盖全部 4 个节点
    expect(result.hierarchy.size).toBe(4);
  });

  it("depth=1：退化为单层（仅 level1）", async () => {
    const driver = mockDriver();
    augmentTx(driver);
    driver.queueResults([
      [{ c: 3 }],
      [{ t: "MENTIONS" }],
      [],
      [
        { id: "n1", rawCommunityId: "10" },
        { id: "n2", rawCommunityId: "10" },
        { id: "n3", rawCommunityId: "20" },
      ],
      [],
    ]);

    const result = await detectHierarchicalCommunities(driver as any, 1);

    expect(result.level1Count).toBe(2);
    expect(result.level2Count).toBe(0);
    expect(result.level3Count).toBe(0);
    expect(result.hierarchy.size).toBe(3);
    for (const [, h] of result.hierarchy) {
      expect(h.level1).toBeDefined();
      expect(h.level2).toBeUndefined();
      expect(h.level3).toBeUndefined();
    }
  });

  it("Level 1 调用 detectCommunities，Level 2/3 调用 clusterRepresentatives", async () => {
    const driver = mockDriver();
    augmentTx(driver);
    driver.queueResults([
      [{ c: 4 }],
      [{ t: "MENTIONS" }],
      [],
      [
        { id: "n1", rawCommunityId: "10" },
        { id: "n2", rawCommunityId: "20" },
        { id: "n3", rawCommunityId: "30" },
        { id: "n4", rawCommunityId: "40" },
      ],
      [],
      [{ fromId: "n1", toId: "n2", weight: 10 },
       { fromId: "n3", toId: "n4", weight: 5 }],
      [], [],
      [],
      [], [],
    ]);

    const result = await detectHierarchicalCommunities(driver as any, 3);

    const calls = driver.getAllRunCalls();

    // Level 1: 恰好 1 次 gds.labelPropagation（detectCommunities）
    const lpCalls = calls.filter(c => c.query.includes("gds.labelPropagation"));
    expect(lpCalls.length).toBe(1);

    // Level 2 + Level 3: 各 1 次跨社区边查询（clusterRepresentatives）
    const edgeCalls = calls.filter(
      c => c.query.includes("fromId") && c.query.includes("toId"),
    );
    expect(edgeCalls.length).toBe(2);

    // Level 2 查询参数 members = 真实节点 id
    expect(edgeCalls[0].params.members).toEqual(
      expect.arrayContaining(["n1", "n2", "n3", "n4"]),
    );
    // Level 3 查询参数 members = 下层社区 id
    expect(edgeCalls[1].params.members).toEqual(
      expect.arrayContaining(["c-1", "c-2", "c-3", "c-4"]),
    );
  });

  it("hierarchy map 中每个节点有 level1/level2/level3 字段", async () => {
    const driver = mockDriver();
    augmentTx(driver);
    driver.queueResults([
      [{ c: 4 }],
      [{ t: "MENTIONS" }],
      [],
      [
        { id: "n1", rawCommunityId: "10" },
        { id: "n2", rawCommunityId: "20" },
        { id: "n3", rawCommunityId: "30" },
        { id: "n4", rawCommunityId: "40" },
      ],
      [],
      [{ fromId: "n1", toId: "n2", weight: 10 },
       { fromId: "n3", toId: "n4", weight: 5 }],
      [], [],
      [],
      [], [],
    ]);

    const result = await detectHierarchicalCommunities(driver as any, 3);

    for (const [nodeId, h] of result.hierarchy) {
      expect(h.level1, `${nodeId} level1 应存在`).toBeDefined();
      expect(typeof h.level1).toBe("string");
      expect(h.level2, `${nodeId} level2 应存在`).toBeDefined();
      expect(typeof h.level2).toBe("string");
      expect(h.level3, `${nodeId} level3 应存在`).toBeDefined();
      expect(typeof h.level3).toBe("string");
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// clusterRepresentatives（通过 detectHierarchicalCommunities 间接测试）
// ═══════════════════════════════════════════════════════════════

describe("clusterRepresentatives（间接测试）", () => {
  it("Union-Find 贪心合并：按跨社区边共现权重降序合并", async () => {
    const driver = mockDriver();
    augmentTx(driver);
    driver.queueResults([
      [{ c: 4 }],
      [{ t: "MENTIONS" }],
      [],
      [
        { id: "n1", rawCommunityId: "10" },
        { id: "n2", rawCommunityId: "20" },
        { id: "n3", rawCommunityId: "30" },
        { id: "n4", rawCommunityId: "40" },
      ],
      [],
      // 跨社区边：n1↔n2 (w=10), n3↔n4 (w=5), n1↔n3 (w=1)
      [{ fromId: "n1", toId: "n2", weight: 10 },
       { fromId: "n3", toId: "n4", weight: 5 },
       { fromId: "n1", toId: "n3", weight: 1 }],
      [], [],
      [],
      [], [],
    ]);

    const result = await detectHierarchicalCommunities(driver as any, 3);

    // n1 & n2 被合并（权重 10，最高）
    expect(result.hierarchy.get("n1")!.level2).toBe(
      result.hierarchy.get("n2")!.level2,
    );
    // n3 & n4 被合并（权重 5，次高）
    expect(result.hierarchy.get("n3")!.level2).toBe(
      result.hierarchy.get("n4")!.level2,
    );
    // n1 & n3 未合并（权重 1 最低，达到目标簇数后停止）
    expect(result.hierarchy.get("n1")!.level2).not.toBe(
      result.hierarchy.get("n3")!.level2,
    );
  });

  it("目标簇数 = sqrt(下层社区数)", async () => {
    const driver = mockDriver();
    augmentTx(driver);
    driver.queueResults([
      [{ c: 4 }],
      [{ t: "MENTIONS" }],
      [],
      [
        { id: "n1", rawCommunityId: "10" },
        { id: "n2", rawCommunityId: "20" },
        { id: "n3", rawCommunityId: "30" },
        { id: "n4", rawCommunityId: "40" },
      ],
      [],
      [{ fromId: "n1", toId: "n2", weight: 10 },
       { fromId: "n3", toId: "n4", weight: 5 },
       { fromId: "n1", toId: "n3", weight: 1 }],
      [], [],
      [],
      [], [],
    ]);

    const result = await detectHierarchicalCommunities(driver as any, 3);

    // 4 个 level-1 社区 → targetCount = floor(sqrt(4)) = 2
    expect(result.level1Count).toBe(4);
    expect(result.level2Count).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// drillDownCommunity
// ═══════════════════════════════════════════════════════════════

describe("drillDownCommunity", () => {
  it("level=1：返回该社区下所有节点", async () => {
    const driver = mockDriver();
    driver.queueResults([
      [{ id: "n1" }, { id: "n2" }],
    ]);

    const nodes = await drillDownCommunity(driver as any, { communityId: "c-1" });

    expect(nodes).toEqual(["n1", "n2"]);
    const calls = driver.getAllRunCalls();
    expect(calls[0].query).toContain("communityId");
    expect(calls[0].params.communityId).toBe("c-1");
  });

  it("level=2：返回该主题下所有节点", async () => {
    const driver = mockDriver();
    driver.queueResults([
      [{ id: "n1" }, { id: "n2" }, { id: "n3" }],
    ]);

    const nodes = await drillDownCommunity(driver as any, { topicId: "h-1" });

    expect(nodes).toEqual(["n1", "n2", "n3"]);
    const calls = driver.getAllRunCalls();
    expect(calls[0].query).toContain("topicId");
    expect(calls[0].params.topicId).toBe("h-1");
  });
});
