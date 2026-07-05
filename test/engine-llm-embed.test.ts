/**
 * graph-memory-pro — LLM 与 Embedding 引擎单元测试
 *
 * 覆盖：
 *   - src/engine/llm.ts:   createCompleteFn / CompleteFn
 *   - src/engine/embed.ts: createEmbedFn / EmbedFn
 *
 * 无法测试的项（源码未实现 / 未导出）：
 *   - isOllamaNative：任务描述提到 11434 端口/ollama 关键字检测逻辑，
 *     但 llm.ts 中并未定义 isOllamaNative（既未导出也无私有实现），
 *     LLM 引擎统一走 OpenAI-compatible 路径，无 Ollama 原生分支，故跳过。
 *   - completeLlm：任务描述提到该函数，但 llm.ts 中不存在该导出，故跳过。
 *   - 维度校验：任务描述提到「config.dimensions 与返回向量维度不一致时抛错」，
 *     但 embed.ts 的 createEmbedFn 从未读取 config.dimensions，也未对返回向量
 *     做长度校验。EmbeddingConfig.dimensions 字段在 types.ts 中有定义但引擎未使用，
 *     故维度校验测试无法编写。若需此能力，应在源码 createEmbedFn 中补充 dimensions 检查。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCompleteFn } from "../src/engine/llm.ts";
import { createEmbedFn } from "../src/engine/embed.ts";

/** 构造一个最小可用的 mock Response（避免依赖真实 Response 构造器） */
function mockResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? status < 400;
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

// ────────────────────────────────────────────────────────────
// LLM 引擎
// ────────────────────────────────────────────────────────────

