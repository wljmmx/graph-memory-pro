/**
 * v2.4.0 重排与多阶段检索评分（点 4 + 点 5）
 *
 * 纯函数，无外部依赖，便于单测：
 * - temporalRecency: 节点新鲜度（基于 validTo / updatedAt），0~1
 * - combineScore:    融合 向量相似度 / 重要性 / 时序新鲜度 / 过时惩罚 的最终排序分
 */

import type { GmNode } from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 节点时序新鲜度 ∈ [0,1]。
 *
 * - 已过期（validTo 在过去）→ 0
 * - transitions 状态（待消解）→ 额外惩罚
 * - 否则按 updatedAt 年龄做指数衰减：fresh = exp(-age / halfLife)
 *
 * @param node 节点
 * @param now 当前时间戳（ms）
 * @param halfLifeDays 半衰期（天，默认 30）
 */
export function temporalRecency(node: GmNode, now: number, halfLifeDays = 30): number {
  // 已失效（软替换/过期）→ 直接 0
  if (typeof node.validTo === "number" && node.validTo > 0 && node.validTo < now) {
    return 0;
  }
  // 待消解冲突节点 → 强惩罚
  if (node.state === "transitional") return 0;
  if (node.state === "superseded") return 0;

  const age = Math.max(0, now - (node.updatedAt ?? node.createdAt ?? now));
  const halfLifeMs = halfLifeDays * DAY_MS;
  return Math.exp(-age / halfLifeMs);
}

/**
 * 融合排序分。
 *
 * score = temporalWeight × recency + (1 - temporalWeight) × base
 * 其中 base = (1 - staleness) × (importance / pagerank 取其一)
 * 向量相似度（vectorSim）作为主分，importance/pagerank 作为次级加权。
 *
 * @param params
 * @returns 综合排序分（越大越靠前）
 */
export function combineScore(params: {
  vectorSim?: number;
  importance?: number;
  pagerank?: number;
  staleness?: number;
  recency?: number;
  temporalWeight?: number;
}): number {
  const temporalWeight = params.temporalWeight ?? 0.3;

  // 语义相似度主分（0 缺省则以重要性/pagerank 兜底）
  const sim = params.vectorSim ?? 0;

  // 结构重要性（importance 优先，回退 pagerank）
  const structure = params.importance ?? params.pagerank ?? 0;

  // 过时惩罚
  const staleness = params.staleness ?? 0;
  const freshness = 1 - Math.min(1, Math.max(0, staleness));

  const base = sim * 0.7 + structure * 0.3 * freshness;
  const recency = params.recency ?? 1;

  return (1 - temporalWeight) * base + temporalWeight * recency;
}

/**
 * 在候选集中，用 query 向量对每个节点做余弦相似度（应用层细化）。
 *
 * 需节点携带 chunkEmbeddings（分块向量）或 embedding（主向量）。
 * 返回 Map<nodeId, bestSimilarity>，分块向量取各块与 query 的最大相似度。
 */
export function computeChunkSimilarities(
  queryVec: number[],
  nodes: GmNode[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of nodes) {
    let best = -Infinity;
    const candidates: number[][] = [];
    if (Array.isArray(n.chunkEmbeddings) && n.chunkEmbeddings.length > 0) {
      candidates.push(...n.chunkEmbeddings);
    }
    if (Array.isArray(n.embedding) && n.embedding.length > 0) {
      candidates.push(n.embedding);
    }
    for (const c of candidates) {
      const s = cosineSimilarity(queryVec, c);
      if (s > best) best = s;
    }
    if (best !== -Infinity) out.set(n.id, best);
  }
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
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