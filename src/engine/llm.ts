/**
 * graph-memory-pro — LLM 引擎（带重试和超时）
 *
 * 从 V1 移植 retry 逻辑：3 次重试 + 30s 超时
 * 所有凭据只从配置对象读取，不做 process.env 回退
 *
 * 支持两种 API 格式（根据 baseURL 自动判断）：
 *   1. OpenAI 兼容格式（baseURL 含 /v1 或指向 openai.com / azure 等云端）：
 *      - 端点: /chat/completions
 *      - 请求: { model, messages, max_tokens, temperature }
 *      - 响应: data.choices[0].message.content
 *
 *   2. Ollama 原生格式（baseURL 不含 /v1，如 http://localhost:11434）：
 *      - 端点: /api/chat
 *      - 请求: { model, messages, stream: false, options: { temperature, num_predict }, keep_alive }
 *      - 响应: data.message.content
 *
 * 参考: https://mintlify.wiki/ollama/ollama/api/endpoints/chat
 *   - Ollama 原生 chat API 不接受顶层 max_tokens/temperature，必须放在 options 内
 *   - num_predict 等价于 OpenAI 的 max_tokens（生成 token 上限）
 *   - keep_alive 控制模型驻留内存时长，默认 5m，传 -1 永久驻留
 */

import type { LlmConfig } from "../types.ts";

/** LLM 补全函数签名 */
export type CompleteFn = (system: string, user: string) => Promise<string>;

/** 重试延迟 */
const RETRY_DELAYS = [2000, 5000, 10_000];

/**
 * 判断是否使用 Ollama 原生 API
 * 规则：仅当 baseURL 明确指向 Ollama 时才走原生 API；
 * 第三方 OpenAI 兼容服务（如 deepseek.com、moonshot.cn）默认走 OpenAI 兼容格式
 */
function isOllamaNative(baseURL: string): boolean {
  const lower = baseURL.toLowerCase();
  // OpenAI 兼容：含 /v1 或指向 openai.com
  if (lower.includes("/v1") || lower.includes("openai.com")) {
    return false;
  }
  // Ollama 特征：默认端口 11434 或 URL 含 "ollama" 关键字
  if (lower.includes("11434") || lower.includes("ollama")) {
    return true;
  }
  // 其他第三方域名（deepseek.com、moonshot.cn 等）默认走 OpenAI 兼容格式
  return false;
}

/**
 * 清洗 baseURL：去除反引号、首尾空格、尾部斜杠
 * 防止 markdown 代码块标记 ` ` 误入 JSON 配置
 */
function sanitizeBaseURL(url: string): string {
  return url
    .replace(/`/g, "")
    .trim()
    .replace(/\/+$/, "");
}

/**
 * 内置 LLM 补全引擎
 * 根据 baseURL 自动选择 OpenAI 兼容格式或 Ollama 原生格式
 */
export function createCompleteFn(config?: LlmConfig): CompleteFn | null {
  if (!config?.model && !config?.baseURL && !config?.apiKey) {
    return null;
  }
  if (!config?.model && !config?.baseURL) {
    return null;
  }

  const baseURL = sanitizeBaseURL(config.baseURL || "http://localhost:11434");

  if (isOllamaNative(baseURL)) {
    return createOllamaNativeComplete(config, baseURL);
  }
  return createOpenAICompatibleComplete(config, baseURL);
}

/**
 * 创建 Ollama 原生 API 补全函数
 * 端点: /api/chat
 * 请求: { model, messages, stream: false, options: { temperature, num_predict }, keep_alive }
 * 响应: data.message.content
 */
function createOllamaNativeComplete(config: LlmConfig, baseURL: string): CompleteFn {
  const apiKey = config.apiKey || "";
  const model = config.model || "qwen2.5:7b";
  // Ollama keep_alive 参数：默认 "5m"，可配置 "1h"/"30m"/-1（永久驻留）
  // 不传时 Ollama 默认 5m 后卸载模型，导致下次调用冷启动延迟
  const keepAlive = config.keepAlive || "5m";

  return async function complete(system: string, user: string): Promise<string> {
    const lastErr: Error[] = [];
    const delays = [...RETRY_DELAYS];

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        // v2.2.0 fix: 使用 Ollama 原生 /api/chat 端点
        // - options 内嵌 temperature 和 num_predict（等价于 OpenAI 的 max_tokens）
        // - 必须传 stream: false，否则返回 SSE 流
        // - keep_alive 控制模型驻留，与 embed.ts 保持一致
        const response = await fetch(`${baseURL}/api/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            stream: false,
            // Ollama 原生 API: options 内嵌 temperature 和 num_predict
            // 不支持顶层 max_tokens/temperature（与 OpenAI 兼容格式不同）
            options: {
              temperature: 0.3,
              num_predict: 1024,
              ...(config.options || {}),
            },
            keep_alive: keepAlive,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`LLM API ${response.status}: ${body.slice(0, 200)}`);
        }

        // Ollama 原生响应: { message: { role, content }, done, total_duration, ... }
        // 与 OpenAI 兼容格式的 choices[0].message.content 不同
        const data = await response.json() as {
          message?: { content?: string | null };
          done?: boolean;
        };

        const content = data.message?.content;
        if (!content) {
          throw new Error("LLM returned no content");
        }

        return content.trim();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastErr.push(error);

        // 对 4xx 错误（非 429 限流）不重试，因为重试也不会成功
        if (error.message.match(/LLM API 4\d{2}/) && !error.message.includes("429")) {
          throw error;
        }

        if (attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
    }

    throw lastErr[lastErr.length - 1] || new Error("LLM completion failed");
  };
}

/**
 * 创建 OpenAI 兼容补全函数
 * 端点: /chat/completions
 * 请求: { model, messages, max_tokens, temperature }
 * 响应: data.choices[0].message.content
 */
function createOpenAICompatibleComplete(config: LlmConfig, baseURL: string): CompleteFn {
  const apiKey = config.apiKey || "";
  const model = config.model || "gpt-4o-mini";

  return async function complete(system: string, user: string): Promise<string> {
    const lastErr: Error[] = [];
    const delays = [...RETRY_DELAYS];

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const response = await fetch(`${baseURL}/chat/completions`, {
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
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`LLM API ${response.status}: ${body.slice(0, 200)}`);
        }

        const data = await response.json() as {
          choices: Array<{ message: { content: string | null } }>;
        };

        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error("LLM returned no content");
        }

        return content.trim();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastErr.push(error);

        // 对 4xx 错误（非 429 限流）不重试，因为重试也不会成功
        if (error.message.match(/LLM API 4\d{2}/) && !error.message.includes("429")) {
          throw error;
        }

        if (attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
    }

    throw lastErr[lastErr.length - 1] || new Error("LLM completion failed");
  };
}
