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
import { getSessionMessages, getSessionMessagesPage, listAllSessionKeys } from "../store/messages.ts";
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
}

interface RebuildPair {
  user: string;
  assistant: string;
  /** 该对的轮次（取 assistant 的 turnIndex），用于断点续传 */
  lastTurn: number;
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
    fs.writeFile(path, JSON.stringify(data)).catch(() => undefined),
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

  // 断点恢复：progressPath 记录优先，否则用调用方传入的起始轮次
  let lastProcessedTurn = opts.lastProcessedTurn ?? 0;
  if (opts.progressPath) {
    const saved = await readRebuildProgress(opts.progressPath);
    if (saved && saved.sessionKey === sessionKey) lastProcessedTurn = saved.lastProcessedTurn || 0;
  }

  // 1) 键集分页流式读取全部消息并配对
  const pairs: RebuildPair[] = [];
  {
    let afterCreatedAt = -1;
    let afterId = "";
    let pendingUser: { content: string; turn: number } | null = null;
    for (;;) {
      const page = await getSessionMessagesPage(driver, sessionKey, afterCreatedAt, afterId, pageSize);
      if (page.length === 0) break;
      for (const m of page) {
        if (m.role === "user") {
          if (pendingUser) pairs.push({ user: pendingUser.content, assistant: "", lastTurn: pendingUser.turn });
          pendingUser = { content: m.content, turn: m.turnIndex };
        } else if (m.role === "assistant") {
          if (pendingUser) {
            pairs.push({ user: pendingUser.content, assistant: m.content, lastTurn: m.turnIndex });
            pendingUser = null;
          }
        }
      }
      const last = page[page.length - 1];
      afterCreatedAt = last.createdAt;
      afterId = last.id;
      if (page.length < pageSize) break;
    }
  }

  const todo = pairs.filter((p) => p.lastTurn > lastProcessedTurn);
  const totalPairs = todo.length;
  if (totalPairs === 0) return { processedPairs: 0, totalPairs, lastProcessedTurn };

  // 2) 并发提取 + 合并批量写
  let processed = 0;
  let lastTurn = lastProcessedTurn;
  let pendingNodes: GmNode[] = [];
  let pendingEdges: GmEdge[] = [];
  const seenNodeIds = new Set<string>();

  // v2.4.1: 按模式选择提取函数（llm=调用 LLM；heuristic=规则快速提取，不调 LLM）
  // 外层已保证 mode="llm" 时 extractor/llm 非空，此处提前取出非空引用供闭包使用
  const llmExtractor = extractor!;
  const extractOne: (p: RebuildPair) => Promise<ExtractResult> =
    mode === "heuristic"
      ? (p) => Promise.resolve(heuristicExtract(p.user, p.assistant))
      : (p) => llmExtractor.extract(llm!, p.user, p.assistant);

  const flush = async () => {
    let wroteNodes = 0;
    let wroteEdges = 0;
    if (pendingNodes.length) {
      try { wroteNodes = await batchUpsertNodes(driver, pendingNodes); }
      catch (e) { logger?.debug?.(`[graph-memory-pro] rebuild batchUpsertNodes failed: ${e}`); }
    }
    if (pendingEdges.length) {
      try { wroteEdges = await batchUpsertEdges(driver, pendingEdges); }
      catch (e) { logger?.debug?.(`[graph-memory-pro] rebuild batchUpsertEdges failed: ${e}`); }
    }
    pendingNodes = [];
    pendingEdges = [];
    seenNodeIds.clear();
    return { wroteNodes, wroteEdges };
  };

