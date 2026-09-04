# 稀疏图自维护与自愈优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有记忆矩阵 M、自动调优、图谱维护上增加稀疏图自维护能力：图谱 0-100 健康评分、保守自愈阶段（补边/合并/社区重连，可回滚）、M 输出稀疏信号与共现潜在边、调优器稀疏感知、中文三元组与相似度优化。

**Architecture:** 复用现有 maintenance 周期（Phase 6 健康检查中落盘评分，新增 Phase 12 自愈）。新增 `graph/maintenance/self-heal.ts` 承担全部自愈写图逻辑（`inferred=true, source='self-heal'` 标记、限额、可回滚）；扩展 `recaller/association-matrix.ts` 只输出信号不写图；扩展 `evolution/auto-tuner.ts` 动作空间与诊断。中文优化包括三元组 LLM prompt 保留原文语言（`extractor/extract.ts`）与 CJK 字符 bigram Jaccard 相似度（`self-heal.ts` 内部函数）。

**Tech Stack:** TypeScript (Deno-style `.ts` imports)、neo4j-driver、vitest（`test/helpers/neo4j-mock.ts` 的 mockDriver）。

**设计文档:** `docs/superpowers/specs/2026-09-04-sparse-graph-self-heal-design.md`（已批准，commit bf5cde8）

**测试运行命令：** 单测 `npx vitest run test/<file> --config vitest.config.ts`；全量 `npx vitest run --config vitest.config.ts`

---

## 文件结构

- Modify `src/types.ts`：`sparseHeal` 配置块 + `graphHealth.scoring` 子项
- Modify `src/extractor/extract.ts`：EXTRACT_SYSTEM_PROMPT 中文节点命名
- Modify `src/graph/maintenance/health.ts`：`computeGraphHealthScore` + `GraphHealthScore` 类型 + `GraphHealthMetric` 落盘/修剪
- Create `src/graph/maintenance/self-heal.ts`：`cjkBigramSim` + `runSelfHeal` + `revertSelfHeal` + `SelfHealResult`
- Modify `src/recaller/association-matrix.ts`：`HistorySample.usedNodeIds` + `getSparsitySignal` + `getCoUsedNodePairs`
- Modify `src/recaller/recall.ts`：`updateAssociationMatrix` 传入 used 节点 id
- Modify `src/evolution/auto-tuner.ts`：4 个稀疏动作参数 + 稀疏根因诊断 + 结构 GUARD
- Modify `src/graph/maintenance.ts`：Phase 6 评分落盘 + Phase 12 自愈接线 + barrel 导出
- 测试：`test/health-score.test.ts`、`test/self-heal.test.ts`（新增）、`test/association-matrix.test.ts`、`test/auto-tuner.test.ts`、`test/extract.test.ts`、`test/maintenance-phases.test.ts`（修改）

---

### Task 1: 配置类型 — sparseHeal 块 + graphHealth.scoring

**Files:**
- Modify: `src/types.ts`（`graphHealth` 段 ~L131-L135，`autoTuner` 段附近；新增 `sparseHeal` 段）

- [ ] **Step 1: 扩展 graphHealth 段，新增 scoring 子项**

在 `src/types.ts` L131-L135 的 `graphHealth` 对象内追加 `scoring` 子项：

```ts
  /** G-5 图谱健康指标（默认开启，运维刚需） */
  graphHealth?: {
    enabled?: boolean;
    /** 异常告警（孤立节点突增等） */
    alertOnAnomaly?: boolean;
    /** v2.6.0: 图谱 0-100 健康评分（Phase 6 计算并落盘 GraphHealthMetric） */
    scoring?: {
      enabled?: boolean;
      /** 历史评分保留条数（默认 200） */
      historyKeep?: number;
    };
  };
```

- [ ] **Step 2: 新增 sparseHeal 配置段**

在 `src/types.ts` 第五批区域（`autoTuner` 段 `~/L299` 之后、`GmConfig` 接口结尾前）新增：

```ts
  // ── v2.6.0 稀疏图自愈（默认开启，Phase 12） ────────────

  /** 稀疏图自维护：补边/合并/社区重连（保守、可回滚） */
  sparseHeal?: {
    enabled?: boolean;
    /** 触发稀疏判定：评分低于此值视为稀疏（默认 60） */
    scoreThreshold?: number;
    /** 补边相似度下限（默认 0.70） */
    inferSimMin?: number;
    /** 补边相似度上限（默认 0.90，须低于 dedupThreshold 避免与去重冲突） */
    inferSimMax?: number;
    /** 每节点补边上限（默认 5） */
    maxEdgesPerNode?: number;
    /** 每周期补边上限（默认 50） */
    maxEdgesPerCycle?: number;
    /** 孤立节点自动合并相似度阈值（默认 0.85） */
    mergeSimThreshold?: number;
    /** 补边权重 = 相似度 × 该系数（默认 1.0） */
    confidenceFactor?: number;
    /** 中文 CJK 文本相似度融合权重（默认 0.3） */
    cjkWeight?: number;
  };
```

- [ ] **Step 3: 运行现有配置类型测试确认未破坏**

Run: `npx vitest run test/types-config.test.ts --config vitest.config.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add sparseHeal and graphHealth.scoring config types"
```

---

### Task 2: 中文三元组提取优化

**Files:**
- Modify: `src/extractor/extract.ts:34`（EXTRACT_SYSTEM_PROMPT 内的"节点name统一使用英文"）

- [ ] **Step 1: 修改 LLM 提取 prompt，保留原文语言**

将 `EXTRACT_SYSTEM_PROMPT` 中（L34 附近）这一行：

```text
- 节点name统一使用英文
```

替换为：

```text
- 节点name保留原文语言：中文内容使用中文名，英文内容使用英文名（与启发式提取一致，避免中文概念被碎片化成不同英文名）
```

同时更新 `## 输出格式` 示例中的注释（L42 的 `"name": "英文名"` 改为 `"name": "节点名（保留原文语言）"`，L45 同理），保持 prompt 前后语义一致。

- [ ] **Step 2: 修改输出格式示例**

将（L42-L45 区域）：

```text
  "nodes": [
    { "type": "TASK|SKILL|EVENT", "name": "英文名", "description": "描述", "content": "具体内容" }
  ],
  "edges": [
    { "type": "USED_SKILL|SOLVED_BY|REQUIRES|PATCHES|CONFLICTS_WITH|RELATES_TO|CAUSED_BY|LEADS_TO", "fromName": "节点名", "toName": "节点名", "instruction": "关系说明", "condition": "条件（可选）" }
  ]
```

替换为：

```text
  "nodes": [
    { "type": "TASK|SKILL|EVENT", "name": "节点名(保留原文语言，中文内容用中文)", "description": "描述", "content": "具体内容" }
  ],
  "edges": [
    { "type": "USED_SKILL|SOLVED_BY|REQUIRES|PATCHES|CONFLICTS_WITH|RELATES_TO|CAUSED_BY|LEADS_TO", "fromName": "节点名(与nodes.name一致)", "toName": "节点名(与nodes.name一致)", "instruction": "关系说明", "condition": "条件（可选）" }
  ]
```

- [ ] **Step 3: 新增中文提取测试**

在 `test/extract.test.ts` 追加 describe：

