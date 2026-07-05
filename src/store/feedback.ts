/**
 * graph-memory-pro — 反馈持久化（I-3，v2.1.2 第二批）
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";
import { getSession } from "./db.ts";

// ── I-3 反馈持久化（v2.1.2 第二批）─────────────────────────────

export interface GmFeedback {
  id: string;                 // 反馈 ID（query hash + timestamp）
  query: string;
  recalledNodeIds: string[];
  usedNodeIds: string[];
  unusedNodeIds: string[];
  timestamp: number;
  sessionId?: string;
  matchedBy: "heuristic" | "llm" | "cold-start" | "custom";
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
