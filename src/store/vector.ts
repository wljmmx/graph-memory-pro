/**
 * graph-memory-pro — 向量索引（Neo4j 数据操作层）
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver } from "neo4j-driver";
import { getSession } from "./db.ts";

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

/**
 * v2.4.0 点6: 保存长文本分块向量（chunkEmbeddings / chunkTexts 属性）。
 *
 * Neo4j 原生属性支持「数组的数组」作为属性值（但向量索引的 embedding 仍是单一向量），
 * 故分块向量以属性形式存储，供多阶段检索在应用层做局部相似度细化。
 *
 * @param chunkTexts 与 chunkVectors 一一对应的文本片段
 * @param vec 主向量（全文本嵌入，写入 embedding 属性，供向量索引检索）
 */
export async function saveChunkVectors(
  driver: Driver,
  nodeId: string,
  chunkTexts: string[],
  chunkVectors: number[][],
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
           n.embeddingModel = $model,
           n.chunkTexts = $chunkTexts,
           n.chunkEmbeddings = $chunkVectors`,
      { nodeId, vec, hash, model: embeddingModel ?? null, chunkTexts, chunkVectors },
    );
  } finally {
    await session.close();
  }
}
