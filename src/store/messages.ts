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

/**
 * v2.8.x: 64-bit FNV-1a 内容指纹（16 位十六进制）。
 *
 * 旧写端用 32-bit djb2 且只对 `content.slice(0, 200)` 求值 —— 前 200 字相同的
 * 不同消息会算出同一个 hash，配合位置分量构成同一 id，MERGE 直接相互覆盖（真丢数据）。
 * 改为全文 + 64-bit：碰撞概率降到可忽略，且不再受"前 200 字"影响。
 */
export function messageContentHash(content: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < content.length; i++) {
    h ^= BigInt(content.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * v2.8.x: 稳定消息键 —— **不含位置分量**。
 *
 * 旧键 `gm:<sessionKey>:<turnIndex>:<role>:<hash200>` 把「数组下标」写进了身份。
 * 宿主存在 compaction（`before_compaction`/`after_compaction` 钩子可观测且不可 veto），
 * 会改写历史数组 → 同一逻辑消息的下标变化 → 算出新 id → 插入重复行。
 *
 * 新键 = sessionKey + role + 全文指纹 + 同内容出现序号：
 *   - 历史被压缩/裁剪位移 → 键不变，不重复
 *   - 同内容重复消息（连发两次"继续"）→ seq 区分，不互相覆盖
 *   - 只追加 → 重放算出同一 id → MERGE 幂等
 *
 * @param seq 该 (sessionKey, role, contentHash) 在会话内的 0 基出现序号
 */
export function buildMessageId(
  sessionKey: string,
  role: "user" | "assistant",
  contentHash: string,
  seq: number,
): string {
  return `gm:${sessionKey}:${role}:${contentHash}:${seq}`;
}

/** 分组计数的键：role + 全文指纹（与 id 无关，故对旧、新两种 id 方案都成立） */
export function messageGroupKey(role: string, contentHash: string): string {
  return `${role}\u0000${contentHash}`;
}

/** 宿主传入的消息块（多模态 content） */
export interface AgentMessageContentBlock {
  type?: string;
  text?: string;
}

/** 宿主 agent_end 传入的单条消息（宽松结构；SDK 契约里 messages 是 unknown[]） */
export interface AgentMessageLike {
  role?: string;
  type?: string;
  content?: string | Array<AgentMessageContentBlock | string>;
  text?: string;
  body?: string;
}

/**
 * v2.8.x: 从一条宿主消息中取出纯文本。
 * 从 index.ts 迁出到本模块，使「过滤 + 取文本 + 生成键」这一整条纯逻辑可被单测直接覆盖
 * （此前测试复制了一份实现，属镜像测试，永远抓不到真实回归）。
 */
export function extractMessageText(msg: AgentMessageLike): string {
  if (!msg) return "";
  const content = msg.content ?? msg.text ?? msg.body ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (typeof b === "string" || b?.type === "text"))
      .map((b) => (typeof b === "string" ? b : b.text ?? ""))
      .join("\n");
  }
  return "";
}

/** 规划出的单条待写消息 */
export interface MessagePersistPlanItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 对账分组键（role + 内容指纹）；调用方需用它回填基线，避免重复实现指纹算法 */
  group: string;
  /** 写入序号（仅诊断用途；不再是身份的一部分） */
  turnIndex: number;
  /** 该 (role, 内容指纹) 在本次数组中的 0 基出现序号 */
  occurrence: number;
  /** true = 库中已有该份数，无需再写（保留同内容重复消息的份数语义，同时不重插历史） */
  alreadyPresent: boolean;
}

/**
 * v2.8.x: 把宿主传入的 messages 规划为待写入清单（纯函数）。
 *
 * 集中承载三件事，供 index.ts 与单测共用同一实现：
 *   1. 过滤：仅 user/assistant 且文本非空
 *   2. 身份：稳定键（sessionKey + role + 全文指纹 + 出现序号），不含位置分量
 *   3. 对账：按「库中已有份数」判断某一份是否已在库 → 跳过，避免键方案切换时重插历史
 *
 * @param existingByGroup 库中 (role, 内容指纹) → 已有份数
 * @param baselineTruncated 基线被截断时不跳过（只保证幂等，不保证不重插）
 */
