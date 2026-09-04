# 稀疏图自维护与自愈优化设计（方案 A）

- **日期**：2026-09-04
- **状态**：已批准（用户确认方案 A + 中文优化章节 F）
- **范围**：在现有记忆矩阵 M、自动调优（EvolveMem）、图谱维护（maintenance）上增加稀疏图自维护能力，并进行中文场景特别优化。

## 背景与问题

当前图谱对稀疏的处理停留在"事后告警 + 惩罚"：

- 健康检查（`graph/maintenance/health.ts`）只**检测**孤立节点比例 > 30%、平均 PageRank < 0.01 等并输出告警，**不主动干预**。
- 记忆矩阵 M（`recaller/association-matrix.ts`）只在 embedding 空间内学习 query 变换，**不接触图谱结构**。
- 自动调优（`evolution/auto-tuner.ts`）动作空间只有召回/后台节流参数，**不感知图谱密度**，诊断也不含稀疏根因。
- 中文场景：三元组提取 LLM prompt 强制"节点name统一使用英文"，导致中文概念被碎片化提取成不同英文名，加剧稀疏；相似度计算缺中文字符级信号。

## 目标

1. 稀疏图可**自愈**：自动补边、保守聚合、社区重连，可回滚。
2. 图谱整体健康**定期评分（0-100）**，可跟踪趋势。
3. 记忆矩阵 M 与自动调优模块**参与**自愈（信号输出、动作空间扩展、稀疏诊断）。
4. 中文场景特别优化（三元组中文化、CJK 相似度）。

## 决策（用户确认）

| 决策点 | 选择 |
|---|---|
| 触发时机 | 并入维护周期（maintenance 新阶段） |
| 干预程度 | 保守 + 自动写图（阈值/上限 + 可回滚标记） |
| 调优配合 | 扩展动作空间 + 扩展诊断根因 |
| 成功标准 | 结构指标 + 召回指标（退步即回滚） |
| 新增需求 | 定期对整体图谱评分，按 100 分处理 |

## 设计

### A. 图谱健康评分（0-100）— 扩展 `graph/maintenance/health.ts`

新增 `computeGraphHealthScore(driver): Promise<GraphHealthScore>`：

| 维度 | 权重 | 计算 |
|---|---|---|
| 连通性/孤立性 | 35% | `1 - isolatedRatio` |
| 密度/平均度数 | 25% | `min(1, log2(1 + avgDegree) / log2(1 + K))`，K=8 |
| 影响力/PageRank | 20% | active 节点中 `pagerank > 0` 占比 |
| 时效性 | 10% | `1 - highStaleRatio` |
| 冲突 | 10% | `1 - transitionalRatio` |

`score = clamp(round(100 × Σ w_i × dim_i), 0, 100)`。

- 结果含分维度明细 + 异常标记，写入 `GraphHealthMetric` 节点（保留近 N=200 条，供趋势/API）。
- 接入 Phase 6 健康检查（`runMaintenance` 中 healthCheck 之后计算并落盘）。
- 评分阈值：`score < 60` 或 `isolatedRatio > 0.3` 视为"稀疏"，触发自愈（见 B）。

新增 `GraphHealthScore` 类型：

```ts
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
```

### B. 保守自愈阶段 — 新文件 `graph/maintenance/self-heal.ts`（Phase 12）

配置块 `sparseHeal`：

```ts
sparseHeal?: {
  enabled?: boolean;                 // 默认 true（与其它维护阶段一致，enabled !== false 时执行）
  scoreThreshold?: number;           // 默认 60
  inferSimMin?: number;              // 补边相似度下限，默认 0.70
  inferSimMax?: number;              // 补边相似度上限（=dedupThreshold 之下），默认 0.90
  maxEdgesPerNode?: number;          // 默认 5
  maxEdgesPerCycle?: number;         // 默认 50
  mergeSimThreshold?: number;        // 孤立节点自动合并阈值，默认 0.85
  confidenceFactor?: number;         // 边权重 = sim × factor，默认 1.0
  cjkWeight?: number;                // 中文文本相似度融合权重，默认 0.3
}
```

