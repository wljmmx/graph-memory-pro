/**
 * graph-memory-pro — gm_reembed 异步任务管理器（v2.8.x）
 *
 * 背景：gm_reembed 全量重嵌入 3.7 万节点在本地 Ollama 上需 15min-数小时，
 * MCP/openclaw 工具同步调用会长时间阻塞会话（触发 stalled-session 诊断）。
 *
 * 方案：启动即返回 taskId，后台分批次（默认每批 400 节点，可配 300-500）循环处理；
 * 通过快照 + SSE 流式接口对外输出进度：
 *   - 处理进度百分比
 *   - 实际处理批次数量 / 总批次
 *   - 当前处理数量 / 当前批次数量（processedNodes/currentBatch）
 *   - 累计 reEmbedded / failed / skipped
 * 支持取消（批次间检查 cancelRequested，最多一个批次内完成当前批后停止）。
 * 所有状态保存在进程内 Map，不落盘；重启后旧任务状态丢失（可重新启动）。
 */

import type { Driver } from "neo4j-driver";
import type { EmbedFn, BatchEmbedFn } from "../engine/embed.ts";
import type { GmConfig } from "../types.ts";
import { reEmbedNodes } from "./reembed.ts";

export type ReembedTaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** 对外进度快照（API / SSE 返回的最小完整信息） */
export interface ReembedTaskSnapshot {
  taskId: string;
  status: ReembedTaskStatus;
  batchSize: number;
  /** 待处理节点总数（启动时统计；处理中新写入的缺失节点不追计） */
  totalNodes: number;
  /** 总批次 = ceil(totalNodes / batchSize) */
  totalBatches: number;
  /** 已完成的批次数量 */
  currentBatch: number;
  /** 已扫描/处理的节点数 */
  processedNodes: number;
  /** 已成功写入向量的节点数 */
  reEmbedded: number;
  /** 失败节点数 */
  failed: number;
  /** 跳过节点数（空文本节点 / 批次内子失败） */
  skipped: number;
  /** 进度百分比 0-100（按节点数计） */
  progressPercent: number;
  /** 平均每批耗时 ms（估算 ETA 用） */
  averageBatchMs: number;
  /** 预计剩余时间 ms（0 = 无法估算） */
  etaMs: number;
  /**
   * v2.8.x: 当前批内阶段（scanning / scan-done / embedding / embed-done / backoff）。
   * 快照不再只在批次返回后更新——批内主动上报，避免"0 进展"无法区分处理中与卡死。
   */
  phase?: string;
  /** v2.8.x: 最近一条批内状态消息（含退避次数与错误、批内耗时等） */
  lastMessage?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  lastError?: string;
}

interface ReembedTask extends ReembedTaskSnapshot {
  cancelRequested: boolean;
}

const DEFAULT_BATCH_SIZE = 400; // v2.8.x: 每批 300-500 区间内的默认值
const DEFAULT_BATCH_INTERVAL_MS = 200; // 批次间休眠，避免连打 Neo4j/Ollama

const _tasks = new Map<string, ReembedTask>();
let _taskSeq = 0;