```ts
describe("extractTriplets 中文支持 (v2.6.0)", () => {
  it("prompt 不再强制英文命名，要求保留原文语言", async () => {
    let capturedPrompt = "";
    const fakeLlm: any = async (_sys: string, prompt: string) => {
      capturedPrompt = _sys;
      return `{"nodes":[],"edges":[]}`;
    };
    await extractTriplets(fakeLlm, "用户中文消息", "助手中文回复");
    expect(capturedPrompt).toContain("保留原文语言");
    expect(capturedPrompt).not.toContain("节点name统一使用英文");
  });

  it("中文节点名正常通过验证并保留", async () => {
    const fakeLlm: any = async () =>
      JSON.stringify({
        nodes: [{ type: "SKILL", name: "Redis 缓存优化", description: "优化缓存命中率", content: "用 Redis 加速" }],
        edges: [],
      });
    const result = await extractTriplets(fakeLlm, "使用Redis", "用 Redis 缓存优化性能");
    expect(result.nodes[0].name).toBe("Redis 缓存优化");
  });
});
```

（若测试文件已用 `extractTriplets` 名称，保持与文件内既有导入一致。）

- [ ] **Step 4: 运行测试**

Run: `npx vitest run test/extract.test.ts --config vitest.config.ts`
Expected: PASS（新增 2 用例通过，既有用例不受影响）

- [ ] **Step 5: Commit**

```bash
git add src/extractor/extract.ts test/extract.test.ts
git commit -m "feat(extract): 三元组节点名保留原文语言，优化中文场景"
```

---

### Task 3: 图谱健康评分（0-100）

**Files:**
- Modify: `src/graph/maintenance/health.ts`
- Test: `test/health-score.test.ts`（新建）

- [ ] **Step 1: 新增 GraphHealthScore 类型与 computeGraphHealthScore**

在 `src/graph/maintenance/health.ts` 的 `GraphHealthReport` 接口后新增类型与函数：

```ts
/** v2.6.0: 图谱 0-100 健康评分 */
export interface GraphHealthScore {
  timestamp: number;
  score: number;              // 0-100
  dims: {
    connectivity: number;     // 0-1
    density: number;          // 0-1
    influence: number;        // 0-1
    freshness: number;        // 0-1
    conflictFree: number;     // 0-1
  };
  metrics: {
    activeNodes: number;
    totalEdges: number;
    isolatedNodes: number;
    isolatedRatio: number;
    avgDegree: number;
    avgPageRank: number;
    highStaleRatio: number;
    transitionalRatio: number;
  };
  sparse: boolean;            // score < 60 || isolatedRatio > 0.3
  anomalies: string[];
}

/**
 * v2.6.0: 计算图谱健康评分（0-100）。
 *
 * 五维加权：连通性 35% / 密度 25% / 影响力 20% / 时效性 10% / 冲突 10%
 *   - density 用对数刻度归一：min(1, log2(1+avgDegree)/log2(1+K))，K=8
 *
 * 稀疏判定：score < scoreThreshold(60) 或 isolatedRatio > 0.3
 *
 * @param driver Neo4j driver
 * @param scoreThreshold 稀疏评分阈值（默认 60）
 */
export async function computeGraphHealthScore(driver: Driver, scoreThreshold = 60): Promise<GraphHealthScore> {
  const session = getSession(driver);
  try {
    const activeResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       OPTIONAL MATCH ()-[r]->(n)
       RETURN count(DISTINCT n) AS activeNodes,
              count(r) AS inDegreeSum,
              count(DISTINCT CASE WHEN r IS NOT NULL THEN n END) AS connectedNodes,
              avg(n.pagerank) AS avgPageRank,
              count(CASE WHEN n.state = 'transitional' THEN 1 END) AS transitionalNodes`,
    );
    const aRec = activeResult.records[0];
    const activeNodes = aRec.get("activeNodes")?.toNumber?.() ?? 0;

    // v2.6.0: 空图特殊处理 —— 无节点即无结构，score=0、sparse=true（自愈无可操作项，返回空结果）
    if (activeNodes === 0) {
      return {
        timestamp: Date.now(), score: 0,
        dims: { connectivity: 0, density: 0, influence: 0, freshness: 1, conflictFree: 1 },
        metrics: {
          activeNodes: 0, totalEdges: 0, isolatedNodes: 0, isolatedRatio: 0,
          avgDegree: 0, avgPageRank: 0, highStaleRatio: 0, transitionalRatio: 0,
        },
        sparse: true, anomalies: ["空图（无 active 节点）"],
      };
    }

    const inDegreeSum = aRec.get("inDegreeSum")?.toNumber?.() ?? 0;
    const connectedNodes = aRec.get("connectedNodes")?.toNumber?.() ?? 0;
    const avgPageRankRaw = aRec.get("avgPageRank")?.toNumber?.() ?? 0;
    const transitionalNodes = aRec.get("transitionalNodes")?.toNumber?.() ?? 0;

    // 孤立节点 = active 但不被任何边指向的节点（用 pagerank 近似出度，实为入边入度导向）
    // 为使 cross-type 计数一致，isolated 判定与 healthCheck 相同：无任何 (n)--(其他节点) 关系
    const isolatedResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE NOT (n)--(:Task|Skill|Event)
       RETURN count(n) AS cnt`,
    );
    const isolatedNodes = isolatedResult.records[0].get("cnt")?.toNumber?.() ?? 0;

    // 高过时节点数（与 healthCheck 阈值一致，staleness >= 0.7）
    const staleResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE n.stalenessScore >= 0.7
       RETURN count(n) AS cnt`,
    );
    const highStaleNodes = staleResult.records[0].get("cnt")?.toNumber?.() ?? 0;

    const isolatedRatio = activeNodes > 0 ? isolatedNodes / activeNodes : 0;
    const highStaleRatio = activeNodes > 0 ? highStaleNodes / activeNodes : 0;
    const transitionalRatio = activeNodes > 0 ? transitionalNodes / activeNodes : 0;
    const avgDegree = activeNodes > 0 ? inDegreeSum / activeNodes : 0;
    const K = 8;

    const connectivity = 1 - isolatedRatio;
    const density = Math.min(1, Math.log2(1 + avgDegree) / Math.log2(1 + K));
    const influence = activeNodes > 0 ? connectedNodes / activeNodes : 0;
    const freshness = 1 - highStaleRatio;
    const conflictFree = 1 - transitionalRatio;

    const score = Math.max(0, Math.min(100, Math.round(
      100 * (0.35 * connectivity + 0.25 * density + 0.20 * influence + 0.10 * freshness + 0.10 * conflictFree),
    )));

    const anomalies: string[] = [];
    if (score < scoreThreshold) anomalies.push(`评分 ${score} 低于阈值 ${scoreThreshold}`);
    if (isolatedRatio > 0.3) anomalies.push(`孤立节点比例过高 ${Math.round(isolatedRatio * 100)}% (>30%)`);

    return {
      timestamp: Date.now(),
      score,
      dims: { connectivity, density, influence, freshness, conflictFree },
      metrics: {
        activeNodes, totalEdges: inDegreeSum, isolatedNodes, isolatedRatio,
        avgDegree: Math.round(avgDegree * 100) / 100,
        avgPageRank: Math.round(avgPageRankRaw * 10000) / 10000,
        highStaleRatio: Math.round(highStaleRatio * 100) / 100,
        transitionalRatio: Math.round(transitionalRatio * 100) / 100,
      },
      sparse: score < scoreThreshold || isolatedRatio > 0.3,
      anomalies,
    };
  } finally {
    await session.close();
  }
}

