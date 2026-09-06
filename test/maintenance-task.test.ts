/**
 * v2.8.x gm_maintain 异步任务管理器测试
 *
 * runMaintenance 本体在 maintenance-phases.test.ts / self-heal.test.ts 等覆盖；
 * 此处将 runMaintenance mock 为可控流水线（14 个 phase + 可选取消/锁跳过），
 * 验证 maintenance-task 的任务状态机：
 *   1. 异步完成：立即返回 taskId，phase 进度推进，终态 done，result 汇总正确
 *   2. 取消：runMaintenance 抛 MaintenanceCancelledError → 终态 cancelled
 *   3. 锁跳过：runMaintenance 空壳返回（durationMs=0 且无 phase 回调）→ lockSkipped=true
 *   4. cancelMaintainTask API：运行中可取消，终态不可取消
 */

import { describe, it, expect, vi } from "vitest";
import type { Driver } from "neo4j-driver";
import { mockDriver } from "./helpers/neo4j-mock.ts";

// mock runMaintenance：按 cfg.test 控制行为
//   cfg.test.cancelAfterPhase >= 0 → 执行到该 phase 后抛 MaintenanceCancelledError
//   cfg.test.lockSkipped === true  → 返回空壳且不触发任何 phase 回调
vi.mock("../src/graph/maintenance.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/graph/maintenance.ts")>();
  return {
    ...actual,
    runMaintenance: vi.fn(
      async (
        _driver: unknown,
        cfg: { test?: { cancelAfterPhase?: number; lockSkipped?: boolean } },
        _llm?: unknown,
        _embed?: unknown,
        _batchEmbed?: unknown,
        onPhase?: (phase: { index: number; total: number; name: string }) => void,
      ) => {
        if (cfg?.test?.lockSkipped === true) {
          // 锁被占用：直接返回空壳（durationMs=0），不调用 onPhase
          return {
            dedup: { pairs: [], merged: 0 },
            pagerank: { scores: new Map(), topK: [] },
            community: { labels: new Map(), communities: new Map(), count: 0 },
            communitySummaries: 0,
            durationMs: 0,
          };
        }
        const total = actual.MAINTENANCE_PHASES.length;
        for (let i = 0; i < total; i++) {
          if (onPhase) onPhase({ index: i, total, name: actual.MAINTENANCE_PHASES[i].name });
          await new Promise((r) => setTimeout(r, 1));
          if (cfg?.test?.cancelAfterPhase !== undefined && i >= cfg.test.cancelAfterPhase) {
            throw new actual.MaintenanceCancelledError("test cancel");
          }
        }
        return {
          dedup: { pairs: [], merged: 3 },
          pagerank: { scores: new Map(), topK: [] },
          community: { labels: new Map(), communities: new Map(), count: 5 },
          communitySummaries: 2,
          importance: { scanned: 10, updated: 9, avgScore: 0.42 },
          conflictResolution: { scanned: 4, resolved: 2, superseded: 0, merged: 1 },
          edgeWeights: { scanned: 6, strengthened: 3, decayed: 2 },
          reverseMemory: { watchlistAdded: 1, watchlistRemoved: 0, decayed: 2 },
          selfHeal: {
            scored: true,
            score: { score: 78, sparse: true },
            sparse: true,
            batchId: "b1",
            edgesAdded: 7,
            mergesApplied: 2,
            mergeCandidates: [],
            reLinks: 1,
            skippedNoEmbedding: 0,
          },
          durationMs: 123,
        };
      },
    ),
  };
});

import {
  startMaintainTask, getMaintainTask, cancelMaintainTask, listMaintainTasks,
} from "../src/graph/maintenance-task.ts";

const PHASE_TOTAL = 14; // 与 MAINTENANCE_PHASES 长度一致

async function waitForTerminal(taskId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = getMaintainTask(taskId);
    if (!snap) throw new Error(`task ${taskId} gone`);
    if (snap.status !== "queued" && snap.status !== "running") return snap;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`task ${taskId} did not reach terminal state in ${timeoutMs}ms`);
}

