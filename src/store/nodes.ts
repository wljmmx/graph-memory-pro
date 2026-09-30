/**
 * graph-memory-pro — 节点 CRUD（Neo4j 数据操作层）
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver, Node, Relationship } from "neo4j-driver";
import neo4j from "neo4j-driver";
import type { GmNode, GmEdge, GmConfig, NodeType } from "../types.ts";
import { getSession, getFlowScope } from "./db.ts";
import {
  typeToLabel,
  computeEmbeddingHash,
  recordToNode,
  recordToEdge,
} from "./schema.ts";
import { createLogger, describeError } from "../logger.ts";
import { bumpGraphRevision } from "./graph-revision.ts";
import { runVectorQuery, DEFAULT_EF_SEARCH } from "./vector-query.ts";

const log = createLogger("store:nodes");

// ─── 节点 CRUD ──────────────────────────────────────────────

/**
 * v2.4.1: 流程作用域感知的 :Benchmark 排除谓词（用于 WHERE 拼接）。
 *
 * 生产流程（production）排除 :Benchmark 标签节点，保证生产数据纯净；
 * benchmark 流程（benchmark）不排除，保证评测只命中基准数据。
 *
 * @param alias Cypher 变量名（如 "n" / "node"）
 * @returns 追加到 WHERE 子句的谓词片段，如 " AND NOT n:Benchmark" 或 ""（benchmark 作用域）
 */
function benchmarkExclusion(alias: string): string {
  return getFlowScope() === "benchmark" ? "" : ` AND NOT ${alias}:Benchmark`;
}

