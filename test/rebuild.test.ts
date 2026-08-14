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
import { rebuildGraphFromStoredMessages, rebuildSessionMessages } from "../src/services/extract-service.ts";
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

// ============================================================
// rebuildSessionMessages（高性能批量重建）
// ============================================================

/** 构造 getSessionMessagesPage 返回的消息记录（升序，供配对） */
function pageMsg(id: string, turnIndex: number, role: string, content: string): { m: unknown } {
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

describe("rebuildSessionMessages", () => {
  it("读取全部消息并并发配对 → 返回 processedPairs 并合并批量写", async () => {
    const driver = mockDriver();
    // 第 1 次 session.run：getSessionMessagesPage 返回 4 条消息（ASC）
    // 第 2/3 次：batchUpsertNodes / batchUpsertEdges 的 RETURN count
    driver.queueResults([
      [
        pageMsg("m1", 1, "user", "构建 API"),
        pageMsg("m2", 2, "assistant", "用 OpenAPI"),
        pageMsg("m3", 3, "user", "部署"),
        pageMsg("m4", 4, "assistant", "执行部署"),
      ],
      [{ c: 2 }],
      [{ c: 1 }],
    ]);

    const llm = makeMockLlm(JSON.stringify({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES }));
    const extractor = new Extractor(driver as any);

    const result = await rebuildSessionMessages(extractor, driver as any, llm, null, console, "s1", { concurrency: 16 });

    expect(result.processedPairs).toBe(2);
    expect(result.totalPairs).toBe(2);
    // 应触发批量写（session.run 调用：1 次读取 + 2 次批量写）
    const calls = driver.getAllRunCalls();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls[0].query).toContain("GmMessage");
  });

  it("写入首字母大写 label（Task/Skill/Event）并正确连边，而非全大写 TASK", async () => {
    const driver = mockDriver();
    driver.queueResults([
      [
        pageMsg("m1", 1, "user", "构建 API"),
        pageMsg("m2", 2, "assistant", "用 OpenAPI"),
      ],
      [{ c: 2 }], // batchUpsertNodes RETURN count
      [{ c: 1 }], // batchUpsertEdges RETURN count
    ]);

    // 边引用名与节点 name 大小写/空格不一致，验证规范化匹配能连上边
    const llm = makeMockLlm(JSON.stringify({
      nodes: SAMPLE_NODES, // name: "build-api" / "openapi-spec"
      edges: [{ type: "USED_SKILL", fromName: "Build API", toName: "OpenAPI Spec", instruction: "task uses skill" }],
    }));
    const extractor = new Extractor(driver as any);

    await rebuildSessionMessages(extractor, driver as any, llm, null, console, "s1", { concurrency: 16 });

    const queries = driver.getAllRunCalls().map((c) => c.query).join("\n");
    // label 必须为首字母大写，禁止全大写 TASK/SKILL
    expect(queries).not.toMatch(/MERGE \(.*:TASK\b/);
    expect(queries).not.toMatch(/MERGE \(.*:TASK /);
    expect(queries).toMatch(/MERGE \(n:Task \{id:/);
    // 边必须被写入（规范化匹配成功），而非 0 条
    expect(queries).toMatch(/:USED_SKILL/);
    expect(queries).toMatch(/fromId/);
  });

  it("无 user/assistant 配对 → 返回 0，不调用 LLM", async () => {
    const driver = mockDriver();
    driver.queueResults([[pageMsg("m1", 1, "assistant", "只有助手消息")]]);

    const llm = makeMockLlm(JSON.stringify({ nodes: [], edges: [] }));
    const extractor = new Extractor(driver as any);

    const result = await rebuildSessionMessages(extractor, driver as any, llm, null, console, "s1");

    expect(result.processedPairs).toBe(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("v2.4.1 回归: turnIndex 全 0（导入数据常见）也能配对，不再 0/0", async () => {
    const driver = mockDriver();
    // 全部 turnIndex=0 —— 旧实现 `0 > 0` 恒 false 导致所有对被过滤（全量 0/0 的根因）
    driver.queueResults([
      [
        pageMsg("m1", 0, "user", "构建 API"),
        pageMsg("m2", 0, "assistant", "用 OpenAPI 实现"),
        pageMsg("m3", 0, "user", "部署"),
        pageMsg("m4", 0, "assistant", "执行部署"),
      ],
      [{ c: 1 }],
      [{ c: 0 }],
    ]);

    const llm = makeMockLlm(JSON.stringify({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES }));
    const extractor = new Extractor(driver as any);

    const result = await rebuildSessionMessages(extractor, driver as any, llm, null, console, "s1");

    expect(result.processedPairs).toBe(2);
    expect(result.totalPairs).toBe(2);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("v2.4.1 回归: role 变体（USER/Human/model）也能配对", async () => {
    const driver = mockDriver();
    driver.queueResults([
      [
        pageMsg("m1", 1, "USER", "构建 API"),
        pageMsg("m2", 2, "model", "用 OpenAPI 实现"),
      ],
      [{ c: 1 }],
      [{ c: 0 }],
    ]);

    const llm = makeMockLlm(JSON.stringify({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES }));
    const extractor = new Extractor(driver as any);

    const result = await rebuildSessionMessages(extractor, driver as any, llm, null, console, "s1");

    expect(result.processedPairs).toBe(1);
    expect(result.totalPairs).toBe(1);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("缺依赖（driver/llm）→ 返回 0", async () => {
    const driver = mockDriver();
    const extractor = new Extractor(driver as any);
    const result = await rebuildSessionMessages(extractor, null, null, null, console, "s1");
    expect(result.processedPairs).toBe(0);
  });

  it("结合进度文件断点续传 → 跳过已处理轮次", async () => {
    const driver = mockDriver();
    // v2.4.1 语义: lastProcessedTurn = 已处理到的对序号（按 (createdAt,id) 顺序，1 起）
    // 记 1 → 跳过第 1 对，只重建第 2 对（m3/m4）
    driver.queueResults([
      [
        pageMsg("m1", 1, "user", "旧"),
        pageMsg("m2", 2, "assistant", "旧回"),
        pageMsg("m3", 3, "user", "新"),
        pageMsg("m4", 4, "assistant", "新回"),
      ],
      [{ c: 1 }],
      [{ c: 0 }],
    ]);

    const progressPath = `${process.env.TMPDIR ?? "/tmp"}/gm-rebuild-progress-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(progressPath, JSON.stringify({ sessionKey: "s1", lastProcessedTurn: 1, processedPairs: 1, totalPairs: 2 }), "utf-8");

    const llm = makeMockLlm(JSON.stringify({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES }));
    const extractor = new Extractor(driver as any);

    let lastInfo: any = null;
    const result = await rebuildSessionMessages(extractor, driver as any, llm, null, console, "s1", {
      concurrency: 16,
      progressPath,
      onProgress: (info) => { lastInfo = info; },
    });

    expect(result.processedPairs).toBe(1);
    expect(result.totalPairs).toBe(1);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(lastInfo?.lastProcessedTurn).toBe(2);

    // 完成后进度文件标记 done
    const { readFile, unlink } = await import("node:fs/promises");
    const saved = JSON.parse(await readFile(progressPath, "utf-8"));
    expect(saved.status).toBe("done");
    expect(saved.lastProcessedTurn).toBe(2);
    await unlink(progressPath).catch(() => undefined);
  });
});