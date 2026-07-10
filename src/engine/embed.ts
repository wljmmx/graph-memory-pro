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
// v2.3.2 S6: 重试 jitter 上限 — 防止并发失败时重试波峰对齐加剧下游过载
const RETRY_JITTER_MAX_MS = 500;

// v2.3.2 阶段二: 简易 LRU 缓存（无外部依赖，基于 Map 插入顺序）
// 避免相同 text 跨 tick 重复 embed（如 associationMatrix 对同一 query 再次 embed、doctor 探测固定文本）
interface LruCacheEntry {
  vec: number[];
  ts: number;
}
const DEFAULT_EMBED_CACHE_SIZE = 256;
const DEFAULT_EMBED_CACHE_TTL_MS = 10 * 60 * 1000; // 10min（短于 QueryCache 30min，保证嵌入新鲜度）

function createLruCache(capacity: number, ttlMs: number) {
  const map = new Map<string, LruCacheEntry>();
  return {
    get(key: string): number[] | null {
      const entry = map.get(key);
      if (!entry) return null;
      if (Date.now() - entry.ts > ttlMs) {
        map.delete(key);
        return null;
      }
      // 命中：移到末尾（Map 末尾为最近使用）
      map.delete(key);
      map.set(key, entry);
      return entry.vec;
    },
    set(key: string, vec: number[]): void {
      if (map.size >= capacity) {
        // 删除最旧（Map 头部第一个 key）
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) map.delete(oldestKey);
      }
      map.set(key, { vec, ts: Date.now() });
    },
    clear(): void {
      map.clear();
    },
    size(): number {
      return map.size;
    },
  };
}

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
  // Ollama keep_alive 参数：默认 "1h"（与 lcm-graph-extra createLocalEmbedFn 一致），
  // 可配置 "5m"/"30m"/"2h"/-1（永久驻留）。
  // 不传或传 "5m" 时，模型在 5 分钟无请求后自动卸载，下次请求需重新加载，
  // 导致首次召回延迟显著（GGUF 模型加载可能数秒到数十秒）。
  const keepAlive = config.keepAlive || "1h";
  // v2.3.0: 预期向量维度（可选）。配置后引擎层校验返回向量维度一致性，
  // 防止模型更换后维度与向量索引不一致（如 nomic-embed-text 768 → 1024）
  const expectedDim = config.dimensions;

  // v2.3.2 阶段二: LRU 缓存 — 避免相同 text 跨 tick 重复 embed
  // 缓存配置可通过 config.cacheSize / config.cacheTtlMs 覆盖（0 表示禁用缓存）
  const cacheSize = (config as any).cacheSize ?? DEFAULT_EMBED_CACHE_SIZE;
  const cacheTtlMs = (config as any).cacheTtlMs ?? DEFAULT_EMBED_CACHE_TTL_MS;
  const cache = (cacheSize > 0 && cacheTtlMs > 0) ? createLruCache(cacheSize, cacheTtlMs) : null;

  return async function embed(text: string): Promise<number[]> {
    if (text == null || text === '') {
      throw new Error('Embedding API: input text cannot be null, undefined, or empty');
    }

    // v2.3.2 阶段二: 命中缓存直接返回，避免重复调用 Ollama
    if (cache) {
      const cached = cache.get(text);
      if (cached) return cached;
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

        // v2.3.2 阶段二: 成功后写入 LRU 缓存
        if (cache) cache.set(text, vec);

        return vec;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastErr.push(error);

        // v2.3.2 S6: 4xx 错误（非 429 限流）不重试 — 重试也不会成功（如 400 无效模型/401 鉴权失败）
        if (error.message.match(/Embedding API 4\d{2}/) && !error.message.includes("429")) {
          throw error;
        }

        if (attempt < delays.length) {
          // v2.3.2 S6: 加 jitter 防并发重试波峰对齐
          const jitter = Math.random() * RETRY_JITTER_MAX_MS;
          await new Promise((r) => setTimeout(r, delays[attempt] + jitter));
        }
      }
    }

    throw lastErr[lastErr.length - 1] || new Error("Embedding failed");
  };
}
