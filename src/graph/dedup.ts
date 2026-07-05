/**
 * graph-memory-pro — 向量去重 (Neo4j 版)
 *
 * 利用 Cypher 余弦相似度批量检测重复节点
 * ✅ 单次查询替代 O(N) 暴力的逐节点 queryNodes 循环
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import { getSession } from "../store/db.ts";
import { findById, mergeNodes } from "../store/store.ts";

export interface DuplicatePair {
  nodeA: string;
  nodeB: string;
  nameA: string;
  nameB: string;
  similarity: number;
}

export interface DedupResult {
  pairs: DuplicatePair[];
  merged: number;
}

/**
 * 批量检测重复节点 — 单条 Cypher 查询，服务端计算余弦相似度
 *
 * 思路：MATCH 所有 active 带 embedding 的节点 → 按类型同组 → 叉积计算余弦相似度
 * → 阈值过滤。复杂度 O(N²) 在 Neo4j 内存完成，100 节点 ≈ 5k 对，无网络往返。
 */
export async function detectDuplicates(driver: Driver, cfg: GmConfig): Promise<DuplicatePair[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (a:Task|Skill|Event {status: 'active'})
       WHERE a.embedding IS NOT NULL
       WITH a
       MATCH (b:Task|Skill|Event {status: 'active'})
       WHERE b.embedding IS NOT NULL
         AND a.id < b.id
         AND a.type = b.type
       WITH a, b,
         a.embedding AS va,
         b.embedding AS vb
       WITH a, b, va, vb,
         reduce(dot = 0.0, i IN range(0, size(va) - 1) | dot + va[i] * vb[i]) AS dotProduct,
         sqrt(reduce(sq = 0.0, i IN range(0, size(va) - 1) | sq + va[i] * va[i])) AS normA,
         sqrt(reduce(sq = 0.0, i IN range(0, size(vb) - 1) | sq + vb[i] * vb[i])) AS normB
       WHERE size(va) = size(vb) AND normA > 0 AND normB > 0
       WITH a, b, dotProduct / (normA * normB) AS cosineSimilarity
       WHERE cosineSimilarity >= $threshold
       RETURN a.id AS nodeA, a.name AS nameA, b.id AS nodeB, b.name AS nameB, cosineSimilarity AS score
       ORDER BY score DESC`,
      { threshold: cfg.dedupThreshold },
    );

    return result.records.map((r) => ({
      nodeA: r.get("nodeA"),
      nodeB: r.get("nodeB"),
      nameA: r.get("nameA"),
      nameB: r.get("nameB"),
      similarity: r.get("score"),
    }));
  } finally {
    await session.close();
  }
}

export async function dedup(driver: Driver, cfg: GmConfig): Promise<DedupResult> {
  const pairs = await detectDuplicates(driver, cfg);
  let merged = 0;
  const consumed = new Set<string>();

  for (const pair of pairs) {
    if (consumed.has(pair.nodeA) || consumed.has(pair.nodeB)) continue;

    const a = await findById(driver, pair.nodeA);
    const b = await findById(driver, pair.nodeB);
    if (!a || !b) continue;
    if (a.type !== b.type) continue;

    let keepId: string, mergeId: string;
    if (a.validatedCount > b.validatedCount) {
      keepId = a.id; mergeId = b.id;
    } else if (b.validatedCount > a.validatedCount) {
      keepId = b.id; mergeId = a.id;
    } else {
      keepId = a.updatedAt >= b.updatedAt ? a.id : b.id;
      mergeId = keepId === a.id ? b.id : a.id;
    }

    await mergeNodes(driver, keepId, mergeId, cfg);
    consumed.add(mergeId);
    merged++;
  }

  return { pairs, merged };
}
