/**
 * v2.4.0 嵌入辅助（点 2 + 点 6）
 *
 * embedNode: 统一构造嵌入文本（受 memorySliceChars 控制），
 *   若启用分块且文本超长，则将每段分别 embed 并保存分块向量，
 *   否则保存单一主向量。供 upsert/reembed/sync/benchmark 共用，避免重复实现。
 */

import type { Driver } from "neo4j-driver";
import type { EmbedFn, BatchEmbedFn } from "../engine/embed.ts";
import type { GmConfig } from "../types.ts";
import { buildEmbedTexts } from "../recaller/chunk.ts";
import { saveVector, saveChunkVectors, computeEmbeddingHash } from "./store.ts";
import { getSession } from "./db.ts";

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

export interface BatchEmbedNodeItem {
  nodeId: string;
  params: EmbedNodeParams;
}

/**
 * 批量嵌入多个节点并写库（v2.4.0）。
 *
 * 复用 batchEmbedFn 一次请求携带多个文本（Ollama /api/embed input 数组），
 * 显著减少 HTTP 请求数，降低本地 Ollama 请求队列压力（503 maximum pending 触发概率）。
 * 兼容分块模式：每个节点的多段文本展平后统一批量 embed，再按节点回填。
 *
 * @returns 成功写入向量的节点数
 */
export async function embedNodeBatch(
  driver: Driver,
  batchEmbedFn: BatchEmbedFn,
  items: BatchEmbedNodeItem[],
  cfg?: GmConfig,
): Promise<number> {
  if (items.length === 0) return 0;

  const groups = items
    .map((item) => {
      const { texts } = buildEmbedTexts({
        name: item.params.name,
        description: item.params.description,
        content: item.params.content,
        memorySliceChars: cfg?.recall?.memorySliceChars,
        chunking: cfg?.recall?.chunking,
      });
      return {
        nodeId: item.nodeId,
        params: item.params,
        texts,
        hash: computeEmbeddingHash(item.params.name, item.params.description, item.params.content),
      };
    })
    .filter((g) => g.texts.length > 0);
  if (groups.length === 0) return 0;

  // 展平所有文本，一次批量 embed（返回与输入等长，失败的为 null）
  const allTexts: string[] = [];
  const textToGroup: number[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    for (const t of groups[gi].texts) {
      allTexts.push(t);
      textToGroup.push(gi);
    }
  }
  const allVectors = await batchEmbedFn(allTexts);

  // 按节点回填（保留成功项，失败的文本在此丢弃）
  const groupVecs: { text: string; vec: number[] }[][] = groups.map(() => []);
  for (let i = 0; i < allTexts.length; i++) {
    const v = allVectors[i];
    if (v && v.length) groupVecs[textToGroup[i]].push({ text: allTexts[i], vec: v });
  }

  let count = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const succeeded = groupVecs[gi];
    if (succeeded.length === 0) continue;
    if (g.texts.length > 1) {
      await saveChunkVectors(
        driver,
        g.nodeId,
        succeeded.map((s) => s.text),
        succeeded.map((s) => s.vec),
        succeeded[0].vec,
        g.hash,
        g.params.embeddingModel,
      );
    } else {
      await saveVector(driver, g.nodeId, succeeded[0].vec, g.hash, g.params.embeddingModel);
    }
    count++;
  }
  return count;
}

/**
 * v2.8.x: 建图写入路径的 embedding 补齐。
 *
 * 根因修复：extract/gm_record/rebuild 等写入路径此前只写 embeddingModel 字段，
 * 从未调用 embed 计算并落盘向量，导致 Task/Skill 节点 100% 缺 embedding。
 * 本函数只补「缺失」的节点（新节点，或内容变化被 upsertNode 归档清空的节点），
 * 已嵌入的不重复调用 embed（文本不变 → hash 不变 → 向量不变），避免无效重算。
 *
 * @param items 待检查的节点（nodeId + 嵌入参数）
 * @param embedFn 单文本嵌入函数（batchEmbedFn 缺失时的回退）
 * @param batchEmbedFn 批量嵌入函数（优先使用，减少 Ollama 请求队列压力）
 * @returns 实际补写向量的节点数
 */
export async function embedNodesMissing(
  driver: Driver,
  items: BatchEmbedNodeItem[],
  embedFn?: EmbedFn,
  batchEmbedFn?: BatchEmbedFn,
  cfg?: GmConfig,
): Promise<number> {
  if (items.length === 0) return 0;
  if (!embedFn && !batchEmbedFn) return 0;

  // 只处理确实缺向量的节点（新写入或内容变化被清空）
  const session = getSession(driver);
  const missing: Array<{ id: string; name: string; description: string; content: string }> = [];
  try {
    const result = await session.run(
      `MATCH (n:Task|Skill|Event)
       WHERE n.id IN $ids
         AND (n.embedding IS NULL OR n.embedding = [])
       RETURN n.id AS id, n.name AS name, n.description AS description, n.content AS content`,
      { ids: items.map((i) => i.nodeId) },
    );
    for (const rec of result.records) {
      missing.push({
        id: rec.get("id") as string,
        name: rec.get("name") ?? "",
        description: rec.get("description") ?? "",
        content: rec.get("content") ?? "",
      });
    }
  } finally {
    await session.close();
  }
  if (missing.length === 0) return 0;

  const byId = new Map(items.map((i) => [i.nodeId, i.params]));
  const toEmbed: BatchEmbedNodeItem[] = missing.map((m) => ({
    nodeId: m.id,
    params: byId.get(m.id) ?? { name: m.name, description: m.description, content: m.content },
  }));

  if (batchEmbedFn) {
    try {
      return await embedNodeBatch(driver, batchEmbedFn, toEmbed, cfg);
    } catch {
      // 批量失败时回退单条，保证部分成功
    }
  }

  let done = 0;
  for (const item of toEmbed) {
    try {
      const n = await embedNode(driver, embedFn!, item.nodeId, item.params, cfg);
      if (n > 0) done++;
    } catch {
      // 单条失败不影响其他节点
    }
  }
  return done;
}