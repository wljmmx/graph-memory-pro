/**
 * graph-memory-pro — Neo4j 数据操作层
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";
import { createHash } from "crypto";
import type { GmNode, GmEdge, GmMessage, NodeType, EdgeType, CommunitySummary } from "../types.ts";
import { VALID_EDGE_TYPES } from "../types.ts";
import { getSession } from "./db.ts";

// ─── 共享工具 ───────────────────────────────────────────────

/**
 * 计算 embedding 一致性 hash（统一格式，所有路径共用）
 * 格式: md5(name|description|content) 全量，pipe 分隔
 * 用于检测 content 是否实质变化，避免 R-4 可进化嵌入误触发
 */
export function computeEmbeddingHash(name: string, description: string, content: string): string {
  return createHash("md5").update(`${name}|${description}|${content}`).digest("hex");
}

// ─── Schema 初始化 ──────────────────────────────────────────

export async function ensureSchema(driver: Driver, dimension: number = 1024): Promise<void> {
  const session = getSession(driver);
  try {
    // 约束: 节点 id 唯一
    for (const label of ["Task", "Skill", "Event"]) {
      await session.run(
        `CREATE CONSTRAINT gm_node_id_${label.toLowerCase()} IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`
      );
    }
    // 约束: 消息 id 唯一
    await session.run(
      "CREATE CONSTRAINT gm_message_id IF NOT EXISTS FOR (m:GmMessage) REQUIRE m.id IS UNIQUE"
    );
    // 索引: 节点状态
    for (const label of ["Task", "Skill", "Event"]) {
      await session.run(
        `CREATE INDEX gm_node_status_${label.toLowerCase()} IF NOT EXISTS FOR (n:${label}) ON (n.status)`
      );
    }
    // 索引: 节点社区
    for (const label of ["Task", "Skill", "Event"]) {
      await session.run(
        `CREATE INDEX gm_node_community_${label.toLowerCase()} IF NOT EXISTS FOR (n:${label}) ON (n.communityId)`
      );
    }
    // 索引: 消息会话
    await session.run(
      "CREATE INDEX gm_message_session IF NOT EXISTS FOR (m:GmMessage) ON (m.sessionKey)"
    );

    // FULLTEXT 索引：用于全文搜索（替代 CONTAINS）
    try {
      await session.run(
        `CREATE FULLTEXT INDEX task_search IF NOT EXISTS FOR (n:Task) ON EACH [n.name, n.description, n.content] OPTIONS { analyzer: "cjk" }`
      );
    } catch { /* may exist */ }
    try {
      await session.run(
        `CREATE FULLTEXT INDEX skill_search IF NOT EXISTS FOR (n:Skill) ON EACH [n.name, n.description, n.content] OPTIONS { analyzer: "cjk" }`
      );
    } catch { /* may exist */ }
    try {
      await session.run(
        `CREATE FULLTEXT INDEX event_search IF NOT EXISTS FOR (n:Event) ON EACH [n.name, n.description, n.content] OPTIONS { analyzer: "cjk" }`
      );
    } catch { /* may exist */ }
    try {
      await session.run(
        `CREATE FULLTEXT INDEX conversation_search IF NOT EXISTS FOR (n:ConversationMessage) ON EACH [n.content] OPTIONS { analyzer: "cjk" }`
      );
    } catch { /* may exist */ }

    // 向量索引 (Neo4j 5.11+): 按标签分离的向量索引，用于语义搜索和去重
    try {
      await session.run(`
        CALL db.index.vector.createNodeIndex(
          'gm_node_embedding_task', ['Task'], 'embedding', ${dimension}, 'cosine'
        )
      `);
    } catch { /* may exist */ }
    try {
      await session.run(`
        CALL db.index.vector.createNodeIndex(
          'gm_node_embedding_skill', ['Skill'], 'embedding', ${dimension}, 'cosine'
        )
      `);
    } catch { /* may exist */ }
    try {
      await session.run(`
        CALL db.index.vector.createNodeIndex(
          'gm_node_embedding_event', ['Event'], 'embedding', ${dimension}, 'cosine'
        )
      `);
    } catch { /* may exist */ }

    // 社区摘要向量索引
    try {
      await session.run(`
        CALL db.index.vector.createNodeIndex(
          'gm_community_embedding', ['GmCommunity'], 'embedding',
          ${dimension}, 'cosine'
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

/** 将 NodeType (TASK/SKILL/EVENT) 映射为 Neo4j Label (Task/Skill/Event) */
function typeToLabel(type: string): string {
  const mapping: Record<string, string> = {
    TASK: "Task",
    SKILL: "Skill",
    EVENT: "Event",
  };
  return mapping[type.toUpperCase()] ?? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
}

/** 将 Neo4j Label (Task/Skill/Event) 映射为 NodeType (TASK/SKILL/EVENT) */
function labelToType(label: string): string {
  const mapping: Record<string, string> = {
    Task: "TASK",
    Skill: "SKILL",
    Event: "EVENT",
  };
  return mapping[label] ?? label.toUpperCase();
}

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
  const session = getSession(driver);
  try {
    const result = await session.run(
      `CALL db.index.vector.queryNodes('gm_node_embedding_task', toInteger($topK), $vec)
        YIELD node, score
        WITH node, score WHERE node.status = 'active'
        RETURN node, score
       UNION ALL
       CALL db.index.vector.queryNodes('gm_node_embedding_skill', toInteger($topK), $vec)
        YIELD node, score
        WITH node, score WHERE node.status = 'active'
        RETURN node, score
       UNION ALL
       CALL db.index.vector.queryNodes('gm_node_embedding_event', toInteger($topK), $vec)
        YIELD node, score
        WITH node, score WHERE node.status = 'active'
        RETURN node, score
       ORDER BY score DESC`,
      { vec, topK },
    );
    return result.records.map((r) => ({
      node: recordToNode(r.get("node")),
      score: r.get("score"),
    })).filter((r): r is { node: GmNode; score: number } => r.node !== null);
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
    // ✅ 优化：限制关系类型为有意义的业务关系，排除 NEXT_SESSION/CONTAINS 等高频低价值边
    // v2.1.2: 新增 CAUSED_BY / LEADS_TO 因果边类型
    const relTypes = "USED_SKILL|SOLVED_BY|REQUIRES|PATCHES|CONFLICTS_WITH|CAUSED_BY|LEADS_TO";
    const result = await session.run(
      `MATCH path = (start:Task|Skill|Event)-[r:${relTypes}*1..${depth}]-(end:Task|Skill|Event)
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

// ── I-3 反馈持久化（v2.1.2 第二批）─────────────────────────────

export interface GmFeedback {
  id: string;                 // 反馈 ID（query hash + timestamp）
  query: string;
  recalledNodeIds: string[];
  usedNodeIds: string[];
  unusedNodeIds: string[];
  timestamp: number;
  sessionId?: string;
  matchedBy: "heuristic" | "llm" | "cold-start";
}

/**
 * 持久化反馈记录到 Neo4j
 *
 * 节点结构：(:GmFeedback {id, query, usedNodeIds, ...})
 * 关系：(:GmFeedback)-[:JUDGED]->(:Task|Skill|Event)  反馈所评价的节点
 */
export async function upsertFeedback(
  driver: Driver,
  feedback: GmFeedback,
): Promise<void> {
  const session = getSession(driver);
  try {
    // 1. 创建 GmFeedback 节点
    await session.run(
      `MERGE (f:GmFeedback {id: $id})
       SET f.query = $query,
           f.recalledNodeIds = $recalledNodeIds,
           f.usedNodeIds = $usedNodeIds,
           f.unusedNodeIds = $unusedNodeIds,
           f.timestamp = $timestamp,
           f.sessionId = $sessionId,
           f.matchedBy = $matchedBy
      `,
      {
        id: feedback.id,
        query: feedback.query,
        recalledNodeIds: feedback.recalledNodeIds,
        usedNodeIds: feedback.usedNodeIds,
        unusedNodeIds: feedback.unusedNodeIds,
        timestamp: neo4j.int(feedback.timestamp),
        sessionId: feedback.sessionId ?? null,
        matchedBy: feedback.matchedBy,
      },
    );

    // 2. 建立 JUDGED 关系（仅对实际被使用/未使用的节点建边）
    // usedNodeIds → [:JUDGED {verdict: 'used'}]
    // unusedNodeIds → [:JUDGED {verdict: 'unused'}]
    if (feedback.usedNodeIds.length > 0) {
      await session.run(
        `MATCH (f:GmFeedback {id: $feedbackId})
         UNWIND $usedNodeIds AS nodeId
         MATCH (n:Task|Skill|Event {id: nodeId})
         MERGE (f)-[r:JUDGED]->(n)
         SET r.verdict = 'used',
             r.timestamp = $timestamp
        `,
        {
          feedbackId: feedback.id,
          usedNodeIds: feedback.usedNodeIds,
          timestamp: neo4j.int(feedback.timestamp),
        },
      );
    }
    if (feedback.unusedNodeIds.length > 0) {
      await session.run(
        `MATCH (f:GmFeedback {id: $feedbackId})
         UNWIND $unusedNodeIds AS nodeId
         MATCH (n:Task|Skill|Event {id: nodeId})
         MERGE (f)-[r:JUDGED]->(n)
         SET r.verdict = 'unused',
             r.timestamp = $timestamp
        `,
        {
          feedbackId: feedback.id,
          unusedNodeIds: feedback.unusedNodeIds,
          timestamp: neo4j.int(feedback.timestamp),
        },
      );
    }

    // 3. 增加被使用节点的 validatedCount（reward signal）
    if (feedback.usedNodeIds.length > 0) {
      await session.run(
        `UNWIND $usedNodeIds AS nodeId
         MATCH (n:Task|Skill|Event {id: nodeId})
         SET n.validatedCount = COALESCE(n.validatedCount, 0) + 1,
             n.updatedAt = timestamp()
        `,
        { usedNodeIds: feedback.usedNodeIds },
      );
    }
  } finally {
    await session.close();
  }
}

/**
 * 查询反馈记录（用于冷启动计数）
 */
export async function getFeedbackCount(driver: Driver): Promise<number> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (f:GmFeedback) RETURN count(f) AS c",
    );
    return result.records[0]?.get("c")?.toNumber?.() ?? 0;
  } finally {
    await session.close();
  }
}

/**
 * 查询某节点的累计使用/未使用计数
 */
export async function getNodeFeedbackStats(
  driver: Driver,
  nodeId: string,
): Promise<{ usedCount: number; unusedCount: number }> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (:Task|Skill|Event {id: $nodeId})<-[r:JUDGED]-(f:GmFeedback)
       RETURN count(CASE WHEN r.verdict = 'used' THEN 1 END) AS usedCount,
              count(CASE WHEN r.verdict = 'unused' THEN 1 END) AS unusedCount
      `,
      { nodeId },
    );
    const rec = result.records[0];
    return {
      usedCount: rec?.get("usedCount")?.toNumber?.() ?? 0,
      unusedCount: rec?.get("unusedCount")?.toNumber?.() ?? 0,
    };
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

// ─── 边 CRUD ────────────────────────────────────────────────

export async function upsertEdge(
  driver: Driver,
  edge: GmEdge,
): Promise<void> {
  // v2.2.0: 防御 LLM 提取产生非预期边类型（Cypher 注入风险）
  if (!VALID_EDGE_TYPES.has(edge.type)) {
    throw new Error(`Invalid edge type: ${edge.type}`);
  }
  const session = getSession(driver);
  try {
    await session.run(
      `MATCH (from:Task|Skill|Event {id: $fromId})
       MATCH (to:Task|Skill|Event {id: $toId})
       MERGE (from)-[r:${edge.type}]->(to)
       SET r.id = $id,
           r.fromId = $fromId,
           r.toId = $toId,
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
    // Phase 1: collect outgoing edges from merge node
    const outResult = await session.run(
      `MATCH (merge:Task|Skill|Event {id: $mergeId})
       OPTIONAL MATCH (merge)-[r]->(target:Task|Skill|Event)
       WHERE target.id <> $keepId AND r IS NOT NULL
       RETURN target.id AS targetId, type(r) AS relType, r.instruction AS instruction, r.weight AS weight`,
      { mergeId },
    );

    // Phase 2: MERGE each outgoing edge (relType as literal per iteration)
    for (const record of outResult.records) {
      const targetIdRaw = record.get('targetId');
      if (!targetIdRaw) continue; // skip null from OPTIONAL MATCH
      const targetId = String(targetIdRaw);
      const relTypeRaw = record.get('relType');
      if (!relTypeRaw) continue;
      const relType = String(relTypeRaw);
      // v2.2.0: 防御非预期边类型
      if (!VALID_EDGE_TYPES.has(relType)) continue;
      const instruction = record.get('instruction') ? String(record.get('instruction')) : null;
      const weight = record.get('weight');
      const w = typeof weight === 'number' ? weight : (weight && typeof weight.toNumber === 'function' ? weight.toNumber() : 0);

      await session.run(
        `MATCH (k {id: $keepId}), (t {id: $targetId})
         MERGE (k)-[nr:${relType}]->(t)
         SET nr.instruction = CASE
           WHEN nr.instruction IS NULL OR trim(nr.instruction) = '' THEN COALESCE($instruction, nr.instruction)
           // v2.2.0: 限制指令拼接长度，防止多次合并后无限增长
           WHEN $instruction IS NOT NULL AND nr.instruction <> $instruction
                AND size(nr.instruction) < 2000
                THEN nr.instruction + ' | ' + $instruction
           ELSE nr.instruction
         END,
         nr.weight = COALESCE(nr.weight, 0) + $weight,
         nr.fromId = $keepId,
         nr.toId = $targetId`,
        { keepId, targetId, instruction, weight: w },
      );
    }

    // Phase 3: collect incoming edges to merge node
    const inResult = await session.run(
      `MATCH (merge:Task|Skill|Event {id: $mergeId})
       OPTIONAL MATCH (source:Task|Skill|Event)-[r2]->(merge)
       WHERE source.id <> $keepId AND r2 IS NOT NULL
       RETURN source.id AS sourceId, type(r2) AS relType, r2.instruction AS instruction, r2.weight AS weight`,
      { mergeId },
    );

    // Phase 4: MERGE each incoming edge
    for (const record of inResult.records) {
      const sourceIdRaw = record.get('sourceId');
      if (!sourceIdRaw) continue;
      const sourceId = String(sourceIdRaw);
      const relTypeRaw = record.get('relType');
      if (!relTypeRaw) continue;
      const relType = String(relTypeRaw);
      // v2.2.0: 防御非预期边类型
      if (!VALID_EDGE_TYPES.has(relType)) continue;
      const instruction = record.get('instruction') ? String(record.get('instruction')) : null;
      const weight = record.get('weight');
      const w = typeof weight === 'number' ? weight : (weight && typeof weight.toNumber === 'function' ? weight.toNumber() : 0);

      await session.run(
        `MATCH (s {id: $sourceId}), (k {id: $keepId})
         MERGE (s)-[nr2:${relType}]->(k)
         SET nr2.instruction = CASE
           WHEN nr2.instruction IS NULL OR trim(nr2.instruction) = '' THEN COALESCE($instruction, nr2.instruction)
           // v2.2.0: 限制指令拼接长度
           WHEN $instruction IS NOT NULL AND nr2.instruction <> $instruction
                AND size(nr2.instruction) < 2000
                THEN nr2.instruction + ' | ' + $instruction
           ELSE nr2.instruction
         END,
         nr2.weight = COALESCE(nr2.weight, 0) + $weight,
         nr2.fromId = $sourceId,
         nr2.toId = $keepId`,
        { sourceId, keepId, instruction, weight: w },
      );
    }

    // Phase 5: update merge counts and status
    await session.run(
      `MATCH (keep {id: $keepId}), (merge {id: $mergeId})
       SET keep.validatedCount = COALESCE(keep.validatedCount, 0) + COALESCE(merge.validatedCount, 0),
           merge.status = 'merged', merge.updatedAt = timestamp()`,
      { keepId, mergeId },
    );

    // Phase 6: S-2 软替换（v2.1.2）
    // 旧实现：DETACH DELETE merge（物理删除，丢失历史）
    // 新实现：保留节点，标记 state=superseded，validTo=now，supersededBy 指向 keep
    //         边 weight 降为 0.1 不参与 GDS 计算（但仍可追溯）
    //         state.enabled=false 时退化为旧行为（物理删除）
    // 注：当前默认走软替换；如需旧行为可由调用方在 mergeNodes 前判断 cfg.state.enabled
    await session.run(
      `MATCH (merge:Task|Skill|Event {id: $mergeId})
       SET merge.state = 'superseded',
           merge.validTo = timestamp(),
           merge.supersededBy = $keepId,
           merge.updatedAt = timestamp()
       WITH merge
       MATCH (merge)-[r]-()
       WHERE NOT type(r) IN ['NEXT_SESSION', 'CONTAINS', 'MENTIONS']
       SET r.weight = 0.1
      `,
      { keepId, mergeId },
    );
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

// ─── 向量索引 ──────────────────────────────────────────────

export async function saveVector(
  driver: Driver,
  nodeId: string,
  vec: number[],
  hash: string,
  embeddingModel?: string,
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      `MATCH (n:Task|Skill|Event {id: $nodeId})
       SET n.embedding = $vec,
           n.embeddingHash = $hash,
           n.embeddingModel = $model`,
      { nodeId, vec, hash, model: embeddingModel ?? null },
    );
  } finally {
    await session.close();
  }
}