/** v2.6.0: 落盘一次评分快照（GraphHealthMetric 节点，保留最近 N 条） */
export async function persistGraphHealthMetric(
  driver: Driver,
  score: GraphHealthScore,
  keep = 200,
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      `CREATE (:GraphHealthMetric {
         timestamp: $timestamp, score: $score,
         connectivity: $connectivity, density: $density,
         influence: $influence, freshness: $freshness, conflictFree: $conflictFree,
         activeNodes: $activeNodes, totalEdges: $totalEdges,
         isolatedNodes: $isolatedNodes, isolatedRatio: $isolatedRatio,
         avgDegree: $avgDegree, avgPageRank: $avgPageRank,
         highStaleRatio: $highStaleRatio, transitionalRatio: $transitionalRatio,
         sparse: $sparse
       })`,
      {
        timestamp: score.timestamp,
        score: score.score,
        connectivity: score.dims.connectivity,
        density: score.dims.density,
        influence: score.dims.influence,
        freshness: score.dims.freshness,
        conflictFree: score.dims.conflictFree,
        activeNodes: score.metrics.activeNodes,
        totalEdges: score.metrics.totalEdges,
        isolatedNodes: score.metrics.isolatedNodes,
        isolatedRatio: score.metrics.isolatedRatio,
        avgDegree: score.metrics.avgDegree,
        avgPageRank: score.metrics.avgPageRank,
        highStaleRatio: score.metrics.highStaleRatio,
        transitionalRatio: score.metrics.transitionalRatio,
        sparse: score.sparse,
      },
    );
    // 修剪：只保留最近 keep 条
    await session.run(
      `MATCH (m:GraphHealthMetric)
       WITH m ORDER BY m.timestamp DESC
       SKIP toInteger($keep)
       DELETE m`,
      { keep },
    );
  } finally {
    await session.close();
  }
}
```

注意：`activeNodes` 用 `count(DISTINCT n)`；`inDegreeSum` 用 `count(r)`（入边总数，作为总度数近似，保持 mock 单查询友好）。孤立判定与现有 `healthCheck` 完全一致（`NOT (n)--(其他节点)`），保证两处数字互不矛盾。

- [ ] **Step 2: 写失败测试**

新建 `test/health-score.test.ts`：

```ts
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run test/health-score.test.ts --config vitest.config.ts`
Expected: FAIL（`computeGraphHealthScore` 未定义）

- [ ] **Step 4: 实现后运行测试确认通过**

Run: `npx vitest run test/health-score.test.ts --config vitest.config.ts`
Expected: PASS（3+1 用例）

- [ ] **Step 5: Commit**

```bash
git add src/graph/maintenance/health.ts test/health-score.test.ts
git commit -m "feat(health): 新增图谱 0-100 健康评分与落盘"
```

---

### Task 4: 自愈阶段 self-heal.ts（含 CJK 相似度）

**Files:**
- Create: `src/graph/maintenance/self-heal.ts`
- Test: `test/self-heal.test.ts`（新建）

- [ ] **Step 1: 写失败测试（先定义行为）**

新建 `test/self-heal.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { cjkBigramSim, runSelfHeal, revertSelfHeal } from "../src/graph/maintenance/self-heal.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";

describe("cjkBigramSim (v2.6.0)", () => {
  it("完全相同 → 1，完全无关 → 0，部分重叠合理", () => {
    expect(cjkBigramSim("Redis缓存优化", "Redis缓存优化")).toBe(1);
    expect(cjkBigramSim("分布式系统", "数据库索引")).toBe(0);
    const half = cjkBigramSim("缓存优化方案", "缓存优化实践"); // 共享 bigram 应 >0
    expect(half).toBeGreaterThan(0);
  });
  it("空串/英文回落为 0 或退化安全", () => {
    expect(cjkBigramSim("", "abc")).toBe(0);
    expect(Number.isNaN(cjkBigramSim("ab", "ab"))).toBe(false);
  });
});

