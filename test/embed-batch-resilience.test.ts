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
});