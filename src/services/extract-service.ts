/**
 * graph-memory-pro v2.3.4 — 后台三元组提取服务
 *
 * 从 index.ts 拆分出的 extractInBackground 业务逻辑。
 * 职责：从最近会话消息中提取实体/关系写入 Neo4j，不阻塞主流程。
 *
 * 依赖：Extractor / Driver / CompleteFn / GmConfig（用于 archiveKeepCount）
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig, GmNode, GmEdge, GmMessage, ExtractResult, NodeType } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { Extractor } from "../extractor/extract.ts";
import { upsertNode, batchUpsertNodes, upsertEdge, batchUpsertEdges } from "../store/store.ts";
import { getCircuitBreaker } from "../engine/circuit-breaker.ts";
import { getSessionMessages, getSessionMessagesPageTolerant, listAllSessionKeys, markMessagesProcessed } from "../store/messages.ts";
import { heuristicExtract } from "../extractor/extract.ts";

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
        // v2.4.1 统一: 与重建流程共用确定性 id（gn-hash(type|name)）+ type 大写归一，
        // 使两条流程 MERGE 命中同一节点实现更新，而非各写一套重复节点。
        const nodeIdMap = new Map<string, string>();
        const nodesToWrite: GmNode[] = [];
        for (const enode of result.nodes) {
          const normalizedType = enode.type.toUpperCase() as NodeType;
          const id = deterministicNodeId(normalizedType, enode.name);
          // v2.4.1: 以规范化名（小写去空格）建索引，供边引用名容错匹配
          nodeIdMap.set(normName(enode.name), id);
          nodesToWrite.push({
            id,
            type: normalizedType,
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
          // v2.4.1: 边引用名用规范化匹配，避免大小写/空格差异导致 0 条边
          const fromId = nodeIdMap.get(normName(eedge.fromName));
          const toId = nodeIdMap.get(normName(eedge.toName));
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

  // v2.4.1 修复: turnIndex 全 0/缺失（导入数据常见）时 `> lastProcessedTurn` 会过滤掉全部消息，
  // 此时不做轮次过滤（重跑由确定性 id 幂等去重兜底）。
  const maxTurn = messages.reduce((mx, m) => Math.max(mx, m.turnIndex ?? 0), 0);
  const ordered = maxTurn > 0
    ? messages.filter((m) => (m.turnIndex ?? 0) > lastProcessedTurn)
    : messages;
  if (ordered.length === 0) return 0;

  // 配对 user/assistant（v2.4.1: role 归一化，兼容 USER/Human/model 等导入变体）
  const pairs: Array<{ user: string; assistant: string }> = [];
  let i = 0;
  while (i < ordered.length) {
    const cur = ordered[i];
    if (normRole(cur.role) === "user") {
      const next = ordered[i + 1];
      if (next && normRole(next.role) === "assistant") {
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

// ─────────────────────────────────────────────────────────────
// v2.4.1 高性能重建：面向 11 万级会话消息的批量重建
//
// 相比 rebuildGraphFromStoredMessages（单次 limit=50 + 内部 maxPairs=3 + LLM 串行），
// 本函数针对大批量做四点优化：
//   1. 键集分页流式读取全部消息（getSessionMessagesPage），消除分页往返
//   2. LLM 并发提取（concurrency 窗口），替代串行 + maxPairs=3
//   3. 多对结果合并为一次 UNWIND 批量写（节点/边），降低 Neo4j 往返
//   4. 确定性节点 id（hash(type+name)），MERGE 幂等去重，重跑不膨胀
// 并支持进度文件断点续传（progressPath），中断后带进度续跑。
// ─────────────────────────────────────────────────────────────

export interface RebuildOptions {
  /** LLM 并发窗口（本地 Ollama 推荐低并发，默认 4，可调 1–128） */
  concurrency?: number;
  /** 键集分页读取的每页大小（默认 2000） */
  pageSize?: number;
  /** 合并写入的批大小上限（默认 500 节点/边） */
  writeBatchSize?: number;
  /** 进度文件路径（JSON），用于断点续传 */
  progressPath?: string;
  /** 进度回调（可用于日志/进度条） */
  onProgress?: (info: { processedPairs: number; totalPairs: number; lastProcessedTurn: number }) => void;
  /** v2.4.1: 提取模式。默认 "llm"（调用 LLM）；"heuristic"（规则快速提取，不调 LLM，零成本） */
  mode?: "llm" | "heuristic";
  /** v2.4.1: 断点续传起始轮次（未传 progressPath 时使用；progressPath 记录优先） */
  lastProcessedTurn?: number;
  /** v2.4.2: 增量重建。只处理未标记（rebuildProcessedAt IS NULL）的消息，
   * 处理完打标记。用「标记」替代进度文件断点，避免每次从头重扫已处理消息，
   * 让新增（在末尾）的时序消息能及时被处理。重复/全量重建请勿开启。 */
  markProcessed?: boolean;
}

