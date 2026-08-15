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

/**
 * v2.4.1: 按 (createdAt, id) 键集分页读取会话消息，升序返回。
 * 用于大批量重建（11万级）时流式读取，避免单次 LIMIT 拉全量。
 */
export async function getSessionMessagesPage(
  driver: Driver,
  sessionKey: string,
  afterCreatedAt: number,
  afterId: string,
  limit: number,
): Promise<GmMessage[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (m:GmMessage {sessionKey: $sessionKey})
       WHERE m.createdAt > $afterCreatedAt
          OR (m.createdAt = $afterCreatedAt AND m.id > $afterId)
       RETURN m
       ORDER BY m.createdAt ASC, m.id ASC
       LIMIT toInteger($limit)`,
      {
        sessionKey,
        afterCreatedAt: neo4j.int(afterCreatedAt),
        afterId,
        limit,
      },
    );
    return result.records.map((r) => {
      const props = r.get("m").properties;
      return {
        id: props.id,
        sessionKey: props.sessionKey,
        turnIndex: props.turnIndex?.toNumber?.() ?? 0,
        role: props.role,
        content: props.content,
        createdAt: props.createdAt?.toNumber?.() ?? 0,
      } as GmMessage;
    });
  } finally {
    await session.close();
  }
}

/**
 * v2.4.1: 类型容错的键集分页。导入的数据可能绕过 saveMessage 直写，
 * createdAt 可能是 integer（saveMessage）或 string（ISO，外部导入）。
 * 与 int 参数比较时 string 恒为 null → 全部行被过滤 → 会话恒 0 对。
 * 本函数首页不带 WHERE（同时探测 createdAt 实际类型），后续页按实际类型分页。
 *
 * v2.4.2: 新增 unprocessedOnly——增量重建用。只返回未标记已处理
 * （rebuildProcessedAt IS NULL）的消息，配合 markMessagesProcessed 实现
 * 「新增消息在末尾、每次只处理增量」的时序语义，避免从头重扫已处理消息。
 */
export async function getSessionMessagesPageTolerant(
  driver: Driver,
  sessionKey: string,
  after: { createdAt: number | string; id: string } | null,
  limit: number,
  unprocessedOnly = false,
): Promise<{ rows: Array<{ id: string; role: string; content: string; createdAt: number | string }>; createdAtIsString: boolean }> {
  const session = getSession(driver);
  try {
    const firstPageWhere = unprocessedOnly ? " WHERE m.rebuildProcessedAt IS NULL" : "";
    const pageWhere = unprocessedOnly ? "\n            AND m.rebuildProcessedAt IS NULL" : "";
    const result = after === null
      ? await session.run(
        `MATCH (m:GmMessage {sessionKey: $sessionKey})${firstPageWhere}
         RETURN m
         ORDER BY m.createdAt ASC, m.id ASC
         LIMIT toInteger($limit)`,
        { sessionKey, limit },
      )
      : await session.run(
        `MATCH (m:GmMessage {sessionKey: $sessionKey})
         WHERE m.createdAt > $afterCreatedAt
            OR (m.createdAt = $afterCreatedAt AND m.id > $afterId)${pageWhere}
         RETURN m
         ORDER BY m.createdAt ASC, m.id ASC
         LIMIT toInteger($limit)`,
        {
          sessionKey,
          afterCreatedAt: typeof after.createdAt === "number" ? neo4j.int(after.createdAt) : after.createdAt,
          afterId: after.id,
          limit,
        },
      );
    const rows = result.records.map((r) => {
      const props = r.get("m").properties;
      return {
        id: String(props.id ?? ""),
        role: String(props.role ?? ""),
        content: String(props.content ?? ""),
        createdAt: (props.createdAt?.toNumber?.() ?? props.createdAt ?? 0) as number | string,
      };
    });
    return { rows, createdAtIsString: rows.length > 0 && typeof rows[0].createdAt === "string" };
  } finally {
    await session.close();
  }
}

/**
 * v2.4.2: 标记一批消息已重建处理（增量重建用）。
 * 幂等：重复标记无害。打上 rebuildProcessedAt 后，增量重建会跳过这些消息，
 * 只处理新增（未标记）消息，避免时序消息排在末尾迟迟不被处理。
 */
export async function markMessagesProcessed(
  driver: Driver,
  sessionKey: string,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  const session = getSession(driver);
  try {
    await session.run(
      `MATCH (m:GmMessage {sessionKey: $sessionKey})
       WHERE m.id IN $ids
       SET m.rebuildProcessedAt = $ts`,
      { sessionKey, ids, ts: neo4j.int(Date.now()) },
    );
  } finally {
    await session.close();
  }
}

/**
 * v2.4.1: 枚举所有出现过的会话 key（用于批量重建遍历全部会话）。
 */
export async function listAllSessionKeys(driver: Driver): Promise<string[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (m:GmMessage)
       WHERE m.sessionKey IS NOT NULL
       WITH DISTINCT m.sessionKey AS k
       RETURN k`,
    );
    return result.records
      .map((r) => r.get("k"))
      .filter((k): k is string => typeof k === "string" && k.length > 0);
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
