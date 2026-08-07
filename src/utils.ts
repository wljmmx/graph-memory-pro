/**
 * graph-memory-pro — 共享工具函数
 *
 * 消除跨模块的重复实现（withTimeout, ALL_REL_TYPES 等）
 */

// ── 关系类型常量 ──────────────────────────────────────────────

/** 所有已知关系类型，供 GDS 投影、社区检测等模块共用 */
export function normalizeString(value: string | null | undefined): string {
  return value ?? "";
}

export const ALL_REL_TYPES = [
  "NEXT_SESSION",
  "CONTAINS",
  "MENTIONS",
  "USED_SKILL",
  "SOLVED_BY",
  "REQUIRES",
  "PATCHES",
  "CONFLICTS_WITH",
  "RELATES_TO",
  "CAUSED_BY",
  "LEADS_TO",
] as const;

// ── 超时工具 ──────────────────────────────────────────────────

/**
 * 带超时的 Promise 包装（lazy 版本，超时后自动清理 timer）
 *
 * 优先使用 lazy 版本（传入工厂函数），避免 Promise 在超时设置前就开始执行。
 * 兼容 eager 版本：传入已创建的 Promise 也可工作（但不会在超时后取消执行）。
 *
 * 注意：本函数超时后不会取消底层操作（orphan request 仍会运行）。
 * 需要取消底层请求时请使用 withTimeoutSignal（透传 AbortSignal 到 fetch）。
 */
export async function withTimeout<T>(
  fn: (() => Promise<T>) | Promise<T>,
  timeoutMs: number,
  label: string = "operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const promise = typeof fn === "function" ? fn() : fn;
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── 信号工具（v2.3.5 B2） ──────────────────────────────────────

/**
 * 合并多个 AbortSignal：任一信号 abort 时合并信号也 abort
 *
 * 用于将调用方的外部超时信号（如 judge 的 8s 超时）与引擎内部安全超时
 * （如 30s 硬上限）组合，确保任一触发即取消底层 fetch。
 *
 * - 全部为 null/undefined → 返回 undefined
 * - 仅一个有效 → 直接返回该信号
 * - 多个有效 → 创建联动 AbortController，任一 abort 即 abort 合并信号
 *   （已 abort 的信号会立即传播其 reason）
 */
export function combineSignals(
  ...signals: (AbortSignal | null | undefined)[]
): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => s != null);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];

  // 已有信号已 abort → 直接返回该信号（保持 reason）
  const alreadyAborted = valid.find((s) => s.aborted);
  if (alreadyAborted) return alreadyAborted;

  const controller = new AbortController();
  const cleanup = () => {
    for (const s of valid) s.removeEventListener("abort", onAbort);
  };
  const onAbort = (e: Event) => {
    const src = e.target as AbortSignal;
    controller.abort(src.reason);
    cleanup();
  };
  for (const s of valid) s.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

/**
 * 带超时 + 取消的 Promise 包装（v2.3.5 B2）
 *
 * 与 withTimeout 的区别：超时时同时
 *   1. abort 透传给 fn 的 AbortSignal — 若 fn 已将 signal 传入 fetch / SDK，
 *      底层请求会被真正取消（避免 orphan request 继续占用配额 / 信号量槽位）；
 *   2. reject 包装 Promise（Promise.race）— 即使 fn 忽略 signal，调用方仍能在
 *      超时后拿到拒绝（不阻塞调用方逻辑）。
 *
 * 双保险设计：signal abort 是"尽力取消底层请求"，race 超时是"保证调用方不卡死"。
 */
export async function withTimeoutSignal<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string = "operation",
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 先 abort signal（让 fn 内部的 fetch 抛 AbortError 取消底层请求），
      // 再 reject（保证调用方拿到明确的 "timed out" 错误，而非 AbortError）
      controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}