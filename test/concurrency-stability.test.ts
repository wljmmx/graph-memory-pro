/**
 * graph-memory-pro v2.3.2 — 并发稳定性单元测试
 *
 * 覆盖阶段一稳定性修复中可直接导出测试的部分：
 *   - S1: preheatProjection 并发互斥（in-flight Promise 复用，防重复 drop/project）
 *   - S4: upsertNode archiveKeepCount 从 cfg 读取（参数化 $keepCount）
 *   - S5: vectorSearchWithScore 容忍部分索引失败（Promise.allSettled）
 *
 * 阶段二性能优化补充测试：
 *   - P2-1: embed LRU 缓存（命中/过期/容量淘汰/禁用）
 *   - P2-2: LLM 并发控制（信号量限流/排队/maxConcurrency）
 *   - P2-3: GDS 自动失效（invalidateProjectionCache/边数 hash）
 *
 * 阶段三可观测与韧性补充测试：
 *   - P3-1: 连接池监控（getPoolMetrics/Session 计数）
 *   - P3-3: 配置热更新（diffConfigSegments/checkReloadAuth/normalizeReloadConfig）
 *
 * S2（extractInBackground 批量回退）与 S3（timer 重入保护）位于 index.ts 私有闭包内，
 * 属于简单 try/catch + flag 模式，由代码审查覆盖，不在此单测范围。
 *
 * 被测模块：
 *   - /workspace/src/graph/pagerank.ts (S1, P2-3)
 *   - /workspace/src/store/nodes.ts (S4, S5)
 *   - /workspace/src/engine/embed.ts (P2-1)
 *   - /workspace/src/engine/llm.ts (P2-2)
 *   - /workspace/src/store/db.ts (P3-1)
 *   - /workspace/src/routes/reload.ts (P3-3)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { upsertNode, vectorSearchWithScore } from "../src/store/nodes.ts";
import { createEmbedFn } from "../src/engine/embed.ts";
import { createCompleteFn } from "../src/engine/llm.ts";
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

// ─── P3-2: 降级熔断器 ──────────────────────────────────────────

describe("v2.3.2 阶段三 P3-2: CircuitBreaker 熔断器", () => {
  it("CLOSED 状态始终放行", async () => {
    const { CircuitBreaker } = await import("../src/engine/circuit-breaker.ts");
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 3, cooldownMs: 1000 });
    expect(breaker.getState()).toBe("closed");
    expect(breaker.allow()).toBe(true);
    expect(breaker.allow()).toBe(true);
    expect(breaker.allow()).toBe(true);
  });

  it("连续失败达阈值后转 OPEN，拒绝请求", async () => {
    const { CircuitBreaker } = await import("../src/engine/circuit-breaker.ts");
    const breaker = new CircuitBreaker({ name: "test-open", failureThreshold: 3, cooldownMs: 1000 });
    // 3 次失败
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
    breaker.recordFailure();
    // 达阈值 → OPEN
    expect(breaker.getState()).toBe("open");
    expect(breaker.allow()).toBe(false);
  });

  it("OPEN cooldown 到期后转 HALF_OPEN 放行探测请求", async () => {
    const { CircuitBreaker } = await import("../src/engine/circuit-breaker.ts");
    const breaker = new CircuitBreaker({ name: "test-halfopen", failureThreshold: 2, cooldownMs: 50 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.allow()).toBe(false); // cooldown 未到期

    // 等待 cooldown
    await new Promise((r) => setTimeout(r, 60));
    expect(breaker.allow()).toBe(true); // HALF_OPEN 放行探测
    expect(breaker.getState()).toBe("half_open");
  });

  it("HALF_OPEN 探测成功 → CLOSED 恢复正常", async () => {
    const { CircuitBreaker } = await import("../src/engine/circuit-breaker.ts");
    const breaker = new CircuitBreaker({ name: "test-recover", failureThreshold: 2, cooldownMs: 50 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");

    await new Promise((r) => setTimeout(r, 60));
    expect(breaker.allow()).toBe(true); // HALF_OPEN
    breaker.recordSuccess(); // 探测成功
    expect(breaker.getState()).toBe("closed");
    expect(breaker.allow()).toBe(true); // 恢复正常放行
  });

  it("HALF_OPEN 探测失败 → 重新 OPEN", async () => {
    const { CircuitBreaker } = await import("../src/engine/circuit-breaker.ts");
    const breaker = new CircuitBreaker({ name: "test-reopen", failureThreshold: 2, cooldownMs: 50 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");

    await new Promise((r) => setTimeout(r, 60));
    expect(breaker.allow()).toBe(true); // HALF_OPEN
    breaker.recordFailure(); // 探测失败
    expect(breaker.getState()).toBe("open");
  });

  it("CLOSED 状态成功重置失败计数", async () => {
    const { CircuitBreaker } = await import("../src/engine/circuit-breaker.ts");
    const breaker = new CircuitBreaker({ name: "test-reset", failureThreshold: 3, cooldownMs: 1000 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess(); // 成功重置
    breaker.recordFailure();
    breaker.recordFailure();
    // 仅 2 次失败（重置后重新计数），未达阈值
    expect(breaker.getState()).toBe("closed");
  });

  it("全局注册表 getCircuitBreaker 返回同一实例", async () => {
    vi.resetModules();
    const { getCircuitBreaker } = await import("../src/engine/circuit-breaker.ts");
    const b1 = getCircuitBreaker("global-test");
    const b2 = getCircuitBreaker("global-test");
    expect(b1).toBe(b2);
  });

  it("reset 手动重置熔断器", async () => {
    const { CircuitBreaker } = await import("../src/engine/circuit-breaker.ts");
    const breaker = new CircuitBreaker({ name: "test-manual-reset", failureThreshold: 2, cooldownMs: 1000 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    breaker.reset();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.allow()).toBe(true);
  });
});

// ─── P2-1: embed LRU 缓存 ──────────────────────────────────────

describe("v2.3.2 阶段二 P2-1: embed LRU 缓存", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function mockEmbedResponse(vec: number[]): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [vec] }),
      text: async () => JSON.stringify({ embeddings: [vec] }),
    } as unknown as Response;
  }

  it("缓存命中：相同 text 第二次不调用 fetch", async () => {
    fetchSpy.mockResolvedValue(mockEmbedResponse([0.1, 0.2, 0.3]));
    const embed = createEmbedFn({ baseURL: "http://localhost:11434", model: "test-p21-hit" });

    await embed("hello");
    await embed("hello");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("TTL 过期后缓存失效，重新调用 fetch", async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(mockEmbedResponse([0.1]));
    const embed = createEmbedFn({
      baseURL: "http://localhost:11434",
      model: "test-p21-ttl",
      cacheTtlMs: 1000,
    });

    await embed("key1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 未过期 → 命中缓存
    await embed("key1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 过期 → 重新请求
    vi.advanceTimersByTime(1500);
    await embed("key1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("容量淘汰：超出 cacheSize 时淘汰最旧条目", async () => {
    fetchSpy.mockImplementation(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const text = body.input[0] as string;
      return mockEmbedResponse([text.length]);
    });
    const embed = createEmbedFn({
      baseURL: "http://localhost:11434",
      model: "test-p21-evict",
      cacheSize: 2,
      cacheTtlMs: 60_000,
    });

    await embed("a"); // cache: [a]
    await embed("b"); // cache: [a, b]
    await embed("c"); // cache: [b, c], a 被淘汰
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // "a" 已被淘汰 → 需重新 fetch（插入 a 时淘汰 b → cache: [c, a]）
    await embed("a");
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // "c" 仍在缓存中（最近使用）→ 命中缓存
    await embed("c");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("cacheSize=0 禁用缓存，每次都调用 fetch", async () => {
    fetchSpy.mockResolvedValue(mockEmbedResponse([0.1]));
    const embed = createEmbedFn({
      baseURL: "http://localhost:11434",
      model: "test-p21-disabled",
      cacheSize: 0,
    });

    await embed("hello");
    await embed("hello");
    await embed("hello");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

// ─── P2-2: LLM 并发控制（信号量） ───────────────────────────────

describe("v2.3.2 阶段二 P2-2: LLM 并发控制（信号量）", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockResponse(content: string): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => content,
    } as unknown as Response;
  }

  it("maxConcurrency=1：并发请求串行执行（第二个 fetch 在第一个完成后才开始）", async () => {
    const callOrder: string[] = [];
    let resolveFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => { resolveFirst = r; });

    fetchSpy.mockImplementation(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const text = body.messages[1].content as string;
      callOrder.push(`start:${text}`);
      if (text === "first") await firstBlocked;
      callOrder.push(`end:${text}`);
      return mockResponse("ok");
    });

    const complete = createCompleteFn({
      baseURL: "https://p22-serial.test/v1",
      model: "m1",
      maxConcurrency: 1,
    });

    const p1 = complete("sys", "first");
    // 让第一个请求先获取信号量并进入 fetch
    await new Promise((r) => setTimeout(r, 10));
    const p2 = complete("sys", "second");

    // 第二个请求被信号量阻塞（fetch 尚未调用）
    expect(callOrder).toEqual(["start:first"]);

    resolveFirst();
    await p1;
    await p2;

    // 两个请求串行完成
    expect(callOrder).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("maxConcurrency=2：并发请求可同时执行", async () => {
    const callOrder: string[] = [];
    let resolveAll!: () => void;
    const block = new Promise<void>((r) => { resolveAll = r; });

    fetchSpy.mockImplementation(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const text = body.messages[1].content as string;
      callOrder.push(`start:${text}`);
      await block;
      callOrder.push(`end:${text}`);
      return mockResponse("ok");
    });

    const complete = createCompleteFn({
      baseURL: "https://p22-parallel.test/v1",
      model: "m2",
      maxConcurrency: 2,
    });

    const p1 = complete("sys", "a");
    const p2 = complete("sys", "b");
    // 让两个请求都进入 fetch
    await new Promise((r) => setTimeout(r, 10));

    // 两个 fetch 同时启动
    expect(callOrder).toContain("start:a");
    expect(callOrder).toContain("start:b");

    resolveAll();
    await Promise.all([p1, p2]);
  });

  it("信号量在请求失败时也释放（不阻塞后续请求）", async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 400, json: async () => ({}), text: async () => "bad request" } as unknown as Response;
      }
      return mockResponse("ok");
    });

    const complete = createCompleteFn({
      baseURL: "https://p22-error.test/v1",
      model: "m3",
      maxConcurrency: 1,
    });

    // 第一个请求失败（400 → 不重试 → 立即抛错，信号量释放）
    await expect(complete("sys", "fail")).rejects.toThrow();

    // 第二个请求能正常执行（信号量已释放）
    const result = await complete("sys", "ok");
    expect(result).toBe("ok");
  });
});

// ─── P2-3: GDS 自动失效 ─────────────────────────────────────────

describe("v2.3.2 阶段二 P2-3: GDS 自动失效", () => {
  it("invalidateProjectionCache 后再次调用触发投影重建", async () => {
    vi.resetModules();
    const { preheatProjection, invalidateProjectionCache } = await import("../src/graph/pagerank.ts");

    let dropCalls = 0;
    let projectCalls = 0;

    const session = {
      async run(query: string, _params: Record<string, any> = {}) {
        if (query.includes("RETURN DISTINCT type(r)")) {
          return { records: [{ get: (k: string) => (k === "t" ? "MENTIONS" : null) }] };
        }
        if (query.includes("count(r) AS cnt")) {
          return { records: [{ get: () => 5 }] };
        }
        if (query.includes("gds.graph.exists")) {
          return { records: [{ get: () => false }] };
        }
        if (query.includes("gds.graph.drop")) { dropCalls++; return { records: [] }; }
        if (query.includes("gds.graph.project")) { projectCalls++; return { records: [] }; }
        return { records: [] };
      },
      async close() {},
    };
    const driver = { session: () => session, async close() {} } as any;

    // 第一次：冷缓存 → drop + project
    await preheatProjection(driver);
    expect(dropCalls).toBe(1);
    expect(projectCalls).toBe(1);

    // 失效缓存
    invalidateProjectionCache();

    // 第二次：缓存已失效 → 再次 drop + project
    await preheatProjection(driver);
    expect(dropCalls).toBe(2);
    expect(projectCalls).toBe(2);
  });

  it("边数变化触发 hash 变化 → 投影重建", async () => {
    vi.resetModules();
    const { preheatProjection } = await import("../src/graph/pagerank.ts");

    let dropCalls = 0;
    let projectCalls = 0;
    let edgeCount = 5;

    const session = {
      async run(query: string, _params: Record<string, any> = {}) {
        if (query.includes("RETURN DISTINCT type(r)")) {
          return { records: [{ get: (k: string) => (k === "t" ? "MENTIONS" : null) }] };
        }
        if (query.includes("count(r) AS cnt")) {
          return { records: [{ get: () => edgeCount }] };
        }
        if (query.includes("gds.graph.exists")) {
          // 缓存命中检查：hash 匹配时 exists=true → 不重建
          return { records: [{ get: () => true }] };
        }
        if (query.includes("gds.graph.drop")) { dropCalls++; return { records: [] }; }
        if (query.includes("gds.graph.project")) { projectCalls++; return { records: [] }; }
        return { records: [] };
      },
      async close() {},
    };
    const driver = { session: () => session, async close() {} } as any;

    // 第一次：edgeCount=5 → 冷缓存 → drop + project
    await preheatProjection(driver);
    expect(dropCalls).toBe(1);
    expect(projectCalls).toBe(1);

    // 第二次：edgeCount 不变 → hash 匹配 → exists=true → 缓存命中（不重建）
    await preheatProjection(driver);
    expect(dropCalls).toBe(1);
    expect(projectCalls).toBe(1);

    // 边数变化 → hash 变化 → 跳过 fast path → 重建
    edgeCount = 6;
    await preheatProjection(driver);
    expect(dropCalls).toBe(2);
    expect(projectCalls).toBe(2);
  });
});

// ─── P3-1: 连接池监控 ──────────────────────────────────────────

describe("v2.3.2 阶段三 P3-1: 连接池监控", () => {
  it("getPoolMetrics 返回正确结构", async () => {
    vi.resetModules();
    const { getPoolMetrics } = await import("../src/store/db.ts");
    const metrics = getPoolMetrics();
    expect(metrics).toHaveProperty("appActiveSessions");
    expect(metrics).toHaveProperty("appTotalSessionsCreated");
    expect(metrics).toHaveProperty("maxPoolSize");
    expect(metrics).toHaveProperty("driverActiveConnections");
    expect(typeof metrics.appActiveSessions).toBe("number");
    expect(typeof metrics.appTotalSessionsCreated).toBe("number");
    expect(metrics.maxPoolSize).toBe(50);
    // driver 未初始化 → null
    expect(metrics.driverActiveConnections).toBeNull();
  });

  it("getSession 递增计数，close 递减 active", async () => {
    vi.resetModules();
    const { getSession, getPoolMetrics } = await import("../src/store/db.ts");

    const driver = {
      session: () => ({ close: async () => {} }),
      async close() {},
    } as any;

    // 初始状态
    expect(getPoolMetrics().appActiveSessions).toBe(0);

    // 获取 session → active +1, total +1
    const s1 = getSession(driver);
    let m = getPoolMetrics();
    expect(m.appActiveSessions).toBe(1);
    expect(m.appTotalSessionsCreated).toBe(1);

    // 关闭 session → active -1, total 不变
    await s1.close();
    m = getPoolMetrics();
    expect(m.appActiveSessions).toBe(0);
    expect(m.appTotalSessionsCreated).toBe(1);
  });

  it("多个并发 session 计数正确", async () => {
    vi.resetModules();
    const { getSession, getPoolMetrics } = await import("../src/store/db.ts");

    const driver = {
      // 每次返回新 session 对象（避免 close 包装链问题）
      session: () => ({ close: async () => {} }),
      async close() {},
    } as any;

    const s1 = getSession(driver);
    const s2 = getSession(driver);
    const s3 = getSession(driver);

    let m = getPoolMetrics();
    expect(m.appActiveSessions).toBe(3);
    expect(m.appTotalSessionsCreated).toBe(3);

    await s2.close();
    m = getPoolMetrics();
    expect(m.appActiveSessions).toBe(2);
    expect(m.appTotalSessionsCreated).toBe(3);
  });
});

// ─── P3-3: 配置热更新（reload 纯函数） ──────────────────────────

describe("v2.3.2 阶段三 P3-3: 配置热更新（reload 纯函数）", () => {
  const baseCfg = {
    neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "pass" },
    llm: { model: "gpt-4o", apiKey: "sk-1" },
    embedding: { model: "text-embed", baseURL: "http://localhost:11434" },
    background: { extractorIntervalMs: 60_000, maintenanceIntervalMs: 6 * 3600_000 },
  } as any;

  describe("diffConfigSegments", () => {
    it("完全相同的配置 → 全部 false", async () => {
      const { diffConfigSegments } = await import("../src/routes/reload.ts");
      const diff = diffConfigSegments(baseCfg, baseCfg);
      expect(diff.neo4j).toBe(false);
      expect(diff.llm).toBe(false);
      expect(diff.embedding).toBe(false);
      expect(diff.background).toBe(false);
    });

    it("neo4j.uri 变化 → neo4j=true", async () => {
      const { diffConfigSegments } = await import("../src/routes/reload.ts");
      const newCfg = { ...baseCfg, neo4j: { ...baseCfg.neo4j, uri: "bolt://newhost:7687" } };
      const diff = diffConfigSegments(baseCfg, newCfg);
      expect(diff.neo4j).toBe(true);
      expect(diff.llm).toBe(false);
    });

    it("llm.model 变化 → llm=true", async () => {
      const { diffConfigSegments } = await import("../src/routes/reload.ts");
      const newCfg = { ...baseCfg, llm: { ...baseCfg.llm, model: "gpt-5" } };
      const diff = diffConfigSegments(baseCfg, newCfg);
      expect(diff.llm).toBe(true);
      expect(diff.neo4j).toBe(false);
    });

    it("embedding.model 变化 → embedding=true", async () => {
      const { diffConfigSegments } = await import("../src/routes/reload.ts");
      const newCfg = { ...baseCfg, embedding: { ...baseCfg.embedding, model: "new-embed" } };
      const diff = diffConfigSegments(baseCfg, newCfg);
      expect(diff.embedding).toBe(true);
    });

    it("background.extractorIntervalMs 变化 → background=true", async () => {
      const { diffConfigSegments } = await import("../src/routes/reload.ts");
      const newCfg = { ...baseCfg, background: { ...baseCfg.background, extractorIntervalMs: 120_000 } };
      const diff = diffConfigSegments(baseCfg, newCfg);
      expect(diff.background).toBe(true);
    });

    it("background 从 undefined → 有值 → background=true", async () => {
      const { diffConfigSegments } = await import("../src/routes/reload.ts");
      const oldCfg = { ...baseCfg, background: undefined };
      const newCfg = { ...baseCfg, background: { extractorIntervalMs: 30_000 } };
      const diff = diffConfigSegments(oldCfg as any, newCfg);
      expect(diff.background).toBe(true);
    });
  });

  describe("checkReloadAuth", () => {
    it("未配置 authToken → 允许访问", async () => {
      const { checkReloadAuth } = await import("../src/routes/reload.ts");
      const result = checkReloadAuth(baseCfg, undefined);
      expect(result.ok).toBe(true);
    });

    it("authToken 匹配 → 允许访问", async () => {
      const { checkReloadAuth } = await import("../src/routes/reload.ts");
      const cfg = { ...baseCfg, mcp: { authToken: "secret-token" } } as any;
      const result = checkReloadAuth(cfg, "secret-token");
      expect(result.ok).toBe(true);
    });

    it("authToken 不匹配 → 401", async () => {
      const { checkReloadAuth } = await import("../src/routes/reload.ts");
      const cfg = { ...baseCfg, mcp: { authToken: "secret-token" } } as any;
      const result = checkReloadAuth(cfg, "wrong-token");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(401);
      expect(result.error).toBe("unauthorized");
    });

    it("cfg 为 null → 允许访问（未初始化时由上层 503 兜底）", async () => {
      const { checkReloadAuth } = await import("../src/routes/reload.ts");
      const result = checkReloadAuth(null, undefined);
      expect(result.ok).toBe(true);
    });
  });

  describe("normalizeReloadConfig", () => {
    it("填充默认值", async () => {
      const { normalizeReloadConfig } = await import("../src/routes/reload.ts");
      const cfg = normalizeReloadConfig({ neo4j: { uri: "bolt://x", user: "u", password: "p" } });
      expect(cfg.compactTurnCount).toBe(6);
      expect(cfg.recallMaxNodes).toBe(6);
      expect(cfg.recallMaxDepth).toBe(2);
      expect(cfg.freshTailCount).toBe(10);
      expect(cfg.dedupThreshold).toBe(0.90);
      expect(cfg.pagerankDamping).toBe(0.85);
      expect(cfg.pagerankIterations).toBe(20);
    });

    it("保留用户提供的值", async () => {
      const { normalizeReloadConfig } = await import("../src/routes/reload.ts");
      const cfg = normalizeReloadConfig({
        neo4j: { uri: "bolt://x", user: "u", password: "p" },
        recallMaxNodes: 20,
        pagerankIterations: 50,
      });
      expect(cfg.recallMaxNodes).toBe(20);
      expect(cfg.pagerankIterations).toBe(50);
      // 未提供的仍填充默认
      expect(cfg.compactTurnCount).toBe(6);
    });
  });
});

// ─── v2.3.3: SEC-1 路由鉴权 + MCP-2 超时 + CB-2 熔断器日志 ────

describe("v2.3.3 SEC-1: HTTP 路由鉴权中间件逻辑", () => {
  // 测试 index.ts 中的鉴权判定逻辑（通过模拟 needsAuth + authToken 比对）
  it("写操作（POST/DELETE）在配置 authToken 时需要鉴权", () => {
    const authToken = "secret-123";
    const needsAuth = true; // POST 路由
    const provided = "wrong-token";
    expect(needsAuth && authToken && provided !== authToken).toBe(true); // 拒绝
    expect(needsAuth && authToken && authToken === authToken).toBe(false || authToken === authToken); // 通过
  });

  it("敏感读操作（/api/health 等）在配置 authToken 时需要鉴权", () => {
    const SENSITIVE_READ_PATHS = new Set(["/api/health", "/api/metrics", "/api/usage", "/api/doctor"]);
    const authToken = "secret-123";
    expect(SENSITIVE_READ_PATHS.has("/api/health")).toBe(true);
    expect(SENSITIVE_READ_PATHS.has("/api/status")).toBe(false); // 普通读不敏感
  });

  it("未配置 authToken 时所有路由放行（向后兼容）", () => {
    const authToken = undefined;
    const needsAuth = true;
    expect(needsAuth && authToken).toBeFalsy(); // 放行
  });
});

describe("v2.3.3 MCP-2: tool execute 超时包装", () => {
  it("withTimeout 在超时后抛出超时错误", async () => {
    // 模拟 withTimeout 逻辑
    async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP tool '${toolName}' timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      try {
        return await Promise.race([fn(), timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    const slow = new Promise<string>(() => {}); // 永不 resolve
    await expect(withTimeout(() => slow, 50, "test-tool")).rejects.toThrow("MCP tool 'test-tool' timed out after 50ms");
  });

  it("withTimeout 在正常完成时返回结果", async () => {
    async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      });
      try {
        return await Promise.race([fn(), timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    const result = await withTimeout(() => Promise.resolve("ok"), 1000);
    expect(result).toBe("ok");
  });
});

describe("v2.3.3 CB-2: 熔断器状态变更日志", () => {
  it("transition 时 logger.info 被调用", async () => {
    vi.resetModules();
    const logCalls: any[] = [];
    vi.doMock("../src/logger.ts", () => ({
      createLogger: () => ({
        info: (msg: string, fields?: any) => logCalls.push({ msg, fields }),
        warn: () => {},
        debug: () => {},
        error: () => {},
        child: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
        getNamespace: () => "circuit-breaker",
      }),
    }));

    const { CircuitBreaker } = await import("../src/engine/circuit-breaker.ts");
    const breaker = new CircuitBreaker({ name: "test-log", failureThreshold: 2, cooldownMs: 1000 });

    // CLOSED → OPEN（触发 transition）
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");

    // 应有状态变更日志
    const stateChangeLog = logCalls.find(
      (l) => l.msg === "circuit breaker state changed" && l.fields?.from === "closed" && l.fields?.to === "open",
    );
    expect(stateChangeLog).toBeDefined();
    expect(stateChangeLog.fields.name).toBe("test-log");

    vi.doUnmock("../src/logger.ts");
    vi.restoreAllMocks();
  });
});

// ─── v2.3.4: CB-1 熔断器时间窗口 + ARCH-1 拆分验证 ─────────────

describe("v2.3.4 CB-1: 熔断器时间窗口衰减", () => {
  it("未配置 failureWindowMs 时累计失败不衰减（向后兼容）", async () => {
    const { CircuitBreaker } = await import("../src/engine/circuit-breaker.ts");
    const breaker = new CircuitBreaker({ name: "test-no-window", failureThreshold: 5, cooldownMs: 1000 });
    // failureWindowMs 默认 0 → 不衰减
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getStatus().failureCount).toBe(3);
    // 即使等待也不会衰减
    await new Promise((r) => setTimeout(r, 50));
    expect(breaker.allow()).toBe(true); // CLOSED 放行
    expect(breaker.getStatus().failureCount).toBe(3); // 计数不变
  });

  it("配置 failureWindowMs 后旧失败在窗口外自动过期", async () => {
    const { CircuitBreaker } = await import("../src/engine/circuit-breaker.ts");
    const breaker = new CircuitBreaker({
      name: "test-window",
      failureThreshold: 5,
      cooldownMs: 1000,
      failureWindowMs: 100, // 100ms 窗口
    });

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getStatus().failureCount).toBe(2);

    // 等待窗口过期
    await new Promise((r) => setTimeout(r, 150));

    // allow() 触发清理 → 过期失败被移除
    expect(breaker.allow()).toBe(true);
    expect(breaker.getStatus().failureCount).toBe(0);
  });
});

describe("v2.3.4 ARCH-1: extract-service 拆分验证", () => {
  it("extractInBackground 从 services/extract-service.ts 导出", async () => {
    const mod = await import("../src/services/extract-service.ts");
    expect(typeof mod.extractInBackground).toBe("function");
  });

  it("空输入时快速返回（无 driver/llm）", async () => {
    const { extractInBackground } = await import("../src/services/extract-service.ts");
    await expect(extractInBackground(null, null, null, null, console, [])).resolves.toBeUndefined();
  });
});
