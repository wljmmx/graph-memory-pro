/**
 * graph-memory-pro — gm_maintain 异步任务管理器（v2.8.x）
 *
 * 背景：gm_maintain 同步调用 runMaintenance（14 个 phase 流水线：补边/去重/PageRank/
 * 社区/摘要/回填/过时/健康/重要性/冲突/边权/反向记忆/嵌入迁移/自愈）在大图上可能耗时
 * 数分钟到数十分钟，MCP/openclaw 工具同步调用会长时间阻塞会话（触发 stalled-session）。
 *
 * 方案（与 gm_reembed 的 reembed-task.ts 对称）：
 *   - 启动即返回 taskId，后台顺序跑完整条维护流水线；
 *   - runMaintenance 新增可选 onPhase 进度钩子，每个 phase 开始前回调，
 *     任务据此更新快照：当前 phase 序号/名称、进度百分比、累计耗时；
 *   - 支持取消（phase 间检查 cancelRequested，抛 MaintenanceCancelledError 中断
 *     剩余 phase，当前 phase 跑完后停止；被中断的 phase 已写结果保留）；
 *   - 快照 + SSE 流式接口对外输出进度（GET /api/maintain/stream?taskId=...）；
 *   - 维护互斥锁复用 runMaintenance 内部模块锁：锁被占用时立即返回
 *     lockSkipped=true（不做等待，避免排队空转）。
 * 所有状态保存在进程内 Map，不落盘；重启后旧任务状态丢失（可重新启动）。
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn, BatchEmbedFn } from "../engine/embed.ts";
import {
  runMaintenance,
  MaintenanceCancelledError,
  MAINTENANCE_PHASES,
  type MaintainPhaseHook,
  type MaintenanceResult,
} from "./maintenance.ts";

export type MaintainTaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** 维护结果关键统计汇总（API / SSE 快照携带，避免暴露完整内部结构） */
export interface MaintainResultSummary {
  /** 去重合并数 */
  merged: number;
  /** 社区数 */
  communities: number;
  /** 社区摘要数 */
  communitySummaries: number;
  /** 重要性评分扫描/平均 */
  importanceScanned: number;
  importanceAvg: number;
  /** 冲突消解 */
  conflictsResolved: number;
  /** 边权重强化/衰减 */
  edgeStrengthened: number;
  edgeDecayed: number;
  /** 反向记忆 */
  reverseWatchlistAdded: number;
  reverseMemoryDecayed: number;
  /** 稀疏自愈 */
  selfHealEdgesAdded: number;
  selfHealMergesApplied: number;
  selfHealScore?: number;
  selfHealSparse: boolean;
  /** 锁被占用跳过（未实际执行） */
  lockSkipped: boolean;
  /** 健康评分（Phase 7 内部计算，可能无） */
  healthScore?: number;
}

/** 对外进度快照（API / SSE 返回的最小完整信息） */
export interface MaintainTaskSnapshot {
  taskId: string;
  status: MaintainTaskStatus;
  /** 流水线 phase 总数（固定 14） */
  phaseTotal: number;
  /** 当前 phase 序号（0 起；done 时为 phaseTotal） */
  currentPhase: number;
  /** 当前 phase 名称 */
  phaseName: string;
  /** 进度百分比 0-100（按 phase 数计） */
  progressPercent: number;
  /** 已运行时长 ms */
  durationMs: number;
  result?: MaintainResultSummary;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  lastError?: string;
}

interface MaintainTask extends MaintainTaskSnapshot {
  cancelRequested: boolean;
}

const _tasks = new Map<string, MaintainTask>();
let _taskSeq = 0;

