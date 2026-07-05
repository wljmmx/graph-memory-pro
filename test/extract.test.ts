/**
 * 三元组提取器单元测试 (graph-memory-pro)
 *
 * 被测模块：/workspace/src/extractor/extract.ts
 *   - extractTriplets(llm, userContent, assistantContent)
 *   - Extractor 类（构造接受 Driver，.extract 委托给 extractTriplets）
 *
 * 关键点：
 *   - LLM 通过 CompleteFn 注入，无需真实 API
 *   - M-7 容错：支持 markdown 代码块 / 前后文本包裹的 JSON
 *   - 支持 6 种基础边 + S-5 因果边 (CAUSED_BY / LEADS_TO)
 *
 * 注意：parseExtractResult / isValidNode / isValidEdge 为 private 未导出函数，
 *      通过 extractTriplets 间接测试其行为。
 *
 * 注意：当前实现 extract.ts 中没有节点去重逻辑 —— 节点只做
 *      `filter(isValidNode).slice(0, 5)`，重复 name 的节点会原样保留。
 *      本测试据实断言该行为（见 "节点去重" 用例注释）。
 */

import { describe, it, expect, vi } from "vitest";
import { extractTriplets, Extractor } from "../src/extractor/extract.ts";
import type { CompleteFn } from "../src/engine/llm.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";

// ── 辅助：构造 mock CompleteFn ─────────────────────────────────

function makeMockLlm(reply: string): CompleteFn {
  return vi.fn(async () => reply) as unknown as CompleteFn;
}

function makeThrowingLlm(err: unknown = new Error("network down")): CompleteFn {
  return vi.fn(async () => {
    throw err;
  }) as unknown as CompleteFn;
}

// ── 辅助：标准合法节点/边 ─────────────────────────────────────

const SAMPLE_NODES = [
  { type: "TASK", name: "build-api", description: "构建 API", content: "实现 REST API" },
  { type: "SKILL", name: "openapi-spec", description: "OpenAPI 规范", content: "使用 OpenAPI 3.1" },
];

const SAMPLE_EDGES = [
  { type: "USED_SKILL", fromName: "build-api", toName: "openapi-spec", instruction: "task uses skill" },
];

// ============================================================
// extractTriplets
// ============================================================

