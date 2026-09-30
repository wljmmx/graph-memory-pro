/**
 * graph-memory-pro — Embedding 引擎（原生 fetch，无外部依赖）
 *
 * 支持两种接口格式，按 baseURL 自动判定（可用 embedding.apiFormat 强制覆盖）：
 *   - Ollama 原生：POST {baseURL}/api/embed，响应 data.embeddings[]
 *   - OpenAI 兼容：POST {baseURL}/embeddings，响应 data.data[].embedding
 *     用于 OVMS 内网服务 /v3/embeddings、OpenAI /v1/embeddings 等
 *
 * 处理逻辑:
 *   1. 清洗 baseURL 中的反引号/首尾空格/尾部斜杠（防止 markdown 代码块标记误入 JSON）
 *   2. 判定 apiFormat：
 *      - 命中 Ollama 默认端口 11434 → ollama（含 /v1 时剥离 /v1 走原生）
 *      - 含版本化路径（/v1、/v3、/v1beta…）→ openai（保留原路径，绝不复写为 /api/embed）
 *      - 其余 → ollama（向后兼容）
 *   3. ollama 传 keep_alive/options；openai 传 input（忽略 Ollama 专有字段）
 */

import type { EmbeddingConfig } from "../types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("embed");

/** Embedding 函数签名 */
export type EmbedFn = (text: string) => Promise<number[]>;

/** 重试延迟 */
const RETRY_DELAYS = [1000, 3000, 5000];
// v2.3.2 S6: 重试 jitter 上限 — 防止并发失败时重试波峰对齐加剧下游过载
const RETRY_JITTER_MAX_MS = 500;

// v2.4.0: 并发控制信号量（限制 embed 并发请求数，防本地 Ollama 503 server busy）
// Ollama 默认 OLLAMA_NUM_PARALLEL=1，单流处理，并发过高会报
// "maximum pending requests exceeded"，触发 embedding 熔断。
// 默认并发 2（v2.8.x: Ollama 同模型请求串行排队，embed 并发过高会占满队列，
// 拖慢对话召回的单条 query embed——实测 4 并发时召回 embed 排队 ~12s。
// 2 为「与对话共存」的安全值，可配置 maxConcurrency 按需调整）。
const DEFAULT_EMBED_MAX_CONCURRENCY = 2;

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
 * v2.4.0: 清空模块级 embed 状态（LRU 缓存 + 共享信号量 + 命中率统计）。
 * 用途：测试隔离（避免跨用例共享缓存导致断言失真），以及运行期配置变更后重置缓存。
 */
