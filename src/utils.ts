/**
 * graph-memory-pro — 共享工具函数
 *
 * 消除跨模块的重复实现（withTimeout, ALL_REL_TYPES 等）
 */

// ── 关系类型常量 ──────────────────────────────────────────────

/** 所有已知关系类型，供 GDS 投影、社区检测等模块共用 */
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