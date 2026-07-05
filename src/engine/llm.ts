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
  // 不传时 Ollama 默认 5m 后卸载模型，导致周期性调用冷启动延迟
  const keepAlive = config.keepAlive;

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
            // keep_alive 仅 Ollama 识别，OpenAI 兼容服务会忽略未知字段
            ...(keepAlive != null ? { keep_alive: keepAlive } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`LLM API ${response.status}: ${body.slice(0, 200)}`);
        }

        const data = await response.json() as {
          choices: Array<{ message: { content: unknown } }>;
        };

        const rawContent = data.choices?.[0]?.message?.content;
        const content = normalizeContent(rawContent);
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
