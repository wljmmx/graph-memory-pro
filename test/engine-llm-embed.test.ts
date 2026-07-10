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
import { createCompleteFn, createRuntimeCompleteFn, __test__ } from "../src/engine/llm.ts";
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

  it("未配置 keepAlive 时默认 1h（OpenAI 兼容端点，v2.3.0 改为始终发送）", async () => {
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
    // v2.3.0: keepAlive 默认 "1h"，避免 Ollama 模型周期性卸载导致冷启动延迟
    expect(body.keep_alive).toBe("1h");
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
    // v2.3.2 S6: 首次重试延迟 = 2000 + jitter(≤500)，快进覆盖
    await vi.advanceTimersByTimeAsync(3000);
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
// 主会话本地模型优先策略（createRuntimeCompleteFn）
// ────────────────────────────────────────────────────────────

describe("createRuntimeCompleteFn", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** 构造一个 mock runtime LLM，complete 由调用方提供实现 */
  function mockRuntimeLlm(impl: (params: any) => Promise<any>) {
    return { complete: vi.fn(impl) };
  }

  it("provider 为 ollama 时，后续调用继续走 runtime LLM（不触发 fallback）", async () => {
    const runtimeLlm = mockRuntimeLlm(async (params) => {
      // 第一次调用是 probe（content: "ping"，maxTokens: 8）
      // 后续是真实任务调用
      const isProbe = params.messages?.[0]?.content === "ping";
      return {
        text: isProbe ? "ok" : "real answer",
        provider: "ollama",
        model: "qwen3.5:9b",
        agentId: "main",
      };
    });

    const complete = createRuntimeCompleteFn(
      runtimeLlm,
      { model: "gpt-4o-mini", baseURL: "https://api.openai.com/v1" },
    );

    const r1 = await complete("sys", "usr1");
    const r2 = await complete("sys", "usr2");
    expect(r1).toBe("real answer");
    expect(r2).toBe("real answer");
    // 2 次调用 + 1 次 probe = 3 次 complete
    expect(runtimeLlm.complete).toHaveBeenCalledTimes(3);
    // 没有触发 fetch（fallback 路径）
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("provider 为 ollama-256k（变体）时仍识别为本地模型", async () => {
    const runtimeLlm = mockRuntimeLlm(async (params) => ({
      text: "answer",
      provider: "ollama-256k",
      model: "qwen3:32k",
      agentId: "main",
    }));
    const complete = createRuntimeCompleteFn(runtimeLlm, {
      model: "gpt-4o-mini",
      baseURL: "https://api.openai.com/v1",
    });
    const result = await complete("sys", "usr");
    expect(result).toBe("answer");
    // runtime 调用 = 1 probe + 1 真实任务
    expect(runtimeLlm.complete).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("provider 为 openai（云端）且有 fallback 配置时，切换到 fallback LLM", async () => {
    const runtimeLlm = mockRuntimeLlm(async (params) => ({
      text: "probe-ok",
      provider: "openai",
      model: "gpt-4o",
      agentId: "main",
    }));
    // fallback fetch mock
    fetchSpy.mockResolvedValue(
      mockResponse({ choices: [{ message: { content: "fallback-answer" } }] }),
    );

    const complete = createRuntimeCompleteFn(runtimeLlm, {
      model: "gpt-4o-mini",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    const result = await complete("sys", "usr");
    expect(result).toBe("fallback-answer");
    // runtime 仅调用 1 次（probe），后续走 fetch
    expect(runtimeLlm.complete).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("provider 为云端但无 fallback 配置时，继续使用 runtime LLM", async () => {
    const runtimeLlm = mockRuntimeLlm(async (params) => {
      const isProbe = params.messages?.[0]?.content === "ping";
      return {
        text: isProbe ? "ok" : "runtime-answer",
        provider: "anthropic",
        model: "claude-sonnet-4",
        agentId: "main",
      };
    });

    // fallbackConfig 为 undefined
    const complete = createRuntimeCompleteFn(runtimeLlm, undefined);
    const result = await complete("sys", "usr");
    expect(result).toBe("runtime-answer");
    // 1 probe + 1 真实任务
    expect(runtimeLlm.complete).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("probe 失败时降级到 fallback LLM", async () => {
    const runtimeLlm = mockRuntimeLlm(async () => {
      throw new Error("runtime unavailable");
    });
    fetchSpy.mockResolvedValue(
      mockResponse({ choices: [{ message: { content: "fallback-after-error" } }] }),
    );

    const complete = createRuntimeCompleteFn(runtimeLlm, {
      model: "gpt-4o-mini",
      baseURL: "https://api.openai.com/v1",
    });

    const result = await complete("sys", "usr");
    expect(result).toBe("fallback-after-error");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("probe 失败且无 fallback 时，runtimeComplete 抛出真实错误", async () => {
    const runtimeLlm = mockRuntimeLlm(async () => {
      throw new Error("runtime down");
    });
    const complete = createRuntimeCompleteFn(runtimeLlm, undefined);
    await expect(complete("sys", "usr")).rejects.toThrow(/runtime down/);
  });

  it("并发首次调用共享 detectPromise，避免重复探测", async () => {
    let probeCount = 0;
    const runtimeLlm = mockRuntimeLlm(async (params) => {
      const isProbe = params.messages?.[0]?.content === "ping";
      if (isProbe) {
        probeCount++;
        // 模拟异步延迟，让并发调用堆积
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        text: isProbe ? "ok" : "answer",
        provider: "ollama",
        model: "qwen3.5:9b",
        agentId: "main",
      };
    });

    const complete = createRuntimeCompleteFn(runtimeLlm);
    // 同时发起 3 个并发首次调用
    const [r1, r2, r3] = await Promise.all([
      complete("sys", "u1"),
      complete("sys", "u2"),
      complete("sys", "u3"),
    ]);

    expect(r1).toBe("answer");
    expect(r2).toBe("answer");
    expect(r3).toBe("answer");
    // probe 只调用 1 次（共享 detectPromise）
    expect(probeCount).toBe(1);
    // runtime complete = 1 probe + 3 真实任务
    expect(runtimeLlm.complete).toHaveBeenCalledTimes(4);
  });

  it("后续调用不再触发 probe（decision 已缓存）", async () => {
    const runtimeLlm = mockRuntimeLlm(async (params) => ({
      text: "ok",
      provider: "ollama",
      model: "qwen3.5:9b",
      agentId: "main",
    }));

    const complete = createRuntimeCompleteFn(runtimeLlm);
    // 5 次连续调用
    for (let i = 0; i < 5; i++) {
      await complete("sys", `usr${i}`);
    }
    // 1 probe + 5 真实任务 = 6 次 complete 调用
    expect(runtimeLlm.complete).toHaveBeenCalledTimes(6);
  });

  it("runtime 返回数组 content 时正确规范化拼接", async () => {
    const runtimeLlm = mockRuntimeLlm(async (params) => {
      const isProbe = params.messages?.[0]?.content === "ping";
      return {
        text: isProbe
          ? "ok"
          : [
              { type: "text", text: "第一段" },
              { type: "text", text: "第二段" },
            ] as any,
        provider: "ollama",
        model: "qwen3.5:9b",
        agentId: "main",
      };
    });

    const complete = createRuntimeCompleteFn(runtimeLlm);
    const result = await complete("sys", "usr");
    expect(result).toBe("第一段第二段");
  });

  it("runtime 返回空 text 时抛 'runtime LLM returned no content'", async () => {
    const runtimeLlm = mockRuntimeLlm(async (params) => {
      const isProbe = params.messages?.[0]?.content === "ping";
      return {
        text: isProbe ? "ok" : "",
        provider: "ollama",
        model: "qwen3.5:9b",
        agentId: "main",
      };
    });

    const complete = createRuntimeCompleteFn(runtimeLlm);
    await expect(complete("sys", "usr")).rejects.toThrow(/runtime LLM returned no content/);
  });

  it("调用 complete 时透传 system + user 消息及 maxTokens/temperature", async () => {
    const runtimeLlm = mockRuntimeLlm(async (params) => ({
      text: "ok",
      provider: "ollama",
      model: "qwen3.5:9b",
      agentId: "main",
    }));

    const complete = createRuntimeCompleteFn(runtimeLlm);
    await complete("system-prompt", "user-prompt");

    // 第二次调用是真实任务，第一次是 probe
    const realCall = runtimeLlm.complete.mock.calls[1][0];
    expect(realCall.messages).toEqual([
      { role: "system", content: "system-prompt" },
      { role: "user", content: "user-prompt" },
    ]);
    expect(realCall.maxTokens).toBe(1024);
    expect(realCall.temperature).toBe(0.3);
    expect(realCall.purpose).toBe("graph-memory-pro:llm");
  });

  it("probe 调用使用极小 maxTokens=8 + purpose 标识", async () => {
    const runtimeLlm = mockRuntimeLlm(async () => ({
      text: "ok",
      provider: "ollama",
      model: "qwen3.5:9b",
      agentId: "main",
    }));

    const complete = createRuntimeCompleteFn(runtimeLlm);
    await complete("sys", "usr");

    const probeCall = runtimeLlm.complete.mock.calls[0][0];
    expect(probeCall.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(probeCall.maxTokens).toBe(8);
    expect(probeCall.temperature).toBe(0);
    expect(probeCall.purpose).toBe("graph-memory-pro:provider-detect");
  });

  it("logger 收到 provider detected 信息", async () => {
    const runtimeLlm = mockRuntimeLlm(async () => ({
      text: "ok",
      provider: "ollama",
      model: "qwen3.5:9b",
      agentId: "main",
    }));
    const logger = { info: vi.fn(), warn: vi.fn() };

    const complete = createRuntimeCompleteFn(runtimeLlm, undefined, logger);
    await complete("sys", "usr");

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/runtime provider detected.*provider=ollama.*model=qwen3\.5:9b.*local=true/),
    );
  });

  it("云端 provider + 无 fallback 时 logger warn 提示 staying on runtime", async () => {
    const runtimeLlm = mockRuntimeLlm(async () => ({
      text: "ok",
      provider: "openai",
      model: "gpt-4o",
      agentId: "main",
    }));
    const logger = { info: vi.fn(), warn: vi.fn() };

    const complete = createRuntimeCompleteFn(runtimeLlm, undefined, logger);
    await complete("sys", "usr");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/cloud but no fallback llm config — staying on runtime/),
    );
  });
});

// ────────────────────────────────────────────────────────────
// isLocalProvider / 关键字匹配（白盒测试）
// ────────────────────────────────────────────────────────────

describe("isLocalProvider", () => {
  const { isLocalProvider, LOCAL_PROVIDER_KEYWORDS } = __test__;

  it("ollama 命中", () => {
    expect(isLocalProvider("ollama")).toBe(true);
  });

  it("Ollama 大小写不敏感", () => {
    expect(isLocalProvider("Ollama")).toBe(true);
    expect(isLocalProvider("OLLAMA")).toBe(true);
  });

  it("ollama-256k 变体命中", () => {
    expect(isLocalProvider("ollama-256k")).toBe(true);
  });

  it("lmstudio / localai / llamafile 命中", () => {
    expect(isLocalProvider("lmstudio")).toBe(true);
    expect(isLocalProvider("localai")).toBe(true);
    expect(isLocalProvider("llamafile")).toBe(true);
  });

  it("llama.cpp / llamacpp 命中", () => {
    expect(isLocalProvider("llama.cpp")).toBe(true);
    expect(isLocalProvider("llamacpp")).toBe(true);
  });

  it("openai / anthropic 不命中", () => {
    expect(isLocalProvider("openai")).toBe(false);
    expect(isLocalProvider("anthropic")).toBe(false);
  });

  it("空字符串 / null 安全返回 false", () => {
    expect(isLocalProvider("")).toBe(false);
    expect(isLocalProvider(null as any)).toBe(false);
    expect(isLocalProvider(undefined as any)).toBe(false);
  });

  it("关键字列表覆盖所有支持的本地 provider", () => {
    expect(LOCAL_PROVIDER_KEYWORDS).toContain("ollama");
    expect(LOCAL_PROVIDER_KEYWORDS).toContain("lmstudio");
    expect(LOCAL_PROVIDER_KEYWORDS).toContain("localai");
    expect(LOCAL_PROVIDER_KEYWORDS).toContain("llamafile");
    expect(LOCAL_PROVIDER_KEYWORDS).toContain("llama.cpp");
    expect(LOCAL_PROVIDER_KEYWORDS).toContain("llamacpp");
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
    // v2.3.2 S6: 重试加 jitter（≤500ms/次），3 次重试总延迟最大 10500ms，快进覆盖
    await vi.advanceTimersByTimeAsync(12_000);
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
    // v2.3.2 S6: 重试加 jitter（≤500ms/次），3 次重试总延迟最大 10500ms，快进覆盖
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
  });

  it("网络错误后重试，第二次成功", async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(mockResponse({ embeddings: [[0.5, 0.6]] }));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434" });
    const promise = embed("text");
    // v2.3.2 S6: 首次重试延迟 = 1000 + jitter(≤500)，快进覆盖
    await vi.advanceTimersByTimeAsync(2000);
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

  it("v2.3.2 S6: 4xx 非 429 错误不重试，直接抛出", async () => {
    fetchSpy.mockResolvedValue(mockResponse("invalid model", { status: 400 }));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434" });
    await expect(embed("text")).rejects.toThrow(/Embedding API 400/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("v2.3.2 S6: 429 限流错误仍重试", async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(mockResponse("rate limited", { status: 429 }));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434" });
    const promise = embed("text");
    const assertion = expect(promise).rejects.toThrow(/Embedding API 429/);
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    // 429 应重试：1 次初始 + 3 次重试 = 4 次
    expect(fetchSpy).toHaveBeenCalledTimes(4);
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

  it("请求体包含 keep_alive（v2.3.0 默认 1h）与 input 字段（v2 schema string 数组）", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1]] }));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434" });
    await embed("my text");
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    // v2.3.0: keepAlive 默认改为 "1h"（原 5m），避免模型周期性卸载
    expect(body.keep_alive).toBe("1h");
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

  it("v2.3.0 维度校验：返回维度与 config.dimensions 一致时通过", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1, 0.2, 0.3]] }));
    const embed = createEmbedFn({
      baseURL: "http://localhost:11434",
      dimensions: 3,
    });
    const result = await embed("text");
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it("v2.3.0 维度校验：返回维度不匹配时抛错（含 expected/got/model）", async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1, 0.2, 0.3]] }));
    const embed = createEmbedFn({
      baseURL: "http://localhost:11434",
      model: "nomic-embed-text",
      dimensions: 768,  // 期望 768，实际返回 3
    });
    const promise = embed("text");
    const assertion = expect(promise).rejects.toThrow(/Embedding dimension mismatch.*expected 768.*got 3.*nomic-embed-text/);
    // v2.3.2 S6: 重试加 jitter（≤500ms/次），3 次重试总延迟最大 10500ms，快进覆盖
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
  });

  it("v2.3.0 维度校验：未配置 dimensions 时不校验（向后兼容）", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ embeddings: [[0.1, 0.2]] }));
    const embed = createEmbedFn({
      baseURL: "http://localhost:11434",
      // 未设置 dimensions
    });
    const result = await embed("text");
    expect(result).toEqual([0.1, 0.2]);
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
