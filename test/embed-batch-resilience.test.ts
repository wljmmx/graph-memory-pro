/**
 * v2.8.x — 批量嵌入的失败韧性（退化重发 + 404 可重试）
 *
 * 现场证据（OVMS 后端，`/v3/embeddings`，模型 `qwen-embedding`）：
 *   - 插件日志：`batch sub-batch failed (8 texts)` +
 *     `error: "Embedding API 404: {"error":"Mediapipe graph definition with requested name is not found"}"`
 *   - 失败是**部分性**的：一次 reEmbed 中 4/8 节点失败，另有节点 4/5 chunks 成功
 *   - 同一 URL/模型 20 并发 curl 全部 200
 *   => 端点与模型名都没配错；是**批量请求**被后端间歇拒绝。
 *
 * 旧行为的两个缺口（本文件的回归目标）：
 *   ① 4xx（非 429）一律不重试 → 瞬时的 404 直接判死，该子批次整批丢失
 *   ② 子批次失败后只有"整批置 null" → 8 个节点直接丢，没有降级路径
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBatchEmbedFn } from "../src/engine/embed.ts";

/**
 * 记录每次请求；handler 按脚本决定状态码。
 *
 * 注意：嵌入缓存是**模块级共享**的（`_embedCacheHandles`，key = baseURL|model），
 * 会跨 client 实例命中。因此每个用例必须用**各自的 baseURL** 隔离，
 * 否则前一个用例缓存下来的向量会让后一个用例根本不发请求（本文件初版即踩此坑）。
 */
function installFetchMock(handler: (body: { input: string[] }) => { status: number; json?: unknown; text?: string }) {
  const calls: { inputs: number; url: string; firstText: string }[] = [];
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    calls.push({ inputs: body.input.length, url: String(url), firstText: body.input[0] });
    const r = handler(body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => (k.toLowerCase() === "server" ? "mock-ovms/1.0" : null) },
      json: async () => r.json ?? {},
      text: async () => r.text ?? "",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", mock);
  // 便于断言"尝试了几「条目」"（而非几次 HTTP 请求）
  const itemsAttempted = () => new Set(calls.filter((c) => c.inputs === 1).map((c) => c.firstText)).size;
  return { calls, itemsAttempted };
}

/** 每个用例唯一的 baseURL —— 绕开模块级共享缓存 */
let caseSeq = 0;
const uniqueBase = () => `http://host-${++caseSeq}:11412/v3`;

const OVMS_404 = {
  status: 404,
  text: '{"error":"Mediapipe graph definition with requested name is not found"}',
};

const okVec = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [0.1, 0.2] })) });