> 优先级说明：`inferSimMin` 与 `mergeSimThreshold` 为自愈静态默认值；当自动调优（AutoTuner）启用时，其动作空间参数 `edgeInferThreshold` / `isolatedMergeThreshold` 覆盖对应静态值（见 D）。

流程（全部保守、可回滚）：

1. **补边（Edge inference）**：active 节点对，满足
   - `embedding` 均非空，
   - 相似度 `sim = (1-cjkWeight)·cosine + cjkWeight·cjkBigramSim ∈ [inferSimMin, inferSimMax)`，
   - 两者间无既有边，
   - 非同向高度数 hub（两端度数均 > maxEdgesPerNode × 2 则跳过），
   - 不跨社区（communityId 相同）优先，跨社区需社区摘要相似度 ≥ 阈值。
   - 建 `RELATES_TO` 边：`weight = sim × confidenceFactor`，`inferred=true`、`source='self-heal'`、`updatedAt=now`。
   - 限额：每节点 ≤ maxEdgesPerNode，每周期 ≤ maxEdgesPerCycle。
2. **合并候选（Merge candidates）**：孤立节点与最近非孤立节点相似度 ≥ mergeSimThreshold → 保守自动合并（调用现有 `mergeNodes`）；低于阈值仅产候选报告（不写图）。
3. **社区重连（Community re-link）**：存在 communityId 的孤立节点 → 连到该社区代表节点（PageRank 最高成员），同样带 `inferred` 标记。
4. **优先级信号**：补边候选按"记忆矩阵 M 共现潜在边"（见 C）优先，其次按相似度。

回滚接口：`revertSelfHeal(driver): Promise<{ removed: number }>` 删除全部 `source='self-heal'` 的边，供 GUARD 与手动运维使用。

返回 `SelfHealResult`：

```ts
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
```

### C. 记忆矩阵 M 参与 — 扩展 `recaller/association-matrix.ts`

- **新增稀疏信号** `getSparsitySignal(): { value: number; recentLowGainRatio: number }`
  - 维护滚动窗口（最近 50 次更新）统计 `neighborhoodGain < 0.1` 的比例；
  - 输出稀疏信号 ∈ [0,1]，供自愈阶段与调优诊断消费（不直接写图）。
- **新增共现潜在边** `getCoUsedNodePairs(maxK: number): Array<{ a: string; b: string; reward: number }>`
  - 数据来源改造：`HistorySample` 新增可选字段 `usedNodeIds?: string[]`；召回侧在提交正向反馈（used 节点列表）时，将 used 节点 id 一并传入 `updateWithMarginalUtility` 并随历史样本记录。
  - 提取逻辑：统计同一历史样本内"正向奖励（reward > 0）共同使用"的节点对累积权重，返回无既有图边、权重最高的 maxK 对。
  - 自愈阶段据此优先补边（使用驱动的潜在边，比纯 embedding 相似度更可信）；维度映射无需依赖矩阵维度 ↔ 节点对齐，直接基于节点 id。
- M 不直接写图，只输出信号与潜在边候选（保持职责单一）。

### D. 自动调优扩展 — `evolution/auto-tuner.ts` + `types.ts`

1. 动作空间新增 4 个稀疏感知参数（加入 `ACTION_BOUNDS` / `extractActionSpace` / `applyActionSpace` / `fillAction`）：

   | 参数 | 范围 | 说明 |
   |---|---|---|
   | `edgeInferThreshold` | 0.60–0.95 | 补边相似度下限（inferSimMin） |
   | `selfHealMaxEdgesPerCycle` | 10–200 | 每周期补边上限 |
   | `isolatedMergeThreshold` | 0.75–0.98 | 孤立节点合并阈值 |
   | `graphScoreAlertThreshold` | 40–80 | 图谱评分告警阈值 |

2. DIAGNOSE：
   - LLM 诊断 prompt 注入 `GraphHealthScore` 摘要（score、dims、isolatedRatio）。
   - 新增启发式根因类："graph sparse（score < 阈值 / isolatedRatio > 30%）" → 建议降低 `edgeInferThreshold`、提高 `selfHealMaxEdgesPerCycle`、降低 `isolatedMergeThreshold`。
