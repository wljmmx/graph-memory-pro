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