describe("批量嵌入失败韧性（v2.8.x）", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("子批次失败 → 自动逐条重发并能救回（批量被拒但单条可用）", async () => {
    let sawBatch = false;
    const { calls } = installFetchMock((body) => {
      // 批量（>1 条）一律 404；单条成功 —— 精确复刻 OVMS 现象
      if (body.input.length > 1) {
        sawBatch = true;
        return OVMS_404;
      }
      return { status: 200, json: okVec(body.input.length) };
    });

    const batchEmbed = createBatchEmbedFn({
      baseURL: uniqueBase(),
      model: "qwen-embedding",
      batchSize: 4,
    } as never);

    const out = await batchEmbed(["a", "b", "c", "d"]);

    // 旧行为：4 个全 null。新行为：逐条降级后全部拿到向量
    expect(out.every((v) => Array.isArray(v) && v.length === 2)).toBe(true);
    expect(sawBatch).toBe(true);
    // 至少发生过一次批量请求 + 若干单条请求
    expect(calls.some((c) => c.inputs > 1)).toBe(true);
    expect(calls.some((c) => c.inputs === 1)).toBe(true);
  });

  it("系统性故障时短路：连续 2 条单发失败即放弃，不放大成请求风暴", async () => {
    const { itemsAttempted } = installFetchMock(() => OVMS_404);

    const batchEmbed = createBatchEmbedFn({
      baseURL: uniqueBase(),
      model: "wrong-model",
      batchSize: 8,
    } as never);

    const out = await batchEmbed(["a", "b", "c", "d", "e", "f", "g", "h"]);

    expect(out.every((v) => v === null)).toBe(true);
    // 短路按「条目」计：连续 2 条单发失败即停 → 至多试探 2 个不同条目
    // （注意不能按 HTTP 请求数断言：404 每条还会各自重试 1 次）
    expect(itemsAttempted()).toBeLessThanOrEqual(2);
    // 关键：不应把 8 个条目全部单发试探（那就是请求风暴）
    expect(itemsAttempted()).toBeLessThan(8);
  });

  it("404 允许重试一次（瞬时资源问题可自愈），非 404 的 4xx 仍立即失败", async () => {
    // 第 1 次 404、第 2 次成功 → 应自动恢复（证明 404 被重试）
    let n = 0;
    const { calls } = installFetchMock(() => {
      n++;
      return n === 1 ? OVMS_404 : { status: 200, json: { data: [{ index: 0, embedding: [1, 2] }] } };
    });

    const batchEmbed = createBatchEmbedFn({
      baseURL: uniqueBase(),
      model: "qwen-embedding",
      batchSize: 1,
    } as never);

    const out = await batchEmbed(["only"]);
    expect(out[0]).toEqual([1, 2]);
    expect(calls.length).toBe(2);
  });

  it("400（真正的客户端错误）不重试 —— 不浪费退避预算", async () => {
    const { calls } = installFetchMock(() => ({
      status: 400,
      text: '{"error":"invalid input type"}',
    }));

    const batchEmbed = createBatchEmbedFn({
      baseURL: uniqueBase(), // 必须独立：否则会命中模块级嵌入缓存，根本发不出请求
      model: "qwen-embedding",
      batchSize: 1,
    } as never);

    const out = await batchEmbed(["only"]);
    expect(out[0]).toBeNull();
    // batchSize=1 → 不触发逐条降级；400 不重试 → 恰好 1 次请求
    expect(calls.length).toBe(1);
  });

  it("响应对象缺少 headers 时，诊断块不得破坏状态码分类（400 仍只发 1 次）", async () => {
    // 回归守卫：诊断块若抛错会被外层 catch 吞掉，使错误消息不再含 `Embedding API NNN`
    // → status 解析为 0 → 真正的 4xx 被重试到底（曾实际发生：1 次变 4 次）
    const calls: number[] = [];
    const mock = vi.fn(async () => {
      calls.push(1);
      return {
        ok: false,
        status: 400,
        // 故意不给 headers
        json: async () => ({}),
        text: async () => '{"error":"invalid input type"}',
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", mock);

    const batchEmbed = createBatchEmbedFn({
      baseURL: uniqueBase(),
      model: "qwen-embedding",
      batchSize: 1,
    } as never);

    const out = await batchEmbed(["only"]);
    expect(out[0]).toBeNull();
    expect(calls.length).toBe(1);
  });
});

/**
 * v2.8.x — 发送节奏（pacing）
 *
 * 回答的问题：n 个子批次是**带间隔**发送，还是**一次性全部排队发起**？
 *   → 后者：`Promise.all` 把全部子批次一次性排队，信号量只限制「同时在飞 ≤ maxConcurrency」，
 *     释放许可后下一个**立即补位**，正常路径**零间隔**。
 *
 * 现场证据（OVMS）表明触发点是这种「背靠背连续请求流」，而非并发上限：
 * 插件并发仅 2 却失败，而手动 8~16 并发压测全部成功、加间隔后不再报错。
 */
describe("嵌入请求发送节奏（v2.8.x）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("默认（requestIntervalMs 未设置）→ 零间隔连发，子批次同一波次全部发出", async () => {
    const t0 = Date.now();
    const times: number[] = [];
    installFetchMock(() => {
      times.push(Date.now() - t0);
      return { status: 200, json: okVec(1) };
    });

    const batchEmbed = createBatchEmbedFn({
      baseURL: uniqueBase(),
      model: "qwen-embedding",
      batchSize: 1,        // 8 条 → 8 个子批次
      maxConcurrency: 8,   // 放开并发，观察是否一次性全发
    } as never);

    await batchEmbed(Array.from({ length: 8 }, (_, i) => `t${i}`));

    expect(times.length).toBe(8);
    // 全部几乎同时发出（同一波次）——间隔远小于任何人为节流
    expect(Math.max(...times) - Math.min(...times)).toBeLessThan(50);
  });

  it("设置 requestIntervalMs → 相邻发送被拉开到设定的最小间隔", async () => {
    const t0 = Date.now();
    const times: number[] = [];
    installFetchMock(() => {
      times.push(Date.now() - t0);
      return { status: 200, json: okVec(1) };
    });

    const batchEmbed = createBatchEmbedFn({
      baseURL: uniqueBase(),
      model: "qwen-embedding",
      batchSize: 1,
      maxConcurrency: 4,
      requestIntervalMs: 60,
    } as never);

    await batchEmbed(Array.from({ length: 4 }, (_, i) => `t${i}`));

    expect(times.length).toBe(4);
    const sorted = [...times].sort((a, b) => a - b);
    // 第 1 次立即发送，之后每两次之间 ≥ 约 intervalMs（留出调度容差）
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(45);
    }
    // 总跨度应接近 3 × 60ms
    expect(sorted[sorted.length - 1] - sorted[0]).toBeGreaterThanOrEqual(150);
  });

  it("requestIntervalMs: 0 / 负数 / 非有限值 → 不引入任何延迟（保持原行为）", async () => {
    for (const v of [0, -5, NaN, Infinity]) {
      const t0 = Date.now();
      const times: number[] = [];
      installFetchMock(() => {
        times.push(Date.now() - t0);
        return { status: 200, json: okVec(1) };
      });
      const batchEmbed = createBatchEmbedFn({
        baseURL: uniqueBase(),
        model: "qwen-embedding",
        batchSize: 1,
        maxConcurrency: 4,
        requestIntervalMs: v,
      } as never);
      await batchEmbed(["a", "b", "c", "d"]);
      expect(times.length).toBe(4);
      expect(Math.max(...times) - Math.min(...times)).toBeLessThan(50);
    }
  });
});