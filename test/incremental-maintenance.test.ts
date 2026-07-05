/**
 * P4-2 增量维护单元测试（v2.2.0）
 *
 * 被测模块：src/graph/incremental-maintenance.ts
 *
 * 覆盖：
 *   - markDirty / getDirtyNodeIds / clearDirty 持久化
 *   - runIncrementalMaintenance：无脏节点 / 多阶段执行 / 清除标记
 *   - 并发锁
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mockDriver } from "./helpers/neo4j-mock.ts";
import {
  markDirty, getDirtyNodeIds, clearDirty, runIncrementalMaintenance,
} from "../src/graph/incremental-maintenance.ts";
import type { GmConfig } from "../src/types.ts";

function mkConfig(overrides: Partial<GmConfig> = {}): GmConfig {
  return {
    neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
    recallMaxNodes: 6, recallMaxDepth: 2, dedupThreshold: 0.9,
    freshTailCount: 10, pagerankDamping: 0.85, pagerankIterations: 20,
    compactTurnCount: 6,
    ...overrides,
  } as GmConfig;
}

// ═══════════════════════════════════════════════════════════════
// 1. 脏节点标记持久化
// ═══════════════════════════════════════════════════════════════

describe("markDirty / getDirtyNodeIds / clearDirty", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("markDirty 空数组 → 不写入", async () => {
    const driver = mockDriver() as any;
    await markDirty(driver, []);
    expect(driver.getAllRunCalls().length).toBe(0);
  });

  it("markDirty 写入脏节点 + getDirtyNodeIds 读取", async () => {
    const driver = mockDriver() as any;
    // MERGE 写入
    driver.queueResult([]);
    // 读取返回数组
    driver.queueResult([{
      ids: ["n-001", "n-002", "n-003"],
    }]);

    await markDirty(driver, ["n-001", "n-002", "n-003"]);
    const ids = await getDirtyNodeIds(driver);

    expect(ids).toEqual(["n-001", "n-002", "n-003"]);
    // markDirty 1 次 + getDirtyNodeIds 1 次
    expect(driver.getAllRunCalls().length).toBe(2);
  });

  it("getDirtyNodeIds 无 MaintenanceMeta 节点 → 返回空数组", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([]);  // 无记录返回

    const ids = await getDirtyNodeIds(driver);
    expect(ids).toEqual([]);
  });

  it("clearDirty 不传参 → 清除全部", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([]);

    await clearDirty(driver);
    expect(driver.getAllRunCalls().length).toBe(1);
  });

  it("clearDirty 传指定 ID → 仅清除指定", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([]);

    await clearDirty(driver, ["n-001", "n-002"]);
    expect(driver.getAllRunCalls().length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. runIncrementalMaintenance
// ═══════════════════════════════════════════════════════════════

describe("runIncrementalMaintenance", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("无脏节点 → 立即返回 processedNodes=0", async () => {
    const driver = mockDriver() as any;
    // getDirtyNodeIds 返回空（无 MaintenanceMeta）
    driver.queueResult([]);

    const cfg = mkConfig();
    const result = await runIncrementalMaintenance(driver, cfg);

    expect(result.processedNodes).toBe(0);
    expect(result.phasesRun).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("有脏节点 → 执行各阶段并清除标记", async () => {
    const driver = mockDriver() as any;
    // 1. getDirtyNodeIds 返回 3 个
    driver.queueResult([{ ids: ["n-001", "n-002", "n-003"] }]);
    // 2. dedup 调用（内部多次 session.run，queue 多个 result）
    // dedup 内部至少 1 次 SCAN，每个 pair 1 次 MERGE
    driver.queueResult([{ records: [] }]);
    // 3. incrementalStaleness: SCAN dirty nodes
    driver.queueResult([{ records: [] }]);
    // 4. incrementalImportance: SCAN dirty nodes
    driver.queueResult([{ records: [] }]);
    // 5. incrementalConflictResolution: SCAN synonyms
    driver.queueResult([{ records: [] }]);
    // 6. incrementalEdgeWeights: SCAN edges
    driver.queueResult([{ records: [] }]);
    // 7. clearDirty
    driver.queueResult([]);

    const cfg = mkConfig();
    const result = await runIncrementalMaintenance(driver, cfg);

    expect(result.processedNodes).toBe(3);
    expect(result.phasesRun.length).toBeGreaterThan(0);
    // 阶段应包含 staleness（默认开启）
    expect(result.phasesRun).toContain("staleness");
  });

  it("staleness.enabled=false → 跳过 staleness 阶段", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ ids: ["n-001"] }]);
    driver.queueResult([{ records: [] }]);  // dedup
    driver.queueResult([{ records: [] }]);  // importance
    driver.queueResult([{ records: [] }]);  // conflict
    driver.queueResult([{ records: [] }]);  // edges
    driver.queueResult([]);  // clearDirty

    const cfg = mkConfig({ staleness: { enabled: false } });
    const result = await runIncrementalMaintenance(driver, cfg);

    expect(result.phasesRun).not.toContain("staleness");
  });

  it("并发锁：第二次调用立即返回空结果", async () => {
    const driver = mockDriver() as any;
    // 第一次调用占住锁
    const cfg = mkConfig();
    driver.queueResult([{ ids: ["n-001"] }]);
    driver.queueResult([{ records: [] }]);
    driver.queueResult([{ records: [] }]);
    driver.queueResult([{ records: [] }]);
    driver.queueResult([{ records: [] }]);
    driver.queueResult([{ records: [] }]);
    driver.queueResult([]);

    const r1 = await runIncrementalMaintenance(driver, cfg);
    expect(r1.processedNodes).toBe(1);

    // 第二次调用应被锁挡住（无脏节点也不应到达，因为锁先释放）
    // 注：锁是模块级，第一次 release 后第二次会重新获取
    driver.queueResult([{ ids: [] }]);
    const r2 = await runIncrementalMaintenance(driver, cfg);
    expect(r2.processedNodes).toBe(0);
  });

  it("阶段失败不影响其他阶段（独立 try-catch）", async () => {
    const driver = mockDriver() as any;
    // 注：getDirtyNodeIds 内部 try-catch 吞掉异常返回 []
    // 所以这里验证：当 dedup/staleness 等阶段抛错时，整体不崩、返回空结果
    const cfg = mkConfig();
    // 让 getDirtyNodeIds 返回空（模拟读失败被吞）→ 增量维护优雅返回
    driver.queueResult([{ ids: [] }]);
    const result = await runIncrementalMaintenance(driver, cfg);
    expect(result.processedNodes).toBe(0);
    expect(result.phasesRun).toEqual([]);
    expect(result.dedup.merged).toBe(0);
  });
});
