/**
 * graph-memory-pro — Schema 初始化与共享工具
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver, Node, Relationship } from "neo4j-driver";
import { createHash } from "crypto";
import type { GmNode, GmEdge, EdgeType } from "../types.ts";
import { getSession, getCachedEdition } from "./db.ts";

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
    // v2.4.1: 消息键集分页复合索引（sessionKey, createdAt, id），
    // 加速 11 万级消息的 getSessionMessagesPage 重建分页，避免全表扫描 + 排序导致卡死。
    await session.run(
      "CREATE INDEX gm_message_session_ctime IF NOT EXISTS FOR (m:GmMessage) ON (m.sessionKey, m.createdAt, m.id)"
    );

    // FULLTEXT 索引：用于全文搜索（替代 CONTAINS）
    try {
      await session.run(
        `CREATE FULLTEXT INDEX task_search IF NOT EXISTS FOR (n:Task) ON [n.name, n.description, n.content] OPTIONS { analyzer: "cjk" }`
      );
    } catch { /* may exist */ }
    try {
      await session.run(
        `CREATE FULLTEXT INDEX skill_search IF NOT EXISTS FOR (n:Skill) ON [n.name, n.description, n.content] OPTIONS { analyzer: "cjk" }`
      );
    } catch { /* may exist */ }
    try {
      await session.run(
        `CREATE FULLTEXT INDEX event_search IF NOT EXISTS FOR (n:Event) ON [n.name, n.description, n.content] OPTIONS { analyzer: "cjk" }`
      );
    } catch { /* may exist */ }
    try {
      await session.run(
        `CREATE FULLTEXT INDEX conversation_search IF NOT EXISTS FOR (n:ConversationMessage) ON [n.content] OPTIONS { analyzer: "cjk" }`
      );
    } catch { /* may exist */ }

    // 向量索引 (Neo4j 5.11+):
    // v2.3.2 阶段二: 合并为单一多 label 索引（Task|Skill|Event 共用 'embedding' 属性）
    // 旧实现按 label 分离 3 个索引，查询需并行 3 次 session + 合并去重。
    // 新实现单索引跨 3 label 检索，省 2 个 session + 去重逻辑，连接池压力降 2/3。
    //
    // v2.4.1 (Neo4j 2026.07+): 合并索引 + 量化实测修正（2026-08-17）。
    // 配置要点（针对 1024 维 embedding，SSD/内存有限的个人设备）：
    //  - m=16: 每个 HNSW 节点默认连接数 → 平衡内存占用和召回，默认足够
    //  - ef_construction=128: 构建时探索深度 → 比默认 100 略高，提升召回，构建慢一点可接受
    //  - vector.quantization.type: 'SCALAR' → 标量量化（压缩约 50% 存储，社区/企业都支持）。
    //    实测（Neo4j 2026.07.1 Enterprise）：'HFQ' 不支持
    //    （'HFQ' is an unsupported 'vector.quantization.type'. Supported: [BINARY, NONE, SCALAR]）；
    //    ef_search 键也不被接受。故量化统一走 SCALAR；
    //    HFQ（High-Fidelity Quantized 检索增强重打分）不是 quantization 类型，而是靠
    //    vector.default_search_expansion_factor > 1.0 开启：先 SCALAR 扩大召回 → 原始 FP32 二次重打分。
    //    故 Enterprise 用 SCALAR + default_search_expansion_factor=1.5，正确启用 HFQ 而不改量化类型。
    //
    // 兼容策略：保留创建 3 个旧索引的语句（IF NOT EXISTS 语义，已存在则 no-op），
    //          避免破坏旧环境；查询层优先用合并索引，旧索引仅向后兼容。
    const edition = getCachedEdition();
    const isEnterprise = edition === "Enterprise";
    try {
      // Neo4j 2026.07+ 推荐语法：CREATE VECTOR INDEX 语法支持精细化 OPTIONS.indexConfig
      // 由于参数是字面量（options 不接受参数），对 dimension 参数内联拼接
      // 注意键名用下划线 ef_construction / ef_search（点号写法非 Neo4j 键名，会被忽略）
      if (isEnterprise) {
        // Enterprise：启用精细 HNSW + 量化参数
        await session.run(`
          CREATE VECTOR INDEX gm_node_embedding IF NOT EXISTS
          FOR (n:Task|Skill|Event) ON n.embedding
          OPTIONS {
            indexConfig: {
              \`vector.dimensions\`: ${dimension},
              \`vector.similarity_function\`: 'cosine',
              \`vector.quantization.type\`: 'SCALAR',
              \`vector.default_search_expansion_factor\`: 1.5,
              \`vector.hnsw.m\`: 16,
              \`vector.hnsw.ef_construction\`: 128
            }
          }
        `);
      } else {
        // Community/未知：基础多 label 向量索引（不启用量化/HNSW 精细选项）
        await session.run(`
          CREATE VECTOR INDEX gm_node_embedding IF NOT EXISTS
          FOR (n:Task|Skill|Event) ON n.embedding
          OPTIONS {
            indexConfig: {
              \`vector.dimensions\`: ${dimension},
              \`vector.similarity_function\`: 'cosine'
            }
          }
        `);
      }
    } catch {
      // 兼容老版本 Neo4j（不支持 CREATE VECTOR INDEX 语法或多 label 选项）回落过程化调用
      try {
        await session.run(`
          CALL db.index.vector.createNodeIndex(
            'gm_node_embedding', ['Task', 'Skill', 'Event'], 'embedding', ${dimension}, 'cosine'
          )
        `);
      } catch { /* may exist or version < 5.11 multi-label index */ }
    }
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

export function recordToNode(rec: Node): GmNode | null {
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
    // v2.4.0: embeddingHistory 以 JSON 字符串存储（Neo4j 属性不支持 List<Map>），读取时反序列化
    embeddingHistory: typeof p.embeddingHistory === "string"
      ? (() => { try { return JSON.parse(p.embeddingHistory); } catch { return undefined; } })()
      : (Array.isArray(p.embeddingHistory) ? p.embeddingHistory : undefined),
    // v2.4.0 点6: 长文本分块向量/文本（数组的数组）
    chunkTexts: Array.isArray(p.chunkTexts) ? p.chunkTexts : undefined,
    chunkEmbeddings: Array.isArray(p.chunkEmbeddings) ? p.chunkEmbeddings : undefined,
  };
}

export function recordToEdge(rec: Relationship): GmEdge | null {
  if (!rec || !rec.properties) return null;
  const p = rec.properties;
  // 使用 startNodeElementId/endNodeElementId 获取节点 element ID
  // 但我们需要的是业务 ID（n.id），需要通过 startNode/endNode 获取
  const fromId = p.fromId ?? "";
  const toId = p.toId ?? "";
  return {
    id: p.id ?? `${fromId}-${toId}-${rec.type}`,
    type: rec.type as EdgeType,
    fromId,
    toId,
    instruction: p.instruction ?? "",
    condition: p.condition,
    weight: typeof p.weight === "number" ? p.weight : (p.weight?.toNumber?.() ?? 1),
    createdAt: p.createdAt?.toNumber?.() ?? 0,
    updatedAt: p.updatedAt?.toNumber?.() ?? 0,
  };
}
