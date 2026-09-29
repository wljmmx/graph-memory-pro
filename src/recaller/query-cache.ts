/**
 * I-1 历史查询缓存（v2.1.2 第二批）
 *
 * LRU 缓存 + 相似 query 加权复用：
 * - 完全相同 query（hash 一致）→ 直接返回缓存结果
 * - 相似 query（cosine >= similarityThreshold）→ 加权返回（缓存结果降权 0.7）
 *
 * 接入点：Recaller.recall() 入口
 */

import type { RecallResult } from "../types.ts";
import { getGraphRevision } from "../store/graph-revision.ts";

interface CacheEntry {
  queryHash: string;
  queryEmbedding?: number[]; // 用于相似度计算（仅在启用相似匹配时存储）
  result: RecallResult;
  timestamp: number;
  hitCount: number;
  /** 条目写入时的图修订号；读取时与当前值比对，不一致即视为失效 */
  graphRevision: number;
}

export interface QueryCacheConfig {
  enabled: boolean;
  maxSize: number;          // LRU 容量，默认 100
  ttlMs: number;           // 过期时间，默认 30min
  similarityThreshold: number; // cosine 相似度阈值，默认 0.95
  // v2.3.1 性能优化: 相似匹配扫描的最大条目数（默认 20）。
  // 旧实现遍历全部缓存条目（maxSize=100），每条做一次 cosine（O(dims)），
  // 100 × 1024 = 102400 次浮点运算。限制为最近 20 条后，运算量降到 1/5。
  // 因 Map 保持插入顺序（LRU 末尾为最新），从末尾倒序扫描即"最近 N 条"。
  similarityScanLimit: number;
}

export const DEFAULT_QUERY_CACHE_CONFIG: QueryCacheConfig = {
  enabled: true,
  maxSize: 100,
  ttlMs: 30 * 60 * 1000,
  similarityThreshold: 0.95,
  similarityScanLimit: 20,
};

/**
 * LRU 历史查询缓存
 *
 * 使用 Map 的插入顺序特性实现 LRU：
 * - get/put 时把条目移到末尾（最新使用）
 * - 超过 maxSize 时删除头部（最久未用）
 */
export class QueryCache {
  private cache = new Map<string, CacheEntry>();
  private readonly cfg: QueryCacheConfig;
  private hits = 0;
  private misses = 0;
  private similarityHits = 0;

  constructor(cfg?: Partial<QueryCacheConfig>) {
    this.cfg = { ...DEFAULT_QUERY_CACHE_CONFIG, ...cfg };
  }

  /**
   * 计算查询的哈希键。
   *
   * v2.8.x: 由 32-bit djb2 换为 64-bit FNV-1a。旧实现只有 32 位，且把长度拼进键里
   * 作为"防碰撞"补偿；两条不同 query 只要 32 位哈希与长度同时相同就会碰撞，
   * 命中后直接返回**另一条 query** 的召回结果。
   */
  private hashQuery(query: string): string {
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let i = 0; i < query.length; i++) {
      h ^= BigInt(query.charCodeAt(i));
      h = (h * prime) & 0xffffffffffffffffn;
    }
    return `q_${h.toString(16)}_${query.length}`;
  }

  /** 精确匹配查询 */
  get(query: string): RecallResult | null {
    if (!this.cfg.enabled) return null;
    const key = this.hashQuery(query);
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    // TTL 检查
    if (Date.now() - entry.timestamp > this.cfg.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    // v2.8.x: 图内容在条目写入后发生了变化 → 该结果不再可信，视为 miss 并清除。
    // 此前只有手动 /api/ops/cache 才能清空，导致写入后同 query 最长 30min 返回旧召回。
    if (entry.graphRevision !== getGraphRevision()) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    // LRU：移到末尾
    this.cache.delete(key);
    this.cache.set(key, { ...entry, hitCount: entry.hitCount + 1 });
    this.hits++;
    return entry.result;
  }

  /**
   * 相似匹配查询（需要外部提供 queryEmbedding）
   * 返回的 result 会带 similarity 衰减权重（× 0.7）
   *
   * v2.3.1 性能优化: 限制扫描条目数为 similarityScanLimit（默认 20），从最近使用条目倒序扫描。
   * 旧实现 O(n) 全量扫描（maxSize=100），限制后扫描量降为 1/5。
   */
  getSimilar(queryEmbedding: number[]): { result: RecallResult; similarity: number } | null {
    if (!this.cfg.enabled || queryEmbedding.length === 0) return null;
    const threshold = this.cfg.similarityThreshold;
    const currentRevision = getGraphRevision();
    let bestMatch: { result: RecallResult; similarity: number } | null = null;

    // v2.3.1: 倒序扫描最近 N 条（Map 末尾为 LRU 最新）
    const entries = Array.from(this.cache.values()).reverse();
    const scanLimit = Math.min(this.cfg.similarityScanLimit, entries.length);
    for (let i = 0; i < scanLimit; i++) {
      const entry = entries[i];
      if (!entry.queryEmbedding) continue;
      if (Date.now() - entry.timestamp > this.cfg.ttlMs) continue;
      // v2.8.x: 图已变化 → 相似复用同样不可信
      if (entry.graphRevision !== currentRevision) continue;

      const sim = cosineSimilarity(queryEmbedding, entry.queryEmbedding);
      if (sim >= threshold && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { result: entry.result, similarity: sim };
      }
    }

    if (bestMatch) {
      this.similarityHits++;
      // 加权降权：相似度越低降权越多
      const weight = 0.7 * bestMatch.similarity;
      return {
        result: applyWeightToResult(bestMatch.result, weight),
        similarity: bestMatch.similarity,
      };
    }
    return null;
  }

  /** 写入缓存 */
  put(query: string, result: RecallResult, queryEmbedding?: number[]): void {
    if (!this.cfg.enabled) return;
    const key = this.hashQuery(query);

    // LRU 容量管理
    if (this.cache.size >= this.cfg.maxSize) {
      // 删除最旧（Map 第一个 key）
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      queryHash: key,
      queryEmbedding,
      result,
      timestamp: Date.now(),
      hitCount: 0,
      graphRevision: getGraphRevision(),
    });
  }

  /** 清理过期条目 */
  evictExpired(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.cfg.ttlMs) {
        this.cache.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  /** 统计信息 */
  getStats() {
    return {
      size: this.cache.size,
      capacity: this.cfg.maxSize,
      hits: this.hits,
      misses: this.misses,
      similarityHits: this.similarityHits,
      hitRate: this.hits + this.misses > 0
        ? (this.hits / (this.hits + this.misses)).toFixed(3)
        : "0",
    };
  }

  /** 清空 */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.similarityHits = 0;
  }
}

// ── 辅助函数 ──────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 对缓存结果应用权重（降权） */
function applyWeightToResult(result: RecallResult, weight: number): RecallResult {
  return {
    nodes: result.nodes.map(n => ({ ...n, pagerank: n.pagerank * weight })),
    edges: result.edges.map(e => ({
      ...e,
      weight: (e.weight ?? 1) * weight,
    })),
    tokenEstimate: result.tokenEstimate,
  };
}
