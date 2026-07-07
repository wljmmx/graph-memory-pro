/**
 * graph-memory-pro — 节点 CRUD（Neo4j 数据操作层）
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";
import type { GmNode, GmEdge } from "../types.ts";
import { getSession } from "./db.ts";
import {
  typeToLabel,
  computeEmbeddingHash,
  recordToNode,
  recordToEdge,
} from "./schema.ts";

// ─── 节点 CRUD ──────────────────────────────────────────────

export async function upsertNode(
  driver: Driver,
  node: GmNode,
): Promise<void> {
  const session = getSession(driver);
  try {
    const label = typeToLabel(node.type);

    // v2.1.2 第三批 R-4: 可进化嵌入
    // 检测 content 实质变化（MD5 hash 对比），变化时：
    //   1. 将当前 embedding 归档到 embeddingHistory 数组（保留最近 archiveKeepCount 条）
    //   2. 清空当前 embedding，让下一次 reembed 周期重算
    //   3. 更新 embeddingHash 为新 content 的 hash
    const newContentHash = computeEmbeddingHash(node.name, node.description, node.content);

    let evolvableApplied = false;
    if (node.id) {
      // 读取旧节点的 embedding/embeddingHash/embeddingHistory
      const existing = await session.run(
        `MATCH (n:${label} {id: $id})
         RETURN n.embedding AS embedding,
                n.embeddingHash AS embeddingHash,
                n.embeddingModel AS embeddingModel,
                n.embeddingHistory AS embeddingHistory`,
        { id: node.id },
      );
      const rec = existing.records[0];
      if (rec) {
        const oldHash = rec.get("embeddingHash");
        const oldEmbedding = rec.get("embedding");
        const oldModel = rec.get("embeddingModel");
        const oldHistory = rec.get("embeddingHistory") ?? [];

        // hash 不同且旧 embedding 存在 → content 实质变化
        if (oldHash && oldHash !== newContentHash && oldEmbedding && Array.isArray(oldEmbedding) && oldEmbedding.length > 0) {
          // 归档旧嵌入
          const archived = Array.isArray(oldHistory) ? [...oldHistory] : [];
          archived.unshift({
            embedding: oldEmbedding,
            embeddingModel: oldModel ?? null,
            embeddingHash: oldHash,
            archivedAt: Date.now(),
          });
          // 保留最近 N 条（默认 3）
          const keepCount = 3;
          const trimmed = archived.slice(0, keepCount);

          await session.run(
            `MATCH (n:${label} {id: $id})
             SET n.embeddingHistory = $history,
                 n.embedding = null,
                 n.embeddingHash = $newHash`,
            { id: node.id, history: trimmed, newHash: newContentHash },
          );
          evolvableApplied = true;
        }
      }
    }

    // v2.1.2: 持久化 S-1/S-3/S-13/S-14/G-4 新增字段（全部可选，向后兼容）
    // R-4: 若 evolvable 已应用（content 变化），不覆盖 embeddingHash（保留 null）
    //      若未应用，写入新 hash（若节点新创建，则记录初始 hash）
    const finalEmbeddingHash = evolvableApplied ? null : newContentHash;

    await session.run(
      `MERGE (n:${label} {id: $id})
       SET n.name = $name,
           n.description = $description,
           n.content = $content,
           n.type = $type,
           n.status = $status,
           n.pagerank = $pagerank,
           n.validatedCount = $validatedCount,
           n.createdAt = $createdAt,
           n.updatedAt = $updatedAt,
           n.validFrom = COALESCE($validFrom, $createdAt),
           n.recordedAt = COALESCE($recordedAt, $createdAt),
           n.source = COALESCE($source, 'experience'),
           n.state = COALESCE($state, 'current'),
           n.stalenessScore = COALESCE($stalenessScore, 0.0),
           n.importanceScore = COALESCE($importanceScore, 0.0),
           n.embeddingHash = COALESCE($embeddingHash, n.embeddingHash)
       SET n.validTo = $validTo,
           n.supersededBy = $supersededBy,
           n.embeddingModel = $embeddingModel
       `,
      {
        id: node.id,
        name: node.name,
        description: node.description,
        content: node.content,
        type: node.type,
        status: node.status,
        pagerank: node.pagerank,
        validatedCount: node.validatedCount,
        createdAt: neo4j.int(node.createdAt),
        updatedAt: neo4j.int(node.updatedAt),
        // v2.1.2 新增字段（向后兼容：undefined 时使用默认值）
        validFrom: node.validFrom ? neo4j.int(node.validFrom) : null,
        validTo: node.validTo ? neo4j.int(node.validTo) : null,
        recordedAt: node.recordedAt ? neo4j.int(node.recordedAt) : null,
        source: node.source ?? null,
        state: node.state ?? null,
        stalenessScore: node.stalenessScore ?? null,
        importanceScore: node.importanceScore ?? null,
        supersededBy: node.supersededBy ?? null,
        embeddingModel: node.embeddingModel ?? null,
        embeddingHash: finalEmbeddingHash,
      },
    );
  } finally {
    await session.close();
  }
}

export async function findById(
  driver: Driver,
  id: string,
): Promise<GmNode | null> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (n:Task|Skill|Event {id: $id}) RETURN n`,
      { id },
    );
    if (!result.records.length) return null;
    return recordToNode(result.records[0].get("n"));
  } finally {
    await session.close();
  }
}

export async function searchNodes(
  driver: Driver,
  query: string,
  limit: number,
): Promise<GmNode[]> {
  const session = getSession(driver);
  try {
    // ✅ 优化：使用 FULLTEXT 索引查询替代 CONTAINS
    // 分别查询三个 FULLTEXT 索引，合并去重后排序
    const fulltextResults = await session.run(`
      CALL db.index.fulltext.queryNodes('task_search', $query, { limit: toInteger($limit) })
      YIELD node AS n, score
      WHERE n.status = 'active'
      RETURN n, score
      UNION ALL
      CALL db.index.fulltext.queryNodes('skill_search', $query, { limit: toInteger($limit) })
      YIELD node AS n, score
      WHERE n.status = 'active'
      RETURN n, score
      UNION ALL
      CALL db.index.fulltext.queryNodes('event_search', $query, { limit: toInteger($limit) })
      YIELD node AS n, score
      WHERE n.status = 'active'
      RETURN n, score
      UNION ALL
      CALL db.index.fulltext.queryNodes('conversation_search', $query, { limit: toInteger($limit) })
      YIELD node AS n, score
      RETURN n, score
    `, { query, limit });

    // 去重并按 validatedCount 排序
    const seen = new Map<string, any>();
    for (const r of fulltextResults.records) {
      const node = r.get("n");
      if (!node || !node.properties) continue;
      const id = node.properties.id;
      if (!seen.has(id)) {
        seen.set(id, recordToNode(node));
      }
    }

    const nodes = Array.from(seen.values());
    nodes.sort((a, b) => (b.validatedCount ?? 0) - (a.validatedCount ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return nodes.slice(0, limit);
  } catch {
    // ✅ Fallback: 如果 FULLTEXT 索引不可用，回退到 CONTAINS
    const result = await session.run(
      `MATCH (n:Task|Skill|Event|ConversationMessage) WHERE (n.status = 'active' OR n.status IS NULL)
       AND (
          n.name CONTAINS $query
          OR n.description CONTAINS $query
          OR n.content CONTAINS $query
       )
       RETURN n
       ORDER BY n.validatedCount DESC, n.updatedAt DESC
       LIMIT toInteger($limit)`,
      { query, limit },
    );
    return result.records.map((r) => recordToNode(r.get("n"))).filter((n): n is GmNode => n !== null);
  } finally {
    await session.close();
  }
}

export async function vectorSearchWithScore(
  driver: Driver,
  vec: number[],
  topK: number,
): Promise<Array<{ node: GmNode; score: number }>> {
  // v2.3.1 性能优化: 3 个向量索引并行查询（旧实现 UNION ALL 顺序执行，耗时 ≈ 3T）。
  // 并行后耗时 ≈ max(T)，预期 vec_search 阶段省 ~66% 时间。
  // 每个 session 独立（Neo4j session 非线程安全），结果合并后去重 + 重排。
  const indexNames = [
    "gm_node_embedding_task",
    "gm_node_embedding_skill",
    "gm_node_embedding_event",
  ] as const;

  const perIndexResults = await Promise.all(
    indexNames.map(async (indexName) => {
      const session = getSession(driver);
      try {
        const result = await session.run(
          `CALL db.index.vector.queryNodes($indexName, toInteger($topK), $vec)
           YIELD node, score
           WITH node, score WHERE node.status = 'active'
           RETURN node, score
           ORDER BY score DESC`,
          { indexName, vec, topK },
        );
        return result.records.map((r) => ({
          node: recordToNode(r.get("node")),
          score: r.get("score"),
        })).filter((r): r is { node: GmNode; score: number } => r.node !== null);
      } finally {
        await session.close();
      }
    }),
  );

  // 合并 3 个索引结果，按 nodeId 去重（保留最高 score），再按 score 降序
  const merged = new Map<string, { node: GmNode; score: number }>();
  for (const batch of perIndexResults) {
    for (const item of batch) {
      const existing = merged.get(item.node.id);
      if (!existing || item.score > existing.score) {
        merged.set(item.node.id, item);
      }
    }
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

export async function graphWalk(
  driver: Driver,
  seedIds: string[],
  depth: number,
  maxNodes = 200,
): Promise<{ nodes: GmNode[]; edges: GmEdge[] }> {
  const session = getSession(driver);
  try {
    // ✅ 优化：限制关系类型为有意义的业务关系，排除 NEXT_SESSION/CONTAINS 等高频低价值边
    // v2.1.2: 新增 CAUSED_BY / LEADS_TO 因果边类型
    // v2.3.1 性能优化: 加 LIMIT 限制返回节点数，防止图规模大时返回过多节点
    //       导致后续 PPR 排序开销爆炸。默认 200（recallMaxNodes 通常 ≤ 50，留 4× 余量）。
    const relTypes = "USED_SKILL|SOLVED_BY|REQUIRES|PATCHES|CONFLICTS_WITH|CAUSED_BY|LEADS_TO";
    const result = await session.run(
      `MATCH path = (start:Task|Skill|Event)-[r:${relTypes}*1..${depth}]-(end:Task|Skill|Event)
       WHERE start.id IN $seedIds
         AND start.status = 'active'
       UNWIND nodes(path) AS n
       UNWIND relationships(path) AS rel
       WITH COLLECT(DISTINCT n)[..$maxNodes] AS nodeList, COLLECT(DISTINCT rel)[..$maxNodes] AS relList
       RETURN nodeList, relList`,
      { seedIds, maxNodes },
    );
    if (!result.records.length) return { nodes: [], edges: [] };
    const row = result.records[0];
    const nodeList = row.get("nodeList") as any[];
    const relList = row.get("relList") as any[];

    return {
      nodes: nodeList.map(recordToNode).filter(Boolean) as GmNode[],
      edges: relList.map(recordToEdge).filter(Boolean) as GmEdge[],
    };
  } finally {
    await session.close();
  }
}

export async function getNodeCount(driver: Driver): Promise<number> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (n:Task|Skill|Event {status: 'active'}) RETURN count(n) AS c",
    );
    return result.records[0]?.get("c")?.toNumber?.() ?? 0;
  } finally {
    await session.close();
  }
}

export async function getNodesByType(
  driver: Driver,
  type: string,
  limit?: number,
): Promise<GmNode[]> {
  const session = getSession(driver);
  try {
    const q = limit
      ? `MATCH (n:${type} {status: 'active'}) RETURN n ORDER BY n.validatedCount DESC LIMIT toInteger($limit)`
      : `MATCH (n:${type} {status: 'active'}) RETURN n ORDER BY n.validatedCount DESC`;
    const result = await session.run(q, { limit: limit ?? 0 });
    return result.records.map((r) => recordToNode(r.get("n"))).filter((n): n is GmNode => n !== null);
  } finally {
    await session.close();
  }
}

export async function getTopNodes(
  driver: Driver,
  limit: number,
): Promise<GmNode[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       RETURN n
       ORDER BY n.pagerank DESC, n.validatedCount DESC
       LIMIT toInteger($limit)`,
      { limit },
    );
    return result.records.map((r) => recordToNode(r.get("n"))).filter((n): n is GmNode => n !== null);
  } finally {
    await session.close();
  }
}
