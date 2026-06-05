/**
 * graph-memory-pro — Neo4j 数据操作层
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";
import { createHash } from "crypto";
import type { GmNode, GmEdge, GmMessage, NodeType, EdgeType, CommunitySummary } from "../types.ts";
import { getSession } from "./db.ts";

// ─── Schema 初始化 ──────────────────────────────────────────

export async function ensureSchema(driver: Driver): Promise<void> {
  const session = getSession(driver);
  try {
    // 约束: 节点 id 唯一
    await session.run(
      "CREATE CONSTRAINT gm_node_id IF NOT EXISTS FOR (n:Task|Skill|Event) REQUIRE n.id IS UNIQUE"
    );
    // 约束: 消息 id 唯一
    await session.run(
      "CREATE CONSTRAINT gm_message_id IF NOT EXISTS FOR (m:GmMessage) REQUIRE m.id IS UNIQUE"
    );
    // 索引: 节点状态
    await session.run(
      "CREATE INDEX gm_node_status IF NOT EXISTS FOR (n:Task|Skill|Event) ON (n.status)"
    );
    // 索引: 节点社区
    await session.run(
      "CREATE INDEX gm_node_community IF NOT EXISTS FOR (n:Task|Skill|Event) ON (n.communityId)"
    );
    // 索引: 消息会话
    await session.run(
      "CREATE INDEX gm_message_session IF NOT EXISTS FOR (m:GmMessage) ON (m.sessionKey)"
    );

    // 向量索引 (Neo4j 5.11+): 用于语义搜索和去重
    try {
      await session.run(`
        CALL db.index.vector.createNodeIndex(
          'gm_node_embedding', '节点嵌入',
          1024, 'cosine'
        )
      `);
    } catch {
      // 可能已存在
    }

    // 社区摘要向量索引
    try {
      await session.run(`
        CALL db.index.vector.createNodeIndex(
          'gm_community_embedding', '社区嵌入',
          1024, 'cosine'
        )
      `);
    } catch {
      // 可能已存在
    }

    // 社区摘要约束
    try {
      await session.run(
        "CREATE CONSTRAINT gm_community_id IF NOT EXISTS FOR (c:GmCommunity) REQUIRE c.id IS UNIQUE"
      );
    } catch {
      // 可能已存在
    }
  } finally {
    await session.close();
  }
}

// ─── 节点 CRUD ──────────────────────────────────────────────

export async function upsertNode(
  driver: Driver,
  node: GmNode,
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      `MERGE (n:${node.type} {id: $id})
       SET n.name = $name,
           n.description = $description,
           n.content = $content,
           n.status = $status,
           n.pagerank = $pagerank,
           n.validatedCount = $validatedCount,
           n.createdAt = $createdAt,
           n.updatedAt = $updatedAt
       `,
      {
        id: node.id,
        name: node.name,
        description: node.description,
        content: node.content,
        status: node.status,
        pagerank: node.pagerank,
        validatedCount: node.validatedCount,
        createdAt: neo4j.int(node.createdAt),
        updatedAt: neo4j.int(node.updatedAt),
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
    // 使用 CONTAINS 替代 FTS5 (Neo4j 原生不支持 FTS5)
    const result = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE n.name CONTAINS $query
          OR n.description CONTAINS $query
          OR n.content CONTAINS $query
       RETURN n
       ORDER BY n.validatedCount DESC, n.updatedAt DESC
       LIMIT toInteger($limit)`,
      { query, limit },
    );
    return result.records.map((r) => recordToNode(r.get("n")));
  } finally {
    await session.close();
  }
}

export async function vectorSearchWithScore(
  driver: Driver,
  vec: number[],
  topK: number,
): Promise<Array<{ node: GmNode; score: number }>> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `CALL db.index.vector.queryNodes('gm_node_embedding', toInteger($topK), $vec)
       YIELD node, score
       WHERE node.status = 'active'
       RETURN node, score
       ORDER BY score DESC`,
      { vec, topK },
    );
    return result.records.map((r) => ({
      node: recordToNode(r.get("node")),
      score: r.get("score"),
    }));
  } finally {
    await session.close();
  }
}

export async function graphWalk(
  driver: Driver,
  seedIds: string[],
  depth: number,
): Promise<{ nodes: GmNode[]; edges: GmEdge[] }> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH path = (start:Task|Skill|Event)-[r*1..${depth}]-(end:Task|Skill|Event)
       WHERE start.id IN $seedIds
         AND start.status = 'active'
       UNWIND nodes(path) AS n
       UNWIND relationships(path) AS rel
       WITH COLLECT(DISTINCT n) AS nodeList, COLLECT(DISTINCT rel) AS relList
       RETURN nodeList, relList`,
      { seedIds },
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

export async function getEdgeCount(driver: Driver): Promise<number> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (:Task|Skill|Event)-[r]->(:Task|Skill|Event) RETURN count(r) AS c",
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
    return result.records.map((r) => recordToNode(r.get("n")));
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
    return result.records.map((r) => recordToNode(r.get("n")));
  } finally {
    await session.close();
  }
}

// ─── 边 CRUD ────────────────────────────────────────────────

export async function upsertEdge(
  driver: Driver,
  edge: GmEdge,
): Promise<void> {
  const session = getSession(driver);
  try {
    // 先用 MERGE 找到或创建节点关系
    // 不使用 APOC apoc.create.relationship，使用原生 Cypher
    await session.run(
      `MATCH (from:Task|Skill|Event {id: $fromId})
       MATCH (to:Task|Skill|Event {id: $toId})
       MERGE (from)-[r:${edge.type}]->(to)
       SET r.id = $id,
           r.instruction = $instruction,
           r.condition = $condition,
           r.weight = $weight,
           r.createdAt = $createdAt,
           r.updatedAt = $updatedAt
      `,
      {
        fromId: edge.fromId,
        toId: edge.toId,
        id: edge.id,
        instruction: edge.instruction,
        condition: edge.condition ?? null,
        weight: edge.weight,
        createdAt: neo4j.int(edge.createdAt),
        updatedAt: neo4j.int(edge.updatedAt),
      },
    );
  } finally {
    await session.close();
  }
}

export async function mergeNodes(
  driver: Driver,
  keepId: string,
  mergeId: string,
): Promise<void> {
  const session = getSession(driver);
  try {
    // 1. 重新连接 merge 节点的所有关系到 keep 节点
    // 使用原生 Cypher MATCH-MERGE, 不使用 APOC
    await session.run(`
      MATCH (keep:Task|Skill|Event {id: $keepId})
      MATCH (merge:Task|Skill|Event {id: $mergeId})
      OPTIONAL MATCH (merge)-[r]->(target:Task|Skill|Event)
      WHERE target.id <> $keepId
      WITH keep, merge, r, target
      CALL {
        WITH keep, r, target
        MERGE (keep)-[nr:type(r)]->(target)
        SET nr.instruction =
          CASE
            WHEN nr.instruction IS NULL THEN r.instruction
            WHEN r.instruction IS NOT NULL AND nr.instruction <> r.instruction
              THEN nr.instruction + ' | ' + r.instruction
            ELSE nr.instruction
          END,
            nr.weight = nr.weight + r.weight
      }
      WITH keep, merge
      OPTIONAL MATCH (source:Task|Skill|Event)-[r2]->(merge)
      WHERE source.id <> $keepId
      CALL {
        WITH keep, r2, source
        MERGE (source)-[nr2:type(r2)]->(keep)
        SET nr2.instruction =
          CASE
            WHEN nr2.instruction IS NULL THEN r2.instruction
            WHEN r2.instruction IS NOT NULL AND nr2.instruction <> r2.instruction
              THEN nr2.instruction + ' | ' + r2.instruction
            ELSE nr2.instruction
          END,
            nr2.weight = nr2.weight + r2.weight
      }
      WITH keep, merge
      // 合并 validatedCount
      SET keep.validatedCount = keep.validatedCount + merge.validatedCount
      // 标记 merge 节点已合并
      SET merge.status = 'merged', merge.updatedAt = timestamp()
    `, { keepId, mergeId });
  } finally {
    await session.close();
  }
}

export async function getEdgesForNodes(
  driver: Driver,
  nodeIds: string[],
): Promise<GmEdge[]> {
  if (!nodeIds.length) return [];
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (from:Task|Skill|Event)-[r]->(to:Task|Skill|Event)
       WHERE from.id IN $nodeIds AND to.id IN $nodeIds
       RETURN r`,
      { nodeIds },
    );
    return result.records.map((r) => recordToEdge(r.get("r"))).filter(Boolean) as GmEdge[];
  } finally {
    await session.close();
  }
}

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
    return result.records.map((r) => recordToNode(r.get("n")));
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
    return result.records.map((r) => recordToNode(r.get("n")));
  } finally {
    await session.close();
  }
}

// ─── 向量索引 ──────────────────────────────────────────────

export async function saveVector(
  driver: Driver,
  nodeId: string,
  _content: string,
  vec: number[],
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      `MATCH (n:Task|Skill|Event {id: $nodeId})
       SET n.embedding = $vec`,
      { nodeId, vec },
    );
  } finally {
    await session.close();
  }
}

export async function getVectorHash(
  driver: Driver,
  _nodeId: string,
): Promise<string> {
  // 在 Neo4j 中我们不存储 hash 到单独的字段
  // 返回空字符串表示始终需要重新计算 embedding
  return "";
}

// ─── 消息存储 ──────────────────────────────────────────────

export async function saveMessage(
  driver: Driver,
  msg: GmMessage,
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      `MERGE (m:GmMessage {id: $id})
       SET m.sessionKey = $sessionKey,
           m.turnIndex = toInteger($turnIndex),
           m.role = $role,
           m.content = $content,
           m.createdAt = $createdAt`,
      {
        id: msg.id,
        sessionKey: msg.sessionKey,
        turnIndex: neo4j.int(msg.turnIndex),
        role: msg.role,
        content: msg.content,
        createdAt: neo4j.int(msg.createdAt),
      },
    );
  } finally {
    await session.close();
  }
}

export async function getSessionMessages(
  driver: Driver,
  sessionKey: string,
  limit: number,
): Promise<GmMessage[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (m:GmMessage {sessionKey: $sessionKey})
       RETURN m
       ORDER BY m.createdAt DESC
       LIMIT toInteger($limit)`,
      { sessionKey, limit },
    );
    return result.records
      .map((r) => {
        const props = r.get("m").properties;
        return {
          id: props.id,
          sessionKey: props.sessionKey,
          turnIndex: props.turnIndex?.toNumber?.() ?? 0,
          role: props.role,
          content: props.content,
          createdAt: props.createdAt?.toNumber?.() ?? 0,
        } as GmMessage;
      })
      .reverse();
  } finally {
    await session.close();
  }
}

export async function getRecentDistinctMessages(
  driver: Driver,
  sessionKey: string,
  limit: number,
): Promise<GmMessage[]> {
  const messages = await getSessionMessages(driver, sessionKey, limit * 2);
  // 去重
  const seen = new Set<string>();
  const distinct: GmMessage[] = [];
  for (const msg of messages) {
    const key = `${msg.role}:${msg.content.slice(0, 100)}`;
    if (!seen.has(key)) {
      seen.add(key);
      distinct.push(msg);
    }
  }
  return distinct.slice(0, limit);
}

// ─── 辅助函数 ──────────────────────────────────────────────

function recordToNode(rec: any): GmNode | null {
  if (!rec || !rec.properties) return null;
  const p = rec.properties;
  return {
    id: p.id,
    type: p.type ?? rec.labels?.[0] ?? "TASK",
    name: p.name ?? "",
    description: p.description ?? "",
    content: p.content ?? "",
    status: p.status ?? "active",
    communityId: p.communityId,
    pagerank: typeof p.pagerank === "number" ? p.pagerank : (p.pagerank?.toNumber?.() ?? 0),
    validatedCount: p.validatedCount?.toNumber?.() ?? 0,
    createdAt: p.createdAt?.toNumber?.() ?? 0,
    updatedAt: p.updatedAt?.toNumber?.() ?? 0,
    embedding: p.embedding,
  };
}

function recordToEdge(rec: any): GmEdge | null {
  if (!rec || !rec.properties) return null;
  const p = rec.properties;
  return {
    id: p.id ?? `${rec.start?.elementId}-${rec.end?.elementId}-${rec.type}`,
    type: rec.type,
    fromId: p.fromId ?? rec.start?.elementId,
    toId: p.toId ?? rec.end?.elementId,
    instruction: p.instruction ?? "",
    condition: p.condition,
    weight: p.weight ?? 1,
    createdAt: p.createdAt?.toNumber?.() ?? 0,
    updatedAt: p.updatedAt?.toNumber?.() ?? 0,
  };
}