  for (let i = 0; i < todo.length; i += concurrency) {
    const window = todo.slice(i, i + concurrency);
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
        // v2.4.1: 同时以规范化名（小写去空格）建索引，供边引用名容错匹配
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
        pendingEdges.push({
          id: `ge-${hashString(fromId + "|" + toId + "|" + eedge.type)}`,
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
    if (opts.progressPath && (i % (concurrency * 20) === 0 || i + concurrency >= todo.length)) {
      await writeRebuildProgress(opts.progressPath, { sessionKey, lastProcessedTurn: lastTurn, processedPairs: processed, totalPairs });
    }
    opts.onProgress?.({ processedPairs: processed, totalPairs, lastProcessedTurn: lastTurn });
  }

  await flush();
  if (opts.progressPath) {
    await writeRebuildProgress(opts.progressPath, { sessionKey, lastProcessedTurn: lastTurn, processedPairs: processed, totalPairs, status: "done" });
  }
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
}

/** 全局进度状态（rebuild-all 用） */
interface RebuildAllProgress {
  totalSessions: number;
  processedSessions: number;
  totalPairs: number;
  processedPairs: number;
  done: boolean;
  /** 每个 session 上次处理到的轮次，用于续跑 */
  sessions: Record<string, number>;
  updatedAt: string;
}

function readAllProgress(path: string): Promise<RebuildAllProgress | null> {
  return import("node:fs/promises").then(
    (fs) => fs.readFile(path, "utf-8").then((t) => {
      try { return JSON.parse(t) as RebuildAllProgress; } catch { return null; }
    }).catch(() => null),
    () => null,
  );
}

function writeAllProgress(path: string, data: RebuildAllProgress): Promise<void> {
  return import("node:fs/promises").then((fs) =>
    fs.writeFile(path, JSON.stringify(data)).catch(() => undefined),
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
  mode: "llm" | "heuristic";
  results: Record<string, { processedPairs: number; totalPairs: number }>;
}> {
  if (!driver) return { totalSessions: 0, processedSessions: 0, totalPairs: 0, processedPairs: 0, mode: opts.mode ?? "llm", results: {} };

  const sessionConcurrency = Math.max(1, opts.sessionConcurrency ?? 2);
  const limitSessions = Math.max(0, opts.limitSessions ?? 0);
  const mode = opts.mode ?? "llm";
  const progressPath = opts.progressPath;

  // 断点恢复：已完成的 session 及其轮次
  let progress: RebuildAllProgress | null = null;
  if (progressPath) progress = await readAllProgress(progressPath);

  const keys = await listAllSessionKeys(driver);
  const targets = limitSessions > 0 ? keys.slice(0, limitSessions) : keys;
  const totalSessions = targets.length;

  const results: Record<string, { processedPairs: number; totalPairs: number }> = {};
  let processedSessions = 0;
  let processedPairs = 0;
  let totalPairs = 0;

  const record = async (key: string, r: { processedPairs: number; totalPairs: number; lastProcessedTurn: number }) => {
    results[key] = r;
    processedSessions++;
    processedPairs += r.processedPairs;
    totalPairs += r.totalPairs;
    if (progressPath) {
      // 会话已全部处理完 → 记为 -1（下次跳过）；否则记录已处理到的轮次以便续跑
      const done = r.processedPairs > 0 && r.processedPairs >= r.totalPairs;
      const mark = done ? -1 : r.lastProcessedTurn;
      const p: RebuildAllProgress = {
        totalSessions,
        processedSessions,
        totalPairs,
        processedPairs,
        done: processedSessions >= totalSessions,
        sessions: { ...(progress?.sessions ?? {}), [key]: mark },
        updatedAt: new Date().toISOString(),
      };
      progress = p;
      await writeAllProgress(progressPath, p);
    }
    logger?.info?.(`[graph-memory-pro] rebuilt session ${key}: ${r.processedPairs}/${r.totalPairs} pairs`);
  };

  // 工作协程池：并发处理多个 session
  let idx = 0;
  const worker = async () => {
    while (idx < totalSessions) {
      const key = targets[idx++];
      // 断点：该 session 已做完（lastTurn 记为 -1）则跳过
      if (progress?.sessions?.[key] === -1) continue;
      try {
        const perSession = progress?.sessions?.[key] ?? undefined;
        const r = await rebuildSessionMessages(extractor, driver, llm, cfg, logger, key, {
          concurrency: opts.concurrency,
          pageSize: opts.pageSize,
          writeBatchSize: opts.writeBatchSize,
          mode,
          // 断点续传：该 session 已处理的轮次
          ...(typeof perSession === "number" && perSession > 0 ? { lastProcessedTurn: perSession } : {}),
        });
        await record(key, r);
      } catch (err) {
        logger?.debug?.(`[graph-memory-pro] rebuild session ${key} failed: ${err}`);
      }
    }
  };
  const workers = Array.from({ length: sessionConcurrency }, () => worker());
  await Promise.all(workers);

  return { totalSessions, processedSessions, totalPairs, processedPairs, mode, results };
}
