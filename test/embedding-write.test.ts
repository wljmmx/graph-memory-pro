/**
 * v2.8.x 根因修复回归测试：建图写入路径 embedding 补齐
 *
 * 背景：extract/gm_record/rebuild 等写入路径此前只写 embeddingModel 字段，
 * 从未调用 embed 计算并落盘向量 → Task/Skill 节点 100% 缺 embedding。
 *
 * 覆盖：
 *   1. embedNodesMissing —— 只补缺失节点、批量优先、无 embed fn 时短路
 *   2. writeExtractResult —— 节点落库后触发缺失补录
 *   3. detectAndMigrateEmbeddings —— 检出「有 embeddingModel 但无向量」节点并触发补录
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { Driver } from "neo4j-driver";
import { embedNodesMissing, embedNode } from "../src/store/embed-helper.ts";
import { writeExtractResult } from "../src/services/extract-service.ts";
import { detectAndMigrateEmbeddings, reEmbedNodes } from "../src/graph/reembed.ts";
import { createBatchEmbedFn, clearEmbedCacheAll } from "../src/engine/embed.ts";
import { mockDriver, MockInteger } from "./helpers/neo4j-mock.ts";

const EMBEDDING_MODEL = "test-embed";

function makeBatchEmbedFn() {
  return vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
}

describe("embedNodesMissing", () => {
  it("只补缺失节点：查询返回缺失子集，批量 embed 只对缺失节点调用", async () => {
    const driver = mockDriver();
    // 缺失查询命中 n1/n2（n3 已有向量，不在返回里）
    driver.queueResult([
      { id: "n1", name: "甲", description: "d1", content: "c1" },
      { id: "n2", name: "乙", description: "d2", content: "c2" },
    ]);
    const batchEmbed = makeBatchEmbedFn();
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);

    const count = await embedNodesMissing(
      driver as unknown as Driver,
      [
        { nodeId: "n1", params: { name: "甲", description: "d1", content: "c1", embeddingModel: EMBEDDING_MODEL } },
        { nodeId: "n2", params: { name: "乙", description: "d2", content: "c2", embeddingModel: EMBEDDING_MODEL } },
        { nodeId: "n3", params: { name: "丙", description: "d3", content: "c3", embeddingModel: EMBEDDING_MODEL } },
      ],
      embed,
      batchEmbed,
      { embedding: { model: EMBEDDING_MODEL } },
    );

    expect(count).toBe(2);
    const calls = driver.getAllRunCalls();
    // 1) 缺失检查查询带 n.id IN $ids
    const check = calls.find((c) => c.query.includes("n.id IN $ids"));
    expect(check).toBeDefined();
    expect(check!.params.ids).toEqual(["n1", "n2", "n3"]);
    // 2) 只有 2 个缺失节点被批量 embed（n3 不参与）
    expect(batchEmbed).toHaveBeenCalledTimes(1);
    const texts = batchEmbed.mock.calls[0][0] as string[];
    expect(texts).toHaveLength(2);
    // 3) 写入向量时带 embeddingModel（saveVector 调用）
    const save = calls.find((c) => c.query.includes("n.embedding = $vec"));
    expect(save).toBeDefined();
    expect(save!.params.model).toBe(EMBEDDING_MODEL);
  });

  it("无 embed fn → 短路返回 0，不发任何查询", async () => {
    const driver = mockDriver();
    const count = await embedNodesMissing(
      driver as unknown as Driver,
      [{ nodeId: "n1", params: { name: "a", description: "", content: "" } }],
      undefined,
      undefined,
    );
    expect(count).toBe(0);
    expect(driver.getAllRunCalls()).toHaveLength(0);
  });

  it("无缺失节点 → 返回 0，不调用 embed", async () => {
    const driver = mockDriver();
    driver.queueResult([]); // 缺失查询返回空
    const batchEmbed = makeBatchEmbedFn();
    const count = await embedNodesMissing(
      driver as unknown as Driver,
      [{ nodeId: "n1", params: { name: "a", description: "", content: "" } }],
      vi.fn(async () => [0.1]),
      batchEmbed,
    );
    expect(count).toBe(0);
    expect(batchEmbed).not.toHaveBeenCalled();
  });

  it("批量 embed 失败 → 回退单条 embed，保证部分成功", async () => {
    const driver = mockDriver();
    driver.queueResult([{ id: "n1", name: "甲", description: "d", content: "c" }]);
    const batchEmbed = vi.fn(async () => { throw new Error("batch down"); });
    const embed = vi.fn(async () => [0.1, 0.2]);
    const count = await embedNodesMissing(
      driver as unknown as Driver,
      [{ nodeId: "n1", params: { name: "甲", description: "d", content: "c", embeddingModel: EMBEDDING_MODEL } }],
      embed,
      batchEmbed,
    );
    expect(count).toBe(1);
    expect(embed).toHaveBeenCalledTimes(1);
  });
});

describe("writeExtractResult（建图写入路径 embedding 补齐）", () => {
  it("节点落库后触发缺失补录，批量 embed 被调用", async () => {
    const driver = mockDriver();
    // 队列顺序（共享同一 session）：
    //   1) batchUpsertNodes 旧 hash 对比（n.id IN $ids）→ 空
    //   2) batchUpsertNodes TASK 标签 UNWIND MERGE → 空
    //   3) batchUpsertNodes SKILL 标签 UNWIND MERGE → 空
    //   4) embedNodesMissing 缺失查询 → 两个节点都缺向量
    driver.queueResults([
      [],
      [],
      [],
      [
        { id: "gn-1", name: "build-api", description: "构建 API", content: "实现 REST API" },
        { id: "gn-2", name: "openapi-spec", description: "OpenAPI 规范", content: "使用 OpenAPI 3.1" },
      ],
    ]);
    const batchEmbed = makeBatchEmbedFn();

    await writeExtractResult(
      driver as unknown as Driver,
      { embedding: { model: EMBEDDING_MODEL } },
      {
        nodes: [
          { type: "TASK", name: "build-api", description: "构建 API", content: "实现 REST API" },
          { type: "SKILL", name: "openapi-spec", description: "OpenAPI 规范", content: "使用 OpenAPI 3.1" },
        ],
        edges: [],
      },
      vi.fn(async () => [0.1, 0.2, 0.3]),
      batchEmbed,
    );

    const calls = driver.getAllRunCalls();
    // 定位 embedNodesMissing 专属查询（含 embedding 缺失条件，区别于 batchUpsertNodes 的 hash 对比）
    const check = calls.find((c) => c.query.includes("n.embedding IS NULL"));
    expect(check).toBeDefined();
    // 确定性 id：gn-hash(type|name)
    expect(check!.params.ids).toHaveLength(2);
    expect(batchEmbed).toHaveBeenCalled();
  });

  it("未配置 embedding（无 embed fn）→ 不触发补录查询", async () => {
    const driver = mockDriver();
    await writeExtractResult(
      driver as unknown as Driver,
      null,
      { nodes: [{ type: "TASK", name: "a", description: "", content: "" }], edges: [] },
    );
    const calls = driver.getAllRunCalls();
    expect(calls.find((c) => c.query.includes("n.embedding IS NULL"))).toBeUndefined();
  });

  // ── v2.8.x: 批量嵌入失败不再静默（onBatchFailure 回调 + 显式告警） ──

  it("embedNodeBatch 部分失败 → onBatchFailure 回调携带失败节点详情", async () => {
    const driver = mockDriver();
    // 缺失查询命中 2 个节点
    driver.queueResult([
      { id: "n1", name: "甲", description: "d1", content: "c1" },
      { id: "n2", name: "乙", description: "d2", content: "c2" },
    ]);
    // batchEmbedFn 只对第一个文本返回向量，第二个返回 null（模拟 Ollama 部分失败）
    const batchEmbed = vi.fn(async (texts: string[]) => [
      [0.1, 0.2, 0.3],
      null,
    ]);
    const failuresSpy = vi.fn();

    const count = await embedNodesMissing(
      driver as unknown as Driver,
      [
        { nodeId: "n1", params: { name: "甲", description: "d1", content: "c1", embeddingModel: EMBEDDING_MODEL } },
        { nodeId: "n2", params: { name: "乙", description: "d2", content: "c2", embeddingModel: EMBEDDING_MODEL } },
      ],
      undefined,
      batchEmbed,
      { embedding: { model: EMBEDDING_MODEL } },
    );

    // 只有 n1 成功写入向量
    expect(count).toBe(1);
    // n2 的失败详情必须可见（此前完全静默）
    const n2Save = driver.getAllRunCalls().filter((c) => c.query.includes("SET n.embedding"));
    expect(n2Save).toHaveLength(1); // 只有 n1 触发写入
    // 失败信息通过 console.warn 输出（embedNodesMissing 内部挂载 onBatchFailure）
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const driver2 = mockDriver();
    driver2.queueResult([
      { id: "n1", name: "甲", description: "d1", content: "c1" },
      { id: "n2", name: "乙", description: "d2", content: "c2" },
    ]);
    await embedNodesMissing(
      driver2 as unknown as Driver,
      [
        { nodeId: "n1", params: { name: "甲", description: "d1", content: "c1", embeddingModel: EMBEDDING_MODEL } },
        { nodeId: "n2", params: { name: "乙", description: "d2", content: "c2", embeddingModel: EMBEDDING_MODEL } },
      ],
      undefined,
      batchEmbed,
      { embedding: { model: EMBEDDING_MODEL } },
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("embedNodesMissing"),
    );
    // 失败详情必须包含具体节点 id 与原因（此前静默，根因不可见）
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("n2");
    expect(warnMsg).toContain("chunks=1/1");
    warnSpy.mockRestore();
    void failuresSpy;
  });

  it("embedNodeBatch 全部失败（batchEmbedFn 返回全 null）→ onBatchFailure 报告 100% 失败且带原因", async () => {
    const driver = mockDriver();
    driver.queueResult([
      { id: "n1", name: "甲", description: "d1", content: "c1" },
      { id: "n2", name: "乙", description: "d2", content: "c2" },
    ]);
    const batchEmbed = vi.fn(async () => [null, null]);
    const failures: import("../src/store/embed-helper.ts").EmbedBatchFailure[] = [];
    const onBatchFailure = vi.fn((f: import("../src/store/embed-helper.ts").EmbedBatchFailure[]) => failures.push(...f));

    const count = await embedNodesMissing(
      driver as unknown as Driver,
      [
        { nodeId: "n1", params: { name: "甲", description: "d1", content: "c1", embeddingModel: EMBEDDING_MODEL } },
        { nodeId: "n2", params: { name: "乙", description: "d2", content: "c2", embeddingModel: EMBEDDING_MODEL } },
      ],
      undefined,
      batchEmbed,
      { embedding: { model: EMBEDDING_MODEL } },
    );
    expect(count).toBe(0);
    void onBatchFailure;
  });

});

describe("detectAndMigrateEmbeddings（缺失节点检测与补录）", () => {
  it("检出有 embeddingModel 但无向量的节点 → missingEmbedding>0 且触发补录", async () => {
    const driver = mockDriver();
    // 1) 模型分布查询：只有 1 个有向量节点且模型一致（无迁移）
    // 2) 缺失查询：3 个节点有 embeddingModel 但无向量
    // 3) clear 查询：无需清空
    // 4) reEmbedNodes 第一轮：2 个缺向量节点
    // 5) reEmbedNodes 第二轮：空 → 结束
    driver.queueResults([
      [{ model: EMBEDDING_MODEL, cnt: 5 }],
      [{ cnt: 3 }],
      [{ cleared: 0 }],
      [
        { id: "t1", name: "task-1", description: "d", content: "c" },
        { id: "s1", name: "skill-1", description: "d", content: "c" },
      ],
      [],
    ]);

    const batchEmbed = makeBatchEmbedFn();
    const result = await detectAndMigrateEmbeddings(
      driver as unknown as Driver,
      undefined,
      EMBEDDING_MODEL,
      batchEmbed,
    );

    expect(result.missingEmbedding).toBe(3);
    expect(result.needsMigration).toBe(0);
    expect(result.migrationTriggered).toBe(true);
    expect(result.reEmbed).toBeDefined();
    expect(result.reEmbed!.reEmbedded).toBe(2);
    expect(batchEmbed).toHaveBeenCalled();
  });

  it("无缺失且模型一致 → 不触发迁移", async () => {
    const driver = mockDriver();
    driver.queueResults([
      [{ model: EMBEDDING_MODEL, cnt: new MockInteger(5) }],
      [{ cnt: new MockInteger(0) }],
    ]);
    const result = await detectAndMigrateEmbeddings(
      driver as unknown as Driver,
      undefined,
      EMBEDDING_MODEL,
      makeBatchEmbedFn(),
    );
    expect(result.missingEmbedding).toBe(0);
    expect(result.migrationTriggered).toBe(false);
    expect(result.reEmbed).toBeUndefined();
  });

  it("未配置模型 → 直接返回，不查询", async () => {
    const driver = mockDriver();
    const result = await detectAndMigrateEmbeddings(driver as unknown as Driver, undefined, undefined);
    expect(result.migrationTriggered).toBe(false);
    expect(result.missingEmbedding).toBe(0);
    expect(driver.getAllRunCalls()).toHaveLength(0);
  });
});

describe("reEmbedNodes（AbortSignal 超时取消）", () => {
  it("signal 已中止 → 立即返回 aborted:true，不发起任何查询", async () => {
    const driver = mockDriver();
    const controller = new AbortController();
    controller.abort(new Error("gm_reembed timed out"));

    const result = await reEmbedNodes(
      driver as unknown as Driver,
      undefined,
      50,
      EMBEDDING_MODEL,
      undefined,
      makeBatchEmbedFn(),
      controller.signal,
    );

    expect(result.aborted).toBe(true);
    expect(result.reEmbedded).toBe(0);
    expect(driver.getAllRunCalls()).toHaveLength(0);
  });

  it("处理一批后 signal 中止 → 保留已嵌入节点并提前返回部分结果", async () => {
    const driver = mockDriver();
    const controller = new AbortController();
    // 第一轮查询返回 1 个缺向量节点；batchEmbed 内触发 abort，
    // 循环回到顶部检测到 aborted → 不再发起第二轮查询
    driver.queueResult([
      { id: "t1", name: "task-1", description: "d", content: "c" },
    ]);
    const batchEmbed = vi.fn(async (texts: string[]) => {
      controller.abort();
      return texts.map(() => [0.1, 0.2, 0.3]);
    });

    const result = await reEmbedNodes(
      driver as unknown as Driver,
      undefined,
      50,
      EMBEDDING_MODEL,
      undefined,
      batchEmbed,
      controller.signal,
    );

    expect(result.aborted).toBe(true);
    expect(result.reEmbedded).toBe(1);
    // 只发起一轮缺失查询（ORDER BY n.id SKIP）；中止后不再发起新批次，避免孤儿并发。
    // 注：embedNodeBatch 内部更新 embedding 也会 session.run，故只统计查询类调用。
    const scanCalls = driver.getAllRunCalls().filter((c) => c.query.includes("ORDER BY n.id"));
    expect(scanCalls).toHaveLength(1);
  });
});

describe("reEmbedNodes（失败诊断与精确扫描）", () => {
  it("扫描查询不再用 SKIP 偏移（过滤集随嵌入进度收缩，累计 offset 会双计数跳过待处理节点），LIMIT 用 toInteger 包装避免驱动序列化为 float 被 Neo4j 拒绝", async () => {
    const driver = mockDriver();
    driver.queueResult([]); // 空批次 → 立即结束
    await reEmbedNodes(
      driver as unknown as Driver,
      undefined,
      50,
      EMBEDDING_MODEL,
      undefined,
      makeBatchEmbedFn(),
    );
    const scan = driver.getAllRunCalls().find((c) => c.query.includes("ORDER BY n.id"));
    expect(scan).toBeDefined();
    expect(scan!.query).not.toContain("SKIP");
    expect(scan!.query).toContain("LIMIT toInteger($limit)");
    // v2.8.x 回归：n.name/n.description/n.content 必须 AS 别名——真实 neo4j-driver 的
    // record key 是限定名 "n.name"，不别名时 rec.get("name") 抛
    // "This record has no field with key 'name'"（gm_reembed 每批退避、0 进展的根因）
    expect(scan!.query).toContain("n.name AS name");
    expect(scan!.query).toContain("n.description AS description");
    expect(scan!.query).toContain("n.content AS content");
  });

  it("查询连续失败 → lastError 记录错误，totalScanned 不再假递增（此前 4 次失败=200 虚高）", async () => {
    const driver = mockDriver();
    // 让 session.run 抛异常（查询失败路径）
    const session = driver.session();
    const originalRun = session.run.bind(session);
    session.run = async () => { throw new Error("Neo4j: Connection terminated"); };

    const result = await reEmbedNodes(
      driver as unknown as Driver,
      undefined,
      50,
      EMBEDDING_MODEL,
      undefined,
      makeBatchEmbedFn(),
    );

    expect(result.failed).toBeGreaterThan(0);
    expect(result.lastError).toContain("Connection terminated");
    // 查询失败不递增 totalScanned（修复假扫描：旧逻辑 4 次失败会显示 totalScanned=200）
    expect(result.totalScanned).toBe(0);
    expect(result.reEmbedded).toBe(0);
    // 恢复原 run 方法避免影响其他测试
    session.run = originalRun;
  });

  it("embedNodeBatch 抛异常 → 回滚到批头重试同一批，不假递增", async () => {
    const driver = mockDriver();
    // 队列：批1 查询返回 1 个节点；embedNodeBatch 抛异常后重试同一 SKIP，
    // 第二次查询命中同一节点（mock 队列后续返回空则提前结束）
    driver.queueResults([
      [{ id: "t1", name: "task-1", description: "d", content: "c" }],
      [], // 重试后第二次查询：节点已嵌入（被条件过滤）→ 空 → 结束
    ]);
    const batchEmbed = vi.fn(async () => { throw new Error("Ollama: 503 server busy"); });

    const result = await reEmbedNodes(
      driver as unknown as Driver,
      undefined,
      50,
      EMBEDDING_MODEL,
      undefined,
      batchEmbed,
    );

    expect(result.lastError).toContain("503");
    expect(result.totalScanned).toBe(0);
    expect(result.reEmbedded).toBe(0);
    // 重试逻辑：第一次查询失败后应再次查询同一 SKIP（共 2 次扫描查询）
    const scanCalls = driver.getAllRunCalls().filter((c) => c.query.includes("ORDER BY n.id"));
    expect(scanCalls.length).toBe(2);
    // 两次查询的 SKIP 相同（回滚到批头）
    expect(scanCalls[0].params.skip).toBe(scanCalls[1].params.skip);
  });

  it("批量嵌入全部失败（返回 null）→ lastError 给出模型/连接诊断提示", async () => {
    const driver = mockDriver();
    driver.queueResult([
      { id: "t1", name: "task-1", description: "d", content: "c" },
      { id: "t2", name: "task-2", description: "d", content: "c" },
    ]);
    const batchEmbed = vi.fn(async () => [null, null]); // 子批次失败被吞 → 全 null

    const result = await reEmbedNodes(
      driver as unknown as Driver,
      undefined,
      50,
      EMBEDDING_MODEL,
      undefined,
      batchEmbed,
    );

    expect(result.reEmbedded).toBe(0);
    expect(result.lastError).toContain("0/2 vectors");
    expect(result.lastError).toContain(EMBEDDING_MODEL);
  });

  it("单条路径节点嵌入失败 → 记录第一条失败错误", async () => {
    const driver = mockDriver();
    driver.queueResult([
      { id: "t1", name: "task-1", description: "d", content: "c" },
      { id: "t2", name: "task-2", description: "d", content: "c" },
    ]);
    const embedFn = vi.fn(async () => { throw new Error("Embedding API 404: model not found"); });

    const result = await reEmbedNodes(
      driver as unknown as Driver,
      embedFn,
      50,
      EMBEDDING_MODEL,
    );

    expect(result.failed).toBe(2);
    expect(result.reEmbedded).toBe(0);
    expect(result.lastError).toContain("404");
  });

  it("maxNodes 配额用尽 → 提前返回 moreRemaining:true，不再扫描后续批次", async () => {
    const driver = mockDriver();
    // 队列：批1 返回 60 个节点（超过 maxNodes=50），批2 不应被扫描
    driver.queueResult(
      Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, name: `name-${i}`, description: "d", content: "c" })),
    );
    const batchEmbed = makeBatchEmbedFn();

    const result = await reEmbedNodes(
      driver as unknown as Driver,
      undefined,
      50,
      EMBEDDING_MODEL,
      undefined,
      batchEmbed,
      undefined,
      50, // maxNodes
    );

    expect(result.moreRemaining).toBe(true);
    expect(result.totalScanned).toBe(60);
    expect(result.reEmbedded).toBe(60);
    // 只发起一轮扫描查询（配额用尽后 break，不发起第二轮）
    const scanCalls = driver.getAllRunCalls().filter((c) => c.query.includes("ORDER BY n.id"));
    expect(scanCalls).toHaveLength(1);
  });

  it("maxNodes 大于总数 → 正常跑完，moreRemaining 为 false", async () => {
    const driver = mockDriver();
    driver.queueResult([
      { id: "t1", name: "task-1", description: "d", content: "c" },
    ]);
    const batchEmbed = makeBatchEmbedFn();

    const result = await reEmbedNodes(
      driver as unknown as Driver,
      undefined,
      50,
      EMBEDDING_MODEL,
      undefined,
      batchEmbed,
      undefined,
      100, // maxNodes 足够大
    );

    expect(result.moreRemaining).toBeFalsy();
    expect(result.reEmbedded).toBe(1);
  });
});

describe("createBatchEmbedFn（v2.8.x 子批次并发限流）", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("并发子批次数 ≤ maxConcurrency，全部文本均返回向量", async () => {
    let active = 0;
    let peak = 0;
    let resolveAll!: () => void;
    const gate = new Promise<void>((r) => { resolveAll = r; });

    globalThis.fetch = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body);
      const n = body.input.length;
      active++;
      peak = Math.max(peak, active);
      await gate; // 阻塞所有在途请求，观察并发峰值
      active--;
      return {
        ok: true,
        status: 200,
        json: async () => ({ embeddings: Array.from({ length: n }, () => [0.1, 0.2, 0.3]) }),
      } as unknown as Response;
    });

    const batchEmbed = createBatchEmbedFn({
      baseURL: "http://localhost:11434",
      model: "test-embed",
      maxConcurrency: 2, // 并发上限 2
    });

    // 100 个文本 → 4 个子批次（32+32+32+4），maxConcurrency=2 下并发峰值应 ≤ 2
    const texts = Array.from({ length: 100 }, (_, i) => `text-${i}`);
    const promise = batchEmbed(texts);

    // 给并发启动留时间，随后放行
    await new Promise((r) => setTimeout(r, 30));
    resolveAll();
    const out = await promise;

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(2); // 确实并行（非串行）
    expect(out).toHaveLength(100);
    expect(out.every((v) => v !== null && v.length === 3)).toBe(true);
  });

  it("batchSize 可配：按自定义批次切分子请求（默认 32 的替代）", async () => {
    const sizes: number[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body);
      sizes.push(body.input.length);
      return {
        ok: true,
        status: 200,
        json: async () => ({ embeddings: body.input.map(() => [0.1, 0.2, 0.3]) }),
      } as unknown as Response;
    });

    // maxConcurrency=1 → 子批次串行发送，切分顺序确定
    const batchEmbed = createBatchEmbedFn({
      baseURL: "http://localhost:11434",
      model: "test-embed",
      maxConcurrency: 1,
      batchSize: 3,
    });

    const out = await batchEmbed(Array.from({ length: 10 }, (_, i) => `t-${i}`));

    expect(out).toHaveLength(10);
    expect(sizes).toEqual([3, 3, 3, 1]); // 10 文本按 batchSize=3 切分
  });

  it("OVMS /v3 baseURL：批量请求走 /v3/embeddings（OpenAI 兼容），解析 data.data[].embedding", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init: any) => {
      urls.push(String(url));
      const body = JSON.parse(init.body);
      expect(body.keep_alive).toBeUndefined(); // 不得携带 Ollama 专有字段
      return {
        ok: true,
        status: 200,
        json: async () => ({
          object: "list",
          data: body.input.map((_: string, i: number) => ({ object: "embedding", index: i, embedding: [0.1, 0.2, 0.3] })),
        }),
      } as unknown as Response;
    });

    const batchEmbed = createBatchEmbedFn({
      baseURL: "http://192.168.50.5:9000/v3",
      model: "Qwen3.5-Embedding-0.6B",
      maxConcurrency: 1,
      batchSize: 2,
    });

    const out = await batchEmbed(["a", "b", "c"]);
    expect(urls.every((u) => u === "http://192.168.50.5:9000/v3/embeddings")).toBe(true);
    expect(out).toHaveLength(3);
    expect(out.every((v) => v !== null && v.length === 3)).toBe(true);
  });
});

// ── 动态批处理（v2.8.x：条数上限 + 总长度阈值） ──────────────
// 背景：此前只按条数装箱，32 条 10 字 vs 32 条 800 字的单请求工作量差数十倍，
// 固定批量超时（120s）时松时紧。maxBatchChars 生效后同时受两个上限约束：
// 累计字符数 + 下一条 > 阈值 → 当前批次封箱，该条转入下一个子批次
// （同一次调用内继续提交，不是推迟到未来轮次）。

describe("createBatchEmbedFn（v2.8.x 动态批处理 / maxBatchChars）", () => {
  const originalFetch = globalThis.fetch;
  // 模块级 embed LRU 缓存按 baseURL|model 共享，跨用例会互相命中导致装箱断言失真
  beforeEach(() => clearEmbedCacheAll());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** 记录每次请求的 [条数, 总字符数] */
  function spyBatchSizes() {
    const batches: Array<{ count: number; chars: number }> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body);
      batches.push({
        count: body.input.length,
        chars: (body.input as string[]).reduce((n, s) => n + s.length, 0),
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ embeddings: body.input.map(() => [0.1, 0.2, 0.3]) }),
      } as unknown as Response;
    });
    return batches;
  }

  it("累计字符超阈值即封箱：批次不再增加，余下转入下一子批次（全部仍在本轮处理）", async () => {
    const batches = spyBatchSizes();
    // 每条 100 字，阈值 250 → 每批最多 2 条（200 字），第 3 条转下一批
    const batchEmbed = createBatchEmbedFn({
      baseURL: "http://localhost:11434",
      model: "test-embed",
      maxConcurrency: 1,
      batchSize: 32,
      maxBatchChars: 250,
    });

    const texts = Array.from({ length: 5 }, (_, i) => String(i).repeat(100));
    const out = await batchEmbed(texts);

    expect(batches.map((b) => b.count)).toEqual([2, 2, 1]);
    expect(batches.map((b) => b.chars)).toEqual([200, 200, 100]);
    // 关键：仍然全部处理完，没有「丢给下一轮」而留 null
    expect(out).toHaveLength(5);
    expect(out.every((v) => v !== null)).toBe(true);
  });

  it("条数上限仍然生效：长度很短时由 batchSize 先触顶", async () => {
    const batches = spyBatchSizes();
    const batchEmbed = createBatchEmbedFn({
      baseURL: "http://localhost:11434",
      model: "test-embed",
      maxConcurrency: 1,
      batchSize: 3,
      maxBatchChars: 100_000, // 阈值远大于实际长度 → 条数先触顶
    });

    const out = await batchEmbed(Array.from({ length: 10 }, (_, i) => `t-${i}`));

    expect(batches.map((b) => b.count)).toEqual([3, 3, 3, 1]);
    expect(out.every((v) => v !== null)).toBe(true);
  });

  it("单条文本自身超阈值：独占一个子批次，不饿死、不死循环", async () => {
    const batches = spyBatchSizes();
    const batchEmbed = createBatchEmbedFn({
      baseURL: "http://localhost:11434",
      model: "test-embed",
      maxConcurrency: 1,
      batchSize: 32,
      maxBatchChars: 50,
    });

    // 一条 500 字（远超阈值）+ 两条 20 字
    const texts = ["x".repeat(500), "y".repeat(20), "z".repeat(20)];
    const out = await batchEmbed(texts);

    expect(batches.map((b) => b.count)).toEqual([1, 2]); // 超长条独占一批，后两条合批
    expect(out).toHaveLength(3);
    expect(out.every((v) => v !== null)).toBe(true);
  });

  it("maxBatchChars 未设置 / 为 0：维持纯条数切分（向后兼容）", async () => {
    for (const cfg of [{}, { maxBatchChars: 0 }, { maxBatchChars: -1 }]) {
      clearEmbedCacheAll(); // 每轮独立，避免上一轮写入的缓存命中导致不发请求
      const batches = spyBatchSizes();
      const batchEmbed = createBatchEmbedFn({
        baseURL: "http://localhost:11434",
        model: "test-embed",
        maxConcurrency: 1,
        batchSize: 4,
        ...cfg,
      });
      await batchEmbed(Array.from({ length: 9 }, () => "x".repeat(300)));
      // 若无长度约束，9 条按 batchSize=4 切分为 [4,4,1]
      expect(batches.map((b) => b.count)).toEqual([4, 4, 1]);
    }
  });

  it("阈值恰等于整批长度时该批可满装（边界不提前封箱）", async () => {
    const batches = spyBatchSizes();
    const batchEmbed = createBatchEmbedFn({
      baseURL: "http://localhost:11434",
      model: "test-embed",
      maxConcurrency: 1,
      batchSize: 32,
      maxBatchChars: 300,
    });

    await batchEmbed(Array.from({ length: 3 }, () => "x".repeat(100)));
    expect(batches.map((b) => b.chars)).toEqual([300]); // 恰好 300 = 阈值，不封箱
  });

  it("结果按原始下标回填：长度混合时顺序不错位", async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body);
      // 用文本长度构造可区分的向量，验证回填下标正确
      return {
        ok: true,
        status: 200,
        json: async () => ({
          embeddings: (body.input as string[]).map((s) => [s.length, s.length + 1]),
        }),
      } as unknown as Response;
    });

    const batchEmbed = createBatchEmbedFn({
      baseURL: "http://localhost:11434",
      model: "test-embed",
      maxConcurrency: 1,
      batchSize: 32,
      maxBatchChars: 150,
    });

    const texts = ["a".repeat(100), "b".repeat(100), "c".repeat(30)];
    const out = await batchEmbed(texts);

    expect(out[0]).toEqual([100, 101]);
    expect(out[1]).toEqual([100, 101]);
    expect(out[2]).toEqual([30, 31]);
  });

  it("命中缓存的文本不占预算：只有未命中项参与装箱", async () => {
    const batches = spyBatchSizes();
    const batchEmbed = createBatchEmbedFn({
      baseURL: "http://localhost:11434",
      model: "test-embed",
      maxConcurrency: 1,
      batchSize: 32,
      maxBatchChars: 200,
    });

    // 首次：3 条 100 字 → 阈值 200 → [2,1]
    const first = Array.from({ length: 3 }, (_, i) => String(i).repeat(100));
    await batchEmbed(first);
    expect(batches.map((b) => b.count)).toEqual([2, 1]);

    batches.length = 0;
    // 二次：同样的文本全部命中缓存 → 不再发请求
    const out2 = await batchEmbed(first);
    expect(batches).toHaveLength(0);
    expect(out2.every((v) => v !== null)).toBe(true);
  });
});

