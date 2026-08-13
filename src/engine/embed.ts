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

// v2.4.0: 并发控制信号量（限制 embed 并发请求数，防本地 Ollama 503 server busy）
// Ollama 默认 OLLAMA_NUM_PARALLEL=1，单流处理，并发过高会报
// "maximum pending requests exceeded"，触发 embedding 熔断。
// 默认并发 3（本地跑不宜超过 3），云端 API 可配置 maxConcurrency 调高。
const DEFAULT_EMBED_MAX_CONCURRENCY = 3;

interface Semaphore {
  acquire(): Promise<() => void>;
}

function createSemaphore(max: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<() => void> {
      if (active >= max) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
        const next = waiters.shift();
        if (next) next();
      };
    },
  };
}

// 模块级共享信号量（同 baseURL+model 的 EmbedFn 共享同一限制器）
const _semaphores = new Map<string, Semaphore>();
function getSemaphore(baseURL: string, model: string, maxConcurrency: number): Semaphore {
  const key = `${baseURL}|${model}`;
  let sem = _semaphores.get(key);
  if (!sem) {
    sem = createSemaphore(maxConcurrency);
    _semaphores.set(key, sem);
  }
  return sem;
}

// v2.3.2 阶段二: 简易 LRU 缓存（无外部依赖，基于 Map 插入顺序）
// 避免相同 text 跨 tick 重复 embed（如 associationMatrix 对同一 query 再次 embed、doctor 探测固定文本）
interface LruCacheEntry {
  vec: number[];
  ts: number;
}
const DEFAULT_EMBED_CACHE_SIZE = 256;
const DEFAULT_EMBED_CACHE_TTL_MS = 10 * 60 * 1000; // 10min（短于 QueryCache 30min，保证嵌入新鲜度）

// P1-6: LRU 缓存键用文本的 64-bit hash 而非原始文本。
// 原始文本键在长文本/高频写入场景会占用额外内存，hash 键固定为 16 位十六进制串。
// 采用 FNV-1a 64-bit（JS 用 BigInt 实现），256 条目下碰撞概率 ≈ 4e-15，可忽略。
function hash64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

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

// v2.4.0 P2-9: embed LRU 缓存命中率统计（供 /api/metrics 输出）
// 键为 baseURL|model，进程级累计，不持久化。
const _embedCacheStats = new Map<string, { hits: number; misses: number }>();
function bumpEmbedCacheStat(key: string, hit: boolean): void {
  const s = _embedCacheStats.get(key) ?? { hits: 0, misses: 0 };
  if (hit) s.hits++;
  else s.misses++;
  _embedCacheStats.set(key, s);
}
export interface EmbedCacheStats {
  cacheKey: string;
  hits: number;
  misses: number;
  hitRate: number;
}
export function getEmbedCacheStats(): EmbedCacheStats[] {
  const out: EmbedCacheStats[] = [];
  for (const [key, s] of _embedCacheStats) {
    const total = s.hits + s.misses;
    out.push({ cacheKey: key, hits: s.hits, misses: s.misses, hitRate: total ? s.hits / total : 0 });
  }
  return out;
}

/**
 * 清洗 baseURL：去除反引号、首尾空格、尾部斜杠
 * 防止 markdown 代码块标记 ` ` 误入 JSON 配置
 */