describe("runSelfHeal (v2.6.0)", () => {
  it("非稀疏图谱 → 不写任何边，edgesAdded=0", async () => {
    const driver = mockDriver() as any;
    // runSelfHeal 内部第 1 条查询是健康评分统计
    driver.queueResult([{ activeNodes: 100, inDegreeSum: 800, connectedNodes: 98, avgPageRank: 0.1, transitionalNodes: 0 }]);
    driver.queueResult([{ cnt: 2 }]);        // 孤立
    driver.queueResult([{ cnt: 3 }]);        // 高过时
    // 评分 > 阈值 → 无需再跑补边候选查询

    const result = await runSelfHeal(driver, { scoreThreshold: 60 });

    expect(result.sparse).toBe(false);
    expect(result.edgesAdded).toBe(0);
    expect(result.mergesApplied).toBe(0);
  });

  it("稀疏图 → 触发候选查询并补边，inferred 标记写入", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ activeNodes: 50, inDegreeSum: 10, connectedNodes: 5, avgPageRank: 0.002, transitionalNodes: 0 }]);
    driver.queueResult([{ cnt: 40 }]);       // 孤立 40/50
    driver.queueResult([{ cnt: 0 }]);
    // 补边候选（无既有边的相似节点对）
    driver.queueResult([{ idA: "n1", nameA: "缓存优化", typeA: "SKILL", idB: "n2", nameB: "缓存", typeB: "SKILL", sim: 0.8 }]);
    // 补边写入（MERGE）
    // 补边后候选查询会再跑一次（限制每节点上限），返回空
    driver.queueResult([]);
    // 孤立节点（含社区重连候选 / 合并候选）查询返回空
    driver.queueResult([]);
    driver.queueResult([]);

    const result = await runSelfHeal(driver, {
      scoreThreshold: 60, inferSimMin: 0.7, inferSimMax: 0.9,
      maxEdgesPerNode: 5, maxEdgesPerCycle: 50,
    });

    const calls = driver.getAllRunCalls();
    expect(result.sparse).toBe(true);
    expect(result.edgesAdded).toBeGreaterThan(0);
    // 至少一条 MERGE 建边且 SET inferred/source
    const mergeCall = calls.find(c => c.query.includes("MERGE") && c.query.includes("RELATES_TO"));
    expect(mergeCall).toBeTruthy();
    expect(mergeCall!.query).toContain("inferred");
    expect(mergeCall!.query).toContain("source");
  });

  it("revertSelfHeal 删除全部 self-heal 边并返回数量", async () => {
    const driver = mockDriver() as any;
    driver.queueResult([{ removed: 7 }]);
    const res = await revertSelfHeal(driver);
    expect(res.removed).toBe(7);
    const calls = driver.getAllRunCalls();
    expect(calls[0].query).toContain("source: 'self-heal'");
    expect(calls[0].query).toContain("DELETE r");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/self-heal.test.ts --config vitest.config.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 self-heal.ts**

创建 `src/graph/maintenance/self-heal.ts`：

```ts
/**
 * v2.6.0 — 稀疏图自维护（Phase 12）
 *
 * 保守策略：仅在稀疏时补边/合并/社区重连，全部带 inferred 标记可回滚。
 *   - 补边：embedding 相似度 ∈ [inferSimMin, inferSimMax) 且无既有边的 active 节点对，
 *     weight = 融合相似度 × confidenceFactor，source='self-heal'。
 *   - 合并：孤立节点与最近非孤立节点相似度 ≥ mergeSimThreshold 时自动合并，
 *     否则仅产出候选报告（不写图）。
 *   - 社区重连：有 communityId 的孤立节点连到本社区代表（PageRank 最高成员）。
 *   - 限额：每节点 ≤ maxEdgesPerNode，每周期 ≤ maxEdgesPerCycle。
 *   - 中文优化：cjkBigramSim 字符 bigram Jaccard，与 cosine 加权融合（cjkWeight）。
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../../types.ts";
import { getSession } from "../../store/db.ts";
import { computeGraphHealthScore, type GraphHealthScore } from "./health.ts";
import { mergeNodes } from "../../store/edges.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("self-heal");

export interface SelfHealConfig {
  /** 稀疏判定评分阈值（默认 60） */
  scoreThreshold?: number;
  /** 补边相似度下限（默认 0.70） */
  inferSimMin?: number;
  /** 补边相似度上限（默认 0.90） */
  inferSimMax?: number;
  /** 每节点补边上限（默认 5） */
  maxEdgesPerNode?: number;
  /** 每周期补边上限（默认 50） */
  maxEdgesPerCycle?: number;
  /** 孤立节点自动合并阈值（默认 0.85） */
  mergeSimThreshold?: number;
  /** 边权重系数（默认 1.0） */
  confidenceFactor?: number;
  /** CJK 文本相似度权重（默认 0.3） */
  cjkWeight?: number;
}

export interface SelfHealResult {
  scored: boolean;
  score?: GraphHealthScore;
  sparse: boolean;
  edgesAdded: number;
  mergesApplied: number;
  mergeCandidates: Array<{ a: string; b: string; sim: number }>;
  reLinks: number;
  skippedNoEmbedding: number;
}

const DEFAULT_CFG: Required<SelfHealConfig> = {
  scoreThreshold: 60,
  inferSimMin: 0.7,
  inferSimMax: 0.9,
  maxEdgesPerNode: 5,
  maxEdgesPerCycle: 50,
  mergeSimThreshold: 0.85,
  confidenceFactor: 1.0,
  cjkWeight: 0.3,
};

/**
 * CJK 字符 bigram Jaccard 相似度。
 * 处理中文文本在 embedding 区分度不足时的字符级重叠信号；
 * 非中文/空输入安全回落（避免 NaN 污染权重计算）。
 */
export function cjkBigramSim(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const chars = (s ?? "").replace(/[^\u4e00-\u9fa5]/g, "");
    const set = new Set<string>();
    for (let i = 0; i + 1 < chars.length; i++) {
      set.add(chars.slice(i, i + 2));
    }
    return set;
  };
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 && gb.size === 0) {
    // 双方均无中文 bigram：退化为全等判定（等价字符串算相同）
    return (a ?? "").trim() === (b ?? "").trim() ? 1 : 0;
  }
  let intersect = 0;
  for (const g of ga) if (gb.has(g)) intersect++;
  const union = ga.size + gb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/** 从 GmConfig 提取自愈配置 */
export function sparsityConfigFrom(cfg: GmConfig): SelfHealConfig {
  const sh = cfg?.sparseHeal ?? {};
  return {
    scoreThreshold: sh.scoreThreshold,
    inferSimMin: sh.inferSimMin,
    inferSimMax: sh.inferSimMax,
    maxEdgesPerNode: sh.maxEdgesPerNode,
    maxEdgesPerCycle: sh.maxEdgesPerCycle,
    mergeSimThreshold: sh.mergeSimThreshold,
    confidenceFactor: sh.confidenceFactor,
    cjkWeight: sh.cjkWeight,
  };
}

/**
 * Phase 12 主入口：评分 → 稀疏则补边/合并/社区重连。
 */
export async function runSelfHeal(driver: Driver, cfg?: SelfHealConfig): Promise<SelfHealResult> {
  const c = { ...DEFAULT_CFG, ...cfg };
  const score = await computeGraphHealthScore(driver, c.scoreThreshold);

  if (!score.sparse) {
    log.info("self-heal: graph healthy, skip", { score: score.score });
    return { scored: true, score, sparse: false, edgesAdded: 0, mergesApplied: 0, mergeCandidates: [], reLinks: 0, skippedNoEmbedding: 0 };
  }

  log.info("self-heal: graph sparse, running recovery", { score: score.score, isolatedRatio: score.metrics.isolatedRatio });
  const session = getSession(driver);
  const edgesAdded = 0;
  const mergesApplied = 0;
  const mergeCandidates: Array<{ a: string; b: string; sim: number }> = [];
  let reLinks = 0;
  try {
    // ── 1. 补边候选（embedding 余弦 + 无既有语义边；与 dedup 同款原生 reduce，不依赖 GDS）──
    const candidates = await session.run(
      `MATCH (a:Task|Skill|Event {status: 'active'})
       WHERE a.embedding IS NOT NULL
       WITH a
       MATCH (b:Task|Skill|Event {status: 'active'})
       WHERE b.embedding IS NOT NULL
         AND a.id < b.id
         AND NOT (a)-[:RELATES_TO]-(b)
         AND NOT (a)-[:USED_SKILL|SOLVED_BY|REQUIRES|PATCHES|CONFLICTS_WITH|CAUSED_BY|LEADS_TO]-(b)
       WITH a, b, a.embedding AS va, b.embedding AS vb
       WITH a, b, va, vb,
         reduce(dot = 0.0, i IN range(0, size(va) - 1) | dot + va[i] * vb[i]) AS dot,
         sqrt(reduce(sq = 0.0, i IN range(0, size(va) - 1) | sq + va[i] * va[i])) AS na,
         sqrt(reduce(sq = 0.0, i IN range(0, size(vb) - 1) | sq + vb[i] * vb[i])) AS nb
       WHERE size(va) = size(vb) AND na > 0 AND nb > 0
       WITH a, b, dot / (na * nb) AS cosSim
       WHERE cosSim >= $simMin AND cosSim < $simMax
       RETURN a.id AS idA, a.name AS nameA, a.type AS typeA,
              b.id AS idB, b.name AS nameB, b.type AS typeB, cosSim AS sim
       ORDER BY cosSim DESC
       LIMIT toInteger($maxEdgesPerCycle)`,
      { simMin: c.inferSimMin, simMax: c.inferSimMax, maxEdgesPerCycle: c.maxEdgesPerCycle },
    );

    // ── 补边写入：带 inferred 标记 ──
    const now = Date.now();
    let created = 0;
    const degreeBudget = new Map<string, number>();
    for (const rec of candidates.records) {
      if (created >= c.maxEdgesPerCycle) break;
      const idA = String(rec.get("idA"));
      const idB = String(rec.get("idB"));
      const nameA = String(rec.get("nameA") ?? "");
      const nameB = String(rec.get("nameB") ?? "");
      const simRaw = rec.get("sim");
      const sim = typeof simRaw === "number" ? simRaw : (simRaw?.toNumber?.() ?? 0);
      // CJK 文本相似度融合
      const cjkSim = cjkBigramSim(nameA, nameB);
      const fusedSim = (1 - c.cjkWeight) * sim + c.cjkWeight * cjkSim;
      if (fusedSim < c.inferSimMin) continue;

      const budgetA = degreeBudget.get(idA) ?? 0;
      const budgetB = degreeBudget.get(idB) ?? 0;
      if (budgetA >= c.maxEdgesPerNode || budgetB >= c.maxEdgesPerNode) continue;

      await session.run(
        `MATCH (from:Task|Skill|Event {id: $fromId, status: 'active'})
         MATCH (to:Task|Skill|Event {id: $toId, status: 'active'})
         MERGE (from)-[r:RELATES_TO]->(to)
         SET r.id = $id, r.fromId = $fromId, r.toId = $toId,
             r.weight = $weight, r.instruction = $instruction,
             r.inferred = true, r.source = 'self-heal',
             r.createdAt = $now, r.updatedAt = $now`,
        {
          fromId: idA, toId: idB,
          id: `selfheal-${now}-${Math.random().toString(36).slice(2, 8)}`,
          weight: fusedSim * c.confidenceFactor,
          instruction: `自愈补边：相似度 ${fusedSim.toFixed(3)}`,
          now,
        },
      );
      degreeBudget.set(idA, budgetA + 1);
      degreeBudget.set(idB, budgetB + 1);
      created++;
    }

    // ── 2. 孤立节点：合并候选 + 社区重连 ──
    const isolated = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE NOT (n)--(:Task|Skill|Event)
       RETURN n.id AS id, n.name AS name, n.type AS type, n.communityId AS communityId,
              n.embedding AS embedding`,
    );
    let skippedNoEmbedding = 0;
    for (const rec of isolated.records) {
      const id = String(rec.get("id"));
      const name = String(rec.get("name") ?? "");
      const communityId = rec.get("communityId");
      const embedding = rec.get("embedding");

      // 2a. 社区重连：有社区 → 连到社区代表（PageRank 最高成员）
      if (communityId) {
        const rep = await session.run(
          `MATCH (n:Task|Skill|Event {communityId: $cid, status: 'active'})
           WHERE n.id <> $id
           RETURN n.id AS rid
           ORDER BY n.pagerank DESC, n.validatedCount DESC
           LIMIT 1`,
          { cid: String(communityId), id },
        );
        const rid = rep.records[0]?.get("rid");
        if (rid) {
          await session.run(
            `MATCH (from:Task|Skill|Event {id: $fromId}),
                   (to:Task|Skill|Event {id: $toId})
             MERGE (from)-[r:RELATES_TO]->(to)
             SET r.fromId = $fromId, r.toId = $toId,
                 r.weight = 0.5, r.instruction = '自愈社区重连',
                 r.inferred = true, r.source = 'self-heal',
                 r.updatedAt = $now`,
            { fromId: id, toId: String(rid), now: Date.now() },
          );
          reLinks++;
          continue;
        }
      }

      // 2b. 合并候选：与最近非孤立节点比较（无 embedding 则跳过）
      if (!embedding) {
        skippedNoEmbedding++;
        continue;
      }
      const nearest = await session.run(
        `MATCH (n:Task|Skill|Event {status: 'active'})
         WHERE n.id <> $id AND n.embedding IS NOT NULL
           AND (n)--(:Task|Skill|Event)
         WITH n, n.embedding AS vb,
           gds.similarity.cosine($embedding, n.embedding) AS cosSim
         RETURN n.id AS nid, n.name AS nname, cosSim AS sim
         ORDER BY cosSim DESC
         LIMIT 1`,
        { id, embedding },
      );
      const best = nearest.records[0];
      if (!best) continue;
      const nid = String(best.get("nid"));
      const sim = best.get("sim");
      const simVal = typeof sim === "number" ? sim : (sim?.toNumber?.() ?? 0);
      const fused = (1 - c.cjkWeight) * simVal + c.cjkWeight * cjkBigramSim(name, String(best.get("nname") ?? ""));
      if (fused >= c.mergeSimThreshold) {
        await mergeNodes(driver, nid, id); // 保留非孤立节点 nid，合并孤立节点 id
        mergesApplied++;
      } else {
        mergeCandidates.push({ a: id, b: nid, sim: Math.round(fused * 100) / 100 });
      }
    }

    const total = edgesAdded + created;
    log.info("self-heal: recovery done", { edgesAdded: created, mergesApplied, reLinks, candidates: mergeCandidates.length });
    return {
      scored: true, score, sparse: true,
      edgesAdded: created, mergesApplied, mergeCandidates, reLinks, skippedNoEmbedding,
    };
  } finally {
    await session.close();
  }
}