interface RebuildPair {
  user: string;
  assistant: string;
  /** 该对的序号（按 (createdAt,id) 顺序的合成序号，1 起），用于断点续传。
   * v2.4.1 修复: 不再用 turnIndex——导入数据常为 0/缺失，`0 > 0` 恒 false 曾导致全部 0/0。 */
  lastTurn: number;
  /** v2.4.2: 组成该对的 GmMessage id，用于增量标记（markProcessed）。 */
  msgIds: string[];
}

/**
 * v2.4.1: 消息 role 归一化。导入数据的 role 可能是 USER/Human/model/AI 等变体，
 * 严格 === "user"/"assistant" 会配不上对导致 0 对。归一为 user/assistant/空。
 */
function normRole(role: unknown): "user" | "assistant" | "" {
  const r = String(role ?? "").trim().toLowerCase();
  if (["user", "human", "用户", "client"].includes(r)) return "user";
  if (["assistant", "ai", "model", "bot", "gpt", "助手", "system-assistant"].includes(r)) return "assistant";
  return "";
}

/** 确定性哈希（FNV-1a 32bit），用于幂等节点 id */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * v2.4.1: 节点名规范化，用于边引用名与节点 name 的容错匹配。
 * LLM 返回的 edge.fromName/toName 常与节点 name 存在大小写/空格/连字符/标点差异，
 * 直接精确匹配会全部落空导致 0 条边。统一转小写并去掉所有非字母数字字符作匹配 key。
 */
function normName(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
}

function deterministicNodeId(type: string, name: string): string {
  return `gn-${hashString(type + "|" + name)}`;
}

function readRebuildProgress(path: string): Promise<{ sessionKey: string; lastProcessedTurn: number } | null> {
  return import("node:fs/promises").then(
    (fs) =>
      fs.readFile(path, "utf-8").then(
        (text) => {
          try {
            const j = JSON.parse(text);
            // v2.4.1: 校验 kind，避免与 rebuild-all 的全局进度文件格式混用
            // 兼容旧格式（无 kind 字段，仅有 sessionKey/lastProcessedTurn）
            if (j.kind !== undefined && j.kind !== "session") return null;
            return { sessionKey: String(j.sessionKey ?? ""), lastProcessedTurn: Number(j.lastProcessedTurn ?? 0) || 0 };
          } catch {
            return null;
          }
        },
        () => null,
      ),
    () => null,
  );
}

function writeRebuildProgress(path: string, data: Record<string, unknown>): Promise<void> {
  return import("node:fs/promises").then((fs) =>
    fs.writeFile(path, JSON.stringify({ kind: "session", version: 2, updatedAt: new Date().toISOString(), ...data })).catch(() => undefined),
  );
}

/**
 * 从 Neo4j 已存储会话消息（:GmMessage）高性能重建三级节点。
 *
 * @returns 实际处理的对数，以及本会话最新处理到的轮次（用于断点续传）
 */
