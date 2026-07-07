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

    // v2.3.1 P0-4 性能优化: 三步合并为单条 Cypher
    // 旧实现（3 次串行 session.run）：
    //   1. MATCH 读旧节点 embedding/hash/history
    //   2. SET 归档 embeddingHistory（条件性）
    //   3. MERGE + SET 主写
    // 新实现（1 次 session.run）：
    //   单条 Cypher 用 OPTIONAL MATCH 读旧节点 + CASE WHEN 决定归档 + MERGE 一次完成
    //
    // R-4 可进化嵌入逻辑保留：
    //   - content 变化（hash 不同）且旧 embedding 存在 → 归档到 embeddingHistory，清空 embedding
    //   - content 未变化或新节点 → 正常写入 hash
    const newContentHash = computeEmbeddingHash(node.name, node.description, node.content);
    const archivedAt = Date.now();

    await session.run(
      `OPTIONAL MATCH (old:${label} {id: $id})
       WITH old,
            CASE
              WHEN old IS NOT NULL
                AND old.embeddingHash IS NOT NULL
                AND old.embeddingHash <> $newContentHash
                AND old.embedding IS NOT NULL
                AND size(old.embedding) > 0
              THEN ([
                {
                  embedding: old.embedding,
                  embeddingModel: old.embeddingModel,
                  embeddingHash: old.embeddingHash,
                  archivedAt: $archivedAt
                }
              ] + COALESCE(old.embeddingHistory, []))[..3]
              ELSE COALESCE(old.embeddingHistory, [])
            END AS newHistory,
            CASE
              WHEN old IS NOT NULL
                AND old.embeddingHash IS NOT NULL
                AND old.embeddingHash <> $newContentHash
                AND old.embedding IS NOT NULL
                AND size(old.embedding) > 0
              THEN true
              ELSE false
            END AS evolvableApplied
       MERGE (n:${label} {id: $id})
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
           n.embeddingHash = CASE
             WHEN evolvableApplied THEN null
             ELSE COALESCE($newContentHash, n.embeddingHash)
           END,
           n.embedding = CASE
             WHEN evolvableApplied THEN null
             ELSE n.embedding
           END,
           n.embeddingHistory = CASE
             WHEN evolvableApplied THEN newHistory
             ELSE COALESCE(n.embeddingHistory, [])
           END,
           n.validTo = $validTo,
           n.supersededBy = $supersededBy,
           n.embeddingModel = $embeddingModel`,
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
        validFrom: node.validFrom ? neo4j.int(node.validFrom) : null,
        validTo: node.validTo ? neo4j.int(node.validTo) : null,
        recordedAt: node.recordedAt ? neo4j.int(node.recordedAt) : null,
        source: node.source ?? null,
        state: node.state ?? null,
        stalenessScore: node.stalenessScore ?? null,
        importanceScore: node.importanceScore ?? null,
        supersededBy: node.supersededBy ?? null,
        embeddingModel: node.embeddingModel ?? null,
        newContentHash,
        archivedAt,
      },
    );
  } finally {
    await session.close();
  }
}

/**
 * v2.3.1 P0-3 性能优化: 批量 upsert 节点
 *
 * 用 UNWIND + MERGE 将多个节点合并为单次 session.run，
 * 替代循环中 N 次 upsertNode 调用（每次 2-3 次 session.run）。
 *
 * 注意：
 *   - 不处理 R-4 可进化嵌入归档（批量场景下 content 变化检测由 reEmbedNodes 周期处理）
 *   - 仅写入基本字段，embeddingHash 用 computeEmbeddingHash 计算
 *   - 适用于 extractInBackground 后台提取的批量写入场景
 *
 * @returns 成功写入的节点数
 */
export async function batchUpsertNodes(
  driver: Driver,
  nodes: GmNode[],
): Promise<number> {
  if (!nodes.length) return 0;
  const session = getSession(driver);
  try {
    const rows = nodes.map((n) => {
      const label = typeToLabel(n.type);
      return {
        id: n.id,
        label,
        name: n.name,
        description: n.description,
        content: n.content,
        type: n.type,
        status: n.status,
        pagerank: n.pagerank,
        validatedCount: n.validatedCount,
        createdAt: neo4j.int(n.createdAt),
        updatedAt: neo4j.int(n.updatedAt),
        embeddingModel: n.embeddingModel ?? null,
        embeddingHash: computeEmbeddingHash(n.name, n.description, n.content),
      };
    });

    // 按 label 分组（UNWIND 无法动态切换 label）
    const byLabel = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!byLabel.has(r.label)) byLabel.set(r.label, []);
      byLabel.get(r.label)!.push(r);
    }

    let totalWritten = 0;
    // 同一 session 内顺序执行不同 label 的批量 MERGE（通常 2-3 个 label）
    for (const [label, batch] of byLabel) {
      const result = await session.run(
        `UNWIND $rows AS row
         MERGE (n:${label} {id: row.id})
         SET n.name = row.name,
             n.description = row.description,
             n.content = row.content,
             n.type = row.type,
             n.status = row.status,
             n.pagerank = row.pagerank,
             n.validatedCount = row.validatedCount,
             n.createdAt = row.createdAt,
             n.updatedAt = row.updatedAt,
             n.embeddingModel = row.embeddingModel,
             n.embeddingHash = row.embeddingHash
         RETURN count(n) AS c`,
        { rows: batch },
      );
      const c = result.records[0]?.get("c");
      totalWritten += (typeof c === "number" ? c : c?.toNumber?.() ?? 0);
    }
    return totalWritten;
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
  // v2.3.1 P1-1 性能优化: 4 个 fulltext 索引并行查询（旧实现 UNION ALL 服务端串行）
  // 旧实现：UNION ALL 在 Neo4j 服务端顺序执行 4 个 fulltext 查询，耗时 ≈ 4T
  // 新实现：应用层 Promise.all 并行 4 个独立 session.run，耗时 ≈ max(T)
  // 失败时 fallback 到 CONTAINS 查询（与旧实现一致）
  const fulltextIndexes = [
    "task_search",
    "skill_search",
    "event_search",
    "conversation_search",
  ] as const;

  try {
    const perIndexResults = await Promise.all(
      fulltextIndexes.map(async (indexName) => {
        const session = getSession(driver);
        try {
          const result = await session.run(
            `CALL db.index.fulltext.queryNodes($indexName, $query, { limit: toInteger($limit) })
             YIELD node AS n, score
             WHERE n.status = 'active' OR n.status IS NULL
             RETURN n, score`,
            { indexName, query, limit },
          );
          return result.records;
        } finally {
          await session.close();
        }
      }),
    );

    // 合并 4 个索引结果，按 nodeId 去重
    const seen = new Map<string, any>();
    for (const records of perIndexResults) {
      for (const r of records) {
        const node = r.get("n");
        if (!node || !node.properties) continue;
        const id = node.properties.id;
        if (!seen.has(id)) {
          seen.set(id, recordToNode(node));
        }
      }
    }

    const nodes = Array.from(seen.values());
    nodes.sort((a, b) => (b.validatedCount ?? 0) - (a.validatedCount ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return nodes.slice(0, limit);
  } catch {
    // ✅ Fallback: 如果 FULLTEXT 索引不可用，回退到 CONTAINS
    const session = getSession(driver);
    try {
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