function makeTaskId(): string {
  _taskSeq++;
  return `maintain-${Date.now()}-${_taskSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeResult(result: MaintenanceResult, phaseFired: boolean): MaintainResultSummary {
  const selfHeal = result.selfHeal;
  return {
    merged: result.dedup?.merged ?? 0,
    communities: result.community?.count ?? 0,
    communitySummaries: result.communitySummaries ?? 0,
    importanceScanned: result.importance?.scanned ?? 0,
    importanceAvg: result.importance?.avgScore ?? 0,
    conflictsResolved: result.conflictResolution?.resolved ?? 0,
    edgeStrengthened: result.edgeWeights?.strengthened ?? 0,
    edgeDecayed: result.edgeWeights?.decayed ?? 0,
    reverseWatchlistAdded: result.reverseMemory?.watchlistAdded ?? 0,
    reverseMemoryDecayed: result.reverseMemory?.decayed ?? 0,
    selfHealEdgesAdded: selfHeal?.edgesAdded ?? 0,
    selfHealMergesApplied: selfHeal?.mergesApplied ?? 0,
    selfHealScore: selfHeal?.score?.score,
    selfHealSparse: selfHeal?.sparse ?? false,
    // 锁被占用时 runMaintenance 直接返回空壳（durationMs=0 且未触发任何 phase）
    lockSkipped: result.durationMs === 0 && !phaseFired,
    healthScore: undefined,
  };
}

function toSnapshot(task: MaintainTask): MaintainTaskSnapshot {
  const progressPercent = task.phaseTotal > 0
    ? Math.min(100, Math.round((task.currentPhase / task.phaseTotal) * 1000) / 10)
    : task.status === "done" ? 100 : 0;
  return {
    taskId: task.taskId,
    status: task.status,
    phaseTotal: task.phaseTotal,
    currentPhase: task.currentPhase,
    phaseName: task.phaseName,
    progressPercent,
    durationMs: task.durationMs,
    ...(task.result !== undefined ? { result: task.result } : {}),
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.lastError ? { lastError: task.lastError } : {}),
  };
}

export interface StartMaintainTaskOptions {
  /** 每个 phase 之间无间隔（流水线连续执行）；保留字段以便未来节流 */
  // phaseIntervalMs?: number;
}

/**
 * 启动一个后台图谱维护任务，立即返回 taskId（不等待流水线完成）。
 *
 * 复用 runMaintenance 内部互斥锁：已有维护在跑时任务立即结束（lockSkipped=true）。
 *
 * @param driver Neo4j driver
 * @param cfg 插件配置
 * @param llm LLM 补全函数（可选，社区摘要/诊断用）
 * @param embedFn 单文本嵌入函数（可选）
 * @param batchEmbedFn 批量嵌入函数（可选）
 * @param options 预留
 */
export function startMaintainTask(
  driver: Driver,
  cfg: GmConfig,
  llm?: CompleteFn,
  embedFn?: EmbedFn,
  batchEmbedFn?: BatchEmbedFn,
  _options: StartMaintainTaskOptions = {},
): MaintainTaskSnapshot {
  const phaseTotal = MAINTENANCE_PHASES.length;
  const task: MaintainTask = {
    taskId: makeTaskId(),
    status: "queued",
    phaseTotal,
    currentPhase: 0,
    phaseName: "",
    progressPercent: 0,
    durationMs: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    cancelRequested: false,
  };
  _tasks.set(task.taskId, task);

  // 后台执行（不 await，保证调用方立即返回；异常在循环内捕获并落状态）
  void (async () => {
    let phaseFired = false;
    try {
      task.status = "running";
      task.updatedAt = Date.now();

      const onPhase: MaintainPhaseHook = (phase) => {
        phaseFired = true;
        task.currentPhase = phase.index;
        task.phaseName = phase.name;
        task.durationMs = Date.now() - task.startedAt;
        task.updatedAt = Date.now();
        if (task.cancelRequested) {
          // 中断剩余 phase（当前 phase 已开始，跑完后由 runMaintenance 抛错中止）
          throw new MaintenanceCancelledError();
        }
      };

      const result = await runMaintenance(driver, cfg, llm, embedFn, batchEmbedFn, onPhase);

      // 锁被占用：runMaintenance 直接返回空壳，onPhase 未触发（phaseFired=false）
      if (result.durationMs === 0 && !phaseFired) {
        task.status = "done";
        task.result = summarizeResult(result, phaseFired);
        task.updatedAt = Date.now();
        task.finishedAt = Date.now();
        return;
      }

      task.currentPhase = phaseTotal;
      task.phaseName = "complete";
      task.result = summarizeResult(result, phaseFired);
      task.status = task.cancelRequested ? "cancelled" : "done";
      task.durationMs = result.durationMs;
      task.updatedAt = Date.now();
      task.finishedAt = Date.now();
    } catch (err: unknown) {
      if (err instanceof MaintenanceCancelledError) {
        task.status = "cancelled";
        task.lastError = undefined;
      } else {
        task.status = "failed";
        task.lastError = (err as Error)?.message ?? String(err);
      }
      task.updatedAt = Date.now();
      task.finishedAt = Date.now();
    }
  })();

  return toSnapshot(task);
}

/** 查询任务快照（不存在返回 undefined） */
export function getMaintainTask(taskId: string): MaintainTaskSnapshot | undefined {
  const task = _tasks.get(taskId);
  return task ? toSnapshot(task) : undefined;
}

/** 列出全部任务快照（新的在前） */
export function listMaintainTasks(): MaintainTaskSnapshot[] {
  const out: MaintainTaskSnapshot[] = [];
  for (const t of _tasks.values()) out.push(toSnapshot(t));
  out.reverse();
  return out;
}

/** 请求取消任务（当前 phase 跑完后停止；返回是否找到并处于可取消状态） */
export function cancelMaintainTask(taskId: string): { found: boolean; cancelled: boolean } {
  const task = _tasks.get(taskId);
  if (!task) return { found: false, cancelled: false };
  if (task.status === "running" || task.status === "queued") {
    task.cancelRequested = true;
    return { found: true, cancelled: true };
  }
  return { found: true, cancelled: false };
}
