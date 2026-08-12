/**
 * v2.4.0 嵌入辅助（点 2 + 点 6）
 *
 * embedNode: 统一构造嵌入文本（受 memorySliceChars 控制），
 *   若启用分块且文本超长，则将每段分别 embed 并保存分块向量，
 *   否则保存单一主向量。供 upsert/reembed/sync/benchmark 共用，避免重复实现。
 */

import type { Driver } from "neo4j-driver";
import type { EmbedFn } from "../engine/embed.ts";
import type { GmConfig } from "../types.ts";
import { buildEmbedTexts } from "../recaller/chunk.ts";
import { saveVector, saveChunkVectors, computeEmbeddingHash } from "./store.ts";

export interface EmbedNodeParams {
  name: string;
  description: string;
  content: string;
  embeddingModel?: string;
}

/**
 * 嵌入一个节点并写库。
 *
 * @returns { vectors } 实际写入的向量数（失败返回 0）
 */
export async function embedNode(
  driver: Driver,
  embedFn: EmbedFn,
  nodeId: string,
  params: EmbedNodeParams,
  cfg?: GmConfig,
): Promise<number> {
  const { texts, chunked } = buildEmbedTexts({
    name: params.name,
    description: params.description,
    content: params.content,
    memorySliceChars: cfg?.recall?.memorySliceChars,
    chunking: cfg?.recall?.chunking,
  });
  if (texts.length === 0) return 0;

  const hash = computeEmbeddingHash(params.name, params.description, params.content);

  // 分块模式：逐段 embed，保存分块向量 + 主向量（主向量用首段结果，供向量索引）
  if (chunked) {
    const chunkVectors: number[][] = [];
    const chunkTexts: string[] = [];
    let mainVec: number[] | null = null;
    for (let i = 0; i < texts.length; i++) {
      const vec = await embedFn(texts[i]);
      if (!vec || vec.length === 0) continue;
      chunkTexts.push(texts[i]);
      chunkVectors.push(vec);
      if (mainVec === null) mainVec = vec;
    }
    if (mainVec === null || chunkVectors.length === 0) return 0;
    await saveChunkVectors(
      driver,
      nodeId,
      chunkTexts,
      chunkVectors,
      mainVec,
      hash,
      params.embeddingModel,
    );
    return chunkVectors.length;
  }

  // 单向量模式：只 embed 主文本
  const vec = await embedFn(texts[0]);
  if (!vec || vec.length === 0) return 0;
  await saveVector(driver, nodeId, vec, hash, params.embeddingModel);
  return 1;
}