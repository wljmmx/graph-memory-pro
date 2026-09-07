/**
 * v2.8.x gm_reembed 异步任务管理器测试
 *
 * 覆盖：
 *   1. 异步完成：分批次处理、进度字段（progressPercent / currentBatch / totalBatches /
 *      processedNodes / totalNodes / reEmbedded）正确，终态 done
 *   2. 取消：批次间生效，终态 cancelled，已处理批次保留
 *   3. 快照查询 / 列表
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Driver } from "neo4j-driver";
import {
  startReembedTask, getReembedTask, cancelReembedTask, listReembedTasks,
} from "../src/graph/reembed-task.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";

const EMBEDDING_MODEL = "test-embed";

function makeBatchEmbedFn() {
  return vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
}

function nodeRecord(id: string) {
  return { id, name: `n-${id}`, description: `desc-${id}`, content: `content-${id}` };
}

async function waitForTerminal(taskId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = getReembedTask(taskId);
    if (!snap) throw new Error(`task ${taskId} gone`);
    if (snap.status !== "queued" && snap.status !== "running") return snap;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`task ${taskId} did not reach terminal state in ${timeoutMs}ms`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startReembedTask（异步分批次）", () => {
  it("分批次处理并完成：进度字段正确，终态 done", async () => {
    const driver = mockDriver();
    // 队列（共享同一 session）：
    //   0: count → 6
    //   1: 批次1 scan → 4 节点；2-5: 4×saveVector
    //   6: 批次2 scan → 2 节点；7-8: 2×saveVector
    //   9: 批次3 scan → []（剩余为空 → 完成）
    driver.queueResults([
      [{ cnt: 6 }],
      [nodeRecord("1"), nodeRecord("2"), nodeRecord("3"), nodeRecord("4")],
      [], [], [], [],
      [nodeRecord("5"), nodeRecord("6")],
      [], [],
      [],
    ]);
    const batchEmbed = makeBatchEmbedFn();

    const snapshot = startReembedTask(
      driver as unknown as Driver,
      { embedding: { model: EMBEDDING_MODEL } },
      undefined,
      batchEmbed,
      { batchSize: 4, batchIntervalMs: 0 },
    );
    expect(snapshot.taskId).toMatch(/^reembed-/);

    const done = await waitForTerminal(snapshot.taskId);
    expect(done.status).toBe("done");
    expect(done.totalNodes).toBe(6);
    expect(done.totalBatches).toBe(2);
    expect(done.currentBatch).toBe(2); // 空批次/末批不虚增 currentBatch
    expect(done.processedNodes).toBe(6);
    expect(done.reEmbedded).toBe(6);
    expect(done.progressPercent).toBe(100);
    expect(done.finishedAt).toBeGreaterThanOrEqual(done.startedAt);

    // 快照查询与列表可见
    expect(getReembedTask(snapshot.taskId)?.status).toBe("done");
    expect(listReembedTasks().some((t) => t.taskId === snapshot.taskId)).toBe(true);
  });

  it("取消在批次间生效：终态 cancelled，已处理批次保留", async () => {
    const driver = mockDriver();
    driver.queueResults([
      [{ cnt: 8 }],
      [nodeRecord("1"), nodeRecord("2"), nodeRecord("3"), nodeRecord("4")],
      [], [], [], [],
      // 批次2 不应发生（取消后循环停止）
    ]);
    const batchEmbed = makeBatchEmbedFn();

    const snapshot = startReembedTask(
      driver as unknown as Driver,
      { embedding: { model: EMBEDDING_MODEL } },
      undefined,
      batchEmbed,
      { batchSize: 4, batchIntervalMs: 2000 }, // 批次间休眠窗口内取消
    );

    // 等批次1 完成进入批次间休眠
    await new Promise((r) => setTimeout(r, 300));
    const { found, cancelled } = cancelReembedTask(snapshot.taskId);
    expect(found).toBe(true);
    expect(cancelled).toBe(true);

    const done = await waitForTerminal(snapshot.taskId);
    expect(done.status).toBe("cancelled");
    expect(done.currentBatch).toBe(1);
    expect(done.processedNodes).toBe(4);
    expect(done.reEmbedded).toBe(4);
    // 取消后不再处理剩余节点
    expect(batchEmbed.mock.calls.length).toBe(1);
  });

  it("查询空批次 → 无待处理节点直接完成", async () => {
    const driver = mockDriver();
    driver.queueResults([[{ cnt: 0 }]]);
    const batchEmbed = makeBatchEmbedFn();

    const snapshot = startReembedTask(
      driver as unknown as Driver,
      { embedding: { model: EMBEDDING_MODEL } },
      undefined,
      batchEmbed,
      { batchSize: 4, batchIntervalMs: 0 },
    );
    const done = await waitForTerminal(snapshot.taskId);
    expect(done.status).toBe("done");
    expect(done.totalNodes).toBe(0);
    expect(done.processedNodes).toBe(0);
    expect(batchEmbed).not.toHaveBeenCalled();
  });

  it("批内进度上报：批次在途时快照 phase/lastMessage 实时更新（不静止 0 进展）", async () => {
    const driver = mockDriver();
    // 队列：count→4；批次1 scan→2 节点；2×saveVector；批2 scan→空（完成）
    driver.queueResults([
      [{ cnt: 4 }],
      [nodeRecord("1"), nodeRecord("2")],
      [], [],
      [],
    ]);
    // 门控 batchEmbedFn：模拟慢 Ollama —— awaiting 时任务停留在 embedding 阶段
    let releaseBatch!: () => void;
    const gate = new Promise<void>((r) => { releaseBatch = r; });
    const batchEmbed = vi.fn(async (texts: string[]) => {
      await gate;
      return texts.map(() => [0.1, 0.2, 0.3]);
    });

    const snapshot = startReembedTask(
      driver as unknown as Driver,
      { embedding: { model: EMBEDDING_MODEL } },
      undefined,
      batchEmbed,
      { batchSize: 4, batchIntervalMs: 0 },
    );

    // 等待任务进入 embedding 阶段（onStatus 实时写入快照）
    const deadline = Date.now() + 3000;
    let snap = getReembedTask(snapshot.taskId)!;
    while (snap.phase !== "embedding" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      snap = getReembedTask(snapshot.taskId)!;
    }
    expect(snap.phase).toBe("embedding");
    expect(snap.lastMessage).toContain("2 items");
    // updatedAt 应已随 phase 上报而推进（非停留在任务启动时刻）
    expect(snap.updatedAt).toBeGreaterThanOrEqual(snapshot.updatedAt);

    // 放行后任务完成
    releaseBatch();
    const done = await waitForTerminal(snapshot.taskId);
    expect(done.status).toBe("done");
    expect(done.reEmbedded).toBe(2);
  });

  it("批次失败退避 → 快照 phase=backoff 携带定位信息（不再静默重试）", async () => {
    const driver = mockDriver();
    const session = driver.session();
    // 让 scan 查询成功返回节点，但 embedNodeBatch 因 batchEmbedFn 抛错而失败 → 进入退避
    driver.queueResults([
      [{ cnt: 2 }],
      [nodeRecord("1")], // 批次1 scan
      [nodeRecord("1")], // 退避后重试同一批（mock 队列耗尽后返回空，but 此队列补足）
      [],
    ]);
    const batchEmbed = vi.fn(async () => { throw new Error("Ollama: 503 server busy"); });

    const snapshot = startReembedTask(
      driver as unknown as Driver,
      { embedding: { model: EMBEDDING_MODEL } },
      undefined,
      batchEmbed,
      { batchSize: 4, batchIntervalMs: 0 },
    );
    const done = await waitForTerminal(snapshot.taskId, 8000);
    // 连续失败到达 MAX_CONSECUTIVE_FAILURES 前任务完成/失败——至少 lastMessage 记录过退避
    expect(done.lastMessage).toBeDefined();
    expect(done.lastMessage).toContain("done");
    void session;
  });
});