export async function upsertNode(
  driver: Driver,
  node: GmNode,
  cfg?: GmConfig,
  extraLabels?: string[],
): Promise<void> {
  const session = getSession(driver);
  try {
    const label = typeToLabel(node.type);
    // v2.4.0: 附加业务标签（如 benchmark 节点打 :Benchmark），用于在生产查询中隔离
    const extraLabelStr = (extraLabels ?? []).map((l) => `:${l}`).join("");

    // v2.3.1 P0-4 性能优化: 三步合并为单条 Cypher
    // 旧实现（3 次串行 session.run）：
    //   1. MATCH 读旧节点 embedding/hash/history
    //   2. SET 归档 embeddingHistory（条件性）
    //   3. MERGE + SET 主写
    // 新实现（1 次 session.run）：
    //   单条 Cypher 用 OPTIONAL MATCH 读旧节点 + CASE WHEN 决定归档 + MERGE 一次完成
    //
    // R-4 可进化嵌入逻辑保留：
    //   - content 变化（hash 不同）且旧 embedding 存在 → 归档到 embeddingHistory，清空 embedding
    //   - content 未变化或新节点 → 正常写入 hash
    //
    // v2.3.2 S4 稳定性修复: archiveKeepCount 从 cfg 读取（修复硬编码 [..3]）
    //   旧实现硬编码 [..3]，忽略 cfg.evolvableEmbedding.archiveKeepCount 配置
    //   新实现用参数 $keepCount，默认 3，可由 cfg 覆盖
    const newContentHash = computeEmbeddingHash(node.name, node.description, node.content);
    const archivedAt = Date.now();
    const keepCount = cfg?.evolvableEmbedding?.archiveKeepCount ?? 3;

    // v2.4.0 修复: Neo4j 属性不支持 Map/List<Map>，embeddingHistory 改为 JSON 字符串存储。
    //   原生 Cypher 无法把 Map 序列化为 JSON（本项目不使用 APOC），故归档逻辑移到应用层：
    //   1) OPTIONAL MATCH 读旧节点 embedding/hash/history
    //   2) 应用层判断是否归档，序列化为 JSON 字符串
    //   3) MERGE + SET 主写，history 以字符串参数传入
    const read = await session.run(
      `OPTIONAL MATCH (old:${label} {id: $id})
       RETURN old.embeddingHash AS oldHash,
              old.embedding AS oldEmbedding,
              old.embeddingModel AS oldModel,
              old.embeddingHistory AS oldHistory`,
      { id: node.id },
    );

    let newHistoryJson: string | null = null;
    const row = read.records[0];
    // v2.8.x: 提升到 if 外 —— 供下面的 updatedAt 判定使用
    const oldHash = row ? row.get("oldHash") : null;
    /**
     * v2.8.x: 内容是否**真的**变了。
     * 重抽一个内容未变的节点不应推进 updatedAt —— 否则每次抽取都把节点"刷新成新的"，
     * 而 `dedup.ts` 的胜出平局判据、召回时序项都读 updatedAt，等于让重放改写时间语义。
     */
    const contentChanged = oldHash == null || oldHash !== newContentHash;
    if (row) {
      const oldEmbedding = row.get("oldEmbedding");
      const oldModel = row.get("oldModel");
      const oldHistory = row.get("oldHistory");

      const evolvableApplied =
        oldHash != null &&
        oldHash !== newContentHash &&
        Array.isArray(oldEmbedding) &&
        oldEmbedding.length > 0;

      if (evolvableApplied) {
        // 反序列化旧的 history（兼容历史 string 与误存的数组两种形态）
        let prev: GmNode["embeddingHistory"] = [];
        if (typeof oldHistory === "string") {
          try { prev = JSON.parse(oldHistory) ?? []; } catch { prev = []; }
        } else if (Array.isArray(oldHistory)) {
          prev = oldHistory;
        }
        const entry = {
          embedding: oldEmbedding,
          embeddingModel: oldModel ?? undefined,
          embeddingHash: oldHash,
          archivedAt,
        };
        newHistoryJson = JSON.stringify([entry, ...(prev ?? [])].slice(0, keepCount));
      }
    }

    const hasNewHistory = newHistoryJson !== null;

    // v2.8.x: 写集合按「权威归属」分层，修复重抽（re-extract）会改写状态与时间语义的问题。
    //   此前全部字段都是无条件 SET，导致：抽取路径传 `pagerank:0, validatedCount:0` 且不传
    //   state/validTo，于是每次重抽都会 ——
    //     ① 把已被 dedup/conflict 标记 superseded 的节点复活成 current（旧事实重新可召回）
    //     ② 清空反馈累积的 validatedCount、GDS 算出的 pagerank、维护算出的 staleness/importance
    //     ③ 把 createdAt/validFrom/recordedAt 刷成本次时间，并清掉 validTo/supersededBy
    //   分层后：
    //     ① 创建/来源字段  → ON CREATE SET（写一次）
    //     ② 内容字段        → 抽取方全权更新（content/description/name/type/status/embeddingModel）
    //     ③ 派生/状态字段  → 归属维护与反馈路径；抽取仅在「属性缺失」时补初值（COALESCE(n.x, $x)）
    //   communityId 不在本语句的写集合内 —— 归属由 updateCommunities 独占，重抽不会改变社区归属。
    await session.run(
      `MERGE (n:${label}${extraLabelStr} {id: $id})
       ON CREATE SET n.createdAt = $createdAt,
                     n.validFrom = COALESCE($validFrom, $createdAt),
                     n.recordedAt = COALESCE($recordedAt, $createdAt),
                     n.source = COALESCE($source, 'experience'),
                     n.state = COALESCE($state, 'current'),
                     n.pagerank = COALESCE($pagerank, 0),
                     n.validatedCount = COALESCE($validatedCount, 0),
                     n.stalenessScore = COALESCE($stalenessScore, 0.0),
                     n.importanceScore = COALESCE($importanceScore, 0.0),
                     n.validTo = $validTo,
                     n.supersededBy = $supersededBy
       SET n.name = $name,
           n.description = $description,
           n.content = $content,
           n.type = $type,
           n.status = $status,
           n.updatedAt = CASE WHEN $contentChanged THEN $updatedAt ELSE COALESCE(n.updatedAt, $updatedAt) END,
           n.embeddingModel = $embeddingModel,
           n.validFrom = COALESCE(n.validFrom, $validFrom, $createdAt),
           n.recordedAt = COALESCE(n.recordedAt, $recordedAt, $createdAt),
           n.source = COALESCE(n.source, $source, 'experience'),
           n.pagerank = COALESCE(n.pagerank, $pagerank, 0),
           n.validatedCount = COALESCE(n.validatedCount, $validatedCount, 0),
           n.stalenessScore = COALESCE(n.stalenessScore, $stalenessScore, 0.0),
           n.importanceScore = COALESCE(n.importanceScore, $importanceScore, 0.0),
           n.state = COALESCE(n.state, $state, 'current'),
           n.embeddingHash = CASE
             WHEN $hasNewHistory THEN null
             ELSE COALESCE($newContentHash, n.embeddingHash)
           END,
           n.embedding = CASE
             WHEN $hasNewHistory THEN null
             ELSE n.embedding
           END,
           n.embeddingHistory = CASE
             WHEN $hasNewHistory THEN $newHistoryJson
             ELSE COALESCE(n.embeddingHistory, [])
           END`,
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
        validFrom: node.validFrom ? neo4j.int(node.validFrom) : null,
        validTo: node.validTo ? neo4j.int(node.validTo) : null,
        recordedAt: node.recordedAt ? neo4j.int(node.recordedAt) : null,
        source: node.source ?? null,
        state: node.state ?? null,
        stalenessScore: node.stalenessScore ?? null,
        importanceScore: node.importanceScore ?? null,
        supersededBy: node.supersededBy ?? null,
        embeddingModel: node.embeddingModel ?? null,
        newContentHash,
        newHistoryJson,
        hasNewHistory,
        // v2.8.x: 内容未变则不推进 updatedAt（避免重抽刷新"新鲜度"，干扰 dedup 平局判据与时序项）
        contentChanged,
      },
    );
    // v2.8.x: 只有真正改变图内容（新建或内容变化）时才让召回结果缓存失效；
    // 纯重复抽取不递增，否则每次抽取都会清空缓存、使缓存形同虚设。
    if (contentChanged) bumpGraphRevision();
  } finally {
    await session.close();
  }
}

