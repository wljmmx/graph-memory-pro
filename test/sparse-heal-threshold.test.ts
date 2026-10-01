/**
 * v2.8.x — `sparseHeal.isolatedRatioThreshold`：孤立节点比例阈值可配
 *
 * 背景（现场）：宿主报错
 *   config.graphHealth.scoring: must not have additional properties: "sparseIsolatedRatioThreshold"
 * 核实发现：该键名不存在，但**概念确实存在且阈值 0.3 是硬编码的** ——
 *   health.ts 的稀疏判定与配套告警都写死 0.3，配置里无法调整。
 *
 * 本文件锁定：
 *   ① 阈值可配且**真的生效**（不是只加了个字段没人读）
 *   ② 默认值保持 0.3（不改变既有行为）
 *   ③ 稀疏判定与配套告警文案使用同一个阈值（不会出现"触发了但告警还写 >30%"）
 *   ④ 配置能一路贯通：GmConfig.sparseHeal → sparsityConfigFrom → runSelfHeal → 评分
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { computeGraphHealthScore, DEFAULT_ISOLATED_RATIO_THRESHOLD } from "../src/graph/maintenance/health.ts";
import { sparsityConfigFrom } from "../src/graph/maintenance/self-heal.ts";

/**
 * 构造图谱统计：active 个节点、isolated 个孤立节点。
 *
 * `computeGraphHealthScore` 只发 3 条查询，且第 1 条按**字段名**取值
 * （activeNodes / inDegreeSum / connectedNodes / avgPageRank / transitionalNodes），
 * 第 2、3 条取 cnt。且实现用 `.toNumber?.() ?? 0`，故必须返回带 toNumber 的 mock 整数
 * —— 直接返回裸 number 会被 `?? 0` 吞成 0（初版 mock 即因此拿到 ratio=0）。
 */
function graphWithIsolatedRatio(active: number, isolated: number) {
  const calls: string[] = [];
  let call = 0;
  const mockInt = (v: number) => ({ toNumber: () => v });
  const session = {
    async run(q: string) {
      calls.push(q);
      call++;
      if (call === 1) {
        const fields: Record<string, { toNumber: () => number }> = {
          activeNodes: mockInt(active),
          inDegreeSum: mockInt(active),               // avgDegree = 1
          connectedNodes: mockInt(active - isolated),
          avgPageRank: mockInt(0),                    // 避免触发 avgPageRank 告警
          transitionalNodes: mockInt(0),
        };
        return { records: [{ get: (k: string) => fields[k] }] };
      }
      // 2 = isolatedNodes，3 = highStaleNodes
      const v = call === 2 ? isolated : 0;
      return { records: [{ get: () => mockInt(v) }] };
    },
    async close() { /* noop */ },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const driver: any = { session: () => session };
  return { driver, calls };
}

describe("computeGraphHealthScore：孤立比例阈值（v2.8.x）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("默认阈值仍是 0.3（不改变既有行为）", async () => {
    expect(DEFAULT_ISOLATED_RATIO_THRESHOLD).toBe(0.3);
    const { driver } = graphWithIsolatedRatio(10, 3); // ratio=0.3，未超阈值
    const r = await computeGraphHealthScore(driver, 0); // 评分为 0 会触发评分路径，故用高阈值隔离
    // ratio=0.3 不 > 0.3 → 不应因比例判稀疏（score=0 < 0 为 false，故 sparse 应为 false）
    expect(r.metrics.isolatedRatio).toBeCloseTo(0.3, 5);
    expect(r.sparse).toBe(false);
  });

  it("调低阈值 → 同样的图被判定为稀疏（阈值真的生效）", async () => {
    const { driver } = graphWithIsolatedRatio(10, 3); // ratio=0.3
    const r = await computeGraphHealthScore(driver, 0, 0.2);
    expect(r.sparse).toBe(true);
  });

  it("调高阈值 → 同样比例不再判稀疏", async () => {
    const { driver } = graphWithIsolatedRatio(10, 5); // ratio=0.5
    const r = await computeGraphHealthScore(driver, 0, 0.8);
    expect(r.sparse).toBe(false);
  });

  it("配套告警文案使用**同一个**阈值（不会写死 >30%）", async () => {
    const { driver } = graphWithIsolatedRatio(10, 5); // ratio=0.5
    const r = await computeGraphHealthScore(driver, 90, 0.2);
    const msg = r.anomalies.find((a) => a.includes("孤立节点比例过高"));
    expect(msg).toBeDefined();
    // 阈值 0.2 → 文案应写 >20%，而不是固定 >30%
    expect(msg).toContain(">20%");
    expect(msg).not.toContain(">30%");
  });

  it("比例未超阈值时不产生该告警", async () => {
    const { driver } = graphWithIsolatedRatio(10, 1); // ratio=0.1
    const r = await computeGraphHealthScore(driver, 90, 0.3);
    expect(r.anomalies.some((a) => a.includes("孤立节点比例过高"))).toBe(false);
  });
});

describe("配置贯通：GmConfig.sparseHeal → SelfHealConfig（v2.8.x）", () => {
  it("isolatedRatioThreshold 被 sparsityConfigFrom 透传", () => {
    const c = sparsityConfigFrom({ sparseHeal: { isolatedRatioThreshold: 0.15, scoreThreshold: 70 } } as never);
    expect(c.isolatedRatioThreshold).toBe(0.15);
    expect(c.scoreThreshold).toBe(70);
  });

  it("未配置时为 undefined，交由 DEFAULT_CFG 的 0.3 兜底", () => {
    const c = sparsityConfigFrom({ sparseHeal: {} } as never);
    expect(c.isolatedRatioThreshold).toBeUndefined();
  });
});