function makeTaskId(): string {
  _taskSeq++;
  return `reembed-${Date.now()}-${_taskSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 统计当前缺失 embedding 的 active 节点数（Task/Skill/Event） */
async function countMissingEmbeddingNodes(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      "MATCH (n:Task|Skill|Event)" +
      " WHERE n.status = 'active' AND (n.embedding IS NULL OR n.embedding = [])" +
      " RETURN count(n) AS cnt",
    );
    return result.records[0]?.get("cnt")?.toNumber?.() ?? 0;
  } finally {
    await session.close();
  }
}

function toSnapshot(task: ReembedTask): ReembedTaskSnapshot {
  const progressPercent = task.totalNodes > 0
    ? Math.min(100, Math.round((task.processedNodes / task.totalNodes) * 1000) / 10)
    : task.status === "done" ? 100 : 0;
  const etaMs = task.status === "running" && task.currentBatch > 0 && task.averageBatchMs > 0
    ? Math.max(0, (task.totalBatches - task.currentBatch) * task.averageBatchMs)
    : 0;
  return {
    taskId: task.taskId,
    status: task.status,
    batchSize: task.batchSize,
    totalNodes: task.totalNodes,
    totalBatches: task.totalBatches,
    currentBatch: task.currentBatch,
    processedNodes: task.processedNodes,
    reEmbedded: task.reEmbedded,
    failed: task.failed,
    skipped: task.skipped,
    progressPercent,
    averageBatchMs: task.averageBatchMs,
    etaMs,
    ...(task.phase !== undefined ? { phase: task.phase } : {}),
    ...(task.lastMessage !== undefined ? { lastMessage: task.lastMessage } : {}),
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.lastError ? { lastError: task.lastError } : {}),
  };
}

export interface StartReembedTaskOptions {
  /** 每批节点数（默认 400，建议 300-500；超出 2000 会被钳制） */
  batchSize?: number;
  /** 批次间间隔 ms（默认 200，避免连打 Neo4j/Ollama） */
  batchIntervalMs?: number;
}

/**
 * 启动一个后台重嵌入任务，立即返回 taskId（不等待处理完成）。
 *
 * @param driver Neo4j driver
 * @param cfg 插件配置（取 embedding.model）
 * @param embedFn 单文本嵌入函数
 * @param batchEmbedFn 批量嵌入函数（优先使用）
 * @param options 批次参数
 */
export function startReembedTask(
  driver: Driver,
  cfg: GmConfig,
  embedFn: EmbedFn | undefined,
  batchEmbedFn: BatchEmbedFn | undefined,
  options: StartReembedTaskOptions = {},
): ReembedTaskSnapshot {
  if (!embedFn && !batchEmbedFn) {
    throw new Error("Embedding engine not configured");
  }
  const batchSize = Math.min(2000, Math.max(1, Math.round(options.batchSize ?? DEFAULT_BATCH_SIZE)));
  const batchIntervalMs = Math.max(0, Math.round(options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS));

  const task: ReembedTask = {
    taskId: makeTaskId(),
    status: "queued",
    batchSize,
    totalNodes: 0,
    totalBatches: 0,
    currentBatch: 0,
    processedNodes: 0,
    reEmbedded: 0,
    failed: 0,
    skipped: 0,
    progressPercent: 0,
    averageBatchMs: 0,
    etaMs: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    cancelRequested: false,
  };
  _tasks.set(task.taskId, task);

  // 后台循环（不 await，保证调用方立即返回；异常在循环内捕获并落状态）
  void (async () => {
    try {
      task.totalNodes = await countMissingEmbeddingNodes(driver);
      task.totalBatches = task.totalNodes > 0
        ? Math.ceil(task.totalNodes / task.batchSize)
        : 0;
      task.status = "running";
      task.phase = "counting";
      task.updatedAt = Date.now();
      const model = cfg.embedding?.model;
      console.log(
        `[graph-memory-pro] reembed-task ${task.taskId}: started, totalNodes=${task.totalNodes}, totalBatches=${task.totalBatches}, batchSize=${task.batchSize}, model=${model ?? "unset"}`,
      );

      if (task.totalNodes === 0) {
        task.status = "done";
        task.finishedAt = Date.now();
        task.updatedAt = Date.now();
        return;
      }

      const batchTimes: number[] = [];
      let consecutiveZeroBatches = 0;
      // v2.8.x: 批内心跳——批次长时间在途（慢 Ollama / 退避重试）时仍刷新
      // updatedAt + lastMessage，快照不再"静止 0 进展"，可区分处理中与卡死。
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      while (!task.cancelRequested) {
        const batchStart = Date.now();
        const batchNo = task.currentBatch + 1;
        task.phase = "batch-start";
        task.lastMessage = `starting batch ${batchNo}/${task.totalBatches}`;
        task.updatedAt = Date.now();
        heartbeat = setInterval(() => {
          if (task.status !== "running") return;
          const elapsedS = Math.round((Date.now() - batchStart) / 1000);
          task.lastMessage = `batch ${batchNo}/${task.totalBatches} in progress (${elapsedS}s elapsed, phase=${task.phase ?? "?"})`;
          task.updatedAt = Date.now();
        }, 10_000);

        let res;
        try {
          // 每轮只处理一个批次（maxNodes=batchSize），返回后更新快照；下一轮从头继续，
          // WHERE 过滤集自行收缩（已嵌入节点被过滤），幂等可续跑。
          // onStatus: 批内阶段/错误实时上报 → 快照可见，退出后由心跳接续。
          res = await reEmbedNodes(
            driver, embedFn, task.batchSize, model, cfg, batchEmbedFn, undefined, task.batchSize,
            (info) => {
              task.phase = info.phase;
              task.lastMessage = info.detail
                ? `batch ${batchNo}/${task.totalBatches}: ${info.phase} ${info.detail}`
                : `batch ${batchNo}/${task.totalBatches}: ${info.phase}`;
              task.updatedAt = Date.now();
            },
          );
        } finally {
          if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        }

        const batchElapsedMs = Date.now() - batchStart;
        console.log(
          `[graph-memory-pro] reembed-task ${task.taskId}: batch ${batchNo}/${task.totalBatches} done in ${batchElapsedMs}ms (scanned=${res.totalScanned}, embedded=${res.reEmbedded}, failed=${res.failed}, skipped=${res.skipped}${res.lastError ? `, lastError=${res.lastError}` : ""})`,
        );
        task.lastMessage = `batch ${batchNo}/${task.totalBatches} done (${res.reEmbedded} embedded, ${batchElapsedMs}ms)`;
        task.phase = "batch-done";

        // 完成判定（先于计数：空批次/末批不算一个处理批次，避免 currentBatch 超过 totalBatches）
        if (res.totalScanned === 0) {
          // 查询返回空：全部处理完，或连续失败被 reEmbedNodes 中止
          if (res.lastError && res.failed > 0) {
            task.status = "failed";
          }
          break;
        }
        if (res.totalScanned < task.batchSize) {
          // 末批（剩余 < batchSize）或连续失败提前中止
          task.currentBatch++;
          task.processedNodes += res.totalScanned;
          task.reEmbedded += res.reEmbedded;
          task.failed += res.failed;
          task.skipped += res.skipped;
          if (res.lastError) task.lastError = res.lastError;
          if (res.lastError && res.failed > 0) {
            task.status = "failed";
          }
          task.updatedAt = Date.now();
          break;
        }

        task.currentBatch++;
        task.processedNodes += res.totalScanned;
        task.reEmbedded += res.reEmbedded;
        task.failed += res.failed;
        task.skipped += res.skipped;
        if (res.lastError) task.lastError = res.lastError;

        const elapsed = Date.now() - batchStart;
        batchTimes.push(elapsed);
        if (batchTimes.length > 20) batchTimes.shift();
        task.averageBatchMs = Math.round(
          batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length,
        );
        task.updatedAt = Date.now();

        // 连续 3 批 0 成功（如 Ollama 模型 404 / baseURL 不可达 / 熔断）→ 止损，不空转烧时间
        if (res.reEmbedded === 0 && (res.failed + res.skipped) > 0 && res.lastError) {
          consecutiveZeroBatches++;
          if (consecutiveZeroBatches >= 3) {
            task.status = "failed";
            task.lastError = task.lastError ?? "3 consecutive batches with 0 embedded";
            break;
          }
        } else {
          consecutiveZeroBatches = 0;
        }

        await new Promise((r) => setTimeout(r, batchIntervalMs));
      }

      if (task.status === "running") {
        task.status = task.cancelRequested ? "cancelled" : "done";
      }
      task.finishedAt = Date.now();
      task.updatedAt = Date.now();
      console.log(
        `[graph-memory-pro] reembed-task ${task.taskId}: finished with status=${task.status} (processed=${task.processedNodes}/${task.totalNodes}, embedded=${task.reEmbedded}, failed=${task.failed}, skipped=${task.skipped})` +
          (task.lastError ? ` lastError=${task.lastError}` : ""),
      );
    } catch (err: unknown) {
      task.status = "failed";
      task.lastError = (err as Error)?.message ?? String(err);
      task.finishedAt = Date.now();
      task.updatedAt = Date.now();
      console.error(`[graph-memory-pro] reembed-task ${task.taskId}: failed with exception: ${task.lastError}`);
    }
  })();

  return toSnapshot(task);
}

/** 查询任务快照（不存在返回 undefined） */
export function getReembedTask(taskId: string): ReembedTaskSnapshot | undefined {
  const task = _tasks.get(taskId);
  return task ? toSnapshot(task) : undefined;
}

/** 列出全部任务快照（新的在前） */
export function listReembedTasks(): ReembedTaskSnapshot[] {
  const out: ReembedTaskSnapshot[] = [];
  for (const t of _tasks.values()) out.push(toSnapshot(t));
  out.reverse();
  return out;
}

/** 请求取消任务（返回是否找到并处于可取消状态） */
export function cancelReembedTask(taskId: string): { found: boolean; cancelled: boolean } {
  const task = _tasks.get(taskId);
  if (!task) return { found: false, cancelled: false };
  if (task.status === "running" || task.status === "queued") {
    task.cancelRequested = true;
    return { found: true, cancelled: true };
  }
  return { found: true, cancelled: false };
}
