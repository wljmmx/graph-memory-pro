/**
 * I-1 历史查询缓存 单元测试 (graph-memory-pro v2.1.2 第二批)
 *
 * 被测模块：/workspace/src/recaller/query-cache.ts
 *
 * 实现说明（与任务描述的差异，以源码为准）：
 *   - hashQuery 是 QueryCache 的 private 方法，未单独导出 → 通过 get/put 公共 API
 *     间接验证其“相同 query → 相同 hash”的确定性。
 *   - cosineSimilarity 是模块级私有函数，未导出 → 通过 getSimilar 公共 API
 *     间接验证各相似度分支。为能直接观测返回的 similarity 数值，相关用例将
 *     similarityThreshold 设为 -2，使所有候选都“命中”。
 *   - get / getSimilar 返回单个 RecallResult（非数组）；getSimilar 返回
 *     { result, similarity }，降权 weight = 0.7 * similarity 直接作用在
 *     result.nodes[].pagerank 与 result.edges[].weight 上。
 *   - getStats().hitRate 为字符串（toFixed(3) 或 "0"）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryCache } from "../src/recaller/query-cache.ts";
import type { RecallResult, GmNode, GmEdge } from "../src/types.ts";

// ── 辅助工厂 ──────────────────────────────────────────────────

function mkNode(id: string, pagerank = 1.0): GmNode {
  return {
    id,
    type: "SKILL",
    name: id,
    description: "",
    content: "",
    status: "active",
    pagerank,
    validatedCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function mkEdge(id: string, weight = 1.0): GmEdge {
  return {
    id,
    type: "USED_SKILL",
    fromId: "a",
    toId: "b",
    instruction: "",
    weight,
    createdAt: 0,
    updatedAt: 0,
  };
}

function mkResult(pagerank = 1.0, weight = 1.0): RecallResult {
  return {
    nodes: [mkNode("n1", pagerank)],
    edges: [mkEdge("e1", weight)],
    tokenEstimate: 100,
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. hashQuery（通过 QueryCache 公共 API 间接验证）
// ═══════════════════════════════════════════════════════════════

describe("hashQuery — 相同 query 返回相同 hash", () => {
  it("相同 query 产生相同 hash → 命中同一条缓存", () => {
    const cache = new QueryCache();
    const r1 = mkResult();
    cache.put("如何创建 conda 环境", r1);

    const got = cache.get("如何创建 conda 环境");
    expect(got).not.toBeNull();
    expect(got).toBe(r1); // 引用相等 → 同一缓存条目
    expect(cache.getStats().hits).toBe(1);
  });

  it("不同 query 产生不同 hash → 互不干扰", () => {
    const cache = new QueryCache();
    cache.put("query-A", mkResult());

    expect(cache.get("query-B")).toBeNull();
    expect(cache.get("query-A")).not.toBeNull();
  });

  it("相同 query 重复 put 覆盖旧条目（同一 key，size 不增长）", () => {
    const cache = new QueryCache();
    const r1 = mkResult(1.0);
    const r2 = mkResult(2.0);

    cache.put("dup-query", r1);
    cache.put("dup-query", r2);

    const got = cache.get("dup-query");
    expect(got).toBe(r2);
    expect(got).not.toBe(r1);
    expect(cache.getStats().size).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. cosineSimilarity（通过 getSimilar 公共 API 间接验证）
//    similarityThreshold = -2 → 所有候选都命中，便于直接观测 similarity
// ═══════════════════════════════════════════════════════════════

describe("cosineSimilarity — 各分支行为", () => {
  it("相同向量 → similarity = 1.0", () => {
    const cache = new QueryCache({ similarityThreshold: -2 });
    cache.put("q", mkResult(), [1, 0]);

    const r = cache.getSimilar([1, 0]);
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeCloseTo(1.0, 6);
  });

  it("正交向量 → similarity = 0", () => {
    const cache = new QueryCache({ similarityThreshold: -2 });
    cache.put("q", mkResult(), [1, 0]);

    const r = cache.getSimilar([0, 1]);
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeCloseTo(0, 6);
  });

  it("反向向量 → similarity = -1", () => {
    const cache = new QueryCache({ similarityThreshold: -2 });
    cache.put("q", mkResult(), [1, 0]);

    const r = cache.getSimilar([-1, 0]);
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeCloseTo(-1, 6);
  });

  it("零向量 → similarity = 0", () => {
    const cache = new QueryCache({ similarityThreshold: -2 });
    cache.put("q", mkResult(), [0, 0]);

    const r = cache.getSimilar([0, 0]);
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeCloseTo(0, 6);
  });

  it("长度不等的向量 → similarity = 0", () => {
    const cache = new QueryCache({ similarityThreshold: -2 });
    cache.put("q", mkResult(), [1, 0, 0]);

    const r = cache.getSimilar([1, 0]);
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeCloseTo(0, 6);
  });

  it("空 queryEmbedding → getSimilar 直接返回 null（length=0 短路）", () => {
    const cache = new QueryCache({ similarityThreshold: -2 });
    cache.put("q", mkResult(), [1, 0]);

    expect(cache.getSimilar([])).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. QueryCache 精确匹配
// ═══════════════════════════════════════════════════════════════

describe("QueryCache 精确匹配", () => {
  it("get 未缓存 → null 且 misses +1", () => {
    const cache = new QueryCache();

    expect(cache.get("not-cached")).toBeNull();

    const stats = cache.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
  });

  it("put 后 get → 返回缓存结果（引用相等）", () => {
    const cache = new QueryCache();
    const r = mkResult();
    cache.put("q1", r);

    expect(cache.get("q1")).toBe(r);
  });

  it("命中后 hits 计数 +1", () => {
    const cache = new QueryCache();
    cache.put("q1", mkResult());

    cache.get("q1");
    expect(cache.getStats().hits).toBe(1);

    cache.get("q1");
    expect(cache.getStats().hits).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. LRU 淘汰
// ═══════════════════════════════════════════════════════════════

describe("LRU 淘汰", () => {
  it("超过 maxSize 时淘汰最旧条目", () => {
    const cache = new QueryCache({ maxSize: 2 });
    cache.put("q1", mkResult());
    cache.put("q2", mkResult());
    cache.put("q3", mkResult()); // 容量 2 → 淘汰 q1

    expect(cache.get("q1")).toBeNull();
    expect(cache.get("q2")).not.toBeNull();
    expect(cache.get("q3")).not.toBeNull();
  });

  it("get 后该条目移到末尾（最近使用），避免被淘汰", () => {
    const cache = new QueryCache({ maxSize: 2 });
    cache.put("q1", mkResult());
    cache.put("q2", mkResult());
    // 访问 q1 → 移到末尾，内部顺序变为 [q2, q1]
    cache.get("q1");
    // 再 put q3 → 淘汰头部 q2，保留 q1
    cache.put("q3", mkResult());

    expect(cache.get("q1")).not.toBeNull();
    expect(cache.get("q2")).toBeNull();
    expect(cache.get("q3")).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. TTL 过期
// ═══════════════════════════════════════════════════════════════

describe("TTL 过期", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("put 后立即 get → 命中", () => {
    const cache = new QueryCache({ ttlMs: 5000 });
    cache.put("q1", mkResult());

    expect(cache.get("q1")).not.toBeNull();
    expect(cache.getStats().hits).toBe(1);
  });

  it("模拟时间前进 ttlMs+1 → get 返回 null（视为 miss）", () => {
    const cache = new QueryCache({ ttlMs: 5000 });
    cache.put("q1", mkResult());

    vi.advanceTimersByTime(5001); // diff = 5001 > 5000

    expect(cache.get("q1")).toBeNull();
    expect(cache.getStats().misses).toBe(1);
    expect(cache.getStats().hits).toBe(0);
  });

  it("过期条目在 get miss 时被删除", () => {
    const cache = new QueryCache({ ttlMs: 5000 });
    cache.put("q1", mkResult());
    expect(cache.getStats().size).toBe(1);

    vi.advanceTimersByTime(5001);
    cache.get("q1"); // 触发过期删除

    expect(cache.getStats().size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. getSimilar 相似匹配
// ═══════════════════════════════════════════════════════════════

describe("getSimilar 相似匹配", () => {
  it("cosine >= threshold → 返回降权结果", () => {
    const cache = new QueryCache({ similarityThreshold: 0.5 });
    // 存入 embedding [1,0]，node.pagerank=1.0，edge.weight=1.0
    cache.put("q", mkResult(1.0, 1.0), [1, 0]);

    // 查询 [0.6, 0.8]（单位向量，cosine([1,0],[0.6,0.8]) = 0.6）
    const r = cache.getSimilar([0.6, 0.8]);
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeCloseTo(0.6, 6);
    // weight = 0.7 * 0.6 = 0.42 → 作用于 pagerank 与 edge.weight
    expect(r!.result.nodes[0].pagerank).toBeCloseTo(0.42, 6);
    expect(r!.result.edges[0].weight).toBeCloseTo(0.42, 6);
    // tokenEstimate 不参与降权
    expect(r!.result.tokenEstimate).toBe(100);
  });

  it("cosine < threshold → null", () => {
    const cache = new QueryCache({ similarityThreshold: 0.95 });
    cache.put("q", mkResult(), [1, 0]);

    // [0,1] 与 [1,0] 正交，cosine=0 < 0.95
    expect(cache.getSimilar([0, 1])).toBeNull();
  });

  it("降权公式：weight = 0.7 * similarity", () => {
    // similarity=1.0 → weight=0.7 → pagerank 1.0 * 0.7 = 0.7
    const cache = new QueryCache({ similarityThreshold: 0.5 });
    cache.put("q", mkResult(1.0, 1.0), [1, 0]);

    const r = cache.getSimilar([1, 0]);
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeCloseTo(1.0, 6);
    expect(r!.result.nodes[0].pagerank).toBeCloseTo(0.7, 6);
    expect(r!.result.edges[0].weight).toBeCloseTo(0.7, 6);
  });

  it("similarityHits 计数 +1", () => {
    const cache = new QueryCache({ similarityThreshold: 0.5 });
    cache.put("q", mkResult(), [1, 0]);

    cache.getSimilar([1, 0]);
    expect(cache.getStats().similarityHits).toBe(1);
  });

  it("未存 embedding 的条目不参与相似匹配", () => {
    const cache = new QueryCache({ similarityThreshold: -2 });
    cache.put("q", mkResult()); // 不传 queryEmbedding

    expect(cache.getSimilar([1, 0])).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. getStats
// ═══════════════════════════════════════════════════════════════

describe("getStats", () => {
  it("初始状态：size=0, hits=0, misses=0, similarityHits=0, hitRate=0", () => {
    const cache = new QueryCache();
    const stats = cache.getStats();

    expect(stats.size).toBe(0);
    expect(stats.capacity).toBe(100);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.similarityHits).toBe(0);
    expect(stats.hitRate).toBe("0");
  });

  it("命中后 hits +1，hitRate 更新", () => {
    const cache = new QueryCache();
    cache.put("q1", mkResult());
    cache.get("q1");

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe("1.000");
  });

  it("miss 后 misses +1，hitRate 更新", () => {
    const cache = new QueryCache();
    cache.get("missing");

    const stats = cache.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
    expect(stats.hitRate).toBe("0.000");
  });

  it("hitRate = hits / (hits + misses)", () => {
    const cache = new QueryCache();
    cache.put("q1", mkResult());
    cache.get("q1");    // hit
    cache.get("miss");  // miss

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    // 1 / (1 + 1) = 0.5
    expect(stats.hitRate).toBe("0.500");
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. evictExpired
// ═══════════════════════════════════════════════════════════════

describe("evictExpired", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("返回清理的条目数（未过期时返回 0）", () => {
    const cache = new QueryCache({ ttlMs: 5000 });
    cache.put("q1", mkResult());
    cache.put("q2", mkResult());

    // diff = 5000，源码判定为 `> ttlMs`，5000 不 > 5000 → 未过期
    vi.advanceTimersByTime(5000);
    expect(cache.evictExpired()).toBe(0);

    // diff = 5001 > 5000 → 全部过期
    vi.advanceTimersByTime(1);
    expect(cache.evictExpired()).toBe(2);
    expect(cache.getStats().size).toBe(0);
  });

  it("仅清理过期条目，保留未过期", () => {
    const cache = new QueryCache({ ttlMs: 5000 });
    cache.put("q1", mkResult()); // timestamp=1000
    vi.advanceTimersByTime(5001); // 时间 6001，q1 过期
    cache.put("q2", mkResult());  // timestamp=6001，新鲜

    const evicted = cache.evictExpired();
    expect(evicted).toBe(1);
    expect(cache.getStats().size).toBe(1);
    expect(cache.get("q2")).not.toBeNull();
  });
});