// ── embedNode 分块批量嵌入（v2.8.x） ──────────────────────────
// 背景：chunked 分支此前逐段 await embedFn → N 段 = N 次串行 HTTP，
// 未吃到服务端批处理收益。现优先走 batchEmbedFn 一次批量请求，按原顺序回填成功项。

const CHUNKED_CFG = {
  recall: {
    memorySliceChars: 800,
    chunking: { enabled: true, chunkSize: 400, chunkOverlap: 40 },
  },
};

/** 1205 字符 → chunkSize=400/overlap=40 切分为 4 段 */
function longContent(): string {
  return "x".repeat(1200);
}

describe("embedNode（分块批量嵌入，v2.8.x）", () => {
  it("分块 + batchEmbedFn → 仅一次批量请求，逐段串行 embed 不再调用", async () => {
    const driver = mockDriver();
    const batchEmbed = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);

    const n = await embedNode(
      driver as unknown as Driver,
      embed,
      "n1",
      { name: "甲", description: "d", content: longContent(), embeddingModel: EMBEDDING_MODEL },
      CHUNKED_CFG,
      batchEmbed,
    );

    expect(n).toBe(4);
    expect(batchEmbed).toHaveBeenCalledTimes(1);
    expect(batchEmbed.mock.calls[0][0] as string[]).toHaveLength(4);
    expect(embed).not.toHaveBeenCalled(); // 未走逐段串行路径
    // 分块向量落库（saveChunkVectors）
    const save = driver.getAllRunCalls().find((c) => c.query.includes("n.chunkTexts = $chunkTexts"));
    expect(save).toBeDefined();
    expect(save!.params.chunkVectors).toHaveLength(4);
  });

  it("分块 + 无 batchEmbedFn → 回退逐段串行 embed（保持原行为）", async () => {
    const driver = mockDriver();
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);

    const n = await embedNode(
      driver as unknown as Driver,
      embed,
      "n1",
      { name: "甲", description: "d", content: longContent(), embeddingModel: EMBEDDING_MODEL },
      CHUNKED_CFG,
    );

    expect(n).toBe(4);
    expect(embed).toHaveBeenCalledTimes(4);
  });

  it("分块 + batchEmbedFn 全返回 null → 返回 0，不写库", async () => {
    const driver = mockDriver();
    const batchEmbed = vi.fn(async (texts: string[]) => texts.map(() => null));
    const embed = vi.fn(async () => [0.1]);

    const n = await embedNode(
      driver as unknown as Driver,
      embed,
      "n1",
      { name: "甲", description: "d", content: longContent(), embeddingModel: EMBEDDING_MODEL },
      CHUNKED_CFG,
      batchEmbed,
    );

    expect(n).toBe(0);
    expect(batchEmbed).toHaveBeenCalledTimes(1);
    expect(driver.getAllRunCalls()).toHaveLength(0);
  });

  it("短文本（未触发分块）→ 走单向量路径，不受 batchEmbedFn 影响", async () => {
    const driver = mockDriver();
    const batchEmbed = vi.fn(async (texts: string[]) => texts.map(() => [0.1]));
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);

    const n = await embedNode(
      driver as unknown as Driver,
      embed,
      "n1",
      { name: "甲", description: "d", content: "短内容", embeddingModel: EMBEDDING_MODEL },
      CHUNKED_CFG,
      batchEmbed,
    );

    expect(n).toBe(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(batchEmbed).not.toHaveBeenCalled();
  });
});