describe("createCompleteFn", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("config 为 undefined 时返回 null", () => {
    expect(createCompleteFn(undefined)).toBeNull();
  });

  it("config 仅有 apiKey 但无 model/baseURL 时返回 null", () => {
    expect(createCompleteFn({ apiKey: "sk-xxx" })).toBeNull();
  });

  it("config 含 model 时返回函数", () => {
    const fn = createCompleteFn({ model: "gpt-4o-mini" });
    expect(typeof fn).toBe("function");
  });

  it("config 含 baseURL 时返回函数", () => {
    const fn = createCompleteFn({ baseURL: "http://localhost:11434/v1" });
    expect(typeof fn).toBe("function");
  });

  it("正常请求：返回 trim 后的 content", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        choices: [{ message: { content: "  hello world  " } }],
      }),
    );
    const complete = createCompleteFn({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });
    const result = await complete("system prompt", "user prompt");
    expect(result).toBe("hello world");
  });

  it("请求体包含正确的 model / messages / max_tokens / temperature", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    const complete = createCompleteFn({
      baseURL: "https://api.openai.com/v1",
      model: "my-model",
    });
    await complete("sys", "usr");
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("my-model");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.3);
  });

  it("配置 keepAlive 时透传到请求体（Ollama 模型驻留）", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    const complete = createCompleteFn({
      baseURL: "http://localhost:11434/v1",
      model: "qwen3.5:9b",
      keepAlive: "30m",
    });
    await complete("s", "u");
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.keep_alive).toBe("30m");
  });

  it("未配置 keepAlive 时不传 keep_alive 字段（OpenAI 兼容）", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    const complete = createCompleteFn({
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
    await complete("s", "u");
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.keep_alive).toBeUndefined();
  });

  it("content 为数组格式（多模态/推理模型）时正确拼接 text", async () => {
    // Ollama OpenAI-compat 层/推理模型可能返回 content 为数组
    fetchSpy.mockResolvedValue(
      mockResponse({
        choices: [{
          message: {
            content: [
              { type: "text", text: "第一段" },
              { type: "text", text: "第二段" },
            ],
          },
        }],
      }),
    );
    const complete = createCompleteFn({
      baseURL: "http://localhost:11434/v1",
      model: "qwen3.5:9b",
    });
    const result = await complete("s", "u");
    expect(result).toBe("第一段第二段");
  });

  it("content 为空数组时抛 'LLM returned no content'", async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(
      mockResponse({ choices: [{ message: { content: [] } }] }),
    );
    const complete = createCompleteFn({
      baseURL: "https://api.openai.com/v1",
      model: "m",
    });
    const promise = complete("s", "u");
    const assertion = expect(promise).rejects.toThrow(/no content/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it("content 为 null 时抛 'LLM returned no content'", async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(
      mockResponse({ choices: [{ message: { content: null } }] }),
    );
    const complete = createCompleteFn({
      baseURL: "https://api.openai.com/v1",
      model: "m",
    });
    const promise = complete("s", "u");
    const assertion = expect(promise).rejects.toThrow(/no content/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it("baseURL 清洗：去除反引号 / 首尾空格 / 尾部斜杠", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    const complete = createCompleteFn({
      baseURL: "` http://localhost:11434/v1/ `",
      model: "m",
    });
    await complete("s", "u");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("Authorization 头使用 Bearer <apiKey>", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    const complete = createCompleteFn({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-secret",
      model: "m",
    });
    await complete("s", "u");
    const [, init] = fetchSpy.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-secret",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("4xx 非 429 错误不重试，直接抛出", async () => {
    fetchSpy.mockResolvedValue(mockResponse("Bad Request", { status: 400 }));
    const complete = createCompleteFn({
      model: "m",
      baseURL: "https://api.openai.com/v1",
    });
    await expect(complete("s", "u")).rejects.toThrow(/LLM API 400/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("content 为空时抛出 'LLM returned no content' 且重试 3 次后失败", async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(
      mockResponse({ choices: [{ message: { content: null } }] }),
    );
    const complete = createCompleteFn({
      model: "m",
      baseURL: "https://api.openai.com/v1",
    });
    const promise = complete("s", "u");
    // 先附加 rejection 断言，避免快进定时器期间产生 unhandled rejection
    const assertion = expect(promise).rejects.toThrow(/LLM returned no content/);
    // 重试延迟 2000 + 5000 + 10000 = 17000ms，快进覆盖全部
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    // 共 4 次尝试（1 次初始 + 3 次重试）
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("网络错误后重试，第二次成功", async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(
        mockResponse({ choices: [{ message: { content: "ok" } }] }),
      );
    const complete = createCompleteFn({
      model: "m",
      baseURL: "https://api.openai.com/v1",
    });
    const promise = complete("s", "u");
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("未指定 baseURL 时使用默认值 https://api.openai.com/v1", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    const complete = createCompleteFn({ model: "gpt-4o-mini" });
    await complete("s", "u");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
  });
});

// ────────────────────────────────────────────────────────────
// Embedding 引擎
// ────────────────────────────────────────────────────────────

describe("createEmbedFn", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("返回 embedding 函数", () => {
    const embed = createEmbedFn({ baseURL: "http://localhost:11434" });
    expect(typeof embed).toBe("function");
  });

  it("正常返回 embeddings[0] 向量", async () => {
    const vector = [0.1, 0.2, 0.3];
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [vector] }));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434" });
    const result = await embed("some text");
    expect(result).toEqual(vector);
  });

  it("baseURL 含 /v1 时自动剥离，使用 Ollama 原生 /api/embed", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1]] }));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434/v1" });
    await embed("text");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/embed");
  });

  it("baseURL 清洗：去除反引号 / 首尾空格 / 尾部斜杠", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1]] }));
    const embed = createEmbedFn({ baseURL: "` http://localhost:11434/ `" });
    await embed("text");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/embed");
  });

  it("无 embeddings 数据时抛错且重试 3 次后失败", async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(mockResponse({}));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434" });
    const promise = embed("text");
    // 先附加 rejection 断言，避免快进定时器期间产生 unhandled rejection
    const assertion = expect(promise).rejects.toThrow(/no embedding data/);
    // 重试延迟 1000 + 3000 + 5000 = 9000ms
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("无 embeddings 数据时错误消息包含模型名和响应预览（便于诊断）", async () => {
    vi.useFakeTimers();
    // 模拟 Ollama 返回错误（如模型不支持 embed）
    fetchSpy.mockResolvedValue(mockResponse({ error: "model 'qwen3.5:9b' does not support embed" }));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434", model: "qwen3.5:9b" });
    const promise = embed("text");
    // 错误消息应同时包含模型名 + 响应预览
    const assertion = expect(promise).rejects.toThrow(/model=qwen3\.5:9b.*does not support embed/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("网络错误后重试，第二次成功", async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(mockResponse({ embeddings: [[0.5, 0.6]] }));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434" });
    const promise = embed("text");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toEqual([0.5, 0.6]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("提供 apiKey 时附加 Authorization 头", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1]] }));
    const embed = createEmbedFn({
      baseURL: "http://localhost:11434",
      apiKey: "sk-embed",
    });
    await embed("text");
    const [, init] = fetchSpy.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-embed",
    );
  });

  it("未提供 apiKey 时不附加 Authorization 头", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1]] }));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434" });
    await embed("text");
    const [, init] = fetchSpy.mock.calls[0];
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it("请求体包含 keep_alive（默认 5m）与 input 字段（v2 schema string 数组）", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1]] }));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434" });
    await embed("my text");
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.keep_alive).toBe("5m");
    // Ollama v2 schema: input 是 string 数组（非旧的 prompt 字符串）
    expect(body.input).toEqual(["my text"]);
    expect(body.prompt).toBeUndefined();
  });

  it("keepAlive 自定义值透传到请求体", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1]] }));
    const embed = createEmbedFn({
      baseURL: "http://localhost:11434",
      keepAlive: "1h",
    });
    await embed("text");
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.keep_alive).toBe("1h");
  });

  it("config.options 透传到请求体 options 字段", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1]] }));
    const embed = createEmbedFn({
      baseURL: "http://localhost:11434",
      options: { num_ctx: 2048 },
    });
    await embed("text");
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.options).toEqual({ num_ctx: 2048 });
  });

  it("未指定 baseURL 时使用默认值 http://localhost:11434", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1]] }));
    const embed = createEmbedFn({});
    await embed("text");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/embed");
  });
});
