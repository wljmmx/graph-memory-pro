/**
 * graph-memory-pro — Schema 初始化与共享工具
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver } from "neo4j-driver";
import { createHash } from "crypto";
import type { GmNode, GmEdge } from "../types.ts";
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

    // 向量索引 (Neo4j 5.11+):
    // v2.3.2 阶段二: 合并为单一多 label 索引（Task|Skill|Event 共用 'embedding' 属性）
    // 旧实现按 label 分离 3 个索引，查询需并行 3 次 session + 合并去重。
    // 新实现单索引跨 3 label 检索，省 2 个 session + 去重逻辑，连接池压力降 2/3。
    // 兼容策略：保留创建 3 个旧索引的语句（IF NOT EXISTS 语义，已存在则 no-op），
    //          避免破坏旧环境；查询层优先用合并索引，旧索引仅向后兼容。
    try {
      await session.run(`
        CALL db.index.vector.createNodeIndex(
          'gm_node_embedding', ['Task', 'Skill', 'Event'], 'embedding', ${dimension}, 'cosine'
        )
      `);
    } catch { /* may exist or version < 5.11 multi-label index */ }
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

// ─── 辅助函数（供其他子模块共享）────────────────────────────

/** 将 NodeType (TASK/SKILL/EVENT) 映射为 Neo4j Label (Task/Skill/Event) */
export function typeToLabel(type: string): string {
  const mapping: Record<string, string> = {
    TASK: "Task",
    SKILL: "Skill",
    EVENT: "Event",
  };
  return mapping[type.toUpperCase()] ?? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
}

/** 将 Neo4j Label (Task/Skill/Event) 映射为 NodeType (TASK/SKILL/EVENT) */
export function labelToType(label: string): string {
  const mapping: Record<string, string> = {
    Task: "TASK",
    Skill: "SKILL",
    Event: "EVENT",
  };
  return mapping[label] ?? label.toUpperCase();
}

export function recordToNode(rec: any): GmNode | null {
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

export function recordToEdge(rec: any): GmEdge | null {
  if (!rec || !rec.properties) return null;
  const p = rec.properties;
  // 使用 startNodeElementId/endNodeElementId 获取节点 element ID
  // 但我们需要的是业务 ID（n.id），需要通过 startNode/endNode 获取
  const fromId = p.fromId ?? rec.startNodeElementId ?? rec.start?.toNumber?.() ?? "";
  const toId = p.toId ?? rec.endNodeElementId ?? rec.end?.toNumber?.() ?? "";
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
