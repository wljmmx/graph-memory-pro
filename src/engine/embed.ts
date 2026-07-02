/**
 * graph-memory-pro — Embedding 引擎（原生 fetch，无外部依赖）
 *
 * 替代原版 dynamic import("openai")，使用 fetch 直接访问
 * OpenAI-compatible embedding API
 * 所有凭据只从配置对象读取，不做 process.env 回退
 */

import type { EmbeddingConfig } from "../types.ts";

/** Embedding 函数签名 */
export type EmbedFn = (text: string) => Promise<number[]>;

/** 重试延迟 */
const RETRY_DELAYS = [1000, 3000, 5000];

/**
 * 内置 embedding 引擎
 * 使用 fetch 直接调用 OpenAI-compatible API
 */
export function createEmbedFn(config: EmbeddingConfig): EmbedFn {
  const apiKey = config.apiKey || "";
  const baseURL = (config.baseURL || "http://192.168.50.5:11434/v1").replace(/\/+$/, "");
  const model = config.model || "Qwen3.5-Embedding-0.6B-GGUF";
  const dimensions = config.dimensions ?? 1024;

  return async function embed(text: string): Promise<number[]> {
    const lastErr: Error[] = [];
    const delays = [...RETRY_DELAYS];

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const response = await fetch(`${baseURL}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            input: text,
            model,
            ...(config.options ? { options: config.options } : {}),
            ...(config.keepAlive ? { keep_alive: config.keepAlive } : {}),
            dimensions,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`Embedding API ${response.status}: ${body.slice(0, 200)}`);
        }

        const data = await response.json() as {
          data: Array<{ embedding: number[] }>;
        };

        if (!data.data?.[0]?.embedding) {
          throw new Error("Embedding API returned no embedding data");
        }

        return data.data[0].embedding;
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