/**
 * v2.3.1 P0-3 性能优化: 批量 upsert 节点
 *
 * 用 UNWIND + MERGE 将多个节点合并为单次 session.run，
 * 替代循环中 N 次 upsertNode 调用（每次 2-3 次 session.run）。
 *
 * 注意：
 *   - 不处理 R-4 可进化嵌入归档（批量场景下 content 变化检测由 reEmbedNodes 周期处理）
 *   - 仅写入基本字段，embeddingHash 用 computeEmbeddingHash 计算
 *   - 适用于 extractInBackground 后台提取的批量写入场景
 *
 * P0-2（可观测性）：批量写入本身不归档旧 embedding，但会对比库中旧 hash 与新的
 * contentHash：若 content 发生变化，记录一条 warn 日志（含 id / label / 新旧 hash），
 * 便于排查"旧 embedding 未归档是否因 reEmbedNodes 周期任务未运行/失败而丢失"。
 *
 * @returns 成功写入的节点数
 */
export async function batchUpsertNodes(
  driver: Driver,
  nodes: GmNode[],
): Promise<number> {
  if (!nodes.length) return 0;
  const session = getSession(driver);
  try {
    const rows = nodes.map((n) => {
      const label = typeToLabel(n.type);
      return {
        id: n.id,
        label,
        name: n.name,
        description: n.description,
        content: n.content,
        type: n.type,
        status: n.status,
        pagerank: n.pagerank,
        validatedCount: n.validatedCount,
        createdAt: neo4j.int(n.createdAt),
        updatedAt: neo4j.int(n.updatedAt),
        // v2.4.0: 与 upsertNode 语义对齐，批量导入也补齐时序/来源/状态默认值，
        // 避免历史/批量导入节点 recordedAt/validFrom 等为空导致时序检索失真
        recordedAt: neo4j.int(n.recordedAt ?? n.createdAt),
        validFrom: neo4j.int(n.validFrom ?? n.createdAt),
        source: n.source ?? "experience",
        state: n.state ?? "current",
        stalenessScore: n.stalenessScore ?? 0.0,
        importanceScore: n.importanceScore ?? 0.0,
        embeddingModel: n.embeddingModel ?? null,
        embeddingHash: computeEmbeddingHash(n.name, n.description, n.content),
        // v2.8.x: 由下面的旧 hash 对比填充；决定 updatedAt 是否推进、旧向量是否失效
        contentChanged: false,
      };
    });

    // v2.8.x: 读取库中这些 id 的旧 embeddingHash，判定内容是否真的变了。
    //   判定结果有两个用途（此前只打一条 warn、不做任何事）：
    //     ① updatedAt 仅在内容变化时推进（重抽未变内容不应刷新"新鲜度"）
    //     ② 内容变化时**清空 embedding/embeddingHash**，使 embedNodesMissing / reEmbedNodes
    //        能重算 —— 旧实现只更新 hash 而保留旧向量，导致「内容已是 B、向量还是 A」
    //        且所有重嵌入路径只查 `embedding IS NULL`，陈旧向量永不重算。
    let changed = 0;
    try {
      const ids = rows.map((r) => r.id);
      const oldRes = await session.run(
        `MATCH (n:Task|Skill|Event) WHERE n.id IN $ids
         RETURN n.id AS id, n.embeddingHash AS hash`,
        { ids },
      );
      const oldByHash = new Map<string | null, string>();
      for (const rec of oldRes.records) {
        const id = rec.get("id");
        if (id != null) oldByHash.set(String(id), rec.get("hash") ?? null);
      }
      for (const r of rows) {
        const oldHash = oldByHash.get(r.id);
        // 新节点（oldHash 缺失）视为"内容变化"：updatedAt 用新值即可，无旧向量可清
        const isNew = oldHash == null;
        r.contentChanged = isNew || oldHash !== r.embeddingHash;
        if (!isNew && r.contentChanged) changed++;
      }
      if (changed > 0) {
        log.info(
          "Batch upsert: content changed — invalidating stale embeddings so they get recomputed",
          { changed, total: rows.length },
        );
      }
    } catch (err) {
      // 对比检测失败不影响主写入流程；但此时无法判定内容是否变化，
      // 保守选择「不推进 updatedAt、不失效向量」（保持旧行为），并留痕以便排查。
      log.warn(
        "Batch upsert: change detection failed — updatedAt preserved and stale embeddings NOT invalidated",
        { error: (err as Error)?.message ?? String(err) },
      );
    }

    // 按 label 分组（UNWIND 无法动态切换 label）
    const byLabel = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!byLabel.has(r.label)) byLabel.set(r.label, []);
      byLabel.get(r.label)!.push(r);
    }

    let totalWritten = 0;
    // 同一 session 内顺序执行不同 label 的批量 MERGE（通常 2-3 个 label）
    for (const [label, batch] of byLabel) {
      const result = await session.run(
        `UNWIND $rows AS row
         MERGE (n:${label} {id: row.id})
         ON CREATE SET n.createdAt = row.createdAt,
                       n.updatedAt = row.updatedAt,
                       n.validFrom = row.validFrom,
                       n.recordedAt = row.recordedAt,
                       n.source = row.source,
                       n.state = row.state,
                       n.pagerank = row.pagerank,
                       n.validatedCount = row.validatedCount,
                       n.stalenessScore = row.stalenessScore,
                       n.importanceScore = row.importanceScore
         SET n.name = row.name,
             n.description = row.description,
             n.content = row.content,
             n.type = row.type,
             n.status = row.status,
             n.embeddingModel = row.embeddingModel,
             n.updatedAt = CASE WHEN row.contentChanged THEN row.updatedAt ELSE COALESCE(n.updatedAt, row.updatedAt) END,
             n.validFrom = COALESCE(n.validFrom, row.validFrom),
             n.recordedAt = COALESCE(n.recordedAt, row.recordedAt),
             n.source = COALESCE(n.source, row.source),
             n.state = COALESCE(n.state, row.state),
             n.pagerank = COALESCE(n.pagerank, row.pagerank),
             n.validatedCount = COALESCE(n.validatedCount, row.validatedCount),
             n.stalenessScore = COALESCE(n.stalenessScore, row.stalenessScore),
             n.importanceScore = COALESCE(n.importanceScore, row.importanceScore),
             n.embeddingHash = CASE WHEN row.contentChanged THEN null ELSE COALESCE(row.embeddingHash, n.embeddingHash) END,
             n.embedding = CASE WHEN row.contentChanged THEN null ELSE n.embedding END
         RETURN count(n) AS c`,
        { rows: batch },
      );
      const c = result.records[0]?.get("c");
      totalWritten += (typeof c === "number" ? c : c?.toNumber?.() ?? 0);
    }
    // v2.8.x: 有任意节点是新建或内容变化 → 召回结果缓存失效
    if (rows.some((r) => r.contentChanged)) bumpGraphRevision();
    return totalWritten;
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
  // v2.3.1 P1-1 性能优化: 4 个 fulltext 索引并行查询（旧实现 UNION ALL 服务端串行）
  // 旧实现：UNION ALL 在 Neo4j 服务端顺序执行 4 个 fulltext 查询，耗时 ≈ 4T
  // 新实现：应用层 Promise.all 并行 4 个独立 session.run，耗时 ≈ max(T)
  // 失败时 fallback 到 CONTAINS 查询（与旧实现一致）
  const fulltextIndexes = [
    "task_search",
    "skill_search",
    "event_search",
    "conversation_search",
  ] as const;

  try {
    const perIndexResults = await Promise.all(
      fulltextIndexes.map(async (indexName) => {
        const session = getSession(driver);
        try {
          const result = await session.run(
            `CALL db.index.fulltext.queryNodes($indexName, $query, { limit: toInteger($limit) })
             YIELD node AS n, score
             WHERE (n.status = 'active' OR n.status IS NULL)${benchmarkExclusion("n")}
             RETURN n, score`,
            { indexName, query, limit },
          );
          return result.records;
        } finally {
          await session.close();
        }
      }),
    );

    // 合并 4 个索引结果，按 nodeId 去重
    const seen = new Map<string, GmNode | null>();
    for (const records of perIndexResults) {
      for (const r of records) {
        const node = r.get("n");
        if (!node || !node.properties) continue;
        const id = node.properties.id;
        if (!seen.has(id)) {
          seen.set(id, recordToNode(node));
        }
      }
    }

    const nodes = Array.from(seen.values()).filter((n): n is GmNode => n !== null);
    nodes.sort((a, b) => (b.validatedCount ?? 0) - (a.validatedCount ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return nodes.slice(0, limit);
  } catch {
    // ✅ Fallback: 如果 FULLTEXT 索引不可用，回退到 CONTAINS
    const session = getSession(driver);
    try {
      const result = await session.run(
        `MATCH (n:Task|Skill|Event|ConversationMessage) WHERE (n.status = 'active' OR n.status IS NULL)${benchmarkExclusion("n")}
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
}

export async function vectorSearchWithScore(
  driver: Driver,
  vec: number[],
  topK: number,
  efSearch: number = DEFAULT_EF_SEARCH,
): Promise<Array<{ node: GmNode; score: number }>> {
  // v2.3.2 阶段二: 优先使用合并索引 gm_node_embedding（单索引跨 Task|Skill|Event）
  // 旧实现：3 个按 label 分离索引并行查询 + 合并去重（3 个 session）。
  // 新实现：单索引单 session 查询，省 2 个 session + 去重逻辑，连接池压力降 2/3。
  // 兼容回退：合并索引不存在（旧环境未升级 schema）时，回退到 3 索引并行（v2.3.1 路径）。
  const MERGED_INDEX = "gm_node_embedding";
  const FALLBACK_INDEXES = ["gm_node_embedding_task", "gm_node_embedding_skill", "gm_node_embedding_event"];

  // 尝试合并索引
  const session = getSession(driver);
  try {
    try {
      // v2.8.x: efSearch 是**检索参数**（非索引存储参数），按 2026.x 规格在查询时传入；
      // 旧版本不认识第 4 参时由 runVectorQuery 自动回落。
      const result = await runVectorQuery(
        session,
        { indexExpr: "$indexName", topKExpr: "toInteger($topK)", vecExpr: "$vec" },
        `WITH node, score WHERE node.status = 'active'${benchmarkExclusion("node")}
         RETURN node, score
         ORDER BY score DESC`,
        { indexName: MERGED_INDEX, vec, topK },
        efSearch,
      );
      const out = result.records.map((r) => ({
        node: recordToNode(r.get("node")),
        score: r.get("score"),
      })).filter((r): r is { node: GmNode; score: number } => r.node !== null);
      // 合并索引查询成功 → 直接返回（单索引天然去重，无需合并）
      return out.sort((a, b) => b.score - a.score);
    } catch {
      // 合并索引不存在或查询失败 → 回退到 3 索引并行（旧环境兼容）
    }

    // v2.3.2 S5: Promise.allSettled 容忍部分索引失败
    const settled = await Promise.allSettled(
      FALLBACK_INDEXES.map(async (indexName) => {
        const s = getSession(driver);
        try {
          const result = await runVectorQuery(
            s,
            { indexExpr: "$indexName", topKExpr: "toInteger($topK)", vecExpr: "$vec" },
            `WITH node, score WHERE node.status = 'active'${benchmarkExclusion("node")}
             RETURN node, score
             ORDER BY score DESC`,
            { indexName, vec, topK },
            efSearch,
          );
          return result.records.map((r) => ({
            node: recordToNode(r.get("node")),
            score: r.get("score"),
          })).filter((r): r is { node: GmNode; score: number } => r.node !== null);
        } finally {
          await s.close();
        }
      }),
    );

    // 仅合并 fulfilled 的结果，rejected 的索引被跳过
    const perIndexResults = settled
      .filter((r): r is PromiseFulfilledResult<{ node: GmNode; score: number }[]> => r.status === "fulfilled")
      .map((r) => r.value);

    // 合并可用索引结果，按 nodeId 去重（保留最高 score），再按 score 降序
    const merged = new Map<string, { node: GmNode; score: number }>();
    for (const batch of perIndexResults) {
      for (const item of batch) {
        const existing = merged.get(item.node.id);
        if (!existing || item.score > existing.score) {
          merged.set(item.node.id, item);
        }
      }
    }
    return Array.from(merged.values()).sort((a, b) => b.score - a.score);
  } finally {
    await session.close();
  }
}

export async function graphWalk(
  driver: Driver,
  seedIds: string[],
  depth: number,
  maxNodes = 200,
): Promise<{ nodes: GmNode[]; edges: GmEdge[] }> {
  const session = getSession(driver);
  try {
    // ✅ 优化：限制关系类型为有意义的业务关系，排除 NEXT_SESSION/CONTAINS 等高频低价值边
    // v2.1.2: 新增 CAUSED_BY / LEADS_TO 因果边类型
    // v2.3.6: 新增 RELATES_TO（泛化关系，benchmark prebuiltEdges 和外部数据集常用）
    // v2.3.1 性能优化: 加 LIMIT 限制返回节点数，防止图规模大时返回过多节点
    //       导致后续 PPR 排序开销爆炸。默认 200（recallMaxNodes 通常 ≤ 50，留 4× 余量）。
    const relTypes = "USED_SKILL|SOLVED_BY|REQUIRES|PATCHES|CONFLICTS_WITH|CAUSED_BY|LEADS_TO|RELATES_TO";
    // P2-7: 在 UNWIND 前用 LIMIT 约束路径数量，避免变量长度遍历产生海量路径后
    // 再由 COLLECT 一次性 UNWIND 造成的中间结果爆炸。maxPaths 取 maxNodes 的 4 倍
    //（与 v2.3.1 预留 4× 余量一致），足以覆盖 maxNodes 个去重节点，同时封顶 UNWIND 工作量。
    const maxPaths = Math.max(1, Math.min(maxNodes * 4, 2000));
    // v2.4.1: 生产作用域排除两端 :Benchmark 节点；benchmark 作用域不排除
    const endExclusion = benchmarkExclusion("end");
    const result = await session.run(
      `MATCH path = (start:Task|Skill|Event)-[r:${relTypes}*1..${depth}]-(end:Task|Skill|Event)
       WHERE start.id IN $seedIds
         AND start.status = 'active'
         ${benchmarkExclusion("start")}${endExclusion}
       WITH path LIMIT toInteger($maxPaths)
       UNWIND nodes(path) AS n
       UNWIND relationships(path) AS rel
       WITH COLLECT(DISTINCT n)[..$maxNodes] AS nodeList, COLLECT(DISTINCT rel)[..$maxNodes] AS relList
       RETURN nodeList, relList`,
      { seedIds, maxNodes, maxPaths },
    );
    if (!result.records.length) return { nodes: [], edges: [] };
    const row = result.records[0];
    const nodeList = row.get("nodeList") as Node[];
    const relList = row.get("relList") as Relationship[];

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
    // v2.3.5 修复: status 过滤兼容 NULL（与 searchNodes 一致），
    // 旧数据或导入数据可能没有 status 属性
    const result = await session.run(
      `MATCH (n:Task|Skill|Event) WHERE (n.status = 'active' OR n.status IS NULL)${benchmarkExclusion("n")} RETURN count(n) AS c`,
    );
    return result.records[0]?.get("c")?.toNumber?.() ?? 0;
  } finally {
    await session.close();
  }
}

/**
 * v2.4.0: 清空当前激活数据库中的全部节点与边（破坏性）。
 *
 * 用途：配合"清理后重新导入"流程，让历史数据按新写入逻辑（含正确时序字段）重建，
 * 从而获得正确的时序/过时/重要性数据。
 * 注意：仅作用于当前激活数据库（getSession 的 database），生产环境请谨慎使用。
 */
export async function clearAllNodes(driver: Driver): Promise<number> {
  const session = getSession(driver);
  try {
    /**
     * v2.8.x: 改用 Neo4j 官方推荐的分批删除，并保留单语句回落。
     *
     * 缺陷背景：`MATCH (n) DETACH DELETE n` 是**单个事务**删除全库。图规模上万节点时，
     * 事务状态会撑爆事务内存（`dbms.memory.transaction.total.max` → `OutOfMemoryError`），
     * 且长时间占用锁。Neo4j 官方文档明确建议大删除用 `CALL { … } IN TRANSACTIONS OF n ROWS`
     * 分批提交。
     *
     * 语义不变：仍是全库删除、仍返回删除总数；差别只在提交粒度。
     * 回落：老版本不支持 `IN TRANSACTIONS` 时退回单语句（行为与旧实现一致）。
     */
    const BATCH_ROWS = 10_000;
    try {
      const batched = await session.run(
        `CALL {
           MATCH (n) DETACH DELETE n
           RETURN count(n) AS c
         } IN TRANSACTIONS OF ${BATCH_ROWS} ROWS
         RETURN sum(c) AS c`,
      );
      return batched.records[0]?.get("c")?.toNumber?.() ?? 0;
    } catch (err) {
      log.warn(
        "clearAllNodes: batched delete unavailable — falling back to single-transaction delete " +
          "(大图下可能耗尽事务内存)",
        { error: describeError(err), batchRows: BATCH_ROWS },
      );
      const result = await session.run("MATCH (n) DETACH DELETE n RETURN count(n) AS c");
      return result.records[0]?.get("c")?.toNumber?.() ?? 0;
    }
  } finally {
    await session.close();
  }
}

export async function getNodesByType(
  driver: Driver,
  type: string,
  limit?: number,
): Promise<GmNode[]> {
  // v2.3.5 修复: 用 typeToLabel 转换，避免 "TASK" 被直接用作 label
  // （Neo4j label 大小写敏感，实际 label 是 "Task" 而非 "TASK"）
  const label = typeToLabel(type);
  const session = getSession(driver);
  try {
    // v2.3.5 修复: status 过滤兼容 NULL（与 searchNodes 一致），
    // 旧数据或导入数据可能没有 status 属性
    const q = limit
      ? `MATCH (n:${label}) WHERE (n.status = 'active' OR n.status IS NULL)${benchmarkExclusion("n")} RETURN n ORDER BY n.validatedCount DESC LIMIT toInteger($limit)`
      : `MATCH (n:${label}) WHERE (n.status = 'active' OR n.status IS NULL)${benchmarkExclusion("n")} RETURN n ORDER BY n.validatedCount DESC`;
    const result = await session.run(q, { limit: limit ?? 0 });
    return result.records.map((r) => recordToNode(r.get("n"))).filter((n): n is GmNode => n !== null);
  } finally {
    await session.close();
  }
}

/**
 * v2.4.2 顶层导出：按时间范围查询节点。
 *
 * @param driver Neo4j driver
 * @param params 查询参数（start/end 毫秒时间戳，timeField 指定 createdAt 或 updatedAt）
 * @returns 命中的节点列表（按 timeField 倒序）
 */
export async function getNodesByTimeRange(
  driver: Driver,
  params: {
    start: number;
    end: number;
    timeField: "createdAt" | "updatedAt";
    type?: NodeType;
    limit?: number;
  },
): Promise<GmNode[]> {
  const { start, end, timeField, type, limit } = params;
  const label = type ? typeToLabel(type) : "Task|Skill|Event";
  const session = getSession(driver);
  try {
    const q = `
      MATCH (n:${label})
      WHERE (n.status = 'active' OR n.status IS NULL)
        AND n.${timeField} >= toFloat($start)
        AND n.${timeField} <= toFloat($end)${benchmarkExclusion("n")}
      RETURN n
      ORDER BY n.${timeField} DESC
      ${limit ? "LIMIT toInteger($limit)" : ""}
    `;
    const result = await session.run(q, { start, end, limit: limit ?? 0 });
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
    // v2.3.5 修复: status 过滤兼容 NULL（与 searchNodes 一致），
    // 旧数据或导入数据可能没有 status 属性
    const result = await session.run(
      `MATCH (n:Task|Skill|Event)
       WHERE (n.status = 'active' OR n.status IS NULL)${benchmarkExclusion("n")}
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
