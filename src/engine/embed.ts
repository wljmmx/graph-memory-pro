/**
 * graph-memory-pro — Embedding 引擎（原生 fetch，无外部依赖）
 *
 * 使用 Ollama 原生 API: baseURL/api/embed
 * 返回格式: data.embeddings[0]
 *
 * 处理逻辑:
 *   1. 如果 baseURL 包含 /v1 → 删除 /v1，使用 Ollama 原生 API
 *   2. 如果不包含 /v1 → 直接使用 Ollama 原生 API
 *   3. 清洗 baseURL 中的反引号/首尾空格（防止 markdown 代码块标记误入 JSON）
 *   4. 传递 keep_alive 参数到 Ollama（默认 5m，可配置 1h/-1 永久）
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
 * 统一使用 Ollama 原生 API
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
  // v2.3.0: 预期向量维度（可选）。配置后引擎层校验返回向量维度一致性，
  // 防止模型更换后维度与向量索引不一致（如 nomic-embed-text 768 → 1024）
  const expectedDim = config.dimensions;

  return async function embed(text: string): Promise<number[]> {
    if (text == null || text === '') {
      throw new Error('Embedding API: input text cannot be null, undefined, or empty');
    }
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
            input: [text],
            keep_alive: keepAlive,
            ...(config.options ? { options: config.options } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          let hint = '';
          if (response.status === 400 && body.includes('invalid input type')) {
            hint = '. 提示：请检查 embedding.model 配置是否为支持 embedding 的模型（如 nomic-embed-text、bge-large-zh），聊天模型（如 qwen3.6）不支持 embedding';
          }
          throw new Error(`Embedding API ${response.status}: ${body.slice(0, 200)}${hint}`);
        }

        const data = await response.json() as any;

        if (!data.embeddings?.[0]) {
          // 打印 Ollama 实际返回内容，便于诊断（如模型不支持 embed、模型名错误等）
          const respPreview = JSON.stringify(data).slice(0, 300);
          console.warn(
            `[graph-memory-pro:embed] Ollama /api/embed returned no embedding data`,
            { model, responsePreview: respPreview, hasEmbeddings: Array.isArray(data.embeddings), embeddingsLen: data.embeddings?.length },
          );
          throw new Error(
            `Ollama embedding API returned no embedding data (model=${model}, response=${respPreview})`,
          );
        }

        const vec: number[] = data.embeddings[0];

        // v2.3.0: 维度校验 — 若 config.dimensions 已配置，校验返回向量维度一致
        // 防止模型更换后维度与向量索引不一致（如 nomic-embed-text 768 → 1024）
        if (expectedDim && vec.length !== expectedDim) {
          throw new Error(
            `Embedding dimension mismatch: expected ${expectedDim}, got ${vec.length} (model=${model}). ` +
            `Check embedding.model or embedding.dimensions in config.`,
          );
        }

        return vec;
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
