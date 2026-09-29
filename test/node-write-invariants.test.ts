/**
 * v2.8.x — 节点写入路径的「权威归属」不变式回归测试
 *
 * 背景（本轮审计发现的高危缺陷）：`upsertNode` / `batchUpsertNodes` 此前对**所有**字段
 * 无条件 `SET`，而抽取路径恒定传 `pagerank: 0, validatedCount: 0` 且不传 state/validTo。
 * 于是每次重抽（re-extract）都会：
 *   ① 把已被 dedup/conflict 标记 `superseded` 的节点**复活**成 `current`（旧事实重新可召回）
 *   ② 清空反馈累积的 `validatedCount`、GDS 算出的 `pagerank`、维护算出的 staleness/importance
 *   ③ 把 `createdAt/validFrom/recordedAt` 刷成本次时间，并清掉 `validTo/supersededBy`
 *   ④ 批量路径更新 `embeddingHash` 却不失效 `embedding` → 「内容已是 B、向量还是 A」且永不重算
 *
 * 本测试锁定修复后的三层不变式：
 *   I1 创建/来源字段（createdAt/validFrom/recordedAt/source）只写一次
 *   I2 内容字段（name/description/content/type/status）由抽取方全权更新
 *   I3 派生/状态字段（pagerank/validatedCount/stalenessScore/importanceScore/state）
 *      与超替字段（validTo/supersededBy）**不得被抽取路径改写**，只在缺失时补初值
 *   I4 communityId 归属 `updateCommunities` 独占 —— 重抽不得改变社区归属
 *   I5 内容真变化时失效旧向量，使重嵌入路径能重算
 */
import { describe, it, expect } from "vitest";
import type { Driver } from "neo4j-driver";
import { mockDriver } from "./helpers/neo4j-mock.ts";
import { upsertNode, batchUpsertNodes } from "../src/store/nodes.ts";
import { computeEmbeddingHash } from "../src/store/schema.ts";
import type { GmNode } from "../src/types.ts";

const NOW = 1_700_000_000_000;

