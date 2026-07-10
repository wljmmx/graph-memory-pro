/**
 * graph-memory-pro — LLM 引擎（带重试和超时）
 *
 * 从 V1 移植 retry 逻辑：3 次重试 + 30s 超时
 * 所有凭据只从配置对象读取，不做 process.env 回退
 */

import type { LlmConfig } from "../types.ts";

/** LLM 补全函数签名 */
export type CompleteFn = (system: string, user: string) => Promise<string>;

/** 重试延迟 */
const RETRY_DELAYS = [2000, 5000, 10_000];
// v2.3.2 S6: 重试 jitter 上限 — 防止并发失败时重试波峰对齐加剧下游过载
const RETRY_JITTER_MAX_MS = 500;

/**
 * 内置 LLM 补全引擎
 * 使用 fetch + retry，支持 OpenAI-compatible API
 */
export function createCompleteFn(config?: LlmConfig): CompleteFn | null {
  if (!config?.model && !config?.baseURL && !config?.apiKey) {
    return null;
  }
  if (!config?.model && !config?.baseURL) {
    return null;
  }
  return createOpenAICompatibleComplete(config);
}

/**
 * 创建 OpenAI-compatible 补全函数
 *
 * 兼容 OpenAI / Ollama OpenAI-compat (/v1/chat/completions) / 其他兼容服务。
 * Ollama 用户须将 baseURL 设为 "http://localhost:11434/v1"（含 /v1）。
 */
