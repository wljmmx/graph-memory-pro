/**
 * graph-memory-pro — Schema 初始化与共享工具
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver, Node, Relationship } from "neo4j-driver";
import { createHash } from "crypto";
import type { GmNode, GmEdge, EdgeType } from "../types.ts";
import { getSession, getCachedEdition } from "./db.ts";
import { createLogger, describeError } from "../logger.ts";

const log = createLogger("store:schema");

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

/**
 * v2.8.x: Neo4j 2026.x 向量 Provider 与 HNSW / 量化参数。
 *
 * 规格来源（用户提供）：Neo4j 2026.x **不再支持全局默认 HNSW 环境变量**
 * （`dbms.index.vector.default.*`），所有 HNSW / 量化参数必须写在建索引的
 * `vectorConfig` 里，Provider 名为 `vector-2.0`。
 *
 * 另外区分两个 ef：
 *   - `hnsw.efConstruction`：**建索引阶段**参数（越大构建越慢、召回越高）
 *   - `efSearch`：**检索阶段**参数，只写在 `db.index.vector.queryNodes` 里，
 *     建索引时不可配置 —— 见 ./vector-query.ts
 */
const VECTOR_PROVIDER_2_0 = "vector-2.0";
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 96;
const SEARCH_EXPANSION_FACTOR = 2.0;

/** 向量索引配置是否与该 Provider 期望一致（用于校验已有索引） */
export interface VectorIndexReport {
  name: string;
  state?: string;
  indexProvider?: string;
  /** 是否已是 2026.x 的 vector-2.0 Provider */
  isModernProvider: boolean;
}

/**
 * v2.8.x: 创建向量索引 —— 三级回落，优先 2026.x 新语法。
 *
 *   ① `indexProvider: 'vector-2.0'` + `vectorConfig`（2026.x，参数集中在此）
 *   ② 旧式 `indexConfig` + 反引号 `vector.*` 键（5.x ~ 2026 早期）
 *   ③ 过程化 `db.index.vector.createNodeIndex`（更老版本）
 *
 * 返回实际生效的那一级，便于日志里确认用户环境到底用了哪种语法。
 */
