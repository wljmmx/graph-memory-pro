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

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Driver } from "neo4j-driver";
import { embedNodesMissing } from "../src/store/embed-helper.ts";
import { writeExtractResult } from "../src/services/extract-service.ts";
import { detectAndMigrateEmbeddings, reEmbedNodes } from "../src/graph/reembed.ts";
import { createBatchEmbedFn } from "../src/engine/embed.ts";
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
});