function createOpenAICompatibleComplete(config: LlmConfig): CompleteFn {
  const apiKey = config.apiKey || "";
  // 清洗 baseURL：去除反引号/首尾空格/尾部斜杠（防止 markdown 标记误入 JSON）
  const baseURL = (config.baseURL || "https://api.openai.com/v1")
    .replace(/`/g, "")
    .trim()
    .replace(/\/+$/, "");
  const model = config.model || "gpt-4o-mini";
  // Ollama keep_alive 参数（仅 Ollama 识别，OpenAI 会忽略）
  // 默认 "1h"（与 embed 引擎一致），不传时 Ollama 默认 5m 后卸载模型，
  // 导致周期性调用冷启动延迟（LLM 模型加载通常数秒到数十秒）。
  const keepAlive = config.keepAlive || "1h";

  // P2-B2: 检测是否为 Ollama 本地服务。
  // Ollama 的 OpenAI 兼容层 (/v1/*) 是实验性支持，keep_alive 可能被忽略。
  // 如果检测到 Ollama（127.0.0.1:11434 或 localhost:11434），优先用原生 /api/chat 端点，
  // 该端点完整支持 keep_alive，避免模型反复卸载加载。
  const isOllamaNative = /127\.0\.0\.1:11434|localhost:11434|0\.0\.0\.0:11434/.test(baseURL)
    && !/\/v1\b/.test(baseURL);

  return async function complete(system: string, user: string): Promise<string> {
    const lastErr: Error[] = [];
    const delays = [...RETRY_DELAYS];

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        let response: Response;
        let apiFormat: 'openai' | 'ollama';

        if (isOllamaNative) {
          // Ollama 原生 /api/chat 端点：keep_alive 完整支持
          apiFormat = 'ollama';
          response = await fetch(`${baseURL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              stream: false,
              options: {
                num_predict: 1024,
                temperature: 0.3,
              },
              keep_alive: keepAlive,
            }),
            signal: AbortSignal.timeout(30_000),
          });
        } else {
          // OpenAI 兼容端点 /v1/chat/completions（含 Ollama /v1 路径和云端 API）
          apiFormat = 'openai';
          response = await fetch(`${baseURL}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              max_tokens: 1024,
              temperature: 0.3,
              // keep_alive 仅 Ollama 识别，OpenAI 兼容服务会忽略未知字段
              ...(keepAlive != null ? { keep_alive: keepAlive } : {}),
            }),
            signal: AbortSignal.timeout(30_000),
          });
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`LLM API ${response.status}: ${body.slice(0, 200)}`);
        }

        const data = await response.json() as any;

        // 响应格式适配：Ollama /api/chat 返回 { message: { content } }，
        // OpenAI /v1/chat/completions 返回 { choices: [{ message: { content } }] }
        const rawContent = apiFormat === 'ollama'
          ? data?.message?.content
          : data?.choices?.[0]?.message?.content;
        const usage = apiFormat === 'ollama'
          ? { prompt_tokens: data?.prompt_eval_count, completion_tokens: data?.eval_count, total_tokens: (data?.prompt_eval_count ?? 0) + (data?.eval_count ?? 0) }
          : data?.usage;
        const content = normalizeContent(rawContent);
        if (!content) {
          throw new Error("LLM returned no content");
        }

        // v2.3.0: 记录 token 用量（OpenAI-compatible API 通常返回 usage 字段，Ollama 不返回）
        try {
          const { recordUsage } = await import("../store/usage.ts");
          recordUsage(
            "config-llm",  // provider 标识（配置的 LLM，非 runtime）
            "unknown",     // purpose 由上层调用方通过包装注入，此处默认 unknown
            usage?.prompt_tokens ?? 0,
            usage?.completion_tokens ?? 0,
          );
        } catch { /* usage 记录失败不影响主流程 */ }

        return content.trim();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastErr.push(error);

        // 对 4xx 错误（非 429 限流）不重试，因为重试也不会成功
        if (error.message.match(/LLM API 4\d{2}/) && !error.message.includes("429")) {
          throw error;
        }

        if (attempt < delays.length) {
          // v2.3.2 S6: 加 jitter 防并发重试波峰对齐
          const jitter = Math.random() * RETRY_JITTER_MAX_MS;
          await new Promise((r) => setTimeout(r, delays[attempt] + jitter));
        }
      }
    }

    throw lastErr[lastErr.length - 1] || new Error("LLM completion failed");
  };
}

/**
 * 规范化 LLM 响应 content 字段
 *
 * OpenAI 标准返回 string，但部分 OpenAI-compatible 实现（含 Ollama 推理模型、
 * 多模态模型）可能返回：
 *   - string → 直接使用
 *   - null/undefined → 返回 ""（触发上层 "no content" 错误）
 *   - Array<{type: "text", text: string}> → 拼接所有 text part
 *   - 其他 → JSON.stringify 兜底
 */
function normalizeContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // OpenAI multimodal format: [{type: "text", text: "..."}, ...]
    return content
      .map((part: any) => {
        if (part == null) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  // 兜底：未知类型转字符串
  try { return String(content); } catch { return ""; }
}

// ─── 主会话本地模型优先策略 ────────────────────────────────────────
//
// 设计目标：当插件运行在 OpenClaw 容器内时，如果主会话模型是本地模型
// （ollama / lmstudio / localai / llamafile 等），优先使用主会话模型进行
// LLM 能力处理；如果主会话模型是云端模型（如 OpenAI / Anthropic），
// 则切换到插件配置的 llm（fallbackConfig）。
//
// 探测策略：首次调用时执行一次轻量 probe（maxTokens=8，单条 user 消息
// "ping"），从返回的 result.provider 判断本地/云端，结果缓存为 decision，
// 所有后续调用按 decision 分发，避免重复探测。

/**
 * 本地模型 provider 关键字（小写匹配）
 *
 * 主会话模型 provider 命中以下任一关键字时视为本地模型：
 *   ollama / ollama-256k / lmstudio / localai / llamafile / llama.cpp / llamacpp
 */
const LOCAL_PROVIDER_KEYWORDS = [
  "ollama",
  "lmstudio",
  "localai",
  "llamafile",
  "llama.cpp",
  "llamacpp",
];

function isLocalProvider(provider: string): boolean {
  if (!provider) return false;
  const lower = provider.toLowerCase();
  return LOCAL_PROVIDER_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * OpenClaw 主会话 runtime LLM 接口（仅依赖 complete 方法）
 *
 * 与 SDK 的 LlmCompleteParams / LlmCompleteResult 保持结构兼容，
 * 但用结构化类型避免直接依赖 SDK 内部类型。
 */
export interface RuntimeLlm {
  complete: (params: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    signal?: AbortSignal;
    purpose?: string;
    agentId?: string;
  }) => Promise<{
    text: string;
    provider: string;
    model: string;
    agentId?: string;
    usage?: unknown;
    audit?: unknown;
  }>;
}

/** logger 最小接口（兼容 console 与 SDK logger） */
interface RuntimeLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/**
 * 创建基于 OpenClaw 主会话 runtime LLM 的补全函数（带 provider 探测 + 缓存）
 *
 * 策略：
 * 1. 首次调用时执行一次轻量 probe（~8 token）探测主会话 provider
 * 2. 检查 result.provider：
 *    - 本地模型 → 后续继续用 runtime LLM（避免云端调用与费用）
 *    - 云端模型 → 后续切换到 fallbackConfig 配置的 LLM
 * 3. 探测结果缓存为 decision，所有后续调用按 decision 分发
 *
 * 设计目标：
 * - 仅一次 ~8 token 的 probe 调用即可完成 provider 探测
 * - 并发安全：所有并发调用共享 detectPromise，避免重复探测
 * - probe 失败时优雅降级到 fallback LLM（如未配置则仍用 runtime LLM）
 */
export function createRuntimeCompleteFn(
  runtimeLlm: RuntimeLlm,
  fallbackConfig?: LlmConfig,
  logger?: RuntimeLogger,
): CompleteFn {
  let decision: "runtime" | "fallback" | null = null;
  let detectPromise: Promise<void> | null = null;
  // fallback CompleteFn（lazy init — 仅在 decision === "fallback" 时创建）
  let cachedFallback: CompleteFn | null = null;

  function getFallback(): CompleteFn | null {
    if (!cachedFallback) {
      cachedFallback = createCompleteFn(fallbackConfig);
    }
    return cachedFallback;
  }

  /**
   * 基于 runtime LLM 的补全调用（含 content 规范化）
   */
  async function runtimeComplete(system: string, user: string): Promise<string> {
    const result = await runtimeLlm.complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: 1024,
      temperature: 0.3,
      purpose: "graph-memory-pro:llm",
    });
    const text = normalizeContent(result?.text);
    if (!text) {
      throw new Error("runtime LLM returned no content");
    }

    // v2.3.0: 记录 runtime LLM token 用量（usage 字段来自 OpenClaw runtime）
    try {
      const { recordUsage } = await import("../store/usage.ts");
      const usage = (result as any)?.usage;
      recordUsage(
        result?.provider ? `runtime-${result.provider}` : "runtime",
        "unknown",
        usage?.promptTokens ?? 0,
        usage?.completionTokens ?? 0,
      );
    } catch { /* usage 记录失败不影响主流程 */ }

    return text.trim();
  }

  /**
   * 探测主会话 runtime LLM 的 provider，缓存 decision
   *
   * 使用极小 probe（maxTokens=8，单条 "ping" 消息）以最小化 token 开销。
   * probe 失败时优雅降级到 fallback（如未配置则 decision 仍为 runtime，
   * 后续 runtimeComplete 调用会抛出真实错误）。
   */
  async function detectProvider(): Promise<void> {
    try {
      const result = await runtimeLlm.complete({
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 8,
        temperature: 0,
        purpose: "graph-memory-pro:provider-detect",
      });
      const provider = (result?.provider ?? "").toString();
      const model = (result?.model ?? "").toString();
      const local = isLocalProvider(provider);
      logger?.info?.(
        `[graph-memory-pro:llm] runtime provider detected: provider=${provider} model=${model} local=${local}`,
      );
      if (local) {
        decision = "runtime";
      } else if (fallbackConfig?.model || fallbackConfig?.baseURL) {
        decision = "fallback";
      } else {
        // 云端 provider 但无 fallback 配置 → 继续用 runtime
        logger?.warn?.(
          `[graph-memory-pro:llm] runtime provider is cloud but no fallback llm config — staying on runtime`,
        );
        decision = "runtime";
      }
    } catch (err) {
      logger?.warn?.(
        `[graph-memory-pro:llm] provider detection failed — switching to fallback: ${err}`,
      );
      decision = "fallback";
    }
  }

  return async (system: string, user: string): Promise<string> => {
    // 首次调用：执行 provider 探测（所有并发调用共享同一个 detectPromise）
    if (decision === null) {
      if (!detectPromise) {
        detectPromise = detectProvider();
      }
      await detectPromise;
    }

    if (decision === "fallback") {
      const fb = getFallback();
      if (fb) return fb(system, user);
      // fallback 配置无效（如未配置 model/baseURL）→ 退回 runtime
    }

    // decision === "runtime" 或 fallback 无效时
    return runtimeComplete(system, user);
  };
}

// 导出内部辅助函数供测试使用（仅测试引用，不影响打包）
export const __test__ = { isLocalProvider, normalizeContent, LOCAL_PROVIDER_KEYWORDS };
