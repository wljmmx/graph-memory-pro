/**
 * 测试 src/utils.ts — 共享工具函数
 */
import { describe, it, expect, vi } from "vitest";
import { withTimeout, withTimeoutSignal, combineSignals, ALL_REL_TYPES } from "../src/utils.ts";

describe("ALL_REL_TYPES", () => {
  it("包含所有 11 种关系类型", () => {
    expect(ALL_REL_TYPES).toHaveLength(11);
    expect(ALL_REL_TYPES).toContain("NEXT_SESSION");
    expect(ALL_REL_TYPES).toContain("CONTAINS");
    expect(ALL_REL_TYPES).toContain("MENTIONS");
    expect(ALL_REL_TYPES).toContain("USED_SKILL");
    expect(ALL_REL_TYPES).toContain("SOLVED_BY");
    expect(ALL_REL_TYPES).toContain("REQUIRES");
    expect(ALL_REL_TYPES).toContain("PATCHES");
    expect(ALL_REL_TYPES).toContain("CONFLICTS_WITH");
    expect(ALL_REL_TYPES).toContain("RELATES_TO");
    expect(ALL_REL_TYPES).toContain("CAUSED_BY");
    expect(ALL_REL_TYPES).toContain("LEADS_TO");
  });
});

describe("withTimeout", () => {
  it("正常完成时返回结果", async () => {
    const result = await withTimeout(() => Promise.resolve(42), 1000, "test");
    expect(result).toBe(42);
  });

  it("超时时抛出带 label 的错误", async () => {
    vi.useFakeTimers();
    const promise = withTimeout(
      () => new Promise<number>(() => {}), // never resolves
      100,
      "slowOp",
    );
    vi.advanceTimersByTime(150);
    await expect(promise).rejects.toThrow("slowOp timed out after 100ms");
    vi.useRealTimers();
  });

  it("支持传入 Promise（eager 模式）", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "eager");
    expect(result).toBe("ok");
  });

  it("超时后清理 timer（不泄漏）", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const promise = withTimeout(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200)),
      50,
      "cleanup",
    );
    vi.advanceTimersByTime(100);
    await expect(promise).rejects.toThrow("cleanup timed out after 50ms");
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("label 默认值为 'operation'", async () => {
    vi.useFakeTimers();
    const promise = withTimeout(
      () => new Promise(() => {}),
      10,
    );
    vi.advanceTimersByTime(20);
    await expect(promise).rejects.toThrow("operation timed out after 10ms");
    vi.useRealTimers();
  });
});

describe("combineSignals", () => {
  it("全部为 null/undefined → 返回 undefined", () => {
    expect(combineSignals(null, undefined)).toBeUndefined();
    expect(combineSignals()).toBeUndefined();
  });

  it("仅一个有效信号 → 直接返回该信号", () => {
    const c = new AbortController();
    expect(combineSignals(null, c.signal, undefined)).toBe(c.signal);
  });

  it("多个信号 → 任一 abort 即 abort 合并信号", () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineSignals(a.signal, b.signal)!;
    expect(combined.aborted).toBe(false);
    b.abort(new Error("b aborted"));
    expect(combined.aborted).toBe(true);
    expect((combined.reason as Error).message).toBe("b aborted");
  });

  it("已 abort 的信号会立即让合并信号 abort", () => {
    const a = new AbortController();
    a.abort(new Error("already"));
    const b = new AbortController();
    const combined = combineSignals(a.signal, b.signal)!;
    expect(combined.aborted).toBe(true);
  });

  it("合并信号 abort 后清理监听器（不泄漏）", () => {
    const a = new AbortController();
    const b = new AbortController();
    const removeSpy = vi.spyOn(a.signal, "removeEventListener");
    const combined = combineSignals(a.signal, b.signal)!;
    b.abort();
    expect(combined.aborted).toBe(true);
    // abort 后已从 a 上移除监听器
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    removeSpy.mockRestore();
  });
});

describe("withTimeoutSignal", () => {
  it("正常完成时返回结果", async () => {
    const result = await withTimeoutSignal(
      () => Promise.resolve("ok"),
      1000,
      "test",
    );
    expect(result).toBe("ok");
  });

  it("将 AbortSignal 透传给 fn", async () => {
    const fn = vi.fn((_signal: AbortSignal) => Promise.resolve(1));
    await withTimeoutSignal(fn, 1000, "test");
    expect(fn).toHaveBeenCalledTimes(1);
    const signal = fn.mock.calls[0]![0] as AbortSignal;
    expect(signal.aborted).toBe(false);
  });

  it("超时时 abort 信号 + 抛出带 label 的错误", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | null = null;
    const promise = withTimeoutSignal(
      (signal) => {
        receivedSignal = signal;
        return new Promise<string>(() => {}); // never resolves
      },
      100,
      "judgeOp",
    );
    vi.advanceTimersByTime(150);
    await expect(promise).rejects.toThrow("judgeOp timed out after 100ms");
    expect(receivedSignal!.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("超时后 fn 内部基于 signal 的 fetch 会收到 abort（模拟）", async () => {
    vi.useFakeTimers();
    const abortEvents: string[] = [];
    const promise = withTimeoutSignal(
      (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => {
            abortEvents.push("aborted");
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      50,
      "fetchOp",
    );
    vi.advanceTimersByTime(60);
    // signal 已 abort（底层 fetch 会被取消）；rejection 可能是 AbortError 或 timeout
    await expect(promise).rejects.toThrow();
    expect(abortEvents).toEqual(["aborted"]);
    vi.useRealTimers();
  });

  it("label 默认值为 'operation'", async () => {
    vi.useFakeTimers();
    const promise = withTimeoutSignal(() => new Promise(() => {}), 10);
    vi.advanceTimersByTime(20);
    await expect(promise).rejects.toThrow("operation timed out after 10ms");
    vi.useRealTimers();
  });
});