export async function rebuildSessionMessages(
  extractor: Extractor | null,
  driver: Driver | null,
  llm: CompleteFn | null,
  cfg: GmConfig | null,
  logger: { debug?(...args: unknown[]): void; info?(...args: unknown[]): void },
  sessionKey: string,
  opts: RebuildOptions = {},
): Promise<{ processedPairs: number; totalPairs: number; lastProcessedTurn: number }> {
  const mode = opts.mode ?? "llm";
  if (!driver) return { processedPairs: 0, totalPairs: 0, lastProcessedTurn: 0 };
  // heuristic 模式不依赖 LLM/Extractor；llm 模式两者必需
  if (mode === "llm" && (!extractor || !llm)) return { processedPairs: 0, totalPairs: 0, lastProcessedTurn: 0 };

  const llmBreaker = getCircuitBreaker("llm");
  if (mode === "llm" && !llmBreaker.allow()) {
    logger?.info?.("[graph-memory-pro] llm circuit OPEN, skip rebuild");
    return { processedPairs: 0, totalPairs: 0, lastProcessedTurn: 0 };
  }

  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const pageSize = Math.max(100, opts.pageSize ?? 2000);
  const writeBatchSize = Math.max(50, opts.writeBatchSize ?? 500);

  // v2.4.2: 增量模式（markProcessed）——用「rebuildProcessedAt 标记」替代进度文件断点：
  // 只读未标记消息、处理完打标记。故忽略进度文件/lastProcessedTurn，从 0 起（未标记即全部处理）。
  const markProcessed = !!opts.markProcessed;
  let lastProcessedTurn = opts.lastProcessedTurn ?? 0;
  if (markProcessed) {
    lastProcessedTurn = 0;
  } else if (opts.progressPath) {
    const saved = await readRebuildProgress(opts.progressPath);
    if (saved && saved.sessionKey === sessionKey) lastProcessedTurn = saved.lastProcessedTurn || 0;
  }

  // v2.4.1: 按模式选择提取函数（llm=调用 LLM；heuristic=规则快速提取，不调 LLM）
  const llmExtractor = extractor!;
  const extractOne: (p: RebuildPair) => Promise<ExtractResult> =
    mode === "heuristic"
      ? (p) => Promise.resolve(heuristicExtract(p.user, p.assistant))
      : (p) => llmExtractor.extract(llm!, p.user, p.assistant);

  // v2.4.1: 流式处理，内存占用 O(pageSize + concurrency + writeBatchSize)，
  // 而非把整会话的全部对一次性载入内存（11 万级数据下避免内存爆满）。
  let processed = 0;      // 已处理对数
  let lastTurn = lastProcessedTurn;
  let totalPairs = 0;     // 本次（断点过滤后）可处理对数
  let pendingNodes: GmNode[] = [];
  let pendingEdges: GmEdge[] = [];
  const seenNodeIds = new Set<string>();
  // v2.4.1: 边去重，避免同一 (from,to,type) 在会话内重复累积导致 pendingEdges 膨胀
  const seenEdgeIds = new Set<string>();

  // v2.4.1: 批量写；失败自动回退逐条 upsert，保证节点/边不因单批失败而丢失
  const flush = async () => {
    if (pendingNodes.length) {
      try { await batchUpsertNodes(driver, pendingNodes); }
      catch (e) {
        logger?.debug?.(`[graph-memory-pro] rebuild batchUpsertNodes failed, fallback single: ${e}`);
        await Promise.allSettled(pendingNodes.map((n) => upsertNode(driver, n, cfg ?? undefined)));
      }
    }
    if (pendingEdges.length) {
      try { await batchUpsertEdges(driver, pendingEdges); }
      catch (e) {
        logger?.debug?.(`[graph-memory-pro] rebuild batchUpsertEdges failed, fallback single: ${e}`);
        await Promise.allSettled(pendingEdges.map((ed) => upsertEdge(driver, ed)));
      }
    }
    pendingNodes = [];
    pendingEdges = [];
    seenNodeIds.clear();
    seenEdgeIds.clear();
  };

  const writeProgress = async (status: string) => {
    if (opts.progressPath) {
      await writeRebuildProgress(opts.progressPath, { sessionKey, lastProcessedTurn: lastTurn, processedPairs: processed, totalPairs, status });
    }
  };

  // 并发提取一个窗口 + 累积 + 按需 flush
  const processWindow = async (window: RebuildPair[]) => {
    const results = await Promise.allSettled(window.map((p) => extractOne(p)));
    let windowTurn = lastTurn;
    for (let k = 0; k < window.length; k++) {
      const p = window[k];
      windowTurn = Math.max(windowTurn, p.lastTurn);
      const r = results[k];
      if (r.status === "rejected") {
        llmBreaker.recordFailure();
        continue;
      }
      llmBreaker.recordSuccess();
      const res = r.value;
      if (!res.nodes.length && !res.edges.length) continue;

      const now = Date.now();
      const nodeIdMap = new Map<string, string>();
      for (const enode of res.nodes) {
        // v2.4.1 统一: type 大写归一后再 hash，与普通流程（extractInBackground）id 对齐，
        // 保证重建能命中普通流程已建的节点并更新，而非新建重复。
        const normalizedType = enode.type.toUpperCase() as NodeType;
        const id = deterministicNodeId(normalizedType, enode.name);
        // v2.4.1: 同时以规范化名建索引，供边引用名容错匹配
        nodeIdMap.set(normName(enode.name), id);
        if (seenNodeIds.has(id)) continue;
        seenNodeIds.add(id);
        pendingNodes.push({
          id,
          type: normalizedType,
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
      for (const eedge of res.edges) {
        // v2.4.1: 边引用名用规范化匹配，避免大小写/空格差异导致 0 条边
        const fromId = nodeIdMap.get(normName(eedge.fromName));
        const toId = nodeIdMap.get(normName(eedge.toName));
        if (!fromId || !toId) continue;
        const eid = `ge-${hashString(fromId + "|" + toId + "|" + eedge.type)}`;
        if (seenEdgeIds.has(eid)) continue;
        seenEdgeIds.add(eid);
        pendingEdges.push({
          id: eid,
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
    }
    lastTurn = windowTurn;
    processed += window.length;
    if (pendingNodes.length >= writeBatchSize || pendingEdges.length >= writeBatchSize) {
      await flush();
    }
    await writeProgress("running");
    opts.onProgress?.({ processedPairs: processed, totalPairs, lastProcessedTurn: lastTurn });
  };

  // 流式：键集分页读取 + 即时配对 + 按窗口处理（不整会话全量载入）
  // v2.4.1 修复: 配对/断点不再依赖 turnIndex（导入数据常为 0/缺失，`0 > 0` 恒 false
  // 曾导致所有会话 0/0 pairs）；改用按 (createdAt,id) 顺序的合成序号 seq（1 起，确定性，
  // 重跑稳定），断点语义 = 已处理到的对序号。role 做归一化，兼容 USER/Human/model 等变体。
  let after: { createdAt: number | string; id: string } | null = null;
  let pairSeq = 0;                       // 本次扫描中已形成的对序号（含被断点跳过的）
  let pendingUser: { content: string; ids: string[] } | null = null;
  const windowBuf: RebuildPair[] = [];
  // v2.4.2: 增量标记收集——本 session 被消费（形成对/孤立 assistant）的消息 id，
  // 扫描结束后统一打 rebuildProcessedAt 标记，下次重建只处理新增（未标记）消息。
  const consumedMsgIds = new Set<string>();
  let pages = 0;
  for (;;) {
    // v2.4.1 护栏: 防御数据异常（键集不前进/超大表）导致死循环
    if (++pages > 100_000) {
      logger?.info?.(`[graph-memory-pro] rebuild page guard hit for ${sessionKey}, stop at page ${pages}`);
      break;
    }
    // v2.4.2: markProcessed 时只读未标记消息（增量）
    const { rows } = await getSessionMessagesPageTolerant(driver, sessionKey, after, pageSize, markProcessed);
    if (rows.length === 0) break;
    for (const m of rows) {
      const role = normRole(m.role);
      if (role === "user") {
        if (pendingUser) {
          pairSeq++;
          if (pairSeq > lastProcessedTurn) {
            const p: RebuildPair = { user: pendingUser.content, assistant: "", lastTurn: pairSeq, msgIds: pendingUser.ids };
            windowBuf.push(p);
            totalPairs++;
            if (markProcessed) for (const id of p.msgIds) consumedMsgIds.add(id);
          }
        }
        pendingUser = { content: m.content, ids: [m.id] };
      } else if (role === "assistant") {
        if (pendingUser) {
          pairSeq++;
          if (pairSeq > lastProcessedTurn) {
            const p: RebuildPair = { user: pendingUser.content, assistant: m.content, lastTurn: pairSeq, msgIds: [...pendingUser.ids, m.id] };
            windowBuf.push(p);
            totalPairs++;
            if (markProcessed) for (const id of p.msgIds) consumedMsgIds.add(id);
          }
          pendingUser = null;
        } else if (markProcessed) {
          // 孤立 assistant（无配对 user）：也标记，避免每次增量扫描都重复读到它
          consumedMsgIds.add(m.id);
        }
      }
    }
    while (windowBuf.length >= concurrency) {
      await processWindow(windowBuf.splice(0, concurrency));
    }
    const last = rows[rows.length - 1];
    // v2.4.1 护栏: 键集未前进（同页重复）则终止，避免死循环
    if (after && String(after.createdAt) === String(last.createdAt) && after.id === last.id) break;
    after = { createdAt: last.createdAt, id: last.id };
    if (rows.length < pageSize) break;
  }
  // 处理尾部不足一个窗口的剩余对
  while (windowBuf.length) {
    await processWindow(windowBuf.splice(0, concurrency));
  }

  await flush();
  // v2.4.2: 增量模式收尾——给本 session 消费过的消息打 rebuildProcessedAt 标记，
  // 下次重建只处理新增（未标记）消息，避免新增时序消息排在末尾延时处理。
  if (markProcessed && consumedMsgIds.size) {
    try {
      await markMessagesProcessed(driver, sessionKey, [...consumedMsgIds]);
    } catch (e) {
      logger?.debug?.(`[graph-memory-pro] markMessagesProcessed failed for ${sessionKey}: ${e}`);
    }
  }
  await writeProgress("done");
  logger?.info?.(`[graph-memory-pro] rebuild complete: ${processed}/${totalPairs} pairs`);
  return { processedPairs: processed, totalPairs, lastProcessedTurn: lastTurn };
}

// ─────────────────────────────────────────────────────────────
// v2.4.1 批量重建全部会话（进程内 session 级并发）
//
// 相比「手动启动多个 API 实例」：本函数在单进程内用 sessionConcurrency 个
// 工作协程并发处理多个 session，每个 session 内部再用 concurrency 窗口并发
// 提取。复用同一 Neo4j 连接池与进度文件，避免多实例的连接池压力与进度竞争。
// 支持 mode（llm/heuristic）与 progressPath 断点续传。
// ─────────────────────────────────────────────────────────────

export interface RebuildAllOptions extends RebuildOptions {
  /** 同时并发处理的 session 数（默认 2，本地 Ollama 请勿过高） */
  sessionConcurrency?: number;
  /** 最多处理多少个 session（调试/分批用，默认 0 = 全部） */
  limitSessions?: number;
  /** v2.4.1: 是否包含内部记忆子会话（默认 false=过滤含 `:active-memory:` 的 key，
   * 避免遍历数万个无产出（无 user/assistant 对）的记忆会话导致卡慢） */
  includeMemorySessions?: boolean;
  /** v2.4.1: 自定义排除的 sessionKey 子串。提供则替换默认排除列表。
   * 默认排除 `:active-memory:` 与 `dreaming-narrative` 前缀（内部记忆/叙事 agent 会话，无对话对）。 */
  excludeSessionKeySubstrings?: string[];
}

/** v2.4.1: 默认排除的内部记忆/叙事 agent 会话子串（无 user/assistant 对话对，重建必然 0 产出）。
 * 用通用前缀 dreaming-narrative 覆盖 rem/light 等所有变体。 */
const DEFAULT_EXCLUDE_SESSION_SUBSTRINGS = [":active-memory:", "dreaming-narrative"];

/** 全局进度状态（rebuild-all 用） */
interface RebuildAllProgress {
  totalSessions: number;
  processedSessions: number;
  totalPairs: number;
  processedPairs: number;
  /** v2.4.1: 处理失败的 session 数，供 API 层与断点文件反馈闭环 */
  failedSessions: number;
  done: boolean;
  /** 每个 session 上次处理到的轮次，用于续跑 */
  sessions: Record<string, number>;
  updatedAt: string;
}

function readAllProgress(path: string): Promise<RebuildAllProgress | null> {
  return import("node:fs/promises").then(
    (fs) => fs.readFile(path, "utf-8").then((t) => {
      try {
        const j = JSON.parse(t) as RebuildAllProgress;
        // v2.4.1: 校验 kind，避免与单 session 进度文件格式混用
        const raw = JSON.parse(t) as Record<string, unknown>;
        if (raw.kind !== undefined && raw.kind !== "all") return null;
        return j;
      } catch { return null; }
    }).catch(() => null),
    () => null,
  );
}

function writeAllProgress(path: string, data: RebuildAllProgress): Promise<void> {
  return import("node:fs/promises").then((fs) =>
    fs.writeFile(path, JSON.stringify({ kind: "all", version: 2, ...data })).catch(() => undefined),
  );
}

/**
 * 遍历全部会话并批量重建三级节点。
 *
 * @returns 处理统计
 */
export async function rebuildAllSessions(
  extractor: Extractor | null,
  driver: Driver | null,
  llm: CompleteFn | null,
  cfg: GmConfig | null,
  logger: { debug?(...args: unknown[]): void; info?(...args: unknown[]): void },
  opts: Omit<RebuildAllOptions, "progressPath"> & { progressPath?: string } = {},
): Promise<{
  totalSessions: number;
  processedSessions: number;
  totalPairs: number;
  processedPairs: number;
  failedSessions: number;
  mode: "llm" | "heuristic";
  results: Record<string, { processedPairs: number; totalPairs: number }>;
}> {
  if (!driver) return { totalSessions: 0, processedSessions: 0, totalPairs: 0, processedPairs: 0, failedSessions: 0, mode: opts.mode ?? "llm", results: {} };

  const sessionConcurrency = Math.max(1, opts.sessionConcurrency ?? 2);
  const limitSessions = Math.max(0, opts.limitSessions ?? 0);
  const mode = opts.mode ?? "llm";
  const progressPath = opts.progressPath;

  // 断点恢复：已完成的 session 及其轮次
  let progress: RebuildAllProgress | null = null;
  if (progressPath) progress = await readAllProgress(progressPath);

  const keys = await listAllSessionKeys(driver);
  // v2.4.1: 默认过滤内部记忆/叙事 agent 会话（`:active-memory:`、`dreaming-narrative-rem`），
  // 它们无 user/assistant 对话对，重建必然 0 产出，遍历会拖慢进度。
  // 可用 excludeSessionKeySubstrings 自定义覆盖；includeMemorySessions=true 时放行 active-memory。
  const baseExclude = opts.includeMemorySessions
    ? DEFAULT_EXCLUDE_SESSION_SUBSTRINGS.filter((s) => s !== ":active-memory:")
    : DEFAULT_EXCLUDE_SESSION_SUBSTRINGS;
  const exclude = opts.excludeSessionKeySubstrings && opts.excludeSessionKeySubstrings.length
    ? opts.excludeSessionKeySubstrings
    : baseExclude;
  const filtered = keys.filter((k) => !exclude.some((s) => k.includes(s)));
  const targets = limitSessions > 0 ? filtered.slice(0, limitSessions) : filtered;
  const totalSessions = targets.length;

  const results: Record<string, { processedPairs: number; totalPairs: number }> = {};
  let processedSessions = 0;
  let processedPairs = 0;
  let totalPairs = 0;
  // v2.4.1: 失败（异常）的 session 计数，供 API 层反馈闭环
  let failedSessions = 0;
  // v2.4.1: LLM 熔断器，worker 级预检，避免熔断 session 被误记为完成（totalPairs=0 → -1）
  const llmBreaker = getCircuitBreaker("llm");

  // v2.4.1: 进度文件磁盘写入节流——此前每 session 全量重写整个 sessions map（JSON 随会话数
  // 线性膨胀），2600+ 会话时 IO 放大严重，慢盘上表现为"跑一批后卡死"。改为 ≥2s 才落盘一次，
  // 结束时兜底写最终进度。
  let lastDiskWrite = 0;
  const persistProgress = async (force = false) => {
    if (!progressPath) return;
    const now = Date.now();
    if (!force && now - lastDiskWrite < 2000) return;
    lastDiskWrite = now;
    await writeAllProgress(progressPath, progress!);
  };

  const record = async (key: string, r: { processedPairs: number; totalPairs: number; lastProcessedTurn: number }) => {
    results[key] = r;
    processedSessions++;
    processedPairs += r.processedPairs;
    totalPairs += r.totalPairs;
    if (progressPath) {
      // v2.4.1: 无可处理对（totalPairs=0）或已全部处理完 → 记为 -1（下次跳过），
      // 避免无产出的 session（如纯 memory 子会话）在续跑时被重复尝试。
      const done = r.totalPairs === 0 || (r.processedPairs > 0 && r.processedPairs >= r.totalPairs);
      const mark = done ? -1 : r.lastProcessedTurn;
      progress = {
        totalSessions,
        processedSessions,
        totalPairs,
        processedPairs,
        failedSessions,
        done: processedSessions >= totalSessions,
        sessions: { ...(progress?.sessions ?? {}), [key]: mark },
        updatedAt: new Date().toISOString(),
      };
      await persistProgress();
    }
    // v2.4.1: 心跳日志——每 100 个 session 汇报一次进度，区分"在跑"与"卡死"
    if (processedSessions % 100 === 0) {
      logger?.info?.(`[graph-memory-pro] rebuild-all progress: ${processedSessions}/${totalSessions} sessions, ${processedPairs} pairs, ${failedSessions} failed`);
    } else {
      logger?.info?.(`[graph-memory-pro] rebuilt session ${key}: ${r.processedPairs}/${r.totalPairs} pairs`);
    }
  };

  // 工作协程池：并发处理多个 session
  let idx = 0;
  const worker = async () => {
    while (idx < totalSessions) {
      const key = targets[idx++];
      // 断点：该 session 已做完（lastTurn 记为 -1）则跳过。
      // v2.4.2: markProcessed 增量模式下以「消息标记」为准，不用进度文件断点。
      if (!opts.markProcessed && progress?.sessions?.[key] === -1) continue;
      // v2.4.1: LLM 熔断时跳过，不 record、不标记，避免被误记为完成（totalPairs=0 → -1）
      if (mode === "llm" && !llmBreaker.allow()) continue;
      try {
        const perSession = opts.markProcessed ? undefined : (progress?.sessions?.[key] ?? undefined);
        const r = await rebuildSessionMessages(extractor, driver, llm, cfg, logger, key, {
          concurrency: opts.concurrency,
          pageSize: opts.pageSize,
          writeBatchSize: opts.writeBatchSize,
          mode,
          markProcessed: opts.markProcessed,
          // v2.4.1: 透传进度回调，支持 API 层实时反馈
          ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
          // 断点续传：该 session 已处理的轮次
          ...(typeof perSession === "number" && perSession > 0 ? { lastProcessedTurn: perSession } : {}),
        });
        await record(key, r);
      } catch (err) {
        // v2.4.1: 失败计数，供 API 层反馈；不标记进度，续跑会重试
        failedSessions++;
        logger?.debug?.(`[graph-memory-pro] rebuild session ${key} failed: ${err}`);
      }
    }
  };
  const workers = Array.from({ length: sessionConcurrency }, () => worker());
  await Promise.all(workers);

  // v2.4.1: 结束时兜底强制落盘最终进度（节流期间可能落后于内存态）
  await persistProgress(true);

  // v2.4.1: 完成汇总日志，明确反馈"已结束"，避免看不到完成状态
  logger?.info?.(
    `[graph-memory-pro] rebuild-all done: ${processedSessions}/${totalSessions} sessions, ${processedPairs}/${totalPairs} pairs, ${failedSessions} failed, mode=${mode}`,
  );
  return { totalSessions, processedSessions, totalPairs, processedPairs, failedSessions, mode, results };
}