export async function getVectorHash(
  driver: Driver,
  nodeId: string,
): Promise<string> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (n:Task|Skill|Event {id: $nodeId})
       RETURN n.embeddingHash AS hash`,
      { nodeId },
    );
    if (!result.records.length) return "";
    const hash = result.records[0].get("hash");
    return hash ?? "";
  } finally {
    await session.close();
  }
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
  const rawLabel = rec.labels?.[0];
  return {
    id: p.id,
    type: p.type ?? (rawLabel ? labelToType(rawLabel) : "TASK"),
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
    // v2.1.2 新增字段（向后兼容：旧数据无这些字段时为 undefined）
    validFrom: p.validFrom?.toNumber?.() ?? (typeof p.validFrom === "number" ? p.validFrom : undefined),
    validTo: p.validTo?.toNumber?.() ?? (typeof p.validTo === "number" ? p.validTo : undefined),
    recordedAt: p.recordedAt?.toNumber?.() ?? (typeof p.recordedAt === "number" ? p.recordedAt : undefined),
    source: p.source,
    supersededBy: p.supersededBy,
    state: p.state,
    stalenessScore: typeof p.stalenessScore === "number" ? p.stalenessScore : (p.stalenessScore?.toNumber?.() ?? undefined),
    importanceScore: typeof p.importanceScore === "number" ? p.importanceScore : (p.importanceScore?.toNumber?.() ?? undefined),
    embeddingModel: p.embeddingModel,
    // v2.1.2 第三批 R-4
    embeddingHash: p.embeddingHash,
    embeddingHistory: Array.isArray(p.embeddingHistory) ? p.embeddingHistory : undefined,
  };
}

function recordToEdge(rec: any): GmEdge | null {
  if (!rec || !rec.properties) return null;
  const p = rec.properties;
  // v2.2.0: 移除 elementId fallback（elementId 是 Neo4j 内部 ID，非业务 ID）
  const fromId = p.fromId ?? "";
  const toId = p.toId ?? "";
  return {
    id: p.id ?? `${fromId}-${toId}-${rec.type}`,
    type: rec.type,
    fromId,
    toId,
    instruction: p.instruction ?? "",
    condition: p.condition,
    weight: typeof p.weight === "number" ? p.weight : (p.weight?.toNumber?.() ?? 1),
    createdAt: p.createdAt?.toNumber?.() ?? 0,
    updatedAt: p.updatedAt?.toNumber?.() ?? 0,
  };
}