export function planMessagePersist(
  messages: AgentMessageLike[],
  sessionKey: string,
  existingByGroup?: Map<string, number>,
  baselineTruncated = false,
): MessagePersistPlanItem[] {
  const out: MessagePersistPlanItem[] = [];
  const seenInBatch = new Map<string, number>();
  let turnIndex = 0;
  for (const msg of messages) {
    if (!msg) continue;
    const rawRole = msg.role ?? msg.type ?? "";
    const isUser = /user|human/i.test(rawRole);
    const isAssistant = /assistant/i.test(rawRole);
    if (!isUser && !isAssistant) continue;
    const content = extractMessageText(msg);
    if (!content || !content.trim()) continue;

    const role: "user" | "assistant" = isAssistant ? "assistant" : "user";
    const h = messageContentHash(content);
    const group = messageGroupKey(role, h);
    const occurrence = seenInBatch.get(group) ?? 0;
    seenInBatch.set(group, occurrence + 1);
    const existing = existingByGroup?.get(group) ?? 0;

    out.push({
      id: buildMessageId(sessionKey, role, h, occurrence),
      role,
      content,
      group,
      turnIndex,
      occurrence,
      alreadyPresent: !baselineTruncated && occurrence < existing,
    });
    turnIndex++;
  }
  return out;
}

export async function saveMessage(
  driver: Driver,
  msg: GmMessage,
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      // v2.8.x: createdAt 只在新建时写 —— 旧版无条件 `SET m.createdAt = $createdAt`，
      // 导致每轮 agent_end 全量重放时把整段历史的时间戳刷成本轮时间（真实时间戳不可恢复，
      // 且 markMessagesByContent 依赖 `u.createdAt < a.createdAt` 配对，同毫秒会静默失配）。
      `MERGE (m:GmMessage {id: $id})
       ON CREATE SET m.createdAt = $createdAt
       SET m.sessionKey = $sessionKey,
           m.turnIndex = toInteger($turnIndex),
           m.role = $role,
           m.content = $content`,
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

/**
 * v2.8.x: 读取某会话已存在的 (role, 内容指纹) 分组计数。
 *
 * 用途：写入端据此判断「某条消息是否已在库」，从而在键方案切换（旧位置键 → 新稳定键）
 * 时**不把历史重新插一遍**，同时保留同内容重复消息的份数。
 * 只取 role + content 两列，按会话限定（走 gm_message_session 索引）。
 *
 * @param cap 返回行数上限；截断时 byGroup 不完整，调用方应退化为「不做跳过」（记 truncated）
 */
export async function getSessionMessageGroupCounts(
  driver: Driver,
  sessionKey: string,
  cap = 20_000,
): Promise<{ byGroup: Map<string, number>; truncated: boolean }> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (m:GmMessage {sessionKey: $sessionKey})
       RETURN m.role AS role, m.content AS content
       LIMIT toInteger($cap)`,
      { sessionKey, cap: neo4j.int(cap) },
    );
    const byGroup = new Map<string, number>();
    for (const r of result.records) {
      const role = String(r.get("role") ?? "");
      const content = String(r.get("content") ?? "");
      if (!role || !content) continue;
      const k = messageGroupKey(role, messageContentHash(content));
      byGroup.set(k, (byGroup.get(k) ?? 0) + 1);
    }
    return { byGroup, truncated: result.records.length >= cap };
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
 * v2.4.2: 按内容反查并标记已处理的对话对（正常运行时流程用）。
 * 运行时增量队列（extract-queue.jsonl）由外部 lcm-graph-extra 写入，规范为
 * {user, assistant, sessionKey?, id?|msgIds?}。优先按 sessionKey 精确区分管理：
 * 传 sessionKey 时精确限定到具体会话；有 id 时走 markMessagesProcessed 按 id。
 * 本函数在无 id 时用 (role, content) 在同 session 内匹配 user/assistant 两条
 * GmMessage 并打 rebuildProcessedAt 标记，使运行时处理过的消息与增量重建共用
 * 同一"已处理"语义，避免下一轮重复处理。匹配不到时静默跳过，不影响提取。
 */
export async function markMessagesByContent(
  driver: Driver,
  userContent: string,
  assistantContent: string,
  sessionKey?: string,
): Promise<void> {
  if (!userContent || !assistantContent) return;
  const session = getSession(driver);
  try {
    // 统一按 sessionKey 区分管理：传 sessionKey 时精确限定到具体会话（利用 gm_message_session 索引），
    // 避免同一内容跨 session 时误标记；未传时退化为"user/assistant 同一会话"的关联匹配。
    const scope = sessionKey ? " AND u.sessionKey = $sessionKey" : "";
    await session.run(
      `MATCH (u:GmMessage {role: 'user', content: $userContent})
       MATCH (a:GmMessage {role: 'assistant', content: $assistantContent})
       WHERE u.sessionKey = a.sessionKey AND u.createdAt < a.createdAt${scope}
       SET u.rebuildProcessedAt = $ts, a.rebuildProcessedAt = $ts`,
      { userContent, assistantContent, sessionKey, ts: neo4j.int(Date.now()) },
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
