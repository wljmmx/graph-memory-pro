/**
 * graph-memory-pro — Embedding 引擎（原生 fetch，无外部依赖）
 *
 * 使用 Ollama 新 API: baseURL/api/embed
 * 请求格式: { model, input, keep_alive }  （注意：input 不是 prompt）
 * 返回格式: data.embeddings[0]  （二维数组）
 *
 * 处理逻辑:
 *   1. 如果 baseURL 包含 /v1 → 删除 /v1，使用 Ollama 原生 API
 *   2. 如果不包含 /v1 → 直接使用 Ollama 原生 API
 *   3. 清洗 baseURL 中的反引号/首尾空格（防止 markdown 代码块标记误入 JSON）
 *   4. 传递 keep_alive 参数到 Ollama（默认 5m，可配置 1h/-1 永久）
 *
 * 参考: https://mintlify.wiki/ollama/ollama/api/endpoints/embed
 *   - 新端点 /api/embed: 参数 input (string|string[])，返回 embeddings (number[][])
 *   - 旧端点 /api/embeddings (legacy): 参数 prompt (string)，返回 embedding (number[])
 */

import type { EmbeddingConfig } from "../types.ts";

/** Embedding 函数签名 */
export type EmbedFn = (text: string) => Promise<number[]>;

/** 重试延迟 */
const RETRY_DELAYS = [1000, 3000, 5000];

/**
 * 清洗 baseURL：去除反引号、首尾空格、尾部斜杠
 * 防止 markdown 代码块标记 ` ` 误入 JSON 配置
 */
function sanitizeBaseURL(url: string): string {
  return url
    .replace(/`/g, "")        // 去除反引号
    .trim()                    // 去除首尾空格
    .replace(/\/+$/, "");      // 去除尾部斜杠
}

/**
 * 内置 embedding 引擎
 * 统一使用 Ollama 新 API /api/embed
 */
export function createEmbedFn(config: EmbeddingConfig): EmbedFn {
  const apiKey = config.apiKey || "";
  let baseURL = sanitizeBaseURL(config.baseURL || "http://localhost:11434");

  if (baseURL.endsWith("/v1")) {
    baseURL = baseURL.slice(0, -3);
  }

  const model = config.model || "Qwen3.5-Embedding-0.6B-GGUF";
  // Ollama keep_alive 参数：默认 "5m"，可配置 "1h"/"30m"/-1（永久驻留）
  // 不传时 Ollama 默认 5m 后卸载模型，导致下次调用冷启动延迟
  const keepAlive = config.keepAlive || "5m";

  return async function embed(text: string): Promise<number[]> {
    const lastErr: Error[] = [];
    const delays = [...RETRY_DELAYS];

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        // v2.2.0 fix: 使用新 API 参数名 input（旧端点 /api/embeddings 用 prompt）
        // 新端点 /api/embed 期望 input 字段，传 prompt 会被忽略，返回空数据
        const response = await fetch(`${baseURL}/api/embed`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            input: text,
            keep_alive: keepAlive,
            ...(config.options ? { options: config.options } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`Embedding API ${response.status}: ${body.slice(0, 200)}`);
        }

        const data = await response.json() as any;

        // 新 API /api/embed 返回 embeddings (二维数组)
        if (!data.embeddings?.[0]) {
          throw new Error("Ollama embedding API returned no embedding data");
        }

        return data.embeddings[0];
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastErr.push(error);

        // v2.2.0: 对 4xx 错误（非 429 限流）不重试，与 llm.ts 保持一致
        if (error.message.match(/Embedding API 4\d{2}/) && !error.message.includes("429")) {
          throw error;
        }

        if (attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
    }

    throw lastErr[lastErr.length - 1] || new Error("Embedding failed");
  };
}
