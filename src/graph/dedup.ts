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
import { createLogger, describeError } from "../logger.ts";

const log = createLogger("dedup");

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
    /**
     * v2.8.x: 优先用内建 `vector.similarity.cosine()`，失败才回落到「列表下标」版。
     *
     * 动因：旧实现用
     *   `reduce(dot = 0.0, i IN range(0, size(va) - 1) | dot + va[i] * vb[i])`
     * 这是对 `LIST<FLOAT>` 的**下标索引**。而 Neo4j 2025+ 引入原生 VECTOR 类型后，
     * 被向量索引索引的属性可能以 VECTOR 物化（驱动侧表现为 `Float64Vector`），
     * 此时 `size()` / `va[i]` 都不成立 —— 现场报错正是
     * `Neo4jError: Float64Vector[...]`（Neo4j 把该值塞进错误消息，长达 4 万字符，
     * 把真正的错误码彻底淹没），dedup 阶段整段失败。
     *
     * `vector.similarity.cosine()` 对 VECTOR 与 LIST<FLOAT> 都成立，且是官方推荐用法；
     * 维度不一致时返回 null（被 `cosineSimilarity IS NOT NULL` 过滤掉），不必再手写
     * sqrt/norm。老版本 Neo4j 没有该函数 → 回落到下标版，行为与旧实现一致。
     */
    const pairs = await (async () => {
      try {
        return await runCosineQuery(session, cfg, "vector");
      } catch (err) {
        log.warn(
          "dedup: vector.similarity.cosine path failed — falling back to list-index cosine " +
            "(若两条路径都失败，说明 embedding 既不是 VECTOR 也不能下标索引)",
          { error: describeError(err) },
        );
        return await runCosineQuery(session, cfg, "listIndex");
      }
    })();

    return pairs;
  } finally {
    await session.close();
  }
}

/**
 * 执行余弦相似度配对查询。
 *
 * @param mode "vector" 用内建 vector.similarity.cosine（兼容 VECTOR 与 LIST<FLOAT>）；
 *             "listIndex" 用 reduce + 下标（仅适用于 LIST<FLOAT>，老版本 Neo4j 回落路径）
 */
async function runCosineQuery(
  session: ReturnType<typeof getSession>,
  cfg: GmConfig,
  mode: "vector" | "listIndex",
): Promise<DuplicatePair[]> {
  const similarityExpr = mode === "vector"
    ? `vector.similarity.cosine(a.embedding, b.embedding) AS cosineSimilarity`
    : `reduce(dot = 0.0, i IN range(0, size(va) - 1) | dot + va[i] * vb[i]) AS dotProduct,
         sqrt(reduce(sq = 0.0, i IN range(0, size(va) - 1) | sq + va[i] * va[i])) AS normA,
         sqrt(reduce(sq = 0.0, i IN range(0, size(vb) - 1) | sq + vb[i] * vb[i])) AS normB`;

  const midClause = mode === "vector"
    ? `WITH a, b, ${similarityExpr}
       WHERE cosineSimilarity IS NOT NULL AND cosineSimilarity >= $threshold`
    : `WITH a, b, a.embedding AS va, b.embedding AS vb
       WITH a, b, va, vb, ${similarityExpr}
       WHERE size(va) = size(vb) AND normA > 0 AND normB > 0
       WITH a, b, dotProduct / (normA * normB) AS cosineSimilarity
       WHERE cosineSimilarity >= $threshold`;

  const result = await session.run(
    `MATCH (a:Task|Skill|Event {status: 'active'})
       WHERE a.embedding IS NOT NULL
       WITH a
       MATCH (b:Task|Skill|Event {status: 'active'})
       WHERE b.embedding IS NOT NULL
         AND a.id < b.id
         AND a.type = b.type
       ${midClause}
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

    await mergeNodes(driver, keepId, mergeId);
    consumed.add(mergeId);
    merged++;
  }

  return { pairs, merged };
}
