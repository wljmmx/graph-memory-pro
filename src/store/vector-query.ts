/**
 * v2.8.x — 向量检索调用（Neo4j 2026.x 检索参数）
 *
 * 背景（用户提供的 2026.x 规格）：
 *   - Neo4j 2026.x 的向量 Provider 是 `vector-2.0`，**HNSW / 量化参数只能写在
 *     建索引的 `vectorConfig` 里**，不再通过全局 `dbms.index.vector.default.*` 配置。
 *   - **`efSearch` 不是索引存储参数，而是检索参数** —— 建索引阶段只有
 *     `hnsw.efConstruction`；检索时把 `efSearch` 传给 `db.index.vector.queryNodes`。
 *
 * 因此本模块统一负责「CALL + YIELD」这一段的生成，各调用点只提供自己的尾段
 * （YIELD 之后的 WITH / MATCH / RETURN 各不相同）。
 *
 * 为什么需要回落：`db.index.vector.queryNodes(name, k, vec, options)` 的四参形式是
 * 新版本才有的。旧环境传第 4 参会被拒，若不回落会让**整个向量召回失效**。
 */

import type { Result, Session } from "neo4j-driver";

/** 默认检索 ef（与用户既有 compose 配置里的 ef_search 一致） */
export const DEFAULT_EF_SEARCH = 48;

/**
 * 会话的最小接口。
 * 刻意用 neo4j 的真实 `Session["run"]` 签名（而非自造的宽松类型）——
 * 自造类型会把 `Record.get()` 收窄成 `unknown`，破坏下游 `recordToNode(r.get("node"))` 的类型。
 */
export interface VectorQuerySession {
  run: Session["run"];
}

export interface VectorCallSpec {
  /** 索引名表达式：`$indexName`（参数化）或 `'gm_community_embedding'`（字面量） */
  indexExpr: string;
  /** topK 表达式：如 `toInteger($topK)` / `toInteger($maxCommunities)` */
  topKExpr: string;
  /** 查询向量表达式：通常 `$vec` */
  vecExpr: string;
}

/** 生成 `db.index.vector.queryNodes` 调用 + YIELD（可附带检索参数 efSearch） */
export function buildVectorCall(spec: VectorCallSpec, withEfSearch: boolean): string {
  const options = withEfSearch ? `, { efSearch: toInteger($efSearch) }` : "";
  return `CALL db.index.vector.queryNodes(${spec.indexExpr}, ${spec.topKExpr}, ${spec.vecExpr}${options})
          YIELD node, score`;
}

/**
 * 判断错误是否为「不接受第 4 个检索参数」这类旧版本不兼容错误。
 * 只在**确实与参数签名相关**时才回落，避免把真实故障（索引缺失、维度不符）也吞掉。
 */
export function looksLikeUnsupportedOptions(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err);
  return /UnknownArgument|Unknown function|Invalid input|InvalidArgument|too many|expected .* argument|options/i.test(msg);
}

/**
 * 执行向量查询，自动处理 `efSearch` 兼容性。
 *
 * @param spec        CALL 段的表达式
 * @param tail        YIELD 之后的 Cypher（各调用点不同）
 * @param params      查询参数（应包含 spec 中引用的那些）
 * @param efSearch    检索 ef；<=0 / 非法 → 不带该参数
 * @returns 查询结果；若带 efSearch 失败且错误指向签名不兼容 → 自动去掉该参数重试一次
 */
export async function runVectorQuery(
  session: VectorQuerySession,
  spec: VectorCallSpec,
  tail: string,
  params: Record<string, unknown>,
  efSearch?: number,
): Promise<Result> {
  const ef = Number.isFinite(efSearch) && (efSearch as number) > 0
    ? Math.floor(efSearch as number)
    : 0;
  if (ef > 0) {
    try {
      return await session.run(`${buildVectorCall(spec, true)}\n${tail}`, { ...params, efSearch: ef });
    } catch (err) {
      if (!looksLikeUnsupportedOptions(err)) throw err;
      // 旧版本不支持第 4 个检索参数 → 回落（检索质量下降，但召回不失效）
    }
  }
  return await session.run(`${buildVectorCall(spec, false)}\n${tail}`, params);
}