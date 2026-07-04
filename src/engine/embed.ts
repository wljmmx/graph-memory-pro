/**
 * graph-memory-pro — Embedding 引擎（原生 fetch，无外部依赖）
 *
 * 使用 Ollama 原生 API: baseURL/api/embed
 * 返回格式: data.embeddings[0]
 * 
 * 处理逻辑:
 *   1. 如果 baseURL 包含 /v1 → 删除 /v1，使用 Ollama 原生 API
 *   2. 如果不包含 /v1 → 直接使用 Ollama 原生 API
 */

import type { EmbeddingConfig } from "../types.ts";

/** Embedding 函数签名 */
export type EmbedFn = (text: string) => Promise<number[]>;

/** 重试延迟 */
const RETRY_DELAYS = [1000, 3000, 5000];

/**
 * 内置 embedding 引擎
 * 统一使用 Ollama 原生 API
 */
export function createEmbedFn(config: EmbeddingConfig): EmbedFn {
  const apiKey = config.apiKey || "";
  let baseURL = (config.baseURL || "http://localhost:11434").replace(/\/+$/, "");
  
  if (baseURL.endsWith("/v1")) {
    baseURL = baseURL.slice(0, -3);
  }
  
  const model = config.model || "Qwen3.5-Embedding-0.6B-GGUF";

  return async function embed(text: string): Promise<number[]> {
    const lastErr: Error[] = [];
    const delays = [...RETRY_DELAYS];

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const response = await fetch(`${baseURL}/api/embed`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            prompt: text,
            ...(config.options ? { options: config.options } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`Embedding API ${response.status}: ${body.slice(0, 200)}`);
        }

        const data = await response.json() as any;

        if (!data.embeddings?.[0]) {
          throw new Error("Ollama embedding API returned no embedding data");
        }

        return data.embeddings[0];
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastErr.push(error);

        if (attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
    }

    throw lastErr[lastErr.length - 1] || new Error("Embedding failed");
  };
}
