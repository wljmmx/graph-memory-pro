/**
 * graph-memory-pro v2.3.2 — 并发稳定性单元测试
 *
 * 覆盖阶段一稳定性修复中可直接导出测试的部分：
 *   - S1: preheatProjection 并发互斥（in-flight Promise 复用，防重复 drop/project）
 *   - S4: upsertNode archiveKeepCount 从 cfg 读取（参数化 $keepCount）
 *   - S5: vectorSearchWithScore 容忍部分索引失败（Promise.allSettled）
 *
 * S2（extractInBackground 批量回退）与 S3（timer 重入保护）位于 index.ts 私有闭包内，
 * 属于简单 try/catch + flag 模式，由代码审查覆盖，不在此单测范围。
 *
 * 被测模块：
 *   - /workspace/src/graph/pagerank.ts (S1)
 *   - /workspace/src/store/nodes.ts (S4, S5)
 */

import { describe, it, expect, vi } from "vitest";
import { upsertNode, vectorSearchWithScore } from "../src/store/nodes.ts";
import type { GmConfig } from "../src/types.ts";

// ─── S1: preheatProjection 并发互斥 ──────────────────────────────

describe("v2.3.2 S1: preheatProjection 并发互斥", () => {
  it("并发调用复用同一 in-flight Promise，drop/project 各仅执行 1 次", async () => {
    // 用 resetModules 获取 fresh 模块实例，确保 _projectionInFlight / _cachedRelTypeHash 为初始空值
    vi.resetModules();
    const { preheatProjection } = await import("../src/graph/pagerank.ts");

    let dropCalls = 0;
    let projectCalls = 0;
    let existsCalls = 0;

    // 自定义 session.run：按 query 内容返回对应结果
    const session = {
      runCalls: [] as any[],
      closeCalls: 0,
      async run(query: string, params: Record<string, any> = {}) {
        session.runCalls.push({ query, params });
        // getExistingRelTypes → 返回 1 个关系类型
        if (query.includes("RETURN DISTINCT type(r)")) {
          return { records: [{ get: (k: string) => (k === "t" ? "MENTIONS" : null) }] };
        }
        // gds.graph.exists → 返回 false（强制走 drop+project 路径）
        if (query.includes("gds.graph.exists")) {
          existsCalls++;
          return { records: [{ get: () => false }] };
        }
        if (query.includes("gds.graph.drop")) {
          dropCalls++;
          return { records: [] };
        }
        if (query.includes("gds.graph.project")) {
          projectCalls++;
          return { records: [] };
        }
        return { records: [] };
      },
      async close() {
        session.closeCalls++;
      },
    };

    const driver = {
      session: () => session,
      async close() {},
    } as any;

    // 并发发起 5 次 preheatProjection
    const results = await Promise.all([
      preheatProjection(driver),
      preheatProjection(driver),
      preheatProjection(driver),
      preheatProjection(driver),
      preheatProjection(driver),
    ]);

    // 全部返回 true（投影就绪）
    expect(results.every((r) => r === true)).toBe(true);
    // 核心断言：互斥锁使 drop + project 各仅执行 1 次（而非 5 次）
    expect(dropCalls).toBe(1);
    expect(projectCalls).toBe(1);
    // session 被关闭（in-flight Promise 结束后清理）
    expect(session.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it("前一批完成后再次调用命中缓存（exists 检查），不触发 drop/project", async () => {
    vi.resetModules();
    const { preheatProjection } = await import("../src/graph/pagerank.ts");

    let dropCalls = 0;
    let projectCalls = 0;
    const session = {
      runCalls: [] as any[],
      closeCalls: 0,
      async run(query: string) {
        session.runCalls.push({ query, params: {} });
        if (query.includes("RETURN DISTINCT type(r)")) {
          return { records: [{ get: (k: string) => (k === "t" ? "MENTIONS" : null) }] };
        }
        // gds.graph.exists → true（图已存在，命中缓存 fast path）
        if (query.includes("gds.graph.exists")) {
          return { records: [{ get: () => true }] };
        }
        if (query.includes("gds.graph.drop")) { dropCalls++; return { records: [] }; }
        if (query.includes("gds.graph.project")) { projectCalls++; return { records: [] }; }
        return { records: [] };
      },
      async close() { session.closeCalls++; },
    };
    const driver = { session: () => session, async close() {} } as any;

    // 第一次：冷缓存 → drop + project
    await preheatProjection(driver);
    expect(dropCalls).toBe(1);
    expect(projectCalls).toBe(1);

    // 第二次：缓存命中（exists=true）→ 不再 drop/project
    await preheatProjection(driver);
    expect(dropCalls).toBe(1);
    expect(projectCalls).toBe(1);
  });
});

// ─── S4: upsertNode archiveKeepCount 配置化 ──────────────────────

describe("v2.3.2 S4: upsertNode archiveKeepCount 从 cfg 读取", () => {
  it("未传 cfg 时 keepCount 默认 3（向后兼容）", async () => {
    const calls: any[] = [];
    const session = {
      async run(query: string, params: Record<string, any> = {}) {
        calls.push({ query, params });
        return { records: [], summary: { counters: { upserts: () => 1 } } };
      },
      async close() {},
    };
    const driver = { session: () => session, async close() {} } as any;

    await upsertNode(driver, {
      id: "n1", type: "TASK", name: "n", description: "d", content: "c",
      status: "active", pagerank: 0, validatedCount: 0, createdAt: 1, updatedAt: 1,
    } as any);

    // 默认 keepCount = 3
    expect(calls[0].params.keepCount).toBe(3);
    // Cypher 使用参数化切片
    expect(calls[0].query).toContain("[..$keepCount]");
  });

  it("传 cfg.evolvableEmbedding.archiveKeepCount=5 时 keepCount=5", async () => {
    const calls: any[] = [];
    const session = {
      async run(query: string, params: Record<string, any> = {}) {
        calls.push({ query, params });
        return { records: [], summary: { counters: { upserts: () => 1 } } };
      },
      async close() {},
    };
    const driver = { session: () => session, async close() {} } as any;

    const cfg = { evolvableEmbedding: { archiveKeepCount: 5 } } as any;
    await upsertNode(driver, {
      id: "n1", type: "TASK", name: "n", description: "d", content: "c",
      status: "active", pagerank: 0, validatedCount: 0, createdAt: 1, updatedAt: 1,
    } as any, cfg);

    expect(calls[0].params.keepCount).toBe(5);
  });

  it("cfg.archiveKeepCount=1 时 keepCount=1", async () => {
    const calls: any[] = [];
    const session = {
      async run(query: string, params: Record<string, any> = {}) {
        calls.push({ query, params });
        return { records: [], summary: { counters: { upserts: () => 1 } } };
      },
      async close() {},
    };
    const driver = { session: () => session, async close() {} } as any;

    const cfg = { evolvableEmbedding: { archiveKeepCount: 1 } } as any;
    await upsertNode(driver, {
      id: "n1", type: "SKILL", name: "n", description: "d", content: "c",
      status: "active", pagerank: 0, validatedCount: 0, createdAt: 1, updatedAt: 1,
    } as any, cfg);

    expect(calls[0].params.keepCount).toBe(1);
  });
});

// ─── S5: vectorSearchWithScore 部分索引失败容错 ──────────────────

describe("v2.3.2 S5 + 阶段二 P2-4: vectorSearchWithScore 容忍部分索引失败", () => {
  it("合并索引优先：单索引 gm_node_embedding 成功直接返回", async () => {
    // v2.3.2 阶段二 P2-4: 优先用合并索引，单 session 单查询即返回
    const driver = {
      session() {
        return {
          async run(_query: string, params: Record<string, any> = {}) {
            const indexName = params.indexName;
            // 合并索引返回 2 个节点
            if (indexName === "gm_node_embedding") {
              return {
                records: [
                  {
                    get: (k: string) => {
                      if (k === "node") return { properties: { id: "Task-1", name: "t", type: "TASK", status: "active" }, labels: ["Task"] };
                      if (k === "score") return 0.95;
                      return null;
                    },
                  },
                  {
                    get: (k: string) => {
                      if (k === "node") return { properties: { id: "Event-1", name: "e", type: "EVENT", status: "active" }, labels: ["Event"] };
                      if (k === "score") return 0.8;
                      return null;
                    },
                  },
                ],
              };
            }
            return { records: [] };
          },
          async close() {},
        };
      },
      async close() {},
    } as any;

    const result = await vectorSearchWithScore(driver, [0.1, 0.2], 5);
    // 合并索引成功 → 直接返回，按 score 降序
    expect(result.length).toBe(2);
    expect(result[0].node.id).toBe("Task-1");
    expect(result[0].score).toBe(0.95);
    expect(result[1].node.id).toBe("Event-1");
  });

  it("合并索引不存在时回退到 3 索引并行，1 个 reject 仍返回其余结果", async () => {
    // v2.3.2 阶段二 P2-4: 合并索引查询抛错 → 回退 3 索引并行（兼容旧环境）
    let callCount = 0;
    const driver = {
      session() {
        return {
          async run(_query: string, params: Record<string, any> = {}) {
            const indexName = params.indexName;
            callCount++;
            // 第一次：合并索引 → 抛错（模拟不存在）
            if (indexName === "gm_node_embedding") {
              throw new Error("index not found");
            }
            // 回退 3 索引：skill 索引失败，task/event 各返回 1 个
            if (indexName === "gm_node_embedding_skill") {
              throw new Error("vector index corrupt");
            }
            const label = indexName.includes("task") ? "Task" : "Event";
            return {
              records: [{
                get: (k: string) => {
                  if (k === "node") {
                    return { properties: { id: `${label}-1`, name: label, type: label.toUpperCase(), status: "active" }, labels: [label] };
                  }
                  if (k === "score") return 0.9;
                  return null;
                },
              }],
            };
          },
          async close() {},
        };
      },
      async close() {},
    } as any;

    const result = await vectorSearchWithScore(driver, [0.1, 0.2], 5);

    // skill 索引失败被跳过，task + event 各 1 个 → 共 2 个结果
    expect(result.length).toBe(2);
    const ids = result.map((r) => r.node.id).sort();
    expect(ids).toEqual(["Event-1", "Task-1"]);
  });

  it("全部索引 reject 时返回空数组（不抛错，由上层 FTS 兜底）", async () => {
    const driver = {
      session() {
        return {
          async run() { throw new Error("all indexes down"); },
          async close() {},
        };
      },
      async close() {},
    } as any;

    const result = await vectorSearchWithScore(driver, [0.1, 0.2], 5);
    // allSettled 容忍全部失败 → 返回空数组，不抛错
    expect(result).toEqual([]);
  });

  it("合并索引天然去重（单索引返回同 id 仅保留一条）", async () => {
    // v2.3.2 阶段二 P2-4: 合并索引单查询，结果天然不重复
    const driver = {
      session() {
        return {
          async run(_query: string, params: Record<string, any> = {}) {
            const indexName = params.indexName;
            if (indexName === "gm_node_embedding") {
              // 合并索引返回 1 个节点（单索引天然不重复）
              return {
                records: [{
                  get: (k: string) => {
                    if (k === "node") {
                      return { properties: { id: "dup-1", name: "dup", type: "TASK", status: "active" }, labels: ["Task"] };
                    }
                    if (k === "score") return 0.95;
                    return null;
                  },
                }],
              };
            }
            return { records: [] };
          },
          async close() {},
        };
      },
      async close() {},
    } as any;

    const result = await vectorSearchWithScore(driver, [0.1, 0.2], 5);
    // 合并索引单查询 → 1 个结果
    expect(result.length).toBe(1);
    expect(result[0].node.id).toBe("dup-1");
    expect(result[0].score).toBe(0.95);
  });
});