function makeNode(over: Partial<GmNode> = {}): GmNode {
  return {
    id: "n1",
    type: "TASK",
    name: "测试节点",
    description: "d",
    content: "c",
    status: "active",
    pagerank: 0,
    validatedCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as GmNode;
}

/** 把写入语句按「ON CREATE 段 / 更新 SET 段」切开，便于断言字段归属 */
function splitQuery(query: string) {
  const onCreateIdx = query.indexOf("ON CREATE SET");
  const updateIdx = query.indexOf("SET n.name");
  return {
    hasOnCreate: onCreateIdx >= 0,
    onCreate: onCreateIdx >= 0 && updateIdx > onCreateIdx ? query.slice(onCreateIdx, updateIdx) : "",
    update: updateIdx >= 0 ? query.slice(updateIdx) : "",
  };
}

describe("节点写入不变式（v2.8.x 权威归属分层）", () => {
  describe("I1/I3 upsertNode：创建字段写一次、派生字段缺失才填", () => {
    it("createdAt 只出现在 ON CREATE 段（重抽不得覆盖真实创建时间）", async () => {
      const driver = mockDriver();
      await upsertNode(driver as unknown as Driver, makeNode());
      const call = driver.getAllRunCalls().find((c) => c.query.includes("MERGE (n:"));
      expect(call).toBeDefined();
      const { hasOnCreate, onCreate, update } = splitQuery(call!.query);
      expect(hasOnCreate).toBe(true);
      expect(onCreate).toContain("n.createdAt = $createdAt");
      expect(update).not.toContain("n.createdAt");
    });

    it("state 不能被强制回写成 'current'（防止复活 superseded 节点）", async () => {
      const driver = mockDriver();
      await upsertNode(driver as unknown as Driver, makeNode());
      const call = driver.getAllRunCalls().find((c) => c.query.includes("MERGE (n:"));
      const { update } = splitQuery(call!.query);
      // 必须是「保留既有值」形式，而不是 `n.state = COALESCE($state, 'current')`
      expect(update).toContain("n.state = COALESCE(n.state,");
      expect(update).not.toMatch(/n\.state\s*=\s*COALESCE\(\$state/);
    });

    it("validTo / supersededBy 只出现在 ON CREATE 段（重抽不得清除超替标记）", async () => {
      const driver = mockDriver();
      await upsertNode(driver as unknown as Driver, makeNode({ validTo: undefined, supersededBy: undefined }));
      const call = driver.getAllRunCalls().find((c) => c.query.includes("MERGE (n:"));
      const { hasOnCreate, onCreate, update } = splitQuery(call!.query);
      expect(hasOnCreate).toBe(true);
      expect(onCreate).toContain("n.validTo = $validTo");
      expect(onCreate).toContain("n.supersededBy = $supersededBy");
      expect(update).not.toContain("n.validTo");
      expect(update).not.toContain("n.supersededBy");
    });

    it("派生字段全部改成「缺失才填」（否则抽取传 0 会清空评分与反馈计数）", async () => {
      const driver = mockDriver();
      await upsertNode(driver as unknown as Driver, makeNode());
      const call = driver.getAllRunCalls().find((c) => c.query.includes("MERGE (n:"));
      const { update } = splitQuery(call!.query);
      for (const f of ["n.pagerank", "n.validatedCount", "n.stalenessScore", "n.importanceScore"]) {
        expect(update).toContain(`${f} = COALESCE(${f},`);
      }
    });

    it("内容字段仍然全权更新（抽取方是内容权威）", async () => {
      const driver = mockDriver();
      await upsertNode(driver as unknown as Driver, makeNode());
      const call = driver.getAllRunCalls().find((c) => c.query.includes("MERGE (n:"));
      const { update } = splitQuery(call!.query);
      for (const f of ["n.name", "n.description", "n.content", "n.type", "n.status"]) {
        expect(update).toContain(`${f} = $`);
      }
    });
  });

  describe("I4 communityId 归属独占", () => {
    it("upsertNode 的写入语句完全不出现 communityId（重抽保留既有社区归属）", async () => {
      const driver = mockDriver();
      await upsertNode(driver as unknown as Driver, makeNode());
      const call = driver.getAllRunCalls().find((c) => c.query.includes("MERGE (n:"));
      expect(call!.query).not.toContain("communityId");
    });

    it("batchUpsertNodes 的写入语句完全不出现 communityId", async () => {
      const driver = mockDriver();
      await batchUpsertNodes(driver as unknown as Driver, [makeNode()]);
      const call = driver.getAllRunCalls().find((c) => c.query.includes("UNWIND $rows"));
      expect(call).toBeDefined();
      expect(call!.query).not.toContain("communityId");
    });
  });

  describe("I1/I3/I5 batchUpsertNodes：抽取主路径", () => {
    it("createdAt 只在 ON CREATE 段；派生字段与状态字段均不可被清空", async () => {
      const driver = mockDriver();
      await batchUpsertNodes(driver as unknown as Driver, [makeNode()]);
      const call = driver.getAllRunCalls().find((c) => c.query.includes("UNWIND $rows"));
      const { hasOnCreate, onCreate, update } = splitQuery(call!.query);
      expect(hasOnCreate).toBe(true);
      expect(onCreate).toContain("n.createdAt = row.createdAt");
      expect(update).not.toContain("n.createdAt");
      expect(update).toContain("n.state = COALESCE(n.state,");
      for (const f of ["n.pagerank", "n.validatedCount", "n.stalenessScore", "n.importanceScore"]) {
        expect(update).toContain(`${f} = COALESCE(${f}, row.`);
      }
    });

    it("I5 内容变化时清空 embedding 与 embeddingHash，使重嵌入路径能重算", async () => {
      const driver = mockDriver();
      await batchUpsertNodes(driver as unknown as Driver, [makeNode()]);
      const call = driver.getAllRunCalls().find((c) => c.query.includes("UNWIND $rows"));
      expect(call!.query).toContain("n.embedding = CASE WHEN row.contentChanged THEN null");
      expect(call!.query).toContain("n.embeddingHash = CASE WHEN row.contentChanged THEN null");
    });

    it("内容未变 → contentChanged=false，不推进 updatedAt", async () => {
      const driver = mockDriver();
      const node = makeNode();
      const sameHash = computeEmbeddingHash(node.name, node.description, node.content);
      // 第一次 run = 旧 hash 对比查询
      driver.queueResult([{ id: node.id, hash: sameHash }]);
      await batchUpsertNodes(driver as unknown as Driver, [node]);
      const call = driver.getAllRunCalls().find((c) => c.query.includes("UNWIND $rows"));
      expect(call!.params.rows[0].contentChanged).toBe(false);
      // updatedAt 用条件式推进，而非无条件写入
      expect(call!.query).toContain("n.updatedAt = CASE WHEN row.contentChanged THEN row.updatedAt");
    });

    it("内容已变 → contentChanged=true（触发向量失效）", async () => {
      const driver = mockDriver();
      const node = makeNode({ content: "新内容" });
      driver.queueResult([{ id: node.id, hash: "stale-hash-from-old-content" }]);
      await batchUpsertNodes(driver as unknown as Driver, [node]);
      const call = driver.getAllRunCalls().find((c) => c.query.includes("UNWIND $rows"));
      expect(call!.params.rows[0].contentChanged).toBe(true);
    });

    it("旧 hash 查询失败 → contentChanged 保持 false（保守：不清向量）并留痕", async () => {
      const driver = mockDriver();
      driver.queueResult([]); // 无旧记录 → 视为新节点
      await batchUpsertNodes(driver as unknown as Driver, [makeNode()]);
      const call = driver.getAllRunCalls().find((c) => c.query.includes("UNWIND $rows"));
      // 无旧记录 = 新节点 → contentChanged 视为 true（无旧向量可清，updatedAt 用新值）
      expect(call!.params.rows[0].contentChanged).toBe(true);
    });
  });
});