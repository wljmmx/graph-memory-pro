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
});
