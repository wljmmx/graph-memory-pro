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
import { createLogger } from "../logger.ts";

const log = createLogger("store:embed");
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
 * v2.8.x: 批量嵌入的失败详情（供调用方输出告警，不再静默丢弃子批次/单节点错误）。
 */
export interface EmbedBatchFailure {
  nodeId: string;
  /** 节点文本中失败的片段数（分块模式可能部分失败） */
  failedChunks: number;
  totalChunks: number;
  /** 失败原因（batchEmbedFn 返回 null 的文本/异常信息） */
  reason?: string;
}

/**
 * 批量嵌入多个节点并写库（v2.4.0）。
 *
 * 复用 batchEmbedFn 一次请求携带多个文本（Ollama /api/embed input 数组），
 * 显著减少 HTTP 请求数，降低本地 Ollama 请求队列压力（503 maximum pending 触发概率）。
 * 兼容分块模式：每个节点的多段文本展平后统一批量 embed，再按节点回填。
 *
 * @param onBatchFailure 可选回调：批量嵌入后发现完全失败/部分失败的节点详情（v2.8.x）
 * @returns 成功写入向量的节点数
 */
export async function embedNodeBatch(
  driver: Driver,
  batchEmbedFn: BatchEmbedFn,
  items: BatchEmbedNodeItem[],
  cfg?: GmConfig,
  onBatchFailure?: (failures: EmbedBatchFailure[]) => void,
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
  // v2.8.x: batchEmbedFn 抛错（Ollama 不可达/模型 404）不再静默吞掉——
  // 交由调用方（reEmbedNodes/embedNodesMissing）决定记录，这里直接向上抛
  // （此前无 catch，抛错会被上层统一处理，但需确认上层已记录日志）
  const allVectors = await batchEmbedFn(allTexts);

  // 按节点回填（保留成功项，失败的文本在此丢弃）
  const groupVecs: { text: string; vec: number[] }[][] = groups.map(() => []);
  for (let i = 0; i < allTexts.length; i++) {
    const v = allVectors[i];
    if (v && v.length) groupVecs[textToGroup[i]].push({ text: allTexts[i], vec: v });
  }

  // v2.8.x: 收集完全失败/部分失败的节点详情（供告警日志，不静默丢弃）
  const failures: EmbedBatchFailure[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const succeeded = groupVecs[gi];
    if (succeeded.length < g.texts.length) {
      failures.push({
        nodeId: g.nodeId,
        failedChunks: g.texts.length - succeeded.length,
        totalChunks: g.texts.length,
        reason: succeeded.length === 0
          ? "batchEmbedFn returned null for all chunks (check embedding model / Ollama status)"
          : `partial: ${succeeded.length}/${g.texts.length} chunks embedded`,
      });
    }
  }
  if (failures.length > 0 && onBatchFailure) {
    onBatchFailure(failures);
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
      return await embedNodeBatch(
        driver, batchEmbedFn, toEmbed, cfg,
        // v2.8.x: 批量部分失败 → 记录具体节点（此前静默，建图缺向量无感知）
        (failures) => {
          const sample = failures.slice(0, 3).map((f) => `id=${f.nodeId} chunks=${f.failedChunks}/${f.totalChunks}`).join("; ");
          log.warn(`embedNodesMissing: ${failures.length}/${toEmbed.length} nodes failed batch embed`, { sample });
        },
      );
    } catch (err) {
      // v2.8.x: 批量失败（Ollama 不可达/模型 404）不再静默——记录后回退单条，保证部分成功
      log.warn("embedNodesMissing: batch embed failed, falling back to single", { error: (err as Error)?.message ?? String(err) });
    }
  }

  let done = 0;
  for (const item of toEmbed) {
    try {
      const n = await embedNode(driver, embedFn!, item.nodeId, item.params, cfg);
      if (n > 0) done++;
      else log.warn("embedNodesMissing: empty text for node, skipped", { nodeId: item.nodeId });
    } catch (err) {
      // v2.8.x: 单条失败记录 nodeId + 原因（此前静默，根因不可见）
      log.warn("embedNodesMissing: node embed failed", { nodeId: item.nodeId, error: (err as Error)?.message ?? String(err) });
    }
  }
  return done;
}