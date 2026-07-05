/**
 * graph-memory-pro — 消息存储（Neo4j 数据操作层）
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";
import type { GmMessage } from "../types.ts";
import { getSession } from "./db.ts";

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