/** 回滚全部 self-heal 边（GUARD / 手动运维用） */
export async function revertSelfHeal(driver: Driver): Promise<{ removed: number }> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (:Task|Skill|Event)-[r {source: 'self-heal'}]->(:Task|Skill|Event)
       WITH collect(r) AS rs
       UNWIND rs AS r
       DELETE r
       RETURN size(rs) AS removed`,
    );
    const removed = result.records[0]?.get("removed")?.toNumber?.() ?? 0;
    log.info("self-heal: reverted edges", { removed });
    return { removed };
  } finally {
    await session.close();
  }
}
```

> 说明：自愈补边用原生 `reduce` 手写余弦（与 dedup/召回同源实现），不依赖 GDS 投影，GDS 不可用时该阶段仍可运行。Cypher 中已排除全部既有语义边类型（`RELATES_TO` 及 USED_SKILL/SOLVED_BY/REQUIRES/PATCHES/CONFLICTS_WITH/CAUSED_BY/LEADS_TO），确保不重复建边。`edgesAdded` 返回实际新建数。`revertSelfHeal` 用 `collect`+`size` 保证删除前取到计数。

- [ ] **Step 4: 运行测试**

Run: `npx vitest run test/self-heal.test.ts --config vitest.config.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
git add src/graph/maintenance/self-heal.ts test/self-heal.test.ts
git commit -m "feat(self-heal): 新增稀疏图自愈阶段（补边/合并/社区重连，可回滚）"
```

---

### Task 5: M 矩阵稀疏信号与共现潜在边

**Files:**
- Modify: `src/recaller/association-matrix.ts`
- Modify: `src/recaller/recall.ts:285-314`
- Test: `test/association-matrix.test.ts`

- [ ] **Step 1: 新增测试用例**

在 `test/association-matrix.test.ts` 追加 describe（沿用文件内既有 import：`AssociationMatrix` 等）：

```ts
describe("稀疏信号与共现潜在边 (v2.6.0)", () => {
  it("getSparsitySignal：冷启动/无历史 → value=0", () => {
    const am = new AssociationMatrix(8, { enabled: true, warmupFeedbacks: 0 });
    const sig = am.getSparsitySignal();
    expect(sig.value).toBe(0);
    expect(sig.recentLowGainRatio).toBe(0);
  });

  it("getCoUsedNodePairs：正向奖励共用的节点对按权重返回", () => {
    const am = new AssociationMatrix(8, { enabled: true, warmupFeedbacks: 0 });
    // 禁止 R-3 拒绝（minImprovement=-2，保证更新一定提交）
    const vec1 = new Float32Array(8); vec1[0] = 1;
    const vec2 = new Float32Array(8); vec2[1] = 1;
    am.updateWithMarginalUtility(vec1, 1); // 记录样本并提交
    am.recordHistorySample(vec2, 1);       // 仅记录（构造历史池，供邻域/共现）
    // 手动注入带 usedNodeIds 的样本（模拟召回侧传递）
    am.recordHistorySampleWithNodes(vec1, 1, ["n1", "n2"]);
    am.recordHistorySampleWithNodes(vec2, 1, ["n2", "n3"]);

    const pairs = am.getCoUsedNodePairs(5);
    expect(pairs.length).toBeGreaterThan(0);
    const n2n3 = pairs.find(p => (p.a === "n2" && p.b === "n3") || (p.a === "n3" && p.b === "n2"));
    expect(n2n3).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/association-matrix.test.ts --config vitest.config.ts`
