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
  if (!config?.apiKey) {
    return null;
  }
  return createOpenAICompatibleComplete(config);
}

/**
 * 创建 OpenAI-compatible 补全函数
 */
function createOpenAICompatibleComplete(config: LlmConfig): CompleteFn {
  const apiKey = config.apiKey || "";
  const baseURL = (config.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
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

        if (attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
    }

    throw lastErr[lastErr.length - 1] || new Error("LLM completion failed");
  };
}