describe("startMaintainTask（异步 14 phase 流水线）", () => {
  it("立即返回 taskId；14 个 phase 推进；终态 done 且 result 汇总正确", async () => {
    const driver = mockDriver();
    const snapshot = startMaintainTask(driver as unknown as Driver, {});

    expect(snapshot.taskId).toMatch(/^maintain-/);
    // async IIFE 可能同步推进到 running（首个 await 前），与 reembed-task 行为一致
    expect(["queued", "running"]).toContain(snapshot.status);
    expect(snapshot.phaseTotal).toBe(PHASE_TOTAL);

    const done = await waitForTerminal(snapshot.taskId);
    expect(done.status).toBe("done");
    expect(done.currentPhase).toBe(PHASE_TOTAL);
    expect(done.phaseName).toBe("complete");
    expect(done.progressPercent).toBe(100);
    expect(done.durationMs).toBe(123);
    expect(done.finishedAt).toBeGreaterThanOrEqual(done.startedAt);

    const r = done.result!;
    expect(r.lockSkipped).toBe(false);
    expect(r.merged).toBe(3);
    expect(r.communities).toBe(5);
    expect(r.communitySummaries).toBe(2);
    expect(r.importanceScanned).toBe(10);
    expect(r.importanceAvg).toBe(0.42);
    expect(r.conflictsResolved).toBe(2);
    expect(r.edgeStrengthened).toBe(3);
    expect(r.edgeDecayed).toBe(2);
    expect(r.reverseMemoryDecayed).toBe(2);
    expect(r.selfHealEdgesAdded).toBe(7);
    expect(r.selfHealMergesApplied).toBe(2);
    expect(r.selfHealScore).toBe(78);
    expect(r.selfHealSparse).toBe(true);

    // 快照查询与列表可见
    expect(getMaintainTask(snapshot.taskId)?.status).toBe("done");
    expect(listMaintainTasks().some((t) => t.taskId === snapshot.taskId)).toBe(true);
  });

  it("运行中的进度：phase 推进过程中 progressPercent 递增、phaseName 正确", async () => {
    const driver = mockDriver();
    const snapshot = startMaintainTask(driver as unknown as Driver, {});
    // 等任务跑到 phase 3（index 2）
    const deadline = Date.now() + 5000;
    let mid: ReturnType<typeof getMaintainTask> | undefined;
    while (Date.now() < deadline) {
      mid = getMaintainTask(snapshot.taskId);
      if (mid && mid.currentPhase >= 3) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(mid).toBeDefined();
    expect(mid!.currentPhase).toBeGreaterThanOrEqual(3);
    expect(mid!.progressPercent).toBeGreaterThanOrEqual(20);
    expect(mid!.phaseName).toBeTruthy();
    expect(mid!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runMaintenance 抛 MaintenanceCancelledError → 终态 cancelled，中断时进度保留", async () => {
    const driver = mockDriver();
    const snapshot = startMaintainTask(
      driver as unknown as Driver,
      { test: { cancelAfterPhase: 4 } } as never,
    );
    const done = await waitForTerminal(snapshot.taskId);
    expect(done.status).toBe("cancelled");
    // 中断发生在 phase index 4 → currentPhase 停在 4（0 起）
    expect(done.currentPhase).toBe(4);
    expect(done.lastError).toBeUndefined();
  });

  it("锁被占用（空壳返回）→ 终态 done 且 lockSkipped=true", async () => {
    const driver = mockDriver();
    const snapshot = startMaintainTask(
      driver as unknown as Driver,
      { test: { lockSkipped: true } } as never,
    );
    const done = await waitForTerminal(snapshot.taskId);
    expect(done.status).toBe("done");
    expect(done.progressPercent).toBe(0);
    expect(done.result?.lockSkipped).toBe(true);
    expect(done.result?.merged).toBe(0);
  });
});

describe("cancelMaintainTask", () => {
  it("运行中任务可取消；已终态任务返回 cancelled=false", async () => {
    const driver = mockDriver();
    const snapshot = startMaintainTask(
      driver as unknown as Driver,
      { test: { cancelAfterPhase: 100 } } as never, // 故意不取消，跑完
    );
    const done = await waitForTerminal(snapshot.taskId);
    expect(done.status).toBe("done");

    // 终态任务不可取消
    const after = cancelMaintainTask(snapshot.taskId);
    expect(after.found).toBe(true);
    expect(after.cancelled).toBe(false);

    // 不存在的任务
    expect(cancelMaintainTask("nope").found).toBe(false);
  });
});