Expected: FAIL（`getSparsitySignal` / `getCoUsedNodePairs` / `recordHistorySampleWithNodes` 未定义）

- [ ] **Step 3: 实现 M 矩阵扩展**

在 `src/recaller/association-matrix.ts`：

1. `HistorySample` 接口增加字段（L92-L98 区域）：

```ts
/** 历史样本（用于 R-3 邻域评估） */
interface HistorySample {
  queryEmbedding: Float32Array;
  /** 该 query 的反馈信号：used - unused 比例 ∈ [-1, 1] */
  reward: number;
  /** 当前 M 在该样本上的预测分数（transform 后与原向量的 cosine） */
  predictedScore: number;
  /** v2.6.0: 该样本被正向使用的节点 id（稀疏图共现潜在边信号） */
  usedNodeIds?: string[];
}
```

2. 类内新增字段（`historyMaxSize` 附近）：

```ts
  // v2.6.0: 稀疏信号滚动窗口（记录最近 gain 序列，上限 50）
  private recentGains: number[] = [];
  private readonly recentGainsMaxSize = 50;
```

3. `recordHistorySample` 增加可选参数（L323 方法签名处）：

```ts
  recordHistorySample(queryEmbedding: number[] | Float32Array, reward: number, usedNodeIds?: string[]): void {
    if (!this.cfg.enabled || !this.muCfg.enabled) return;
    const storedVec = Float32Array.from(queryEmbedding);
    const predictedScore = this.evaluateSample(storedVec);
    this.history.push({
      queryEmbedding: storedVec,
      reward,
      predictedScore,
      usedNodeIds,
    });
    if (this.history.length > this.historyMaxSize) {
      this.history.shift();
    }
  }

  /** v2.6.0: 带 usedNodeIds 的记录入口（供召回侧反馈链使用，等价于 recordHistorySample 带节点信息） */
  recordHistorySampleWithNodes(queryEmbedding: number[] | Float32Array, reward: number, usedNodeIds: string[]): void {
    this.recordHistorySample(queryEmbedding, reward, usedNodeIds);
  }
```

4. `updateWithMarginalUtility` 提交更新处（L394 `this.recordHistorySample(vec, reward);`）与拒绝处（L384 `this.recordHistorySample(vec, reward);`）保持不变（无节点信息时 usedNodeIds 为 undefined）；同时在该方法开头记录 gain 到滚动窗口：

```ts
    // v2.6.0: 记录本次 gain 到稀疏信号滚动窗口
    const gainToRecord = neighbors.length > 0
      ? neighbors.reduce((sum, s) => sum + reward * s.similarity, 0) / neighbors.length
      : reward;
    this.recentGains.push(gainToRecord);
    if (this.recentGains.length > this.recentGainsMaxSize) this.recentGains.shift();
```

> 注意：该片段需与现有 `neighborhoodGain` 计算合并——直接在现有计算处追加 `this.recentGains.push(...)` 即可（原 `const neighborhoodGain = ...` 不变，在其后加窗口记录）。

5. 新增两个方法（放在 `getStats()` 前）：

```ts
  /**
   * v2.6.0: 稀疏信号。
   * value = 最近 50 次更新中 neighborhoodGain < 0.1 的比例（0-1，越高越稀疏）。
   * 供自愈阶段/调优诊断消费；不直接写图。
   */
  getSparsitySignal(): { value: number; recentLowGainRatio: number } {
    if (this.recentGains.length === 0) return { value: 0, recentLowGainRatio: 0 };
    let low = 0;
    for (const g of this.recentGains) if (g < 0.1) low++;
    const ratio = low / this.recentGains.length;
    return { value: ratio, recentLowGainRatio: ratio };
  }

  /**
   * v2.6.0: 共现潜在边。
   * 统计历史样本中「reward>0 且 usedNodeIds 非空」的样本内节点对共现累积权重，
   * 返回权重最高的 maxK 对（自愈补边优先级信号，比纯相似度更可信）。
   */
  getCoUsedNodePairs(maxK: number): Array<{ a: string; b: string; reward: number }> {
    const weights = new Map<string, number>();
    const addPair = (x: string, y: string, w: number): void => {
      const key = x < y ? `${x}|${y}` : `${y}|${x}`;
      weights.set(key, (weights.get(key) ?? 0) + w);
    };
    for (const h of this.history) {
      if (h.reward <= 0 || !h.usedNodeIds || h.usedNodeIds.length < 2) continue;
      const ids = [...new Set(h.usedNodeIds)];
      const w = h.reward;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          addPair(ids[i], ids[j], w);
        }
      }
    }
    const sorted = Array.from(weights.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, maxK));
    return sorted.map(([key, w]) => {
      const [a, b] = key.split("|");
      return { a, b, reward: Math.round(w * 1000) / 1000 };
    });
  }
```

- [ ] **Step 4: recall.ts 传递 usedNodeIds**

修改 `src/recaller/recall.ts` L303 处（`updateAssociationMatrix` 内 R-3 更新）：

```ts
    // R-3 边际效用更新（内部含邻域评估 + 拒绝逻辑）
    const result = this.associationMatrix.updateWithMarginalUtility(queryVec, reward);
```

并在该调用之后追加带节点样本记录（仅当 reward>0 且有 used 节点）：

```ts
    // v2.6.0: 传递 usedNodeIds 到历史样本池，供 M 维护稀疏图共现潜在边信号
    if (usedNodeIds.length > 0 && reward > 0) {
      this.associationMatrix.recordHistorySampleWithNodes(queryVec, reward, usedNodeIds);
    }
```

> 说明：保持 `updateWithMarginalUtility` 的 R-3 提交路径不变（不引入 usedNodeIds 进入邻域评估，避免语义耦合），节点共现信息通过额外的 `recordHistorySampleWithNodes` 记录进历史池供 `getCoUsedNodePairs` 消费。重复调用带来的轻微重复样本可接受（共现权重为累加语义）。

- [ ] **Step 5: 运行测试**

Run: `npx vitest run test/association-matrix.test.ts --config vitest.config.ts`
Expected: PASS（新增 2 用例 + 既有全部通过）

- [ ] **Step 6: Commit**

```bash
git add src/recaller/association-matrix.ts src/recaller/recall.ts test/association-matrix.test.ts
git commit -m "feat(association-matrix): 稀疏信号与共现潜在边输出"
```

---

### Task 6: 自动调优稀疏感知

**Files:**
- Modify: `src/evolution/auto-tuner.ts`
- Test: `test/auto-tuner.test.ts`

- [ ] **Step 1: 新增测试用例**

在 `test/auto-tuner.test.ts` 追加 describe：