export function clearEmbedCacheAll(): void {
  _embedCacheHandles.clear();
  _semaphores.clear();
  _embedCacheStats.clear();
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

/** 嵌入接口格式 */
type EmbedApiFormat = "ollama" | "openai";

/** Ollama 默认端口判定（与 llm.ts isOllamaNative 一致，不限 host） */
function isOllamaPort(baseURL: string): boolean {
  return /:11434(?:\/|$)/.test(baseURL);
}

/**
 * 版本化路径判定：/v1、/v3、/v1beta、/v2.1 等。
 * 用于识别 OpenAI 兼容服务（OVMS v3 / OpenAI v1 / 多数网关）。
 */
function hasVersionSegment(baseURL: string): boolean {
  return /\/v\d+[a-z0-9._-]*(?:\/|$)/i.test(baseURL);
}

/**
 * 解析嵌入接口格式：显式 apiFormat 优先，否则按 baseURL 自动判定。
 *
 * 关键点：OVMS 内网服务走 /v3/embeddings（OpenAI 兼容），
 * baseURL 形如 http://host:port/v3 时须判定为 "openai"，
 * 绝不能被改写成 Ollama 原生 /api/embed。
 */
function resolveEmbedApiFormat(baseURL: string, explicit?: unknown): EmbedApiFormat {
  if (explicit === "ollama" || explicit === "openai") return explicit;
  if (isOllamaPort(baseURL)) return "ollama";
  if (hasVersionSegment(baseURL)) return "openai";
  return "ollama";
}

/**
 * OpenAI 兼容端点规范化：至少含版本段。
 * 已含 /v3、/v1 等原样保留；缺版本段时补 /v1（与 llm.ts compatBase 一致）。
 */
function resolveOpenAICompatBase(baseURL: string): string {
  return hasVersionSegment(baseURL) ? baseURL : `${baseURL}/v1`;
}

/**
 * 内置 embedding 引擎
 * 按 apiFormat 分发：Ollama 原生 /api/embed 或 OpenAI 兼容 /embeddings（含 OVMS v3）
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

/**
 * 嵌入请求目标（端点 + 鉴权 + 模型 + 格式）。
 * 引擎与 bench/诊断工具共用同一份解析，避免两处端点逻辑漂移。
 */
export interface EmbedEndpoint {
  apiFormat: EmbedApiFormat;
  /** 规范化后的 baseURL（ollama 已剥离 /v1；openai 保留/补全版本段） */
  baseURL: string;
  /** 完整请求 URL */
  url: string;
  model: string;
  apiKey: string;
  keepAlive: string | number;
  options: Record<string, number | boolean | string> | undefined;
}

/**
 * 解析嵌入端点与请求参数（无缓存/信号量副作用，可安全用于 bench）。
 * 端点规则：ollama → {baseURL}/api/embed；openai → {baseURL}/embeddings。
 */
export function resolveEmbedEndpoint(config: EmbeddingConfig): EmbedEndpoint {
  const rawBaseURL = sanitizeBaseURL(config.baseURL || "http://localhost:11434");
  const apiFormat = resolveEmbedApiFormat(rawBaseURL, config.apiFormat);
  // 端点规范化：
  //   - ollama：剥离尾部 /v1（Ollama OpenAI 兼容路径 → 原生 /api/embed）
  //   - openai：保留版本路径（OVMS /v3 原样保留），必要时补 /v1，绝不复写为 /api/embed
  const baseURL = apiFormat === "ollama"
    ? (rawBaseURL.endsWith("/v1") ? rawBaseURL.slice(0, -3) : rawBaseURL)
    : resolveOpenAICompatBase(rawBaseURL);
  return {
    apiFormat,
    baseURL,
    url: apiFormat === "ollama" ? `${baseURL}/api/embed` : `${baseURL}/embeddings`,
    model: config.model || "Qwen3.5-Embedding-0.6B-GGUF",
    apiKey: config.apiKey || "",
    keepAlive: buildKeepAlive(config),
    options: config.options,
  };
}

/**
 * 构造嵌入请求体。
 * ollama → input 数组 + keep_alive/options；
 * openai 兼容（含 OVMS /v3）→ 仅 model/input，忽略 Ollama 专有字段。
 */
export function buildEmbedRequestBody(
  endpoint: Pick<EmbedEndpoint, "apiFormat" | "model" | "keepAlive" | "options">,
  inputs: string[],
): Record<string, unknown> {
  return endpoint.apiFormat === "ollama"
    ? {
        model: endpoint.model,
        input: inputs,
        keep_alive: endpoint.keepAlive,
        ...(endpoint.options ? { options: endpoint.options } : {}),
      }
    : { model: endpoint.model, input: inputs };
}

/** 构造嵌入请求头（含可选 Bearer 鉴权） */
export function buildEmbedRequestHeaders(
  endpoint: Pick<EmbedEndpoint, "apiKey">,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(endpoint.apiKey ? { "Authorization": `Bearer ${endpoint.apiKey}` } : {}),
  };
}

