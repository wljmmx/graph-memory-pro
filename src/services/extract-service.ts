/**
 * graph-memory-pro v2.3.4 — 后台三元组提取服务
 *
 * 从 index.ts 拆分出的 extractInBackground 业务逻辑。
 * 职责：从最近会话消息中提取实体/关系写入 Neo4j，不阻塞主流程。
 *
 * 依赖：Extractor / Driver / CompleteFn / GmConfig（用于 archiveKeepCount）
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig, GmNode, GmEdge, GmMessage } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { Extractor } from "../extractor/extract.ts";
import { upsertNode, batchUpsertNodes, upsertEdge, batchUpsertEdges } from "../store/store.ts";
import { getCircuitBreaker } from "../engine/circuit-breaker.ts";
import { getSessionMessages } from "../store/messages.ts";

/**
 * 后台三元组提取：从最近会话消息中提取实体/关系写入 Neo4j。
 *
 * @param extractor 三元组提取器
 * @param driver Neo4j driver
 * @param llm LLM 补全函数
 * @param cfg 插件配置（读取 embedding.model + evolvableEmbedding.archiveKeepCount）
 * @param logger 日志接口
 * @param pendingMessages 待处理的对话对
 */
export async function extractInBackground(
  extractor: Extractor | null,
  driver: Driver | null,
  llm: CompleteFn | null,
  cfg: GmConfig | null,
  logger: { debug?(...args: unknown[]): void; info?(...args: unknown[]): void },
  pendingMessages: Array<{ user: string; assistant: string }>,
): Promise<void> {
  if (!extractor || !driver || !llm || pendingMessages.length === 0) return;

  // v2.3.2 阶段三: LLM 熔断器 — OPEN 时跳过整个 extract tick，减少 Ollama 压力
  const llmBreaker = getCircuitBreaker("llm");
  if (!llmBreaker.allow()) {
    if (process.env.GM_DEBUG) logger?.debug?.("[graph-memory-pro] llm circuit OPEN, skip extract tick");
    return;
  }

  let extracted = 0;
  const maxPairs = 3;
  const pairs = pendingMessages.slice(0, maxPairs);

  for (const pair of pairs) {
    try {
      const result = await extractor.extract(llm, pair.user, pair.assistant);
      llmBreaker.recordSuccess();
      if (result.nodes.length > 0) {
        extracted++;
        const now = Date.now();

        // v2.3.1 P0-3 性能优化: 批量 upsert 节点（UNWIND + MERGE）
        const nodeIdMap = new Map<string, string>();
        const nodesToWrite: GmNode[] = [];
        for (const enode of result.nodes) {
          const id = `auto-${now}-${Math.random().toString(36).slice(2, 8)}`;
          nodeIdMap.set(enode.name, id);
          nodesToWrite.push({
            id,
            type: enode.type,
            name: enode.name,
            description: enode.description,
            content: enode.content,
            status: "active",
            communityId: undefined,
            pagerank: 0,
            validatedCount: 0,
            createdAt: now,
            updatedAt: now,
            embeddingModel: cfg?.embedding?.model,
          });
        }
        try {
          await batchUpsertNodes(driver, nodesToWrite);
        } catch (e) {
          // v2.3.2 S2 稳定性修复: 批量失败时回退到逐条 upsert，保证部分成功（防数据丢失）
          if (process.env.GM_DEBUG) logger?.debug?.(`  [graph-memory-pro] batchUpsertNodes failed, fallback to single upsert: ${e}`);
          await Promise.allSettled(nodesToWrite.map(n => upsertNode(driver, n, cfg ?? undefined)));
        }

        // v2.3.1 P0-3: 批量 upsert 边
        const edgesToWrite: GmEdge[] = [];
        for (const eedge of result.edges) {
          const fromId = nodeIdMap.get(eedge.fromName);
          const toId = nodeIdMap.get(eedge.toName);
          if (!fromId || !toId) continue;
          edgesToWrite.push({
            id: `edge-${now}-${Math.random().toString(36).slice(2, 8)}`,
            type: eedge.type,
            fromId,
            toId,
            instruction: eedge.instruction,
            condition: eedge.condition,
            weight: 1,
            createdAt: now,
            updatedAt: now,
          });
        }
        if (edgesToWrite.length > 0) {
          try {
            await batchUpsertEdges(driver, edgesToWrite);
          } catch (e) {
            if (process.env.GM_DEBUG) logger?.debug?.(`  [graph-memory-pro] batchUpsertEdges failed, fallback to single upsert: ${e}`);
            await Promise.allSettled(edgesToWrite.map(e => upsertEdge(driver, e)));
          }
        }
      }
    } catch (err) {
      llmBreaker.recordFailure();
      if (process.env.GM_DEBUG) logger?.debug?.(`  [graph-memory-pro] extract pair failed: ${err}`);
    }
  }
  if (extracted > 0) {
    logger?.info?.(`[graph-memory-pro] background extractor: ${extracted} turns processed`);
  }
}

/**
 * v2.4.1: 从 Neo4j 已存储的会话消息（:GmMessage）重建三级节点（TASK/SKILL/EVENT）。
 *
 * 场景：会话记录已经导入/存储在 Neo4j（通过 saveMessage 写入 :GmMessage 节点），
 * 需要按已有记录重新跑 LLM 提取，重建生产图谱的三级节点。
 *
 * 流程：
 *   1. 按 sessionKey 读取该会话最近的 N 条消息（getSessionMessages）
 *   2. 将消息对（user / assistant）配对为 extractor 输入
 *   3. 复用 extractInBackground 的核心提取+写入逻辑重建节点
 *
 * 注意：仅对本次未处理过的会话生效（通过 lastProcessedTurn 跳过已重建的轮次），
 * 避免重复提取造成节点堆积。生产流程节点不带 :Benchmark 标签，与 benchmark 隔离。
 */
export async function rebuildGraphFromStoredMessages(
  extractor: Extractor | null,
  driver: Driver | null,
  llm: CompleteFn | null,
  cfg: GmConfig | null,
  logger: { debug?(...args: unknown[]): void; info?(...args: unknown[]): void },
  sessionKey: string,
  limit = 50,
  lastProcessedTurn = 0,
): Promise<number> {
  if (!extractor || !driver || !llm) return 0;
  const messages = await getSessionMessages(driver, sessionKey, limit);
  if (messages.length === 0) return 0;

  // 按 turnIndex 升序，跳过已处理的轮次
  const ordered = [...messages].filter((m) => (m.turnIndex ?? 0) > lastProcessedTurn);
  if (ordered.length === 0) return 0;

  // 配对 user/assistant（允许 user 后缺 assistant 时跳过该轮）
  const pairs: Array<{ user: string; assistant: string }> = [];
  let i = 0;
  while (i < ordered.length) {
    const cur = ordered[i];
    if (cur.role === "user") {
      const next = ordered[i + 1];
      if (next && next.role === "assistant") {
        pairs.push({ user: cur.content, assistant: next.content });
        i += 2;
        continue;
      }
    }
    i += 1;
  }

  if (pairs.length === 0) return 0;
  await extractInBackground(extractor, driver, llm, cfg, logger, pairs);
  return pairs.length;
}
