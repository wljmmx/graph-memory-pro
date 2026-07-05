# Graph Memory Pro 演进路线图

> 规划版本：2.1.10 ｜ 已发布版本：2.3.0
> 模块定位：**记忆底层引擎**——图内操作（提取/存储/检索/去重/维护/质量优化/自主进化）
> 上层编排（上下文管理、prompt组装、Agent工作流、用户界面）由 **lcm-graph-extra** 负责
> 基于 15 篇文献/项目横评，聚焦 T1 引擎核心 + T2 质量保障，不入编排层
>
> **发布说明**：v2.1.10 路线图 22 项方案已全部落地，发布为 v2.2.0。
>
> **v2.2.0 工程化补强**（路线图之外的对外接口/可观测性/工程化）：
> - MCP Server（13 tools，Streamable HTTP，Bearer Token 鉴权）
> - `/api/metrics`（Prometheus text exposition format，10+ 指标）
> - `/api/auto-tuner/state` + `/api/association-matrix/state`（状态查询入口）
> - `npm run benchmark` CLI + `config.example.json` 配置示例
> - 单元测试补全（HTTP API / LLM-Embedding / 抽取器，230 → 298 用例）
> - Dockerfile + docker-compose + GitHub Actions CI
> - CHANGELOG.md（含配置迁移指南）
>
> **v2.2.1 工程化补强**（P4 能力补齐 + 降级项落地）：
> - **P4-1**：I-2 裁判 Tier 2/3 接入点 — `JudgeStrategy` 抽象 + 3 个内置策略（Heuristic/LLM/Custom），含安全护栏（fallback/截断/超时）
> - **P4-2**：增量维护（Incremental Maintenance）— 仅对 `markDirty` 脏节点执行节点级阶段，4 个 HTTP 端点
> - **P1-4**：拆分 maintenance.ts — 1044 行 → 340 barrel + 6 子模块（staleness/health/importance/conflict/edge-weights/reverse-memory）
> - **P1-5**：拆分 store.ts — 1128 行 → 69 barrel + 7 子模块（schema/nodes/edges/feedback/community/vector/messages）
> - **P2-1**：结构化日志重构 — `createLogger(namespace)` 工厂 + 分级 + JSON + traceId，迁移 44 处 console 调用
> - 单元测试 298 → 340 用例（+42），tsc 0 错误，全部向后兼容
>
> **v2.2.2 发布阻断修复**（类型声明 + 发布配置 + 文档一致性）：
> - **P0-1**：tsup 启用 `dts: true`，dist/ 产出 `index.d.ts`（修复消费者类型缺失）
> - **P0-2**：统一文档测试数字为 367（README/release.yml/AUDIT/CHANGELOG/ROADMAP）
> - **P0-3**：`openclaw.plugin.json` 加入 npm `files` 字段（修复插件清单未发布）
> - **P1-1**：package.json 补 `author`/`license` 字段，统一署名
> - **P1-2**：移除入库的 `actionlint` 二进制，改用 CI 下载
> - **P1-3**：ROADMAP 验收 checklist 勾选已落地项
> - **新增能力**：主会话本地模型优先策略（`createRuntimeCompleteFn`，provider 探测 + 缓存，+22 测试）
> - 单元测试 340 → 367 用例（+27），tsc 0 错误，全部向后兼容

---

## 一、能力边界

```
┌─────────────────────────────────────────────────┐
│  lcm-graph-extra（上层编排层）                    │
│  上下文管理 · prompt 组装 · Agent 工作流 · UI     │
│  调用 graph-memory-pro 的 Re-exports API         │
├─────────────────────────────────────────────────┤
│  graph-memory-pro（记忆底层引擎）← 本规划         │
│  提取 · 存储 · 检索 · 去重 · 维护 · 质量 · 进化  │
│  暴露：Recaller / upsertNode / runMaintenance 等  │
└─────────────────────────────────────────────────┘
```