// 单次请求：发送 inputs 数组，返回对齐的向量数组（带重试 + 维度校验）
// v2.8.x: timeoutMs 可配——批量路径输入多（每请求 ≤ 段数上限），本地 CPU Ollama
// 在极端负载下 30s 可能超时，误触发重试风暴（表现为 gm_reembed 首批次
// "跑几分钟 0 进展"），故批量路径上调到 120s。
async function performEmbedRequest(
  client: EmbedClient,
  inputs: string[],
  timeoutMs = 30_000,
): Promise<number[][]> {
  const { apiFormat, url, model, baseURL, expectedDim } = client;
  const isOllama = apiFormat === "ollama";
  const delays = [...RETRY_DELAYS];
  const lastErr: Error[] = [];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildEmbedRequestHeaders(client),
        body: JSON.stringify(buildEmbedRequestBody(client, inputs)),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        let hint = '';
        if (response.status === 400 && body.includes('invalid input type')) {
          hint = '. 提示：请检查 embedding.model 配置是否为支持 embedding 的模型（如 nomic-embed-text、bge-large-zh），聊天模型（如 qwen3.6）不支持 embedding';
        }
        throw new Error(`Embedding API ${response.status}: ${body.slice(0, 200)}${hint}`);
      }

      const data = await response.json() as {
        embeddings?: number[][];
        data?: Array<{ embedding?: number[]; index?: number }>;
      };

      // 响应解析：Ollama → data.embeddings[]；
      // OpenAI 兼容（OVMS / OpenAI）→ data.data[].embedding，按 index 升序对齐输入顺序
      let vecs: number[][] | undefined;
      if (isOllama) {
        vecs = data.embeddings;
      } else if (Array.isArray(data.data)) {
        vecs = [...data.data]
          .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
          .map((d) => d?.embedding)
          .filter((v): v is number[] => Array.isArray(v));
      }

      if (!vecs || vecs.length === 0) {
        const respPreview = JSON.stringify(data).slice(0, 300);
        const label = isOllama ? "Ollama /api/embed" : "OpenAI-compatible /embeddings";
        log.warn(`${label} returned no embedding data`, { model, baseURL, responsePreview: respPreview, inputsLen: inputs.length });
        throw new Error(
          `Embedding API returned no embedding data (model=${model}, response=${respPreview})`,
        );
      }

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
      // v2.5.2: 过滤含 NaN/Infinity 的向量，防止下游污染 M 矩阵
      const cleanVecs: number[][] = [];
      for (let i = 0; i < vecs.length; i++) {
        const v = vecs[i];
        let hasBad = false;
        for (let j = 0; j < v.length; j++) {
          if (!Number.isFinite(v[j])) { hasBad = true; break; }
        }
        if (hasBad) {
          log.warn("向量含 NaN/Infinity，已丢弃", { model, inputIndex: i, inputLen: inputs.length });
        } else {
          cleanVecs.push(v);
        }
      }
      if (cleanVecs.length === 0 && vecs.length > 0) {
        throw new Error(`Embedding model returned all NaN vectors (model=${model})`);
      }
      return cleanVecs;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastErr.push(error);

      /**
       * 4xx 默认不重试（重试也不会成功，如 400 无效模型 / 401 鉴权失败）。
       *
       * v2.8.x: 但 **404 例外** —— 实测 OVMS 会在并发/资源未就绪时对
       * `/v3/embeddings` 返回 404 `{"error":"Mediapipe graph definition with requested
       * name is not found"}`，而**同一个 URL、同一个模型名在紧邻的请求中成功**
       * （证据：一次 reEmbed 中 4/8 节点失败，另有节点 4/5 chunks 成功 —— 失败是"部分性"
       * 的，不是配置错误；用户同地址 20 并发 curl 全部 200）。
       * 既然 404 在这里是瞬时资源问题而非客户端错误，就必须允许重试。
       *
       * 成本控制：404 只重试 **1 次**（不消耗完整退避预算），
       * 因此真正写错模型名时也只是多花约 1s 后失败，不会显著拖慢。
       */
      const statusMatch = error.message.match(/Embedding API (\d{3})/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const isClientError = status >= 400 && status < 500;
      const isRetryable404 = status === 404;
      if (isClientError && !error.message.includes("429")) {
        if (!isRetryable404 || attempt >= 1) throw error;
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
  apiFormat: EmbedApiFormat;
  baseURL: string;
  /** 完整请求 URL（由 resolveEmbedEndpoint 解析，performEmbedRequest 直接用） */
  url: string;
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
  // 端点解析复用 resolveEmbedEndpoint —— 引擎/bench 单一事实来源，避免逻辑漂移
  const ep = resolveEmbedEndpoint(config);
  const expectedDim = config.dimensions;
  const cacheSize = config.cacheSize ?? DEFAULT_EMBED_CACHE_SIZE;
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_EMBED_CACHE_TTL_MS;
  const cacheLabel = `${ep.baseURL}|${ep.model}`;
  const cache = getSharedEmbedCache(cacheLabel, cacheSize, cacheTtlMs);
  const maxConcurrency = config.maxConcurrency ?? DEFAULT_EMBED_MAX_CONCURRENCY;
  const semaphore = getSemaphore(ep.baseURL, ep.model, maxConcurrency);
  return {
    apiFormat: ep.apiFormat,
    apiKey: ep.apiKey,
    baseURL: ep.baseURL,
    url: ep.url,
    model: ep.model,
    keepAlive: ep.keepAlive,
    expectedDim,
    cache,
    cacheLabel,
    semaphore,
    options: ep.options,
  };
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
      const vecs = await performEmbedRequest(c, [text]);
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
// v2.8.x: 单请求最大文本数 16 → 32。Ollama /api/embed 的 input 数组由服务端批处理，
// 更大批次减少请求往返；配合 maxConcurrency 并发子批次，GPU 利用率更高。
// v2.8.x: 改为可配置（embedding.batchSize），默认仍为 32；本地弱 CPU 可调小以降低单请求超时风险。
const DEFAULT_BATCH_SIZE = 32;

/**
 * v2.8.x: 子批次切分（条数上限 + 可选总长度预算）。
 *
 * 只按条数装箱时，单请求工作量方差极大——32 条 10 字 vs 32 条 800 字相差
 * 数十倍，固定的批量超时（120s）因而时松时紧，长文本场景易被击穿后触发
 * 重试风暴。给定 maxBatchChars 后改为「长度感知」装箱：
 * 累计字符数再加下一条会超预算时，当前子批次封箱，该条进入下一个子批次
 * （同一次调用内继续提交；不是推迟到未来的调度轮次）。
 *
 * 保证：
 *   - 每个子批次条数 ≤ batchSize，字符数 ≤ maxBatchChars（单条自身超预算时除外）
 *   - 单条自身超预算时独占一个子批次 → 严格前进，不会死循环/饿死
 *   - maxBatchChars <= 0 时退化为纯按条数切分，与旧实现逐字节等价
 *   - 不改变输入顺序（子批次内保序，配合并发限流不影响结果回填）
 */
function splitSubBatches(
  toEmbed: number[],
  textLen: (index: number) => number,
  batchSize: number,
  maxBatchChars: number,
): number[][] {
  const useCharBudget = maxBatchChars > 0;
  const out: number[][] = [];
  let cur: number[] = [];
  let curChars = 0;
  for (const i of toEmbed) {
    const len = textLen(i);
    const countFull = cur.length >= batchSize;
    // cur.length > 0 条件：单条超预算时不无限等待，让它独占一个子批次
    const charsFull = useCharBudget && cur.length > 0 && curChars + len > maxBatchChars;
    if ((countFull || charsFull) && cur.length > 0) {
      out.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(i);
    curChars += len;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export function createBatchEmbedFn(config: EmbeddingConfig): BatchEmbedFn {
  const c = buildEmbedClient(config);
  // v2.8.x: 批次大小可配——非法/非正值回退默认，避免 0 导致批次切分死循环。
  const batchSize = Number.isFinite(config.batchSize) && (config.batchSize as number) >= 1
    ? Math.floor(config.batchSize as number)
    : DEFAULT_BATCH_SIZE;
  // v2.8.x: 动态批处理的总长度预算（<= 0 / 非有限值 = 关闭）
  const maxBatchChars = Number.isFinite(config.maxBatchChars) && (config.maxBatchChars as number) > 0
    ? Math.floor(config.maxBatchChars as number)
    : 0;

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

    // v2.8.x: 子批次并发发送（此前串行 for 循环，未利用 maxConcurrency）。
    // 信号量 acquire 自然限流：并发数 ≤ maxConcurrency（本地 Ollama 默认 8），
    // 每请求携带 ≤ batchSize 文本，GPU 批处理利用率更高。
    // v2.8.x: 装箱同时受 maxBatchChars（总长度预算，可选）约束——见 splitSubBatches。
    const subBatches = splitSubBatches(toEmbed, (i) => texts[i].length, batchSize, maxBatchChars);
    await Promise.all(
      subBatches.map(async (idxs) => {
        const inputs = idxs.map((i) => texts[i]);
        const release = await c.semaphore.acquire();
        try {
          const vecs = await performEmbedRequest(
            c, inputs,
            // v2.8.x: 批量请求放宽到 120s（输入多为 32 段文本，弱 CPU 下 30s 易误超时）
            120_000,
          );
          for (let k = 0; k < idxs.length; k++) {
            const v = vecs[k];
            if (v && v.length) {
              out[idxs[k]] = v;
              if (c.cache) c.cache.set(hash64(texts[idxs[k]]), v);
            }
          }
        } catch (err) {
          // 子批次整体失败：该批置 null（调用方跳过），避免整批功亏一篑
          // 单文本失败造成的少量缺失由调用方（建图/召回）用 FTS 兜底
          // v2.8.x: 记录错误到日志——此前完全静默，Ollama 模型 404 / baseURL 不可达时
          // 会表现为"全部嵌入失败"且无任何线索（如 gm_reembed failed=37319）。
          // 带 baseURL + 首个文本前缀，便于快速定位是连接/模型/输入问题。
          log.warn(`batch sub-batch failed (${idxs.length} texts)`, {
            url: c.url, apiFormat: c.apiFormat, model: c.model, baseURL: c.baseURL,
            expectedDim: c.expectedDim,
            error: (err as Error)?.message ?? String(err),
          });

          /**
           * v2.8.x: 降级为**逐条重发**。
           *
           * 动因：实测 OVMS 对 `/v3/embeddings` 会间歇性返回 404
           * `Mediapipe graph definition with requested name is not found`，而同一
           * URL/模型在紧邻请求中成功 —— 端点没配错，是**批量请求**被后端拒绝。
           * 旧行为只有"整批置 null"，于是 8 个节点直接丢失（reEmbed 4/8 failed）。
           * 逐条重发把「批量失败」降级为「变慢但保住数据」。
           *
           * 短路：连续 2 条单发也失败 → 判定为系统性故障（如模型名真的写错、后端已挂），
           * 立即放弃剩余条目，避免把「一次批量失败」放大成 N 倍请求风暴。
           */
          if (idxs.length > 1) {
            let consecutiveFails = 0;
            let recovered = 0;
            for (const i of idxs) {
              if (consecutiveFails >= 2) break; // 系统性故障，放弃剩余
              try {
                const vecs = await performEmbedRequest(
                  c, [texts[i]],
                  120_000,
                );
                const v = vecs[0];
                if (v && v.length) {
                  out[i] = v;
                  if (c.cache) c.cache.set(hash64(texts[i]), v);
                  recovered++;
                  consecutiveFails = 0;
                } else {
                  consecutiveFails++;
                }
              } catch (oneErr) {
                consecutiveFails++;
                log.warn("batch item retry failed (single-input request also rejected)", {
                  url: c.url, model: c.model,
                  inputChars: texts[i]?.length ?? 0,
                  error: (oneErr as Error)?.message ?? String(oneErr),
                });
              }
            }
            if (recovered > 0) {
              log.info("batch sub-batch recovered by single-input retries", {
                url: c.url, recovered, attempted: idxs.length,
              });
            }
          }
        } finally {
          release();
        }
      }),
    );
    return out;
  };
}
