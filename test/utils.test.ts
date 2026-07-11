/**
 * 测试 src/utils.ts — 共享工具函数
 */
import { describe, it, expect, vi } from "vitest";
import { withTimeout, ALL_REL_TYPES } from "../src/utils.ts";

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