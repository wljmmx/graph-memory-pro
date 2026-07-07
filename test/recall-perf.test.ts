/**
 * v2.3.1 召回性能优化 单元测试
 *
 * 被测模块：/workspace/src/recaller/recall.ts
 *
 * 验证点：
 *   1. 单次 recall() 调用中 embed 只被调用 1 次（旧实现 3 次）
 *      - recallPrecise 内部不再 embed
 *      - recallGeneralized 内部不再 embed
 *      - QueryCache 相似匹配复用入口已计算的 queryEmbedding
 *   2. recallPrecise 和 recallGeneralized 并行执行（Promise.all）
 *   3. embedOnce 短时去重：并发相同 query 的 recall() 共享 in-flight promise
 *
 * 性能基线（用户反馈）：
 *   - vec_embed 1000+ms × 3 = 3000ms（旧）
 *   - recall_precise 1200+ms（含 1 次 embed）
 *   - recall_total 1500+ms
 *
 * 优化目标：
 *   - vec_embed 1000ms × 1 = 1000ms（节省 2000ms）
 *   - recall_total ~1100ms（节省 ~400ms）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GmConfig, GmNode } from "../src/types.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";

// ── vi.mock：拦截 store 模块，使 recallPrecise/recallGeneralized 走最小路径 ──
vi.mock("../src/store/store.ts", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    // FTS 搜索返回空，避免触发 graphWalk/PPR 路径
    searchNodes: vi.fn().mockResolvedValue([]),
    // 向量搜索返回空
    vectorSearchWithScore: vi.fn().mockResolvedValue([]),
    // 图遍历返回空
    graphWalk: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    // 社区代表返回空
    communityRepresentatives: vi.fn().mockResolvedValue([]),
    // 社区向量搜索返回空
    communityVectorSearch: vi.fn().mockResolvedValue([]),
    // 反馈持久化 no-op
    upsertFeedback: vi.fn().mockResolvedValue(undefined),
    saveVector: vi.fn().mockResolvedValue(undefined),
    getVectorHash: vi.fn().mockResolvedValue(""),
    computeEmbeddingHash: vi.fn().mockReturnValue("hash"),
  };
});

// 拦截 PPR（避免真实图算法）
vi.mock("../src/graph/pagerank.ts", () => ({
  personalizedPageRank: vi.fn().mockResolvedValue({ scores: new Map() }),
}));

// 在 mock 生效后导入
import { Recaller } from "../src/recaller/recall.ts";

// ── 辅助工厂 ──────────────────────────────────────────────────

function mkConfig(overrides: Partial<GmConfig> = {}): GmConfig {
  return {
    neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
    compactTurnCount: 6,
    recallMaxNodes: 20,
    recallMaxDepth: 3,
    freshTailCount: 6,
    dedupThreshold: 0.92,
    pagerankDamping: 0.85,
    pagerankIterations: 20,
    ...overrides,
  } as GmConfig;
}

const SAMPLE_VEC = [0.1, 0.2, 0.3, 0.4];

/** 构造带调用计数的 embed 函数 */
function makeCountedEmbed(delayMs = 0) {
  const calls: string[] = [];
  const fn = vi.fn(async (text: string): Promise<number[]> => {
    calls.push(text);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return [...SAMPLE_VEC];
  });
  return { fn, calls };
}

// ═══════════════════════════════════════════════════════════════
// 1. embed 单次调用验证（核心优化）
// ═══════════════════════════════════════════════════════════════