**graph-memory-pro 的 Re-exports**（[index.ts:508-524](file:///workspace/index.ts#L508-L524)）：
`Recaller`, `upsertNode`, `upsertEdge`, `mergeNodes`, `runMaintenance`, `Extractor`, `extractTriplets`, `searchNodes`, `getTopNodes`, `dedup`, `personalizedPageRank`, `computeGlobalPageRank`, `detectCommunities`, `summarizeCommunities`, `getCommunityPeers`, `getVectorHash`, `createEmbedFn`, `getDriver`

**设计原则**：graph-memory-pro 只做"图内"操作，不做"图外"编排。新功能若涉及 lcm-graph-extra 的编排逻辑，引擎层只提供基础 API，编排逻辑在 lcm-graph-extra 实现。

---

## 二、15 篇文献/方案横评

逐篇评估对 graph-memory-pro 引擎层的适配度，按 T1/T2/T3/不入 四级分类。

### T1：引擎核心，必须做（直接提升召回质量，完全在引擎层）

| 编号 | 方案 | 论文 | 核心机制 | 一句话 | 成本 |
|---|---|---|---|---|---|
| R-1 | 自主调优 | EvolveMem (arxiv 2605.13941) | 召回参数暴露为动作空间，LLM 诊断失败案例自动调优，revert-on-regression | 让召回参数自己学会调优 | 5-7天 |
| R-3 | 边际效用奖励 | UMEM (arxiv 2602.10652) | 语义邻域建模，奖励从二值升级为边际效用，避免死记硬背 | 让 M 矩阵不再过拟合 | 4-6天 |
| R-4 | 可进化嵌入 | EvoEmbedding (南京大学 2026.06) | 节点 content 更新时重算嵌入，嵌入版本化，冲突消解 | 解决静态嵌入时效性问题 | 3-4天 |
| S-10 | Benchmark | Mem0 2026 报告 | 接入 LoCoMo/LongMemEval 标准评测，建立质量基线 | 没有评测就无法证明有效 | 4-6天 |

**选型理由**：这 4 项直接回答"召回能不能更准"——R-1 自动调参、R-3 防过拟合、R-4 保持嵌入新鲜、S-10 量化验证。四者形成闭环：调优→学习→嵌入→评测。

### T2：质量保障，应该做（提升数据质量，完全在引擎层）

| 编号 | 方案 | 论文 | 核心机制 | 一句话 | 成本 |
|---|---|---|---|---|---|
| S-1+S-3 | 时态+来源 | 综述论文 + TencentDB | 节点加 validFrom/validTo/recordedAt/source 字段 | 让记忆有时间维度和来源标注 | 3-4天 |
| S-13 | 状态追踪 | A-TMA (2026.07) | 节点加 state 字段（current/superseded/transitional），召回时分类标注 | 防止幽灵记忆（新旧事实共存） | 3-4天 |
| S-14 | 过时检测 | Mem0 2026 报告 | 节点加 stalenessScore，召回时降权，与 S-13 矛盾检测协同 | 防止"置信但错误"的检索 | 2-3天 |

**选型理由**：S-1/S-3/S-13/S-14 是 schema 层升级，让图谱有"时间感"和"质量感"。S-1 是 S-13 和 S-14 的前置依赖。

### T3：引擎层扩展（原不入引擎中属于引擎层的 5 项，移除成本/复杂度考量后重新纳入）

以下 5 项在上一版评估中因"成本/复杂度"被排除。重新评估后，它们完全属于引擎层职责范围，应纳入 v2.1.10。

| 编号 | 方案 | 论文 | 核心机制 | 纳入原因 | 依赖 | 成本 |
|---|---|---|---|---|---|---|
| S-4 | 层次化社区 | 综述论文 | 2-3 层社区抽象，自顶向下导航 | 社区检测是引擎层核心能力，层次化是自然延伸 | 当前 community.ts | 3-5天 |
| S-2 | 软替换 | 综述论文 | DETACH DELETE → SET state='superseded' | mergeNodes 是引擎层操作，软删除是其升级 | S-13 状态追踪 | 2-3天 |
| S-5 | 因果关系 | 综述论文 | 新增 CAUSED_BY / LEADS_TO 边类型 | 边类型定义在引擎层，不需要跨轮推理，单轮即可提取 | 当前 extract.ts | 2-3天 |
| L-3 | 边权重调整 | 文章 | 根据裁判反馈调整边 weight | GDS 投影和边权重在引擎层，反馈驱动权重是合理升级 | I-2 裁判反馈 | 3-4天 |
| L-4 | 反向记忆项 | 文章 | 弱化"频繁召回但无效"的节点 | 召回逻辑在引擎层，衰减是 L-2 的扩展 | I-2 裁判反馈 + L-2 衰减 | 2-3天 |

### 编排层（lcm-graph-extra 负责）

以下 4 项的数据/决策不在引擎层，由 lcm-graph-extra 负责（lcm-graph-extra 有独立路线图，不在本项目内维护）。

| 方案 | 论文 | 归属原因 |
|---|---|---|
| S-12 跨轨迹抽象 | From Storage to Experience | 输入是原始对话轨迹，图谱里只有提取后的节点 |
| S-8 记忆回顾总结 | 用户需求 | 自然语言摘要 + UI 展示 |
| S-7 用户画像 | TencentDB L3 | 蒸馏需要对话历史，引擎层提供存储 API |
| R-5 动态混合 | Dynamic Mixture | 场景权重决策在编排层 |

---

## 三、v2.1.10 聚焦方案（T1+T2+T3 共 12 项）

### 架构总览

```
                    ┌──────────────────┐
                    │  R-1 自主调优     │ ← 诊断失败案例，调整召回参数
                    │  (EvolveMem)     │
                    └────────┬─────────┘
                             │ 调优
                    ┌────────▼─────────┐
                    │  R-3 边际效用奖励 │ ← M 矩阵学习，防过拟合
                    │  (UMEM)          │
                    └────────┬─────────┘
                             │ 更新
    ┌───────────────────────┼───────────────────────┐
    │                       │                       │
    ▼                       ▼                       ▼
┌──────────┐    ┌──────────────────┐    ┌──────────────────┐
│ 提取层    │    │ 存储层 (Neo4j)    │    │ 召回层            │
│ extract  │───▶│ + S-1 时态字段    │◀───│ Recaller         │
│ + S-5    │    │ + S-3 来源标记    │    │ + L-1 M 矩阵     │
│ 因果边   │    │ + S-13 状态追踪   │    │ + R-4 可进化嵌入  │
│          │    │ + S-14 过时检测   │    │ + L-4 反向记忆项  │
│          │    │ + S-2 软替换      │    │                  │
└──────────┘    └────────┬─────────┘    └──────────────────┘
                         │
                ┌────────▼─────────┐
                │ 维护层            │
                │ + S-4 层次化社区  │
                │ + L-3 边权重调整  │
                └────────┬─────────┘
                         │
                ┌────────▼─────────┐
                │  S-10 Benchmark   │ ← 量化验证一切
                └──────────────────┘
```

### 补充模块 G：深度能力（v2.1.10 重新核对 13 份资料，按性能/长期价值/用户友好度筛选）

经重新核对 13 份资料并按"长期使用性能、自主进化价值、用户友好度"筛选，保留 4 项，简化 1 项，剔除 1 项（G-1 深度整合，因 LLM 成本高且与 S-4 抽象重复）：

| 编号 | 方案 | 来源 | 核心机制 | 依赖 | 成本 | 决策 |
|---|---|---|---|---|---|---|
| ~~G-1~~ | ~~深度整合阶段~~ | ~~综述+TencentDB L4~~ | ~~周期性 LLM 反思整合~~ | ~~S-4~~ | ~~4-5天~~ | ❌ 剔除：LLM 成本高，与 S-4 抽象重复，长期累积抽象节点污染图谱 |
| G-2 | 冲突消解策略 | A-TMA 三层故障模型 | S-13/S-14 检测矛盾后，纯规则消解：时态优先/来源优先/合并 | S-13+S-14 | 2-3天 | ✅ 保留：S-13/S-14 的逻辑闭环，纯规则无 LLM 成本 |
| G-3 | 重要性评分（importanceScore） | 综述+Mem0 报告 | importanceScore = f(recency, frequency, centrality, source)，与 stalenessScore 互补 | S-1+S-3 | 2-3天 | ✅ 保留：纯计算无 LLM 成本，召回质量直接受益，R-1 自主调优的基础信号 |
| G-4 | 嵌入模型版本化（简化版） | EvoEmbedding 补充 | 仅记录 embeddingModel 字段，模型变更时调 reembed.ts | R-4 | 1天 | ⚠️ 简化：剔除双轨运行/版本化历史，仅加字段+复用 reembed |
| G-5 | 图谱健康指标 | Mem0 报告 | 连通性/密度/聚类系数/孤立节点比例，监控诊断 | 当前 store.ts | 2天 | ✅ 保留：GDS 单次查询性能影响可忽略，运维刚需 |
| G-6 | 冷启动策略 | U-Mem + 自进化文章 | M 矩阵冷启动期用 BM25+向量混合，裁判冷启动期用规则兜底 | L-1+I-2 | 2-3天 | ✅ 保留：解决冷启动期召回慢/不准问题，无 LLM 成本 |

**筛选原则**：
- **保留**：纯计算/纯规则，无 LLM 成本，长期使用性能稳定
- **简化**：剔除过度工程化部分，保留核心价值
- **剔除**：LLM 成本高或与现有机制重复，长期使用反而增加图谱噪声

### 依赖关系

```
S-1 (Bi-Temporal)  ──→  S-13 (状态追踪)  ──→  S-14 (过时检测)  ──→  G-2 (冲突消解)
                     ──→  S-2 (软替换)                              ──→  G-3 (重要性评分)

S-3 (来源标记)     ──→  L-2 (节点衰减)                              ──→  G-3 (重要性评分)

I-2 (裁判反馈)     ──→  L-1 (M 矩阵)    ──→  R-3 (边际效用奖励)    ──→  G-6 (冷启动策略)
                     ──→  L-3 (边权重调整) ──→  R-4 (可进化嵌入)     ──→  G-4 (嵌入迁移)
                     ──→  L-4 (反向记忆项)  ──→  R-1 (自主调优)

S-4 (层次化社区)    ──→  独立

S-5 (因果关系)      ──→  独立

G-5 (图谱健康)      ──→  独立，监控基础

S-10 (Benchmark)   ──→  验证 R-1/R-3/R-4/L-3/L-4/G-2/G-3 的效果
```

---

## 四、详细任务（7 项）

### T1-1：Schema 升级（S-1 Bi-Temporal + S-3 来源标记）

**目标**：让节点有"时间感"和"来源感"。

**新增字段**（全部可选，向后兼容）：

```typescript
interface GmNode {
  // 现有字段...
  validFrom?: number;      // 事件实际发生时间
  validTo?: number;        // 失效时间（null = 仍有效）
  recordedAt: number;      // 写入图的时间（= 当前 createdAt）
  source: "experience" | "knowledge" | "imported";  // 默认 "experience"
  supersededBy?: string;   // 被哪个新版本替代
}
```

**接入点**：[types.ts](file:///workspace/src/types.ts) 类型扩展、[store.ts](file:///workspace/src/store/store.ts) upsertNode 持久化、[extract.ts](file:///workspace/src/extractor/extract.ts) 提取时设置 source

**成本**：3-4 天

---

### T1-2：Schema 升级（S-13 状态追踪 + S-14 过时检测）

**目标**：让节点有"质量感"——知道哪些是当前有效的，哪些已过时。

**新增字段**：

```typescript
interface GmNode {
  state: "current" | "superseded" | "transitional";  // 默认 "current"
  stalenessScore: number;  // 0~1，0=新鲜，1=过时，默认 0
}
```

**S-13 状态追踪**：
- 节点 merge 时，旧节点 state → `superseded`，新节点 state → `current`
- 召回时按 state 分类标注："以下信息当前有效""以下信息已过时"
- 依赖 S-1 的 validTo 字段自动推导 state

**S-14 过时检测**：
- 维护周期计算 stalenessScore：内容与最新对话的矛盾程度、state 变更频率
- 过时节点（stalenessScore > 0.7）在召回时降权
- 默认 heuristic 模式（规则引擎），可选 LLM 模式

**接入点**：[types.ts](file:///workspace/src/types.ts) 类型扩展、[store.ts](file:///workspace/src/store/store.ts) mergeNodes 设置 state、[maintenance.ts](file:///workspace/src/graph/maintenance.ts) 新增过时检测阶段、[recall.ts](file:///workspace/src/recaller/recall.ts) 召回时按 state/stalenessScore 分类

**成本**：5-7 天（S-13 3-4天 + S-14 2-3天）

---

### T1-3：反馈闭环（I-1 缓存 + I-2 裁判 + I-3 持久化）

**目标**：建立"召回→使用→反馈→改进"的闭环。

**I-1 历史查询缓存**：
- LRU 缓存（maxSize=100, TTL=30min）
- 相同 query 直接返回，相似 query（cosine > 0.95）加权返回
- 接入 [recall.ts](file:///workspace/src/recaller/recall.ts) recall() 入口

**I-2 LLM 裁判反馈**（仅 Tier 1 启发式规则，Tier 2/3 在 lcm-graph-extra）：
- 异步运行，不阻塞召回
- 启发式规则：节点是否在 assistant 回复中被引用（字符串匹配）
- 输出：usedNodeIds / unusedNodeIds
- 接入 [recall.ts](file:///workspace/src/recaller/recall.ts) 召回后

**I-3 反馈持久化**：
- 新增 `GmFeedback` 节点类型，存储到 Neo4j
- Schema：`{ query, recalledNodeIds, usedNodeIds, timestamp, sessionId }`
- 接入 [store.ts](file:///workspace/src/store/store.ts) 新增 upsertFeedback

**成本**：3-5 天

---

### T1-4：在线学习（L-1 关联矩阵 M + R-3 边际效用奖励）

**目标**：让 M 矩阵越用越准，且不过拟合。

**L-1 关联矩阵 M**（来自文章进化出的算法）：
```
query_vec → BatchNorm → M @ vec + bias → × gain × row_scale → 向量搜索
```

- M 初始单位矩阵，维度 = embedding.dimensions（默认 1024）
- 学习规则：Hebbian（强化正确）+ Momentum（平滑）+ Adam（自适应）
- 冷启动：累计 100 次反馈后启用
- 接入 [recall.ts](file:///workspace/src/recaller/recall.ts) 向量搜索前

**R-3 边际效用奖励**（升级 L-1 的奖励计算）：
- 语义邻域：找到与当前 query 相似的 N 个历史 query（N=5）
- 在邻域上评估 M 更新的边际效用
- 只在邻域整体提升时更新 M（避免过拟合到单一案例）
- 接入 [recall.ts](file:///workspace/src/recaller/recall.ts) M 矩阵更新逻辑

**成本**：6-9 天（L-1 4-5天 + R-3 2-4天，L-1 和 R-3 紧密耦合，建议一起实现）

---

### T1-5：可进化嵌入（R-4）

**目标**：节点 content 更新时自动重算嵌入，解决静态嵌入时效性问题。

**实现要点**：
- upsertNode 时检测 content 是否实质变化（MD5 hash 对比）
- 变化时触发重新嵌入，旧嵌入存档（embeddingHistory）
- 冲突消解：新事实与旧事实矛盾时，新嵌入覆盖旧嵌入
- 与 S-1 Bi-Temporal 协同：旧嵌入的 validTo 自动设置

**接入点**：[store.ts](file:///workspace/src/store/store.ts) upsertNode 嵌入演化、[embed.ts](file:///workspace/src/engine/embed.ts) 支持版本化嵌入、[reembed.ts](file:///workspace/src/graph/reembed.ts) 批量重嵌入时考虑冲突消解

**成本**：3-4 天

---

### T1-6：自主调优（R-1 EvolveMem）

**目标**：召回参数不再由人工配置，LLM 自动诊断失败案例并调优。

**EvolveMem 四步循环**：

1. **EVALUATE**：在 Benchmark（S-10）上评估当前配置
2. **DIAGNOSE**：LLM 读取失败案例，归类根因（"向量搜索过多噪声""PPR 深度不足"）
3. **PROPOSE**：LLM 提出配置调整（如"recallMaxNodes 6→10"）
4. **GUARD**：revert-on-regression（退步→回退）+ explore-on-stagnation（停滞→探索）

**动作空间**（结构化）：

```typescript
interface EvolveActionSpace {
  recallMaxNodes: number;         // 3-15
  recallMaxDepth: number;         // 1-4
  pagerankDamping: number;        // 0.7-0.95
  pagerankIterations: number;     // 10-50
  dedupThreshold: number;         // 0.80-0.98
  freshTailCount: number;         // 5-20
  associativeLearningRate: number; // 0.001-0.1
  vectorSearchTopK: number;       // 5-30
}
```

**安全护栏**：
- revert-on-regression：退步 > 2pp → 自动回退
- explore-on-stagnation：连续 5 轮无改进 → 探索新维度
- 配置版本快照：每次变更存档，可回溯

**接入点**：新增 [src/evolution/diagnose.ts](file:///workspace/src/evolution/diagnose.ts)、[src/evolution/action_space.ts](file:///workspace/src/evolution/action_space.ts)、[src/evolution/guard.ts](file:///workspace/src/evolution/guard.ts)、[maintenance.ts](file:///workspace/src/graph/maintenance.ts) 维护周期末尾触发诊断

**成本**：5-7 天

---

### T1-7：Benchmark 评估（S-10）

**目标**：建立标准评测体系，量化验证 T1-1~T1-6 的效果。

**评测数据集**：

| Benchmark | 规模 | 类别 | 目标 |
|---|---|---|---|
| LoCoMo | 1,540 题 | 单跳/多跳/开放域/时序 | P@1 > 50% |
| LongMemEval | 500 题 | 6 类（含知识更新/多会话） | 时序 F1 可用 |

**评估指标**：P@1、P@3、MRR、F1、Latency P99、Token 消耗

**新增脚本**：`npm run benchmark` → 运行全量评测，输出报告

**接入点**：新增 [benchmarks/locomo.ts](file:///workspace/benchmarks/locomo.ts)、[benchmarks/longmemeval.ts](file:///workspace/benchmarks/longmemeval.ts)

**成本**：4-6 天

---

### T3-1：层次化社区（S-4）

**目标**：在现有单层社区检测上叠加 2-3 层抽象，形成社区→主题→领域的层次树。

**实现要点**：
- 在 community.ts 中新增 `detectHierarchicalCommunities(driver, depth=3)`
- 每层：将上一层社区代表节点作为输入，再次运行 Label Propagation
- 社区代表节点：该社区中 PageRank 最高的节点
- 召回时支持自顶向下导航：从顶层社区钻取到底层节点

**接入点**：[src/graph/community.ts](file:///workspace/src/graph/community.ts) 新增函数、[src/recaller/recall.ts](file:///workspace/src/recaller/recall.ts) 召回时钻取

**成本**：3-5 天

---

### T3-2：软替换（S-2）

**目标**：mergeNodes 时保留旧节点（标记为 superseded），而非物理删除。

**前置条件**：S-13 状态追踪已落地。

**实现要点**：
- mergeNodes Phase 6：将 `DETACH DELETE` 改为 `SET n.state = 'superseded', n.validTo = timestamp()`
- 所有查询（store.ts 约 20+ 处）添加 `WHERE n.state IS NULL OR n.state = 'current'` 过滤
- 旧节点的边保留，但 weight 降为 0.1（不参与 GDS 计算）

**接入点**：[src/store/store.ts](file:///workspace/src/store/store.ts) mergeNodes 修改、所有 MATCH 查询加 state 过滤

**成本**：2-3 天

---

### T3-3：因果关系（S-5）

**目标**：新增 CAUSED_BY（EVENT→EVENT）和 LEADS_TO（TASK→EVENT）边类型。

**实现要点**：
- [types.ts](file:///workspace/src/types.ts) EdgeType 枚举新增 `CAUSED_BY`、`LEADS_TO`
- [extract.ts](file:///workspace/src/extractor/extract.ts) 提取 prompt 新增因果识别规则
- [pagerank.ts](file:///workspace/src/graph/pagerank.ts) ALL_REL_TYPES 新增
- [community.ts](file:///workspace/src/graph/community.ts) ALL_REL_TYPES 新增
- [maintenance.ts](file:///workspace/src/graph/maintenance.ts) deriveRelatesFromMentions 适配

**提取规则**：因果边不需要跨轮推理。"因为 X 所以 Y"的因果链在单轮对话中即可识别——LLM 判断"这个消息里的事件 A 直接导致了事件 B"。

**接入点**：5 个文件（types.ts/extract.ts/pagerank.ts/community.ts/maintenance.ts）

**成本**：2-3 天

---

### T3-4：边权重调整（L-3）

**目标**：根据 I-2 裁判反馈，调整边的 weight。

**实现要点**：
- 维护周期新增边权重调整阶段
- 规则：被裁判标记为"有效"的召回路径上的边 weight × 1.1，未使用的边 weight × 0.95
- 与 GDS 投影协同：边权重调整后，在下一个维护周期重建投影时生效（不是每次调整都重建）
- 冷启动：初始所有边 weight = 1.0，累计 100 次反馈后启用

**接入点**：[src/graph/maintenance.ts](file:///workspace/src/graph/maintenance.ts) 新增阶段、[src/store/store.ts](file:///workspace/src/store/store.ts) 新增 updateEdgeWeight

**成本**：3-4 天

---

### T3-5：反向记忆项（L-4）

**目标**：弱化"频繁召回但从未被裁判标记为有效"的节点。

**实现要点**：
- 维护周期计算每个节点的"召回频次 vs 有效频次"比值
- 比值 > 10（召回 10 次以上但从未有效）→ stalenessScore += 0.1
- 与 S-14 过时检测协同：stalenessScore 高的节点在召回时降权
- 冷启动：累计 100 次反馈后启用

**接入点**：[src/graph/maintenance.ts](file:///workspace/src/graph/maintenance.ts) 新增阶段、[src/recaller/recall.ts](file:///workspace/src/recaller/recall.ts) 召回时降权

**成本**：2-3 天

---

### G-1：~~深度整合阶段~~（已剔除）

**剔除原因**：
1. **LLM 成本高**：每个社区都需要一次 LLM 调用做反思整合
2. **与 S-4 抽象重复**：S-4 层次化社区已提供抽象层，再叠加 LLM 反思属于过度抽象
3. **污染图谱**：长期使用累积大量"抽象节点"，反而增加召回噪声
4. **收益不确定**：抽象节点对召回质量提升无直接证据

---

### G-2：冲突消解策略

**目标**：S-13/S-14 检测到矛盾后，明确消解策略，而非仅标注。

**A-TMA 三层故障模型对应**：

| 层 | 故障 | 当前实现 | 本任务 |
|---|---|---|---|
| Perception | 检测矛盾 | S-13 state + S-14 staleness | 已实现 |
| Cognition | 理解矛盾原因 | 缺 | **本任务** |
| Action | 修复/消解 | 缺 | **本任务** |

**消解策略**（按优先级）：

1. **时态优先**（默认）：validFrom 更新的胜出，旧节点 state → superseded
2. **来源优先**：source=knowledge 优先于 source=experience（外部权威 > 个人经验）
3. **置信度优先**：validatedCount 高的胜出
4. **合并**：LLM 判断两节点是否可合并为更完整的描述

**实现要点**：
- 在 maintenance.ts 新增 conflictResolution 阶段
- 扫描 S-13 标注的 transitional 节点对
- 按上述策略消解，写入消解决策日志（GmDecision 节点）

**接入点**：[src/graph/maintenance.ts](file:///workspace/src/graph/maintenance.ts) 新增阶段、[src/store/store.ts](file:///workspace/src/store/store.ts) 新增 upsertDecision

**成本**：2-3 天

---

### G-3：重要性评分（importanceScore）

**目标**：节点除了 stalenessScore（新鲜度），还需要 importanceScore（价值），二者互补。

**计算公式**：

```
importanceScore = 0.3 × recency + 0.3 × frequency + 0.2 × centrality + 0.2 × source

- recency: 1 - min(age/days, 30) / 30  // 30 天衰减
- frequency: min(validatedCount / 10, 1)  // 10 次饱和
- centrality: pagerank / max_pagerank  // 归一化
- source: knowledge=1.0, experience=0.7, imported=0.5
```

**实现要点**：
- 每个维护周期重新计算 importanceScore
- 召回时按 `score × importanceScore × (1 - stalenessScore)` 加权排序
- 与 L-4 反向记忆项协同：importanceScore 持续低于阈值 → 进入观察列表

**接入点**：[src/types.ts](file:///workspace/src/types.ts) 新增 importanceScore 字段、[src/graph/maintenance.ts](file:///workspace/src/graph/maintenance.ts) 计算阶段、[src/recaller/recall.ts](file:///workspace/src/recaller/recall.ts) 召回排序

**成本**：2-3 天

---

### G-4：嵌入模型版本化（简化版）

**目标**：嵌入模型升级时（如 nomic → v2），能识别并触发迁移。

**简化方案**（剔除原 G-4 的双轨运行/版本化历史/迁移检测）：
- 仅在节点上添加 `embeddingModel` 字段（存储嵌入时的模型名）
- 配置变更时，对比配置的 model 与节点存储的 embeddingModel
- 不一致时，调用现有 `reembed.ts` 全量重嵌入
- 无需双轨运行：迁移期间直接重嵌入，旧嵌入被覆盖

**接入点**：[src/types.ts](file:///workspace/src/types.ts) 新增 embeddingModel 字段、[src/graph/reembed.ts](file:///workspace/src/graph/reembed.ts) 检测逻辑

**成本**：1 天

---

### G-5：图谱健康指标

**目标**：监控/诊断基础，提供图谱级健康指标。

**指标清单**：

| 指标 | 计算 | 健康范围 |
|---|---|---|
| 节点总数 | count(n) | 增长趋势 |
| 边总数 | count(r) | 与节点比 1-5 |
| 孤立节点比例 | 无边的节点 / 总节点 | < 20% |
| 连通分量数 | GDS wcc.stream | 趋势稳定 |
| 平均聚类系数 | GDS localClusteringCoefficient | 0.1-0.5 |
| 图密度 | 2×edges / (nodes×(nodes-1)) | 0.01-0.2 |
| 社区数 | detectCommunities.count | 与节点比 1:10-1:100 |
| 过时节点比例 | stalenessScore > 0.7 的节点 | < 30% |

**实现要点**：
- 维护周期末尾计算并存储到 `GmHealth` 节点
- HTTP API `/api/health` 暴露
- 异常指标告警（如孤立节点比例突增）

**接入点**：[src/graph/maintenance.ts](file:///workspace/src/graph/maintenance.ts) 新增 healthCheck 阶段、[src/routes/crud.ts](file:///workspace/src/routes/crud.ts) 新增 `/api/health`

**成本**：2 天

---

### G-6：冷启动策略

**目标**：M 矩阵和裁判在反馈数据不足时的兜底策略。

**M 矩阵冷启动**（前 100 次反馈）：
- M = 单位矩阵（无变换）
- 召回使用 BM25 + 向量搜索混合（BM25 权重 0.4，向量 0.6）
- 累计 100 次反馈后，开始训练 M

**裁判冷启动**（前 50 次反馈）：
- 不调用 LLM，使用纯规则：节点 id 出现在 assistant 回复中 → 有效
- 累计 50 次后，启用 LLM 裁判

**实现要点**：
- 配置项：`warmupFeedbacks: 100`（M 矩阵）、`judgeWarmupFeedbacks: 50`（裁判）
- 冷启动期日志明确标注 `[cold-start]`
- 冷启动期不触发 R-1 自主调优

**接入点**：[src/recaller/recall.ts](file:///workspace/src/recaller/recall.ts) 冷启动分支、[src/recaller/judge.ts](file:///workspace/src/recaller/judge.ts) 冷启动规则

**成本**：2-3 天

---

## 五、实施顺序

### 第一批：Schema 升级 + 监控基础（无依赖，可并行）

```
S-1 + S-3  ──→  S-13 + S-14
S-5 (因果关系，独立)
G-5 (图谱健康，独立)
```

**产出**：types.ts 扩展 8 个字段 + 2 种边类型 + 健康指标 API

### 第二批：反馈闭环 + 冷启动（依赖第一批的 S-1）

```
I-1 ──→  I-2 ──→  I-3
G-6 (冷启动策略，与 I-2 协同)
```

**产出**：缓存层 + 启发式裁判 + 反馈持久化 + 冷启动兜底

### 第三批：学习能力 + 重要性（依赖第二批的 I-2/I-3）

```
L-1 + R-3  ──→  R-4
G-3 (重要性评分，与 L-2 协同)
```

**产出**：M 矩阵 + 边际效用奖励 + 可进化嵌入 + 重要性评分

### 第四批：结构升级 + 冲突消解 + 嵌入版本（依赖第一/二/三批）

```
S-13 ──→ S-2 (软替换，依赖 S-13)
S-4 (层次化社区，独立)
S-13 + S-14 ──→  G-2 (冲突消解，依赖状态+过时)
R-4 ──→  G-4 (嵌入版本字段，依赖 R-4)
L-3 (边权重调整，依赖 I-2)
L-4 (反向记忆项，依赖 I-2 + L-2)
```

**产出**：层次化社区 + 软替换 + 边权重 + 反向记忆 + 冲突消解 + 嵌入版本字段

### 第五批：验证闭环（依赖前面所有）

```
S-10 ──→  R-1
```

**产出**：Benchmark 基线 → 自主调优 → Benchmark 验证提升

---

## 六、配置总览

```json
{
  "plugins": {
    "entries": {
      "graph-memory-pro": {
        "config": {
          "neo4j": { /* 现有 */ },
          "llm": { /* 现有 */ },
          "embedding": { /* 现有 */ },

          "temporal": {
            "enabled": false,
            "source": "experience"
          },

          "state": {
            "enabled": false,
            "tracking": true
          },

          "staleness": {
            "enabled": false,
            "threshold": 0.7,
            "mode": "heuristic"
          },

          "queryCache": {
            "enabled": true,
            "maxSize": 100,
            "ttlMs": 1800000,
            "similarityThreshold": 0.95
          },

          "judge": {
            "enabled": false,
            "asyncMode": true,
            "tier": 1
          },

          "associative": {
            "enabled": false,
            "dimensions": 1024,
            "learningRate": 0.01,
            "warmupFeedbacks": 100,
            "algorithm": "adam"
          },

          "marginalUtility": {
            "enabled": false,
            "neighborhoodSize": 5,
            "updateThreshold": 0.05
          },

          "evoEmbedding": {
            "enabled": false,
            "reembedOnContentChange": true,
            "conflictDetection": true,
            "keepHistoryVersions": 5
          },

          "evolve": {
            "enabled": false,
            "intervalRounds": 10,
            "revertThreshold": 0.02,
            "stagnationRounds": 5
          },

          "benchmark": {
            "enabled": false,
            "dataset": "locomo",
            "outputDir": "benchmarks/results"
          },

          "hierarchicalCommunity": {
            "enabled": false,
            "depth": 3,
            "minMembersPerCommunity": 3
          },

          "softDelete": {
            "enabled": false
          },

          "causalEdges": {
            "enabled": false,
            "extract": true
          },

          "edgeWeightTuning": {
            "enabled": false,
            "warmupFeedbacks": 100,
            "boostFactor": 1.1,
            "decayFactor": 0.95
          },

          "inverseMemory": {
            "enabled": false,
            "warmupFeedbacks": 100,
            "stalenessIncrement": 0.1,
            "triggerRatio": 10
          },

          "consolidation": {
            "enabled": false,
            "note": "G-1 已剔除，深度整合由 S-4 层次化社区 + G-3 重要性评分覆盖"
          },

          "conflictResolution": {
            "enabled": false,
            "strategy": "temporal",
            "logDecisions": true
          },

          "importance": {
            "enabled": false,
            "weights": {
              "recency": 0.3,
              "frequency": 0.3,
              "centrality": 0.2,
              "source": 0.2
            }
          },

          "embeddingMigration": {
            "enabled": false,
            "note": "简化版：仅加 embeddingModel 字段，模型变更时调 reembed.ts"
          },

          "graphHealth": {
            "enabled": true,
            "alertOnAnomaly": true
          },

          "coldStart": {
            "warmupFeedbacks": 100,
            "judgeWarmupFeedbacks": 50,
            "fallbackToBM25": true
          }
        }
      }
    }
  }
}
```

---

## 七、T3 编排层协作（不在本版本实施，仅预留 API）

以下能力在 v2.1.10 中**仅提供引擎层基础 API**，完整实现在 lcm-graph-extra：

| API | 用途 | 消费方 |
|---|---|---|
| `consolidateBuffer(nodes: GmNode[]): Promise<string[]>` | 将情节缓冲中的节点整合到全局图谱 | lcm-graph-extra S-9 |
| `linkNodes(fromId, toId, type): Promise<void>` | 创建语义链接 | lcm-graph-extra S-11 |
| `evolveNode(id, updates): Promise<void>` | 触发节点演化 | lcm-graph-extra S-11 |
| `judgeRecall(query, nodes, response): JudgeResult` | 启发式召回质量评估（Tier 1） | lcm-graph-extra R-2 |

---

## 八、关键风险与对策

| 风险 | 对策 |
|---|---|
| M 矩阵过拟合 | R-3 语义邻域 + 边际效用奖励，只在邻域整体提升时更新 |
| 自主调优回退 | R-1 revert-on-regression 自动回退上一稳定配置 |
| 嵌入演化历史膨胀 | R-4 限制 keepHistoryVersions=5 |
| Schema 演进破坏旧数据 | 所有新字段可选，向后兼容 |
| 裁判反馈延迟/缺失 | 无反馈时不更新 M |
| Benchmark 数据集不能直接用于 Neo4j | 提供适配层，将对话转为 graph-memory 提取格式 |
| 过时检测假阳性 | 默认 heuristic 模式，LLM 模式可选 |
| 幽灵记忆状态标注不准 | 基于 S-1 的 validTo 自动推导 state |

---

## 九、验收标准

### 功能验收

- [x] S-1+S-3：节点有 validFrom/validTo/recordedAt/source 字段
- [x] S-13：节点有 state 字段，召回时按 current/superseded 分类
- [x] S-14：节点有 stalenessScore，过时节点在召回中降权
- [x] I-1：相同 query 第二次延迟 < 10ms
- [x] I-2：启发式裁判异步运行，准确率 > 80%
- [x] I-3：反馈数据可查询
- [x] L-1+R-3：M 矩阵冷启动后启用，邻域评估后更新
- [x] R-4：节点 content 变更触发重嵌入，冲突可检测
- [x] R-1：诊断循环可运行，revert-on-regression 生效
- [x] S-10：LoCoMo P@1 > 50%，npm run benchmark 可运行

### 性能验收

- [ ] 召回延迟 P99 < 500ms（含缓存命中）— 待发布 v2.3.0 benchmark 基线报告
- [x] 维护周期不因新阶段显著延长（< 30%）
- [x] M 矩阵内存占用 < 50MB
- [x] R-1 诊断循环单次 < 30s
- [x] R-4 嵌入重算仅在 content 实质变化时触发

### 兼容性验收

- [x] 旧数据（无新字段）可正常读写
- [x] 关闭新功能时行为与 v2.2.0 一致
- [x] 现有 HTTP API 不破坏向后兼容
- [x] 现有 Re-exports 接口不变

---

## 十、参考资料

### 核心文献（T1 直接引用）

- **EvolveMem** (arxiv 2605.13941) — 自主调优动作空间 + 诊断循环
- **UMEM** (arxiv 2602.10652) — 边际效用奖励 + 语义邻域
- **EvoEmbedding** (南京大学 2026.06) — 可进化嵌入
- **Mem0 State of AI Agent Memory 2026** — Benchmark 全景 + 过时检测

### 质量文献（T2 直接引用）

- **Graph-based Agent Memory** (arxiv 2602.05665) — Bi-Temporal 建模
- **A-TMA** (2026.07) — 幽灵记忆三层故障模型 + 状态追踪

### 编排层文献（T3 预留 API）

- **GAM** (ACL 2026) — 情节缓冲与语义整合分离
- **A-MEM** (NeurIPS 2025) — Zettelkasten 四步闭环
- **U-Mem** (arxiv 2602.22406) — 成本感知提取级联

### 实践参考

- **自进化记忆系统文章**（方治宇 2026.03）— M 矩阵 + 进化框架
- **TencentDB Agent Memory** — L1-L3 层次沉淀（仅取 L1 原子事实提取）

### 项目内相关文件

- [src/types.ts](file:///workspace/src/types.ts) — S-1/S-3/S-13/S-14 schema 接入
- [src/store/store.ts](file:///workspace/src/store/store.ts) — 所有 schema 持久化
- [src/recaller/recall.ts](file:///workspace/src/recaller/recall.ts) — I-1/I-2/L-1/R-3/R-4 接入
- [src/graph/maintenance.ts](file:///workspace/src/graph/maintenance.ts) — S-14/R-1 接入
- [src/engine/embed.ts](file:///workspace/src/engine/embed.ts) — R-4 接入
- [src/extractor/extract.ts](file:///workspace/src/extractor/extract.ts) — S-3 接入
- [index.ts](file:///workspace/index.ts) — Re-exports 接口

---

## 十一、版本信息

- **规划版本**：2.1.10
- **基于版本**：2.2.0（当前已发布）
- **规划日期**：2026-07-04
- **模块定位**：记忆底层引擎——图内操作
- **上层编排**：lcm-graph-extra
- **T1 核心方案**：自主调优 + 边际效用奖励 + 可进化嵌入 + Benchmark（4 项）
- **T2 质量方案**：Schema 升级（时态/来源/状态/过时）（3 项）
- **T3 引擎扩展**：层次化社区 + 软替换 + 因果关系 + 边权重 + 反向记忆（5 项）
- **G 深度能力**：冲突消解 + 重要性评分 + 嵌入版本（简化）+ 图谱健康 + 冷启动（5 项，G-1 深度整合已剔除）
- **编排层**：12 项由 lcm-graph-extra 负责（G-7/G-12 已剔除，G-8 已简化），lcm-graph-extra 有独立路线图
- **预计实施周期**：5 批次，约 60-75 天