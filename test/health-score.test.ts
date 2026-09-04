import { describe, it, expect } from "vitest";
import { computeGraphHealthScore, persistGraphHealthMetric } from "../src/graph/maintenance/health.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";

describe("computeGraphHealthScore (v2.6.0)", () => {
  it("健康图 → 高分（>80）且 sparse=false", async () => {
    const driver = mockDriver() as any;
    // call1: 统计（active=100, 入边=400, connected=90, avgPR=0.05, transitional=0）
    driver.queueResult([{ activeNodes: 100, inDegreeSum: 400, connectedNodes: 90, avgPageRank: 0.05, transitionalNodes: 0 }]);
    // call2: 孤立节点 = 10
    driver.queueResult([{ cnt: 10 }]);
    // call3: 高过时 = 5
    driver.queueResult([{ cnt: 5 }]);

    const score = await computeGraphHealthScore(driver, 60);

    expect(score.score).toBeGreaterThan(80);
    expect(score.sparse).toBe(false);
    expect(score.dims.connectivity).toBeCloseTo(0.9, 5);
    expect(score.metrics.activeNodes).toBe(100);
  });

  it("全孤立空连图 → 低分且 sparse=true、anomalies 非空", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ activeNodes: 50, inDegreeSum: 0, connectedNodes: 0, avgPageRank: 0, transitionalNodes: 0 }]);
    driver.queueResult([{ cnt: 49 }]); // 孤立 49/50
    driver.queueResult([{ cnt: 0 }]);

    const score = await computeGraphHealthScore(driver, 60);

    expect(score.score).toBeLessThan(40);
    expect(score.sparse).toBe(true);
    expect(score.dims.density).toBe(0);
    expect(score.anomalies.length).toBeGreaterThan(0);
  });

  it("空图 → score=0、sparse 无明显异常、不 NaN", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ activeNodes: 0, inDegreeSum: 0, connectedNodes: 0, avgPageRank: null, transitionalNodes: 0 }]);
    driver.queueResult([{ cnt: 0 }]);
    driver.queueResult([{ cnt: 0 }]);

    const score = await computeGraphHealthScore(driver, 60);

    expect(Number.isNaN(score.score)).toBe(false);
    expect(score.score).toBe(0);
    expect(score.sparse).toBe(true); // score 0 < 60
  });
});

describe("persistGraphHealthMetric (v2.6.0)", () => {
  it("写入 CREATE + 修剪 DELETE 两条 Cypher", async () => {
    const driver = mockDriver() as any;
    await persistGraphHealthMetric(driver, {
      timestamp: 1, score: 72,
      dims: { connectivity: 0.9, density: 0.5, influence: 0.8, freshness: 0.9, conflictFree: 1 },
      metrics: { activeNodes: 100, totalEdges: 400, isolatedNodes: 10, isolatedRatio: 0.1, avgDegree: 4, avgPageRank: 0.05, highStaleRatio: 0.05, transitionalRatio: 0 },
      sparse: false, anomalies: [],
    }, 200);

    const calls = driver.getAllRunCalls();
    expect(calls.length).toBe(2);
    expect(calls[0].query).toContain("CREATE (:GraphHealthMetric");
    expect(calls[1].query).toContain("GraphHealthMetric");
    expect(calls[1].query).toContain("SKIP toInteger($keep)");
  });
});