async function createVectorIndexBestEffort(
  session: { run: (q: string, p?: Record<string, unknown>) => Promise<unknown> },
  indexName: string,
  labelPattern: string,
  prop: string,
  dimension: number,
  isEnterprise: boolean,
): Promise<"vector-2.0" | "indexConfig" | "procedural" | "failed"> {
  // ① 2026.x：参数全部写入 vectorConfig
  const vectorConfigAttempts = isEnterprise
    ? [
        `{ indexProvider: '${VECTOR_PROVIDER_2_0}', vectorConfig: { dimensions: ${dimension}, similarityFunction: 'cosine', quantizationType: 'SCALAR', hnsw: { m: ${HNSW_M}, efConstruction: ${HNSW_EF_CONSTRUCTION} }, searchExpansionFactor: ${SEARCH_EXPANSION_FACTOR} } }`,
        // Community 或字段名不被接受时：去掉量化与 HNSW 调优，仅保留维度/相似度
        `{ indexProvider: '${VECTOR_PROVIDER_2_0}', vectorConfig: { dimensions: ${dimension}, similarityFunction: 'cosine' } }`,
      ]
    : [
        `{ indexProvider: '${VECTOR_PROVIDER_2_0}', vectorConfig: { dimensions: ${dimension}, similarityFunction: 'cosine' } }`,
      ];
  for (const options of vectorConfigAttempts) {
    try {
      await session.run(`
        CREATE VECTOR INDEX ${indexName} IF NOT EXISTS
        FOR (n:${labelPattern}) ON n.${prop}
        OPTIONS ${options}
      `);
      return "vector-2.0";
    } catch { /* 试下一种写法 */ }
  }

  // ② 旧式 indexConfig（保留以兼容 5.x ~ 2026 早期）
  try {
    await session.run(`
      CREATE VECTOR INDEX ${indexName} IF NOT EXISTS
      FOR (n:${labelPattern}) ON n.${prop}
      OPTIONS {
        indexConfig: {
          \`vector.dimensions\`: ${dimension},
          \`vector.similarity_function\`: 'cosine'${isEnterprise ? `,
          \`vector.quantization.type\`: 'SCALAR',
          \`vector.default_search_expansion_factor\`: 1.5,
          \`vector.hnsw.m\`: ${HNSW_M},
          \`vector.hnsw.ef_construction\`: ${HNSW_EF_CONSTRUCTION}` : ""}
        }
      }
    `);
    return "indexConfig";
  } catch { /* 试过程化 API */ }

  // ③ 过程化 API（Neo4j 2026.x 已移除该过程）
  try {
    const labels = labelPattern.split("|").map((l) => `'${l.trim()}'`).join(", ");
    await session.run(
      `CALL db.index.vector.createNodeIndex('${indexName}', [${labels}], '${prop}', ${dimension}, 'cosine')`,
    );
    return "procedural";
  } catch {
    return "failed";
  }
}

// v2.6.x: 最近一次 ensureSchema 使用的向量维度。供社区向量索引缺失时自愈复用
// （community.ts triggerCommunityIndexHeal 无需再次解析配置，直接用本值重建索引）。
let _lastEnsuredDimension = 1024;

/** 最近一次 ensureSchema 使用的向量维度（默认 1024） */
export function getLastEnsuredDimension(): number {
  return _lastEnsuredDimension;
}

export async function ensureSchema(driver: Driver, dimension: number = 1024): Promise<void> {
  _lastEnsuredDimension = dimension;
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
        `CREATE FULLTEXT INDEX task_search IF NOT EXISTS FOR (n:Task) ON EACH [n.name, n.description, n.content] OPTIONS { indexConfig: { \`fulltext.analyzer\`: 'cjk' } }`
      );
    } catch { /* may exist */ }
    try {
      await session.run(
        `CREATE FULLTEXT INDEX skill_search IF NOT EXISTS FOR (n:Skill) ON EACH [n.name, n.description, n.content] OPTIONS { indexConfig: { \`fulltext.analyzer\`: 'cjk' } }`
      );
    } catch { /* may exist */ }
    try {
      await session.run(
        `CREATE FULLTEXT INDEX event_search IF NOT EXISTS FOR (n:Event) ON EACH [n.name, n.description, n.content] OPTIONS { indexConfig: { \`fulltext.analyzer\`: 'cjk' } }`
      );
    } catch { /* may exist */ }
    try {
      await session.run(
        `CREATE FULLTEXT INDEX conversation_search IF NOT EXISTS FOR (n:ConversationMessage) ON EACH [n.content] OPTIONS { indexConfig: { \`fulltext.analyzer\`: 'cjk' } }`
      );
    } catch { /* may exist */ }
    try {
      await session.run(
        `CREATE FULLTEXT INDEX experience_search IF NOT EXISTS FOR (e:EXPERIENCE) ON EACH [e.summary, e.context, e.title, e.detail] OPTIONS { indexConfig: { \`fulltext.analyzer\`: 'cjk' } }`
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

    /**
     * v2.8.x: 向量索引创建改为「三级回落 + 结果留痕」，并校验已有索引的 Provider。
     *
     * 规格（用户提供，Neo4j 2026.x）：不再支持全局 HNSW 环境变量
     * （dbms.index.vector.default.*），HNSW/量化参数必须写在建索引的 vectorConfig 里，
     * Provider 为 vector-2.0；efSearch 是**检索参数**（见 ./vector-query.ts），
     * 建索引阶段只有 hnsw.efConstruction。
     *
     * 此前实现的两个问题：
     *   ① 只写旧式 indexConfig（反引号 vector.* 键），在 2026.x 上拿不到 vector-2.0；
     *   ② 外层 catch 空吞 → 索引是否真的建成、用的什么 Provider，日志上一无所知
     *      （历史上正是这个静默 catch 让 gm_community_embedding 长期不存在）。
     */
    const indexTargets: Array<{ name: string; labels: string; prop: string; note?: string }> = [
      { name: "gm_node_embedding", labels: "Task|Skill|Event", prop: "embedding" },
      // 旧式按 label 分离的 3 个索引：保留创建（IF NOT EXISTS 语义）以兼容旧环境，
      // 查询层优先用合并索引，这三个仅作回退。
      { name: "gm_node_embedding_task", labels: "Task", prop: "embedding", note: "legacy fallback" },
      { name: "gm_node_embedding_skill", labels: "Skill", prop: "embedding", note: "legacy fallback" },
      { name: "gm_node_embedding_event", labels: "Event", prop: "embedding", note: "legacy fallback" },
      { name: "gm_community_embedding", labels: "GmCommunity", prop: "embedding" },
    ];

    const methods: Record<string, string> = {};
    for (const t of indexTargets) {
      const m = await createVectorIndexBestEffort(session, t.name, t.labels, t.prop, dimension, isEnterprise);
      methods[t.name] = m;
      if (m === "failed") {
        log.error(
          `vector index NOT created: ${t.name} — 所有语法均被拒绝，该索引相关召回会失效`,
          { labels: t.labels, dimension },
        );
      } else if (m !== "vector-2.0") {
        log.warn(
          `vector index ${t.name} created via legacy syntax (${m}) — 该环境未启用 2026.x 的 vector-2.0/vectorConfig，HNSW 参数可能未生效`,
          { labels: t.labels },
        );
      }
    }
    log.info("vector indexes ensured", { edition, methods });

    // 校验已有索引的实际 Provider（新建的也一并看，确认 vector-2.0 是否真的生效）
    try {
      const show = await session.run(
        "SHOW VECTOR INDEXES YIELD name, indexProvider, state RETURN name, indexProvider, state",
      );
      const reports: VectorIndexReport[] = show.records.map((r) => {
        const provider = r.get("indexProvider") ?? undefined;
        return {
          name: String(r.get("name")),
          indexProvider: provider,
          state: r.get("state") ?? undefined,
          isModernProvider: provider === VECTOR_PROVIDER_2_0,
        };
      });
      const ours = reports.filter((r) => indexTargets.some((t) => t.name === r.name));
      log.info("vector index status", {
        indexes: ours.map((r) => `${r.name}[${r.indexProvider ?? "?"}/${r.state ?? "?"}]`).join(", "),
      });
      // 需要重建的：仍是旧 Provider 的索引（IF NOT EXISTS 不会升级已存在的索引）
      const needRebuild = ours.filter((r) => !r.isModernProvider);
      if (needRebuild.length > 0) {
        log.warn(
          "部分向量索引仍使用旧 Provider —— IF NOT EXISTS 不会升级已存在的索引，需先 DROP 再 CREATE。" +
            "大向量库重建为后台异步（state: POPULATING），耗时可能很长，故此处不自动执行。" +
            "请按需手动执行（把维度换成你的实际值）：",
          {
            indexes: needRebuild.map((r) => r.name).join(", "),
            fix: needRebuild
              .map((r) => {
                const t = indexTargets.find((x) => x.name === r.name)!;
                return `DROP VECTOR INDEX \`${r.name}\` IF EXISTS; CREATE VECTOR INDEX \`${r.name}\` FOR (n:${t.labels}) ON (n.${t.prop}) ` +
                  `OPTIONS { indexProvider: '${VECTOR_PROVIDER_2_0}', vectorConfig: { dimensions: ${dimension}, quantizationType: 'SCALAR', hnsw: { m: ${HNSW_M}, efConstruction: ${HNSW_EF_CONSTRUCTION} }, searchExpansionFactor: ${SEARCH_EXPANSION_FACTOR} } };`;
              })
              .join(" "),
          },
        );
      }
    } catch (err) {
      // SHOW VECTOR INDEXES 不可用（老版本）→ 不影响主流程，但留痕
      log.warn("SHOW VECTOR INDEXES unavailable — 无法校验索引 Provider", { error: describeError(err) });
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