function sanitizeBaseURL(url: string | null | undefined): string {
  const u = url ?? "";
  return u
    .replace(/`/g, "")
    .trim()
    .replace(/\/+$/, "");
}

/**
 * 内置 embedding 引擎
 * 统一使用 Ollama 原生 API
 */

// 模块级共享 LRU 缓存（keyed by baseURL|model）：
// 单文本 embed 与批量 batchEmbed 复用同一缓存，减少重复 embed 与内存开销。
const _embedCacheHandles = new Map<string, ReturnType<typeof createLruCache>>();
function getSharedEmbedCache(key: string, cacheSize: number, cacheTtlMs: number) {
  if (cacheSize <= 0 || cacheTtlMs <= 0) return null;
  let handle = _embedCacheHandles.get(key);
  if (!handle) {
    handle = createLruCache(cacheSize, cacheTtlMs);
    _embedCacheHandles.set(key, handle);
  }
  return handle;
}

function buildKeepAlive(config: EmbeddingConfig): string | number {
  const raw = config.keepAlive;
  if (raw === undefined || raw === null || raw === "") return "1h";
  if (typeof raw === "number") return raw;
  const trimmed = String(raw).trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

// 单次请求：发送 inputs 数组，返回对齐的向量数组（带重试 + 维度校验）
async function performEmbedRequest(
  baseURL: string,
  apiKey: string,
  model: string,
  keepAlive: string | number,
  options: Record<string, number | boolean | string> | undefined,
  inputs: string[],
  expectedDim: number | undefined,
): Promise<number[][]> {
  const delays = [...RETRY_DELAYS];
  const lastErr: Error[] = [];
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
          input: inputs,
          keep_alive: keepAlive,
          ...(options ? { options } : {}),
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

      const data = await response.json() as { embeddings?: number[][] };

      if (!data.embeddings || data.embeddings.length === 0) {
        const respPreview = JSON.stringify(data).slice(0, 300);
        console.warn(
          `[graph-memory-pro:embed] Ollama /api/embed returned no embedding data`,
          { model, responsePreview: respPreview, inputsLen: inputs.length },
        );
        throw new Error(
          `Ollama embedding API returned no embedding data (model=${model}, response=${respPreview})`,
        );
      }

      const vecs = data.embeddings;
      if (expectedDim) {
        for (const v of vecs) {
          if (v.length !== expectedDim) {
            throw new Error(
              `Embedding dimension mismatch: expected ${expectedDim}, got ${v.length} (model=${model}). ` +
              `Check embedding.model or embedding.dimensions in config.`,
            );
          }
        }
      }
      return vecs;
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
}

type EmbedClient = {
  baseURL: string;
  apiKey: string;
  model: string;
  keepAlive: string | number;
  expectedDim: number | undefined;
  cache: ReturnType<typeof createLruCache> | null;
  cacheLabel: string;
  semaphore: Semaphore;
  options: Record<string, number | boolean | string> | undefined;
};

function buildEmbedClient(config: EmbeddingConfig): EmbedClient {
  const apiKey = config.apiKey || "";
  let baseURL = sanitizeBaseURL(config.baseURL || "http://localhost:11434");
  if (baseURL.endsWith("/v1")) {
    baseURL = baseURL.slice(0, -3);
  }
  const model = config.model || "Qwen3.5-Embedding-0.6B-GGUF";
  const keepAlive = buildKeepAlive(config);
  const expectedDim = config.dimensions;
  const cacheSize = config.cacheSize ?? DEFAULT_EMBED_CACHE_SIZE;
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_EMBED_CACHE_TTL_MS;
  const cacheLabel = `${baseURL}|${model}`;
  const cache = getSharedEmbedCache(cacheLabel, cacheSize, cacheTtlMs);
  const maxConcurrency = config.maxConcurrency ?? DEFAULT_EMBED_MAX_CONCURRENCY;
  const semaphore = getSemaphore(baseURL, model, maxConcurrency);
  return { apiKey, baseURL, model, keepAlive, expectedDim, cache, cacheLabel, semaphore, options: config.options };
}

/**
 * 单文本 embedding 引擎
 */
export function createEmbedFn(config: EmbeddingConfig): EmbedFn {
  const c = buildEmbedClient(config);

  return async function embed(text: string): Promise<number[]> {
    if (text == null || text === '') {
      throw new Error('Embedding API: input text cannot be null, undefined, or empty');
    }

    // v2.3.2 阶段二: 命中缓存直接返回，避免重复调用 Ollama
    // P1-6: 缓存键用文本 hash，减少原始文本键的内存占用
    const cacheKey = c.cache ? hash64(text) : null;
    if (cacheKey) {
      const cached = c.cache!.get(cacheKey);
      if (cached) {
        // P2-9: 记录命中率
        bumpEmbedCacheStat(c.cacheLabel, true);
        return cached;
      }
      bumpEmbedCacheStat(c.cacheLabel, false);
    }

    // v2.4.0: acquire 信号量，确保并发不超限（重试在持锁期间复用同一槽位）
    const release = await c.semaphore.acquire();
    try {
      const vecs = await performEmbedRequest(
        c.baseURL, c.apiKey, c.model, c.keepAlive, c.options, [text], c.expectedDim,
      );
      const vec = vecs[0];
      // v2.3.2 阶段二: 成功后写入 LRU 缓存
      if (cacheKey) c.cache!.set(cacheKey, vec);
      return vec;
    } finally {
      release();
    }
  };
}

/**
 * 批量 embedding 引擎（v2.4.0 P2-9）
 *
 * 一次 HTTP 请求携带多个文本（Ollama /api/embed 原生支持 input 数组），
 * 显著减少请求数，降低本地 Ollama 请求队列压力（503 maximum pending 触发概率）。
 * 复用单文本引擎的：共享 LRU 缓存 + 共享信号量 + keep_alive + 重试。
 *
 * 返回与输入等长的 (number[] | null)[]；单个文本失败返回 null（不阻塞整批）。
 */
export type BatchEmbedFn = (texts: string[]) => Promise<(number[] | null)[]>;
const BATCH_SIZE = 16;

export function createBatchEmbedFn(config: EmbeddingConfig): BatchEmbedFn {
  const c = buildEmbedClient(config);

  return async function batchEmbed(texts: string[]): Promise<(number[] | null)[]> {
    const out: (number[] | null)[] = new Array(texts.length).fill(null);
    if (!texts.length) return out;

    // 先查缓存，剩下未命中的才发请求
    const toEmbed: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (t == null || t === '') continue;
      if (c.cache) {
        const ck = hash64(t);
        const cached = c.cache.get(ck);
        if (cached) {
          out[i] = cached;
          bumpEmbedCacheStat(c.cacheLabel, true);
          continue;
        }
        bumpEmbedCacheStat(c.cacheLabel, false);
      }
      toEmbed.push(i);
    }

    // 按子批次发送（每批 ≤ BATCH_SIZE 个），持锁期间复用同一并发槽位
    for (let start = 0; start < toEmbed.length; start += BATCH_SIZE) {
      const idxs = toEmbed.slice(start, start + BATCH_SIZE);
      const inputs = idxs.map((i) => texts[i]);
      const release = await c.semaphore.acquire();
      try {
        const vecs = await performEmbedRequest(
          c.baseURL, c.apiKey, c.model, c.keepAlive, c.options, inputs, c.expectedDim,
        );
        for (let k = 0; k < idxs.length; k++) {
          const v = vecs[k];
          if (v && v.length) {
            out[idxs[k]] = v;
            if (c.cache) c.cache.set(hash64(texts[idxs[k]]), v);
          }
        }
      } catch {
        // 子批次整体失败：该批置 null（调用方跳过），避免整批功亏一篑
        // 单文本失败造成的少量缺失由调用方（建图/召回）用 FTS 兜底
      } finally {
        release();
      }
    }
    return out;
  };
}