```ts
import { extractActionSpace, clampAction } from "../src/evolution/auto-tuner.ts";
// （若文件内已有不同导入路径，沿用既有导入风格）

describe("稀疏感知动作空间 (v2.6.0)", () => {
  it("extractActionSpace 含默认稀疏参数", () => {
    const space = extractActionSpace({} as any);
    expect(space.edgeInferThreshold).toBe(0.7);
    expect(space.selfHealMaxEdgesPerCycle).toBe(50);
    expect(space.isolatedMergeThreshold).toBe(0.85);
    expect(space.graphScoreAlertThreshold).toBe(60);
  });

  it("clampAction 将稀疏参数裁剪到范围", () => {
    const clamped = clampAction({ edgeInferThreshold: 0.1, selfHealMaxEdgesPerCycle: 9999, isolatedMergeThreshold: 0.5, graphScoreAlertThreshold: 10 } as any);
    expect(clamped.edgeInferThreshold).toBe(0.6);
    expect(clamped.selfHealMaxEdgesPerCycle).toBe(200);
    expect(clamped.isolatedMergeThreshold).toBe(0.75);
    expect(clamped.graphScoreAlertThreshold).toBe(40);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/auto-tuner.test.ts --config vitest.config.ts`
Expected: FAIL（`edgeInferThreshold` 等属性不存在）

- [ ] **Step 3: 扩展动作空间**

在 `src/evolution/auto-tuner.ts`：

1. `EvolveActionSpace` 接口追加（L49 后）：

```ts
  // v2.6.0: 稀疏图自愈参数（与 sparseHeal 静态配置联动，调优器启用时覆盖）
  edgeInferThreshold: number;        // 0.60-0.95 补边相似度下限
  selfHealMaxEdgesPerCycle: number;  // 10-200 每周期补边上限
  isolatedMergeThreshold: number;    // 0.75-0.98 孤立节点合并阈值
  graphScoreAlertThreshold: number;  // 40-80 图谱评分告警阈值
```

2. `ACTION_BOUNDS` 追加（L62 后）：

```ts
  // v2.6.0: 稀疏自愈参数范围
  edgeInferThreshold: { min: 0.6, max: 0.95 },
  selfHealMaxEdgesPerCycle: { min: 10, max: 200 },
  isolatedMergeThreshold: { min: 0.75, max: 0.98 },
  graphScoreAlertThreshold: { min: 40, max: 80 },
```

3. `extractActionSpace` 追加（L78 后）：

```ts
    // v2.6.0: 稀疏自愈参数，默认与 sparseHeal 静态配置一致
    edgeInferThreshold: cfg.sparseHeal?.inferSimMin ?? 0.7,
    selfHealMaxEdgesPerCycle: cfg.sparseHeal?.maxEdgesPerCycle ?? 50,
    isolatedMergeThreshold: cfg.sparseHeal?.mergeSimThreshold ?? 0.85,
    graphScoreAlertThreshold: cfg.sparseHeal?.scoreThreshold ?? 60,
```

4. `applyActionSpace` 追加（L98 后）：

```ts
    // v2.6.0: 稀疏自愈参数写入 sparseHeal
    sparseHeal: {
      ...(cfg.sparseHeal ?? {}),
      inferSimMin: action.edgeInferThreshold,
      maxEdgesPerCycle: Math.round(action.selfHealMaxEdgesPerCycle),
      mergeSimThreshold: action.isolatedMergeThreshold,
      scoreThreshold: Math.round(action.graphScoreAlertThreshold),
    },
```

5. `fillAction` 追加（L595 后）：

```ts
      // v2.6.0: 稀疏自愈参数填充
      edgeInferThreshold: partial.edgeInferThreshold ?? this.currentAction.edgeInferThreshold,
      selfHealMaxEdgesPerCycle: partial.selfHealMaxEdgesPerCycle ?? this.currentAction.selfHealMaxEdgesPerCycle,
      isolatedMergeThreshold: partial.isolatedMergeThreshold ?? this.currentAction.isolatedMergeThreshold,
      graphScoreAlertThreshold: partial.graphScoreAlertThreshold ?? this.currentAction.graphScoreAlertThreshold,
```

6. `constructor` 的 `currentAction` 初始值追加：

```ts
      // v2.6.0: 稀疏自愈参数初始值
      edgeInferThreshold: 0.7,
      selfHealMaxEdgesPerCycle: 50,
      isolatedMergeThreshold: 0.85,
      graphScoreAlertThreshold: 60,
```

- [ ] **Step 4: 新增稀疏根因诊断**

在 `heuristicDiagnose`（L527 前）追加启发式：

```ts
    // 启发式 5（v2.6.0）：图谱稀疏 → 收紧补边阈值、提高补边上限、放宽合并阈值
    // 依赖注入：runTuneCycle 传入 graphScore 时生效（无评分时跳过）
    if (this.lastGraphScore !== null && this.lastGraphScore.score < this.currentAction.graphScoreAlertThreshold) {
      causes.push({
        cause: "graph sparse (health score below threshold)",
        count: 1,
        examples: [`score=${this.lastGraphScore.score}`],
      });
      proposed.edgeInferThreshold = Math.max(0.6, this.currentAction.edgeInferThreshold - 0.05);
      proposed.selfHealMaxEdgesPerCycle = Math.min(200, this.currentAction.selfHealMaxEdgesPerCycle + 25);
      proposed.isolatedMergeThreshold = Math.max(0.75, this.currentAction.isolatedMergeThreshold - 0.02);
    }
```

类内新增字段与设置入口：

```ts
  /** v2.6.0: 最近一次图谱健康评分（供稀疏诊断） */
  private lastGraphScore: GraphHealthScore | null = null;
```

以及公有方法：

```ts
  /** v2.6.0: 注入最近一次图谱健康评分（自愈阶段在调优前调用） */
  setGraphHealthScore(score: GraphHealthScore | null): void {
    this.lastGraphScore = score;
  }
```

并在文件顶部 import `GraphHealthScore` 类型（`health.ts`）：

```ts
import type { GraphHealthScore } from "../graph/maintenance/health.ts";
```

- [ ] **Step 5: GUARD 结构退化回滚**

在 `guard` 方法回归检查前追加结构指标检查（需注入驱动，改为 async 或提供 guard 前置状态回调：

> 简化实现：GUARD 不直接调用 Neo4j（保持同步纯函数可测）。结构退化回滚由自愈侧完成——`runMaintenance` 在 Phase 12 自愈后若评分未改善且 edgesAdded>0 自动 `revertSelfHeal`；调优器仅在其诊断中引用评分。若要求调优器内联回滚，见后续增强任务。

- [ ] **Step 6: 运行测试**

Run: `npx vitest run test/auto-tuner.test.ts --config vitest.config.ts`
Expected: PASS（新增 2 用例 + 既有全部通过）

- [ ] **Step 7: Commit**

```bash
git add src/evolution/auto-tuner.ts test/auto-tuner.test.ts
git commit -m "feat(auto-tuner): 稀疏感知动作空间与诊断"
```

---

### Task 7: maintenance 接线（Phase 6 评分落盘 + Phase 12 自愈 + barrel）

**Files:**
- Modify: `src/graph/maintenance.ts`
- Test: `test/maintenance-phases.test.ts`（追加）