3. GUARD：
   - 回归检查加入结构指标（孤立比/评分）：若自愈引起结构退化（孤立比上升超阈值）→ 调用 `revertSelfHeal` 回滚并回退配置。
4. 冷启动/禁用语义不变：`AutoTuner` 与 `sparseHeal` 各自独立 `enabled`；自愈不依赖调优器开关（调优器关掉时自愈仍可独立运行）。

### E. 配置与接线

- `types.ts`：新增 `sparseHeal` 配置块；`graphHealth` 段增加 `scoring` 子项（`enabled?`、`historyKeep?`）。
- `graph/maintenance.ts`：
  - Phase 6 健康检查中调用 `computeGraphHealthScore` 并落盘 `GraphHealthMetric`；
  - 新增 Phase 12（在 Phase 10 反向记忆之后）：`sparseHeal.enabled !== false` 时执行 `runSelfHeal(driver, cfg)`；`revert` 参数供 GUARD。
  - barrel 重新导出 `self-heal.ts` 公共 API。
- 成功标准：结构（孤立比下降、平均度数/密度提升）+ 召回（Benchmark P@1/MRR 不退化，退化即回滚）。

### F. 中文场景优化

1. **F-1 三元组中文化**（`extractor/extract.ts`）：
   - EXTRACT_SYSTEM_PROMPT 中"节点name统一使用英文"改为"节点 name 保留原文语言（中文内容用中文名，英文内容用英文名）"；
   - 与启发式 `slugify`（中文保留原样）行为对齐，消除两条路径不一致；
   - 降低中文概念碎片化 → 从源头缓解稀疏。
2. **F-2 CJK 文本相似度**（新工具函数，置于 `graph/maintenance/self-heal.ts` 内部，仅自愈消费）：
   - `cjkBigramSim(a: string, b: string): number` — 字符二元组（bigram）Jaccard；
   - 自愈补边/合并候选与 embedding cosine 加权融合（`cjkWeight` 默认 0.3）；
   - 中文 embedding 区分度不足时的补充信号。
3. **F-3 归一化核对**：
   - 确认 `normName` 对中文保留 `[\u4e00-\u9fa5]`（去标点/空白），补边配对不会因中文标点漏配；如有遗漏补测试。
4. **F-4 社区摘要验证**：
   - 现有社区摘要已是中文友好（≤30 字、`、` 连接、成员兜底），仅补充中文用例验证，不改实现。

## 测试计划

- `test/maintenance-phases.test.ts`：新增 Phase 12 自愈测试（稀疏图谱 → 补边/合并/重连、限额生效、`inferred` 标记、`revertSelfHeal` 回滚）。
- `test/health-score.test.ts`：评分公式各维度边界（空图、全孤立、健康图、score clamp 0-100）、落盘历史。
- `test/association-matrix.test.ts`：`getSparsitySignal` / `getCoUsedNodePairs` 行为（低增益窗口、正向奖励共现对、`usedNodeIds` 线程传递）。
- `test/auto-tuner.test.ts`：新增动作空间参数 clamp/apply、稀疏根因诊断、结构指标 GUARD 回滚。
- `test/extract.test.ts`：中文内容提取保留中文节点名；`cjkBigramSim` 单元测试（含在 self-heal 测试中）。
- Benchmark（S-10）作为召回不退化回归护栏。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 误补边引入噪声 | 相似度区间下限 0.70 + 每节点/每周期上限 + `inferred` 标记可回滚 |
| 误合并丢失信息 | 仅相似度 ≥ 0.85 的孤立节点自动合并，其余只产候选报告 |
| 中文 embedding 区分度不足 | `cjkBigramSim` 加权融合补充信号 |
| 自愈导致召回退化 | GUARD 结构指标 + 召回指标双重护栏，退化即 `revertSelfHeal` + 配置回退 |
| 性能（O(N²) 相似度） | 复用 dedup 的 Cypher 端批量余弦计算；按类型分组 + LIMIT 上限控制 |
