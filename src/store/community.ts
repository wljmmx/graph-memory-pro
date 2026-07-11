/**
 * graph-memory-pro — 社区管理（Neo4j 数据操作层）
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";
import type { GmNode, CommunitySummary } from "../types.ts";
import { getSession } from "./db.ts";
import { recordToNode } from "./schema.ts";

// ─── 社区管理 ──────────────────────────────────────────────

export async function updateCommunities(
  driver: Driver,
  labels: Map<string, string>,
): Promise<void> {
  const session = getSession(driver);
  try {
    const tx = session.beginTransaction();
    try {
      for (const [nodeId, communityId] of labels) {
        await tx.run(
          `MATCH (n:Task|Skill|Event {id: $nodeId})
           SET n.communityId = $communityId`,
          { nodeId, communityId },
        );
      }
      await tx.commit();
    } catch {
      await tx.rollback();
    }
  } finally {
    await session.close();
  }
}

export async function getCommunitySummary(
  driver: Driver,
  communityId: string,
): Promise<CommunitySummary | null> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (c:GmCommunity {id: $id}) RETURN c`,
      { id: communityId },
    );
    if (!result.records.length) return null;
    const props = result.records[0].get("c").properties;
    return {
      communityId: props.id,
      summary: props.summary,
      memberCount: props.memberCount?.toNumber?.() ?? 0,
      embedding: props.embedding,
    };
  } finally {
    await session.close();
  }
}

export async function getAllCommunitySummaries(
  driver: Driver,
): Promise<Map<string, CommunitySummary>> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (c:GmCommunity) RETURN c",
    );
    const map = new Map<string, CommunitySummary>();
    for (const r of result.records) {
      const props = r.get("c").properties;
      map.set(props.id, {
        communityId: props.id,
        summary: props.summary,
        memberCount: props.memberCount?.toNumber?.() ?? 0,
        embedding: props.embedding,
      });
    }
    return map;
  } finally {
    await session.close();
  }
}

export async function upsertCommunitySummary(
  driver: Driver,
  communityId: string,
  summary: string,
  memberCount: number,
  embedding?: number[],
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      `MERGE (c:GmCommunity {id: $id})
       SET c.summary = $summary,
           c.memberCount = $memberCount,
           c.embedding = $embedding,
           c.updatedAt = timestamp()`,
      { id: communityId, summary, memberCount: neo4j.int(memberCount), embedding: embedding || null },
    );
  } finally {
    await session.close();
  }
}

export async function pruneCommunitySummaries(driver: Driver): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      `MATCH (c:GmCommunity)
       WHERE NOT EXISTS {
         MATCH (n:Task|Skill|Event {communityId: c.id})
       }
       DELETE c`,
    );
  } finally {
    await session.close();
  }
}

export async function communityRepresentatives(
  driver: Driver,
  communityIds: string[],
): Promise<GmNode[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE n.communityId IN $communityIds
       RETURN n
       ORDER BY n.pagerank DESC, n.validatedCount DESC`,
      { communityIds },
    );
    return result.records.map((r) => recordToNode(r.get("n"))).filter((n): n is GmNode => n !== null);
  } finally {
    await session.close();
  }
}

export async function communityVectorSearch(
  driver: Driver,
  vec: number[],
): Promise<Array<{ id: string; summary: string; score: number }>> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `CALL db.index.vector.queryNodes('gm_community_embedding', 5, $vec)
       YIELD node, score
       RETURN node, score
       ORDER BY score DESC`,
      { vec },
    );
    return result.records.map((r) => {
      const props = r.get("node").properties;
      return { id: props.id, summary: props.summary, score: r.get("score") };
    });
  } finally {
    await session.close();
  }
}

/**
 * v2.3.1 性能优化: 合并 communityVectorSearch + communityRepresentatives 为单条 Cypher
 *
 * 旧实现 recallGeneralized 串行两步：
 *   1. communityVectorSearch(driver, vec) → 查询社区向量索引（5 个社区）
 *   2. communityRepresentatives(driver, top3CommunityIds) → 查询这些社区的代表节点
 *
 * 新实现：单条 Cypher 一次完成向量检索 + 代表节点查询，减少一次网络往返（~5-20ms）。
 * 内部逻辑：
 *   - 先向量检索 top-N 社区（默认 3，可配 maxCommunities）
 *   - 对每个社区，匹配其下 status='active' 的节点
 *   - 按 community score × node pagerank 排序，每个社区取 top representatives
 *
 * @param maxCommunities 取前 N 个社区（默认 3，与旧实现 recallGeneralized 一致）
 * @param repsPerCommunity 每个社区最多返回多少代表节点（默认不限制，由调用方 limit 截断）
 */
export async function communityVectorSearchWithReps(
  driver: Driver,
  vec: number[],
  maxCommunities = 3,
): Promise<Array<{ node: GmNode; communityScore: number }>> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `CALL db.index.vector.queryNodes('gm_community_embedding', toInteger($maxCommunities), $vec)
       YIELD node, score
       WITH node.id AS cid, score AS cscore
       WHERE cid IS NOT NULL
       MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE n.communityId = cid
       RETURN n, cscore
       ORDER BY cscore DESC, n.pagerank DESC, n.validatedCount DESC`,
      { vec, maxCommunities },
    );
    return result.records.map((r) => ({
      node: recordToNode(r.get("n")),
      communityScore: r.get("cscore"),
    })).filter((r): r is { node: GmNode; communityScore: number } => r.node !== null);
  } finally {
    await session.close();
  }
}

export async function nodesByCommunityIds(
  driver: Driver,
  communityIds: string[],
  limit: number,
): Promise<GmNode[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE n.communityId IN $communityIds
       RETURN n
       ORDER BY n.pagerank DESC, n.validatedCount DESC
       LIMIT toInteger($limit)`,
      { communityIds, limit },
    );
    return result.records.map((r) => recordToNode(r.get("n"))).filter((n): n is GmNode => n !== null);
  } finally {
    await session.close();
  }
}
