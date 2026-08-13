/**
 * 从 Neo4j 已存储会话消息（:GmMessage）重建三级节点 — 单元测试
 *
 * 被测模块：/workspace/src/services/extract-service.ts
 *   - rebuildGraphFromStoredMessages(extractor, driver, llm, cfg, logger, sessionKey, limit, lastProcessedTurn)
 *
 * 场景：会话记录已通过 saveMessage 写入 Neo4j，用户需要按已有记录重建 TASK/SKILL/EVENT 三级节点。
 *
 * 关键点：
 *   - getSessionMessages 使用 session.run 读取 :GmMessage 节点
 *   - extractInBackground 复用同一 mock 会话，将提取结果批量写入 :Task|:Skill|:Event
 *   - LLM 通过 CompleteFn 注入，无需真实 API
 */

import { describe, it, expect, vi } from "vitest";
import type { CompleteFn } from "../src/engine/llm.ts";
import { Extractor } from "../src/extractor/extract.ts";
import { rebuildGraphFromStoredMessages } from "../src/services/extract-service.ts";
import { mockDriver, MockInteger } from "./helpers/neo4j-mock.ts";

function makeMockLlm(reply: string): CompleteFn {
  return vi.fn(async () => reply) as unknown as CompleteFn;
}

/** 构造一条 :GmMessage 记录（properties 结构，供 getSessionMessages 解析） */
function msg(id: string, turnIndex: number, role: string, content: string): { m: unknown } {
  return {
    m: {
      properties: {
        id,
        sessionKey: "s1",
        turnIndex: new MockInteger(turnIndex),
        role,
        content,
        createdAt: new MockInteger(1000 + turnIndex),
      },
    },
  };
}

const SAMPLE_NODES = [
  { type: "TASK", name: "build-api", description: "构建 API", content: "实现 REST API" },
  { type: "SKILL", name: "openapi-spec", description: "OpenAPI 规范", content: "使用 OpenAPI 3.1" },
];
const SAMPLE_EDGES = [
  { type: "USED_SKILL", fromName: "build-api", toName: "openapi-spec", instruction: "task uses skill" },
];

describe("rebuildGraphFromStoredMessages", () => {
  it("读取已存储会话消息并配对 user/assistant → 返回配对数并写入节点", async () => {
    const driver = mockDriver();
    // getSessionMessages 的查询为 ORDER BY createdAt DESC，故 mock 按新→旧返回，
    // 函数内部 .reverse() 后恢复为旧→新，再配对 2 对 user/assistant
    driver.queueResult([
      { m: { properties: { id: "m4", sessionKey: "s1", turnIndex: new MockInteger(4), role: "assistant", content: "执行部署", createdAt: new MockInteger(1004) } } },
      { m: { properties: { id: "m3", sessionKey: "s1", turnIndex: new MockInteger(3), role: "user", content: "部署", createdAt: new MockInteger(1003) } } },
      { m: { properties: { id: "m2", sessionKey: "s1", turnIndex: new MockInteger(2), role: "assistant", content: "用 OpenAPI", createdAt: new MockInteger(1002) } } },
      { m: { properties: { id: "m1", sessionKey: "s1", turnIndex: new MockInteger(1), role: "user", content: "构建 API", createdAt: new MockInteger(1001) } } },
    ]);

    const llm = makeMockLlm(JSON.stringify({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES }));
    const extractor = new Extractor(driver as any);

    const processed = await rebuildGraphFromStoredMessages(
      extractor,
      driver as any,
      llm,
      null,
      console,
      "s1",
      50,
      0,
    );

    expect(processed).toBe(2);
    // 应触发节点批量写入（session.run 被调用：getSessionMessages + batchUpsert…）
    const calls = driver.getAllRunCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].query).toContain("GmMessage");
  });

  it("没有匹配的 user/assistant 对 → 返回 0 且不调用 LLM", async () => {
    const driver = mockDriver();
    // 只有单独一条 assistant 消息，无 user 配对
    driver.queueResult([
      { m: { properties: { id: "m1", sessionKey: "s1", turnIndex: new MockInteger(1), role: "assistant", content: "只有助手消息", createdAt: new MockInteger(1001) } } },
    ]);

    const llm = makeMockLlm(JSON.stringify({ nodes: [], edges: [] }));
    const extractor = new Extractor(driver as any);

    const processed = await rebuildGraphFromStoredMessages(
      extractor,
      driver as any,
      llm,
      null,
      console,
      "s1",
      50,
      0,
    );

    expect(processed).toBe(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("lastProcessedTurn 过滤已处理轮次 → 只重建之后的轮次", async () => {
    const driver = mockDriver();
    // 4 条消息 DESC 顺序，lastProcessedTurn=2 → reverse 后为 [1,2,3,4]，只配对 3/4
    driver.queueResult([
      { m: { properties: { id: "m4", sessionKey: "s1", turnIndex: new MockInteger(4), role: "assistant", content: "新回", createdAt: new MockInteger(1004) } } },
      { m: { properties: { id: "m3", sessionKey: "s1", turnIndex: new MockInteger(3), role: "user", content: "新", createdAt: new MockInteger(1003) } } },
      { m: { properties: { id: "m2", sessionKey: "s1", turnIndex: new MockInteger(2), role: "assistant", content: "旧回", createdAt: new MockInteger(1002) } } },
      { m: { properties: { id: "m1", sessionKey: "s1", turnIndex: new MockInteger(1), role: "user", content: "旧", createdAt: new MockInteger(1001) } } },
    ]);

    const llm = makeMockLlm(JSON.stringify({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES }));
    const extractor = new Extractor(driver as any);

    const processed = await rebuildGraphFromStoredMessages(
      extractor,
      driver as any,
      llm,
      null,
      console,
      "s1",
      50,
      2,
    );

    expect(processed).toBe(1);
  });

  it("无消息记录或缺少 extractor/driver/llm → 直接返回 0", async () => {
    const driver = mockDriver();
    driver.queueResult([]); // 无消息

    const llm = makeMockLlm(JSON.stringify({ nodes: [], edges: [] }));
    const extractor = new Extractor(driver as any);

    const processed = await rebuildGraphFromStoredMessages(
      extractor,
      driver as any,
      llm,
      null,
      console,
      "nonexistent",
      50,
      0,
    );
    expect(processed).toBe(0);

    // 缺 llm
    const processedNoLlm = await rebuildGraphFromStoredMessages(
      extractor,
      driver as any,
      null,
      null,
      console,
      "s1",
      50,
      0,
    );
    expect(processedNoLlm).toBe(0);
  });
});