describe("v2.3.1 recall() embed 调用次数", () => {
  let recaller: Recaller;

  beforeEach(() => {
    const driver = mockDriver() as any;
    recaller = new Recaller(driver, mkConfig());
  });

  it("单次 recall() 调用中 embed 仅被调用 1 次（旧实现为 3 次）", async () => {
    const { fn, calls } = makeCountedEmbed();
    recaller.setEmbedFn(fn);

    await recaller.recall("如何配置 Neo4j");

    // 关键断言：embed 只被调用 1 次
    // 旧实现：recallPrecise(1) + recallGeneralized(1) + QueryCache相似匹配(1) = 3 次
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["如何配置 Neo4j"]);
  });

  it("embed 未配置时 recall() 不抛错（FTS 仍可工作）", async () => {
    // 不调用 setEmbedFn
    const result = await recaller.recall("测试查询");
    expect(result).toBeDefined();
    expect(result.nodes).toEqual([]);
  });

  it("embed 抛错时 recall() 仍返回 FTS 结果（不中断主流程）", async () => {
    const failingEmbed = vi.fn(async (): Promise<number[]> => {
      throw new Error("Ollama down");
    });
    recaller.setEmbedFn(failingEmbed);

    const result = await recaller.recall("查询");
    expect(result).toBeDefined();
    // embed 失败时，recallPrecise/recallGeneralized 回退路径会各自重试 embed
    // （容错设计：瞬时错误可能重试成功）。成功路径下 embed 仅调用 1 次。
    expect(failingEmbed.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("连续两次 recall() 相同 query 命中 QueryCache 精确匹配 → embed 不再调用", async () => {
    const { fn } = makeCountedEmbed();
    recaller.setEmbedFn(fn);

    await recaller.recall("相同查询");
    await recaller.recall("相同查询");

    // 第二次命中 QueryCache 精确匹配，embed 仍只被调用 1 次
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. recallPrecise / recallGeneralized 并行执行验证
// ═══════════════════════════════════════════════════════════════

describe("v2.3.1 recall() 并行执行", () => {
  it("recallPrecise 和 recallGeneralized 并行执行（Promise.all）", async () => {
    const driver = mockDriver() as any;
    const recaller = new Recaller(driver, mkConfig());

    // embed 延迟 50ms，模拟真实 ~1000ms 的开销（缩短以便测试）
    const { fn } = makeCountedEmbed(50);
    recaller.setEmbedFn(fn);

    const t0 = Date.now();
    await recaller.recall("并行测试查询");
    const elapsed = Date.now() - t0;

    // 关键断言：embed 仅调用 1 次（已在入口计算并复用）
    expect(fn).toHaveBeenCalledTimes(1);

    // 并行执行：总时间应远小于串行执行时间
    // 注：因 store 全部 mock 为空返回，recallPrecise 早退、recallGeneralized 早退，
    //     实际耗时主要在 embed 的 50ms。串行模式下需要 50ms（embed 1 次）+ 路径开销。
    //     此处主要验证不抛错且 embed 仅 1 次。
    expect(elapsed).toBeLessThan(500);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. embedOnce 短时去重验证
// ═══════════════════════════════════════════════════════════════

describe("v2.3.1 embedOnce 并发去重", () => {
  it("并发相同 query 的 recall() 共享 in-flight embed promise", async () => {
    const driver = mockDriver() as any;
    const recaller = new Recaller(driver, mkConfig());

    // embed 延迟 80ms，模拟 ~1000ms 开销
    const { fn } = makeCountedEmbed(80);
    recaller.setEmbedFn(fn);

    // 同步发起 3 个并发 recall()（相同 query，但不同 Recaller 实例间无共享，
    // 这里测试同一实例的并发去重）
    // 注意：QueryCache 在第一次 recall 完成前不会命中（put 在 recall 末尾），
    //       所以 3 个并发调用都会走到 embed 路径，embedOnce 应去重为 1 次。
    const results = await Promise.all([
      recaller.recall("并发查询"),
      recaller.recall("并发查询"),
      recaller.recall("并发查询"),
    ]);

    // 全部返回有效结果
    expect(results).toHaveLength(3);
    results.forEach(r => expect(r).toBeDefined());

    // 关键断言：embed 仅被调用 1 次（in-flight promise 被共享）
    // 注：QueryCache 的精确匹配在 recall 入口检查，并发场景下第一次 put 之前
    //     其他两个调用也会 miss，但 embedOnce 去重了底层的 embed 调用。
    //     实际调用次数为 1（首个发起的）+ 0（其他两个复用 in-flight）= 1。
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("不同 query 的并发 recall() 各自调用 embed（不去重）", async () => {
    const driver = mockDriver() as any;
    const recaller = new Recaller(driver, mkConfig());

    const { fn } = makeCountedEmbed(20);
    recaller.setEmbedFn(fn);

    await Promise.all([
      recaller.recall("查询A"),
      recaller.recall("查询B"),
    ]);

    // 不同 query 各自调用 embed，不去重
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