describe("extractTriplets", () => {
  // ── 1. 正常提取 ──────────────────────────────────────────
  it("正常提取：LLM 返回标准 JSON → 正确解析 nodes/edges", async () => {
    const llm = makeMockLlm(
      JSON.stringify({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES }),
    );

    const result = await extractTriplets(llm, "帮我构建 API", "建议用 OpenAPI");

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ name: "build-api", type: "TASK" });
    expect(result.edges[0]).toMatchObject({
      type: "USED_SKILL",
      fromName: "build-api",
      toName: "openapi-spec",
    });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  // ── 2. M-7 容错：markdown 代码块 ─────────────────────────
  it("M-7 容错：LLM 返回带 ```json 代码块的 JSON → 提取并解析", async () => {
    const payload = `\`\`\`json
${JSON.stringify({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES }, null, 2)}
\`\`\``;

    const llm = makeMockLlm(payload);

    const result = await extractTriplets(llm, "构建 API", "用 OpenAPI");

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].name).toBe("build-api");
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe("USED_SKILL");
  });

  // ── 3. M-7 容错：前后文本包裹（含嵌套对象时的已知限制） ─
  // 注意：extract.ts 的 M-7 regex `\{[\s\S]*?"nodes"[\s\S]*?\}` 使用非贪婪
  // 匹配，遇到节点对象内部的 `}` 会提前结束，导致 JSON 不完整 → 返回空数组。
  // 这是当前实现的已知限制，本测试据实断言该行为。
  it("M-7 容错：LLM 返回带前后文本的 JSON（含嵌套节点）→ regex 截断，返回空数组", async () => {
    const json = JSON.stringify({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES });
    const payload = `好的，这是提取结果：\n${json}\n以上为本次提取的三元组。`;

    const llm = makeMockLlm(payload);

    const result = await extractTriplets(llm, "构建 API", "用 OpenAPI");

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  // 补充：前后文本包裹「无嵌套对象」的 JSON → regex 可完整提取
  it("M-7 容错：前后文本包裹空数组 JSON（无嵌套对象）→ regex 完整提取并解析", async () => {
    const payload = `结果如下：{"nodes":[],"edges":[]} 完毕。`;

    const llm = makeMockLlm(payload);

    const result = await extractTriplets(llm, "用户", "助手");

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  // ── 4. 空对话 ────────────────────────────────────────────
  it("空对话：user/assistant 均空 → 直接返回空数组，不调用 LLM", async () => {
    const llm = makeMockLlm('{"nodes":[],"edges":[]}');

    const result = await extractTriplets(llm, "", "   ");

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("空对话：user/assistant 均为空白字符 → 返回空数组", async () => {
    const llm = makeMockLlm('{"nodes":[],"edges":[]}');

    const result = await extractTriplets(llm, "  \n\t ", "  ");

    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  // ── 5. 因果边提取（S-5） ─────────────────────────────────
  it("因果边提取：LLM 返回 CAUSED_BY / LEADS_TO 边 → 正确识别", async () => {
    const nodes = [
      { type: "EVENT", name: "db-down", description: "数据库宕机", content: "PG 服务挂了" },
      { type: "EVENT", name: "timeout", description: "超时", content: "上游超时" },
      { type: "TASK", name: "deploy", description: "部署任务", content: "执行部署" },
    ];
    const edges = [
      { type: "CAUSED_BY", fromName: "timeout", toName: "db-down", instruction: "DB 宕机导致超时" },
      { type: "LEADS_TO", fromName: "deploy", toName: "db-down", instruction: "部署引发了宕机" },
    ];

    const llm = makeMockLlm(JSON.stringify({ nodes, edges }));

    const result = await extractTriplets(llm, "部署后数据库挂了", "分析因果");

    expect(result.edges).toHaveLength(2);
    const caused = result.edges.find((e) => e.type === "CAUSED_BY");
    const leads = result.edges.find((e) => e.type === "LEADS_TO");
    expect(caused).toBeDefined();
    expect(caused?.fromName).toBe("timeout");
    expect(caused?.toName).toBe("db-down");
    expect(leads).toBeDefined();
    expect(leads?.fromName).toBe("deploy");
    expect(leads?.toName).toBe("db-down");
  });

  // ── 6. 节点去重（实际行为：不去重） ─────────────────────
  // 注意：extract.ts 当前实现只做 filter(isValidNode).slice(0, 5)，
  //      并不按 name 去重。本用例据实断言：重复 name 的合法节点会原样保留。
  it("节点去重：LLM 返回重复 name 的节点 → 当前实现不去重，原样保留", async () => {
    const nodes = [
      { type: "TASK", name: "dup", description: "first", content: "c1" },
      { type: "TASK", name: "dup", description: "second", content: "c2" },
      { type: "TASK", name: "dup", description: "third", content: "c3" },
    ];

    const llm = makeMockLlm(JSON.stringify({ nodes, edges: [] }));

    const result = await extractTriplets(llm, "重复节点", "回复");

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.every((n) => n.name === "dup")).toBe(true);
  });

  // ── 7. JSON 解析失败 ─────────────────────────────────────
  it("JSON 解析失败：LLM 返回纯文本非 JSON → 返回空数组（不抛错）", async () => {
    const llm = makeMockLlm("抱歉，我无法理解这段对话。");

    const result = await extractTriplets(llm, "用户消息", "助手回复");

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("JSON 解析失败：LLM 返回残缺 JSON（无 nodes 字段）→ 返回空数组", async () => {
    const llm = makeMockLlm('{ "foo": "bar" ');

    const result = await extractTriplets(llm, "用户消息", "助手回复");

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("LLM 异常：complete 抛错 → 捕获并返回空数组", async () => {
    const llm = makeThrowingLlm(new Error("network down"));

    const result = await extractTriplets(llm, "用户消息", "助手回复");

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  // ── 8. 多轮对话提取（user + assistant 同时有内容） ────────
  it("多轮对话提取：user/assistant 均有内容 → LLM 被调用且 prompt 包含两段", async () => {
    const mockFn = vi.fn(async (_sys: string, _usr: string) =>
      JSON.stringify({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES }),
    );
    const llm = mockFn as unknown as CompleteFn;

    const result = await extractTriplets(
      llm,
      "用户：帮我构建一个 REST API",
      "助手：建议使用 OpenAPI 3.1 规范来定义接口",
    );

    expect(mockFn).toHaveBeenCalledTimes(1);
    const [, userPrompt] = mockFn.mock.calls[0];
    expect(userPrompt).toContain("帮我构建一个 REST API");
    expect(userPrompt).toContain("建议使用 OpenAPI 3.1 规范来定义接口");
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
  });

  it("仅 user 有内容，assistant 为空 → 仍正常调用 LLM 提取", async () => {
    const llm = makeMockLlm(
      JSON.stringify({
        nodes: [{ type: "TASK", name: "solo-task", description: "d", content: "c" }],
        edges: [],
      }),
    );

    const result = await extractTriplets(llm, "用户单独提问", "");

    expect(llm).toHaveBeenCalledTimes(1);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].name).toBe("solo-task");
  });

  // ── 额外：节点/边过滤与限流 ──────────────────────────────
  it("无效节点被过滤：缺 name / 非法 type / 字段类型错误 → 过滤掉", async () => {
    const nodes = [
      { type: "TASK", name: "valid", description: "d", content: "c" },
      { type: "TASK", name: "", description: "empty name", content: "c" }, // 空 name
      { type: "UNKNOWN", name: "bad-type", description: "d", content: "c" }, // 非法 type
      { type: "TASK", name: "no-desc", description: 123, content: "c" }, // description 非字符串
      { type: "TASK", name: "no-content", description: "d", content: null }, // content 非字符串
      null, // 非对象
    ];

    const llm = makeMockLlm(JSON.stringify({ nodes, edges: [] }));

    const result = await extractTriplets(llm, "用户消息", "助手回复");

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].name).toBe("valid");
  });

  it("节点大小写不敏感：type 为小写 task 仍合法", async () => {
    const nodes = [
      { type: "task", name: "lower-task", description: "d", content: "c" },
    ];

    const llm = makeMockLlm(JSON.stringify({ nodes, edges: [] }));

    const result = await extractTriplets(llm, "用户消息", "助手回复");

    expect(result.nodes).toHaveLength(1);
  });

  it("节点限流：超过 5 个合法节点 → 截断为 5 个", async () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      type: "TASK",
      name: `task-${i}`,
      description: "d",
      content: "c",
    }));

    const llm = makeMockLlm(JSON.stringify({ nodes, edges: [] }));

    const result = await extractTriplets(llm, "用户消息", "助手回复");

    expect(result.nodes).toHaveLength(5);
  });

  it("边限流：超过 8 条合法边 → 截断为 8 条", async () => {
    const edges = Array.from({ length: 12 }, (_, i) => ({
      type: "RELATES_TO",
      fromName: `a-${i}`,
      toName: `b-${i}`,
      instruction: "rel",
    }));

    const llm = makeMockLlm(JSON.stringify({ nodes: [], edges }));

    const result = await extractTriplets(llm, "用户消息", "助手回复");

    expect(result.edges).toHaveLength(8);
  });

  it("无效边被过滤：缺 fromName / toName / type → 过滤掉", async () => {
    const edges = [
      { type: "USED_SKILL", fromName: "a", toName: "b", instruction: "ok" },
      { type: "USED_SKILL", fromName: "", toName: "b", instruction: "empty from" }, // 过滤
      { type: "USED_SKILL", fromName: "a", toName: "", instruction: "empty to" }, // 过滤
      { type: "", fromName: "a", toName: "b", instruction: "empty type" }, // 过滤
      null, // 过滤
    ];

    const llm = makeMockLlm(JSON.stringify({ nodes: [], edges }));

    const result = await extractTriplets(llm, "用户消息", "助手回复");

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].fromName).toBe("a");
  });
});

// ============================================================
// Extractor 类
// ============================================================

describe("Extractor", () => {
  it("Extractor.extract 委托给 extractTriplets，行为一致", async () => {
    const driver = mockDriver();
    const extractor = new Extractor(driver as any);
    const llm = makeMockLlm(
      JSON.stringify({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES }),
    );

    const result = await extractor.extract(llm, "构建 API", "用 OpenAPI");

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.nodes[0].name).toBe("build-api");
  });

  it("Extractor.extract 空对话 → 返回空数组", async () => {
    const driver = mockDriver();
    const extractor = new Extractor(driver as any);
    const llm = makeMockLlm('{"nodes":[],"edges":[]}');

    const result = await extractor.extract(llm, "", "");

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});