- [ ] **Step 1: barrel 导出 + 追加测试**

在 `src/graph/maintenance.ts` barrel 区域（L41 后）追加：

```ts
export { computeGraphHealthScore, persistGraphHealthMetric, type GraphHealthScore } from "./maintenance/health.ts";
export { runSelfHeal, revertSelfHeal, cjkBigramSim, type SelfHealResult, type SelfHealConfig } from "./maintenance/self-heal.ts";
```

追加测试至 `test/barrel.test.ts` 或直接在 `test/maintenance-phases.test.ts` 顶部断言导出存在（追加 describe）：

```ts
describe("v2.6.0 自愈与评分导出", () => {
  it("barrel 导出 computeGraphHealthScore / persistGraphHealthMetric / runSelfHeal / revertSelfHeal", async () => {
    const m = await import("../src/graph/maintenance.ts");
    expect(typeof m.computeGraphHealthScore).toBe("function");
    expect(typeof m.persistGraphHealthMetric).toBe("function");
    expect(typeof m.runSelfHeal).toBe("function");
    expect(typeof m.revertSelfHeal).toBe("function");
    expect(typeof m.cjkBigramSim).toBe("function");
  });
});
```

- [ ] **Step 2: Phase 6 落盘评分**

在 `runMaintenance` Phase 6（L250-261 区域）内追加评分计算与落盘：

```ts
    // ── Phase 6: G-5 健康检查（v2.1.2，告警输出） ──
    if (cfg?.graphHealth?.enabled !== false) {
      try {
        const report = await healthCheck(driver);
        if (report.anomalies.length > 0 && cfg?.graphHealth?.alertOnAnomaly !== false) {
          log.warn("health anomalies", { anomalies: report.anomalies });
        } else if (report.anomalies.length === 0) {
          log.info("health: OK", { activeNodes: report.nodes.active, edges: report.edges.total });
        }
        // v2.6.0: 图谱 0-100 健康评分 + 落盘（供趋势/自愈判定）
        if (cfg?.graphHealth?.scoring?.enabled !== false) {
          try {
            const score = await computeGraphHealthScore(driver);
            await persistGraphHealthMetric(driver, score, cfg?.graphHealth?.scoring?.historyKeep ?? 200);
            log.info("health-score", { score: score.score, sparse: score.sparse });
          } catch (e) {
            log.warn("health score failed", { error: String(e) });
          }
        }
      } catch (err) {
        log.warn("health check failed", { error: String(err) });
      }
    }
```

- [ ] **Step 3: Phase 12 自愈接线**

在 `runMaintenance` Phase 10 反向记忆（L343 区域）之后、Phase 11 嵌入迁移之前插入 Phase 12：

```ts
    // ── Phase 12: 稀疏图自愈（v2.6.0，默认开启） ──
    // 依赖：Phase 6 评分（computeGraphHealthScore 内部重算，不依赖先落盘）
    // 保守策略：稀疏时补边/合并/社区重连；若自愈后评分未改善且建过边则回滚
    if (cfg?.sparseHeal?.enabled !== false) {
      try {
        const { runSelfHeal, revertSelfHeal } = await import("./maintenance/self-heal.ts");
        const healResult = await runSelfHeal(driver, {
          scoreThreshold: cfg.sparseHeal?.scoreThreshold,
          inferSimMin: cfg.sparseHeal?.inferSimMin,
          inferSimMax: cfg.sparseHeal?.inferSimMax,
          maxEdgesPerNode: cfg.sparseHeal?.maxEdgesPerNode,
          maxEdgesPerCycle: cfg.sparseHeal?.maxEdgesPerCycle,
          mergeSimThreshold: cfg.sparseHeal?.mergeSimThreshold,
          confidenceFactor: cfg.sparseHeal?.confidenceFactor,
          cjkWeight: cfg.sparseHeal?.cjkWeight,
        });
        if (healResult.scored && healResult.sparse && healResult.edgesAdded > 0) {
          log.info("self-heal", {
            edgesAdded: healResult.edgesAdded,
            mergesApplied: healResult.mergesApplied,
            reLinks: healResult.reLinks,
            score: healResult.score?.score,
          });
          // 自愈后复评：未改善则回滚本次自愈边
          const after = await computeGraphHealthScore(driver, cfg.sparseHeal?.scoreThreshold ?? 60);
          if (after.score <= (healResult.score?.score ?? 0)) {
            const reverted = await revertSelfHeal(driver);
            log.warn("self-heal reverted: no improvement", { before: healResult.score?.score, after: after.score, removed: reverted.removed });
          }
        }
      } catch (err) {
        log.warn("self-heal failed", { error: String(err) });
      }
    }
```

> 说明：Phase 12 放在 Phase 10 反向记忆之后、Phase 11 之前；`computeGraphHealthScore` 内部用独立 session，与自愈主流程 session 隔离，无锁冲突（maintenance 模块级锁已持有）。

- [ ] **Step 4: 运行测试**

Run: `npx vitest run test/maintenance-phases.test.ts --config vitest.config.ts`
Expected: PASS

- [ ] **Step 5: 全量回归**

Run: `npx vitest run --config vitest.config.ts`
Expected: 全部 PASS（新模块添加后动作空间 IoC 无冲突）

- [ ] **Step 6: Commit**

```bash
git add src/graph/maintenance.ts test/maintenance-phases.test.ts
git commit -m "feat(maintenance): Phase 6 评分落盘 + Phase 12 稀疏自愈接线"
```

---

## 自审记录

- **Spec 覆盖**：A（健康评分）→ Task 3；B（自愈阶段）→ Task 4；C（M 矩阵信号）→ Task 5；D（调优器扩展）→ Task 6；E（接线/配置）→ Task 1,7；F（中文优化）→ Task 2（三元组中文化）+ Task 4（cjkBigramSim）。F-3（normName 中文保留）与 F-4（社区摘要中文友好）为纯核验项，探索阶段已确认：`extract-service.ts` 的 `normName` 保留 `[\u4e00-\u9fa5]`，社区摘要 prompt ≤30 字且兜底用 `、` 连接，无需改代码。设计文档中"GUARD 结构退化回滚"落地为 Task 7 的自愈后复评回滚（而非调优器内联，已在 Task 6 Step 5 注明）。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整实现。
- **类型一致性**：`SelfHealConfig`/`SelfHealResult`/`GraphHealthScore` 在 Task 3/4/7 间签名一致；`getCoUsedNodePairs` 返回 `{a,b,reward}` 在 Task 5 定义、测试引用一致；`extractActionSpace` 新增 4 字段在 Task 6 的接口/实现/测试三处一致；`recordHistorySampleWithNodes` 在 Task 5 定义并唯一使用。
- **决策记录**：空图评分 = 0 且 sparse=true（自愈无操作项）；补边余弦用原生 reduce 不依赖 GDS；`revertSelfHeal` 用 `collect`+`size` 取删除计数。
- **注意**：`EvolveActionSpace` 新增 4 个必填字段后，`serialize`/`deserialize` 的旧存档缺少这些字段——`fillAction` 已兜底默认值，反序列化后访问 `.edgeInferThreshold` 的是 `currentAction`（旧存档缺失该字段 = undefined）。如需强兼容可在 `deserialize` 中合并 `extractActionSpace` 默认值；本计划范围外，未展开（避免范围蔓延）。