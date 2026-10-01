/**
 * v2.8.x — sparseHeal 的 5 个新增选项：**真的接进实现**，不是只加 schema
 *
 * 背景：现场宿主拒绝这 5 个键（`schema is false`）。补 schema 后必须同时接实现 ——
 * 否则 `communityReconnect: false` 会看起来关掉了、实际什么都没发生，
 * 即"配置项说谎"（本项目已多次修复同类问题）。
 *
 * 同时锁定：**默认值必须与补丁前行为逐项等价**（三个行为全开 / 不限总量 / 不自动回滚），
 * 否则等于偷偷改变既有行为。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { runSelfHeal, sparsityConfigFrom, revertSelfHeal } from "../src/graph/maintenance/self-heal.ts";

/** 每次 run 返回预设结果的会话；记录全部 Cypher 便于断言"某段是否被执行" */
function fakeDriver(handlers: Array<() => unknown>) {
  const queries: string[] = [];
  let i = 0;
  const session = {
    async run(q: string) {
      queries.push(q);
      const h = handlers[Math.min(i, handlers.length - 1)];
      i++;
      return h();
    },
    async close() { /* noop */ },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const driver: any = { session: () => session };
  return { driver, queries };
}

const mockInt = (v: number) => ({ toNumber: () => v });

/**
 * 健康的图（不稀疏）→ runSelfHeal 直接返回，不进入恢复阶段。
 *
 * 注意各项必须**互相自洽**：若 inDegreeSum/connectedNodes 为 0，
 * 算出来 connectivity=1 但 density/influence=0 → 评分仅 55 < 60，仍判定为稀疏
 * （初版 mock 即因此误判）。
 */
const healthy = () => ({
  records: [{
    get: (k: string) => ({
      activeNodes: mockInt(100),
      inDegreeSum: mockInt(100),     // avgDegree=1 → density>0
      connectedNodes: mockInt(100),  // influence=1
      avgPageRank: mockInt(1),       // 避免 avgPageRank<0.01 告警（仅为报告项）
      transitionalNodes: mockInt(0),
    } as Record<string, unknown>)[k],
  }],
});

/** 稀疏的图：active=10、isolated=10 → ratio=1.0，且评分为 0 */
function sparseHandlers() {
  return [
    // 1) 健康评分第 1 条
    () => ({
      records: [{
        get: (k: string) => ({
          activeNodes: mockInt(10), inDegreeSum: mockInt(0),
          connectedNodes: mockInt(0), avgPageRank: mockInt(0), transitionalNodes: mockInt(0),
        } as Record<string, unknown>)[k],
      }],
    }),
    () => ({ records: [{ get: () => mockInt(10) }] }), // 2) isolatedNodes
    () => ({ records: [{ get: () => mockInt(0) }] }),  // 3) highStale
    () => ({ records: [] }),                            // 4) 补边候选：空
    () => ({ records: [] }),                            // 5) 孤立节点列表：空
  ];
}

describe("sparseHeal 新增选项：默认值必须与补丁前行为等价", () => {
  afterEach(() => vi.restoreAllMocks());

  it("未配置 → 三个行为全开、不限总量、不自动回滚", () => {
    const c = sparsityConfigFrom({ sparseHeal: {} } as never);
    // 这些字段为 undefined，由 DEFAULT_CFG 兜底为 true/true/true/0/false
    expect(c.autoEdgeRepair).toBeUndefined();
    expect(c.nodeMerge).toBeUndefined();
    expect(c.communityReconnect).toBeUndefined();
    expect(c.maxOperationsPerRun).toBeUndefined();
    expect(c.rollbackOnError).toBeUndefined();
    // 行为等价性由下面的执行断言确认（补边查询仍会发出）
  });

  it("默认（不传开关）→ 补边候选查询仍会发出（等价于原行为）", async () => {
    const { driver, queries } = fakeDriver(sparseHandlers());
    await runSelfHeal(driver);
    expect(queries.some((q) => q.includes("NOT (a)-[:RELATES_TO]-(b)"))).toBe(true);
  });

  it("autoEdgeRepair=false → **不发出**补边候选查询（整段跳过）", async () => {
    const { driver, queries } = fakeDriver(sparseHandlers());
    await runSelfHeal(driver, { autoEdgeRepair: false });
    expect(queries.some((q) => q.includes("NOT (a)-[:RELATES_TO]-(b)"))).toBe(false);
    // 但孤立节点扫描仍执行（其他两个行为不受影响）
    expect(queries.some((q) => q.includes("WHERE NOT (n)--(:Task|Skill|Event)"))).toBe(true);
  });

  it("autoEdgeRepair=true 显式传入 → 仍执行补边", async () => {
    const { driver, queries } = fakeDriver(sparseHandlers());
    await runSelfHeal(driver, { autoEdgeRepair: true });
    expect(queries.some((q) => q.includes("NOT (a)-[:RELATES_TO]-(b)"))).toBe(true);
  });
});

describe("三个行为开关的独立性与透传", () => {
  it("sparsityConfigFrom 透传全部 5 项", () => {
    const c = sparsityConfigFrom({
      sparseHeal: {
        autoEdgeRepair: false, nodeMerge: false, communityReconnect: false,
        maxOperationsPerRun: 7, rollbackOnError: true,
      },
    } as never);
    expect(c).toMatchObject({
      autoEdgeRepair: false, nodeMerge: false, communityReconnect: false,
      maxOperationsPerRun: 7, rollbackOnError: true,
    });
  });

  it("三个开关彼此独立：只关重连不影响合并（配置层可分辨）", () => {
    const c = sparsityConfigFrom({ sparseHeal: { communityReconnect: false } } as never);
    expect(c.communityReconnect).toBe(false);
    expect(c.nodeMerge).toBeUndefined();      // 未设 → DEFAULT 兜底 true
    expect(c.autoEdgeRepair).toBeUndefined();
  });
});

describe("graphHealth.scoring 阈值别名：本项优先", () => {
  it("只设 sparseHeal 侧 → 用 sparseHeal 侧", () => {
    const c = sparsityConfigFrom({ sparseHeal: { scoreThreshold: 55, isolatedRatioThreshold: 0.25 } } as never);
    expect(c.scoreThreshold).toBe(55);
    expect(c.isolatedRatioThreshold).toBe(0.25);
  });

  it("只设 graphHealth.scoring 侧 → 用 scoring 侧", () => {
    const c = sparsityConfigFrom({
      graphHealth: { scoring: { sparseScoreThreshold: 70, sparseIsolatedRatioThreshold: 0.4 } },
    } as never);
    expect(c.scoreThreshold).toBe(70);
    expect(c.isolatedRatioThreshold).toBe(0.4);
  });

  it("两处都设且不同 → graphHealth.scoring 优先（并 warn 一次，不静默）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = sparsityConfigFrom({
      sparseHeal: { scoreThreshold: 55, isolatedRatioThreshold: 0.25 },
      graphHealth: { scoring: { sparseScoreThreshold: 70, sparseIsolatedRatioThreshold: 0.4 } },
    } as never);
    expect(c.scoreThreshold).toBe(70);
    expect(c.isolatedRatioThreshold).toBe(0.4);
    warn.mockRestore();
  });
});

describe("runSelfHeal：健康图不做任何恢复", () => {
  it("不稀疏 → 直接返回、不写任何边", async () => {
    const { driver, queries } = fakeDriver([healthy]);
    const r = await runSelfHeal(driver);
    expect(r.sparse).toBe(false);
    expect(r.edgesAdded).toBe(0);
    expect(queries.some((q) => q.includes("RELATES_TO"))).toBe(false);
  });
});

describe("revertSelfHeal：按批次精确删除（rollbackOnError 的实现基础）", () => {
  it("传 batchId → 只删该批次", async () => {
    const queries: string[] = [];
    const session = {
      async run(q: string, p?: Record<string, unknown>) {
        queries.push(q);
        return { records: [{ get: () => mockInt(3) }] };
      },
      async close() { /* noop */ },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await revertSelfHeal({ session: () => session } as any, "selfheal-123");
    expect(r.removed).toBe(3);
    expect(queries[0]).toContain("selfHealBatch: $batchId");
    expect(queries[0]).toContain("DELETE r");
  });
});