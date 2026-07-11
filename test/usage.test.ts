/**
 * 测试 src/store/usage.ts — LLM Token 用量统计
 */
import { describe, it, expect, beforeEach } from "vitest";
import { recordUsage, getUsageStats, _resetUsageStats } from "../src/store/usage.ts";

describe("recordUsage / getUsageStats", () => {
  beforeEach(() => {
    _resetUsageStats();
  });

  it("初始 total.calls 为 0", () => {
    const stats = getUsageStats();
    expect(stats.total.calls).toBe(0);
    expect(stats.total.promptTokens).toBe(0);
    expect(stats.total.completionTokens).toBe(0);
    expect(stats.total.totalTokens).toBe(0);
  });

  it("记录一次调用后 total 正确累加", () => {
    recordUsage("ollama", "extract", 100, 50);
    const stats = getUsageStats();
    expect(stats.total.calls).toBe(1);
    expect(stats.total.promptTokens).toBe(100);
    expect(stats.total.completionTokens).toBe(50);
    expect(stats.total.totalTokens).toBe(150);
  });

  it("按 provider 分组", () => {
    recordUsage("ollama", "extract", 100, 50);
    recordUsage("openai", "recall", 200, 100);
    const stats = getUsageStats();
    expect(stats.byProvider["ollama"].calls).toBe(1);
    expect(stats.byProvider["ollama"].totalTokens).toBe(150);
    expect(stats.byProvider["openai"].calls).toBe(1);
    expect(stats.byProvider["openai"].totalTokens).toBe(300);
  });

  it("按 purpose 分组", () => {
    recordUsage("ollama", "extract", 100, 50);
    recordUsage("ollama", "recall", 200, 100);
    const stats = getUsageStats();
    expect(stats.byPurpose["extract"].calls).toBe(1);
    expect(stats.byPurpose["extract"].totalTokens).toBe(150);
    expect(stats.byPurpose["recall"].calls).toBe(1);
    expect(stats.byPurpose["recall"].totalTokens).toBe(300);
  });

  it("多次调用同一 provider/purpose 累加", () => {
    recordUsage("ollama", "extract", 100, 50);
    recordUsage("ollama", "extract", 200, 100);
    const stats = getUsageStats();
    expect(stats.total.calls).toBe(2);
    expect(stats.total.totalTokens).toBe(450);
    expect(stats.byProvider["ollama"].calls).toBe(2);
    expect(stats.byPurpose["extract"].calls).toBe(2);
  });

  it("处理 0 值 token 输入", () => {
    recordUsage("ollama", "extract", 0, 0);
    const stats = getUsageStats();
    expect(stats.total.calls).toBe(1);
    expect(stats.total.totalTokens).toBe(0);
  });

  it("startedAt 在初始化时设定", () => {
    const stats = getUsageStats();
    expect(stats.startedAt).toBeTruthy();
    expect(new Date(stats.startedAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("_resetUsageStats 重置所有统计", () => {
    recordUsage("ollama", "extract", 100, 50);
    _resetUsageStats();
    const stats = getUsageStats();
    expect(stats.total.calls).toBe(0);
    expect(stats.total.totalTokens).toBe(0);
    expect(Object.keys(stats.byProvider)).toHaveLength(0);
    expect(Object.keys(stats.byPurpose)).toHaveLength(0);
  });
});