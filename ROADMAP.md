# Graph Memory Pro 演进路线图

> 版本：2.1.10
> 模块定位：**记忆底层引擎**——图内操作（提取/存储/检索/去重/维护/质量优化/自主进化）
> 上层编排（上下文管理、prompt组装、Agent工作流、用户界面）由 **lcm-graph-extra** 负责
> 基于 15 篇文献/项目横评，聚焦 T1 引擎核心 + T2 质量保障，不入编排层

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

### T3：编排层协作（引擎层提供基础 API，编排逻辑在 lcm-graph-extra）

| 方案 | 引擎层提供 | lcm-graph-extra 实现 |
|---|---|---|
| S-9 GAM 情节缓冲 | `consolidateBuffer(nodes)` API | 缓冲管理、语义边界检测、触发策略 |
| S-11 A-MEM Zettelkasten | `linkNodes(fromId, toId, type)` / `evolveNode(id)` API | Note 构建、Link 触发策略、Evolve 调度 |
| S-6 场景隔离 | `sceneId` 字段 | 场景划分、隔离策略、跨场景关联 |
| R-2 U-Mem 级联 | `judgeRecall()` 启发式规则（Tier 1） | Tier 2/3 级联决策、Thompson 采样 |

### 不入引擎：逐项详细说明

以下 9 项被评估为不入本版本引擎层，每项按"方案价值 → 为什么不在引擎层做 → 如果要做应该在哪做 → 引擎层能提供什么"四段分析。

---

#### S-12 跨轨迹抽象（From Storage to Experience 论文）

**方案价值**：从多个独立对话中发现"这个问题多次出现"的固定模式，蒸馏为经验节点，提升召回。

**为什么不在引擎层做**：跨轨迹抽象的核心输入是**原始对话轨迹**（conversation transcripts），不是图谱节点。论文的 Storage→Reflection→Experience 三阶段中，Storage 和 Reflection 需要访问完整的对话历史、消息序列、用户反馈——这些数据不在 Neo4j 图谱中，而在宿主系统（lcm-graph-extra）的对话管理模块中。引擎层只看到提取后的节点，看不到原始对话，无法做模式发现。

**如果要做应该在哪做**：lcm-graph-extra。它管理对话生命周期，拥有完整的对话历史，是跨对话模式发现的天然位置。发现模式后，可通过 `upsertNode` 将经验节点写入图谱。

**引擎层能提供什么**：提供 `createExperienceNode(pattern)` API，接收编排层蒸馏好的经验模式，存入图谱。引擎层不负责蒸馏，只负责存储。

---

#### S-8 记忆回顾总结

**方案价值**：支持"本周学会了什么""今年有什么特别记忆"等人类可读的记忆回顾。

**为什么不在引擎层做**：回顾总结的四个环节——①自然语言查询理解（"本周"→时间范围、 "学会了什么"→语义意图）②时间范围聚合（需要理解对话上下文而非节点时间戳）③LLM 生成自然语言摘要（编排层职责）④展示界面（UI）——全部在编排层。引擎层能做的只是"查询某个时间范围内的节点"，但用户说"本周"时，需要编排层知道当前对话的上下文时间。

**如果要做应该在哪做**：lcm-graph-extra。它管理对话会话，知道"当前是第几周"，能调用 `Recaller.searchNodes` 获取数据，再用 LLM 生成摘要。TencentDB 的"本周总结"功能就是在编排层实现的。

**引擎层能提供什么**：`getNodesByTimeRange(from, to)` API，按 createdAt/recordedAt 过滤节点。这是纯数据查询，不涉及摘要生成。

---

#### S-7 用户画像（TencentDB L3）

**方案价值**：从历史对话中蒸馏用户偏好（技术栈、代码风格、工作习惯），用于个性化召回。

**为什么不在引擎层做**：画像蒸馏需要三个条件——①完整的对话历史（而非仅提取后的节点）②跨会话的用户行为追踪（同一个用户在不同会话中的偏好一致性）③偏好变化的时态建模（"上个月喜欢 React，这个月转向 Vue"）。这三项数据都不在 Neo4j 图谱中。图谱只存储提取后的 TASK/SKILL/EVENT 节点，没有原始对话，没有用户身份映射，没有行为序列。

**如果要做应该在哪做**：lcm-graph-extra。它管理用户会话，追踪用户行为，可以在对话间隙蒸馏画像。蒸馏完成后，将画像存储为 `GmProfile` 节点写入图谱（引擎层提供 `upsertProfile` API），召回时通过 `Recaller` 的 `profileWeight` 参数影响召回排序。

**引擎层能提供什么**：
- `upsertProfile(profile)` — 存储画像节点
- `getProfile(userId)` — 查询画像
- `Recaller` 支持 `profileWeight` 参数 — 召回时按画像偏好加权

---

#### S-4 层次化社区

**方案价值**：在现有单层社区检测上叠加 2-3 层抽象，形成社区→主题→领域的层次树，支持自顶向下导航召回。

**为什么不在引擎层做**：三个原因——

1. **计算成本线性增长**：每层社区检测需要一次 GDS graph.project + labelPropagation.stream，当前单层已耗时数秒，3 层意味着 3 倍时间。GDS 投影创建是 Neo4j 中最昂贵的操作之一。

2. **收益不确定**：当前单层社区检测已满足召回需求（community.ts 的 `getCommunityPeers` 和 `summarizeCommunities`）。层次化社区的额外价值在于"自顶向下导航"，但 graph-memory-pro 的召回路径是"精确召回→图游走→PPR→社区补充"，不是"从顶层社区向下钻取"。要利用层次化，需要重构整个召回链路——这属于架构变更，不属于功能增强。

3. **当前社区层数已够用**：单层社区在 100-1000 节点规模下已能提供有效的聚类。层次化社区在 10000+ 节点规模下才有显著优势，而 graph-memory-pro 的典型部署规模在 1000-5000 节点。

**如果要做应该在哪做**：在 graph-memory-pro 的社区检测模块中做，但属于 v3.0.0 架构升级，不适合 v2.1.10 功能增强。

**引擎层能提供什么**：当前 `detectCommunities` + `summarizeCommunities` 已提供单层社区能力。层次化是同一个模块的升级，但需要更大的版本跨度。

---

#### S-2 软替换（替代 DETACH DELETE）

**方案价值**：mergeNodes 时保留旧节点（标记为 superseded），而非物理删除，支持历史回溯。

**为什么不在引擎层做**：三个原因——

1. **查询复杂度全面上升**：当前所有查询（`MATCH (n:Task|Skill|Event)`）不需要过滤 state。引入软删除后，每个查询都要加 `WHERE n.state = 'current'` 或 `WHERE n.state IS NULL OR n.state = 'current'`（兼容旧数据）。这涉及 store.ts 中约 20+ 处 Cypher 查询的修改，且容易遗漏。

2. **与 S-13 部分重叠**：S-13 已经引入了 state 字段（current/superseded/transitional）。如果 S-13 已实现，软替换就是 state 的自然延伸。但 S-13 的 state 是标注当前节点的状态，而软替换要求旧节点保留并标记——这需要修改 mergeNodes 的核心逻辑（当前是 DETACH DELETE），还要处理旧节点的边如何处理（一并保留？重新连线到新节点？）。

3. **当前方案可接受**：mergeNodes 的 DETACH DELETE 配合 S-13 的 state 追踪，已经能区分"当前有效"和"已被替代"。如果未来需要完整的历史回溯，可以在 S-13 稳定后，将 DETACH DELETE 改为 SET state = 'superseded'——这是一个小改动，但需要 S-13 先行。

**如果要做应该在哪做**：在 graph-memory-pro 的 mergeNodes 中做，但需要 S-13 先落地、查询全部适配后。建议放在 v2.2.0 而非 v2.1.10。

**引擎层能提供什么**：S-13 的 state 字段已经为软替换打下了基础。v2.1.10 完成后，S-2 的改动量很小（改 mergeNodes 中一行 Cypher + 给所有查询加 state 过滤）。

---

#### S-5 因果关系（CAUSED_BY / LEADS_TO）

**方案价值**：新增两种边类型，表达"事件 A 导致事件 B"（CAUSED_BY，EVENT→EVENT）和"任务导致事件"（LEADS_TO，TASK→EVENT），支持故障溯源场景。

**为什么不在引擎层做**：两个原因——

1. **提取难度与收益不匹配**：当前 6 种关系类型（USED_SKILL、SOLVED_BY、REQUIRES、PATCHES、CONFLICTS_WITH、RELATES_TO）的提取依赖 LLM 从对话中识别。因果关系需要 LLM 理解"因为 A 所以 B"的因果链，这在单轮对话中很少出现——多数因果链跨越多轮对话，需要上下文理解。在不引入跨轮推理的情况下，提取准确率极低。

2. **涟漪效应大**：新增边类型需要修改 5 个文件——extract.ts（提取 prompt 和验证）、pagerank.ts（ALL_REL_TYPES）、community.ts（ALL_REL_TYPES）、maintenance.ts（deriveRelatesFromMentions）、types.ts（EdgeType 枚举）。每个文件改动不大，但验证成本高（需要确认 GDS 投影、PageRank 计算、社区检测在新边类型下行为正确）。

**如果要做应该在哪做**：在 graph-memory-pro 的 extract.ts 中做（边类型定义在引擎层），但需要先验证提取准确率。建议在 S-10 Benchmark 建立后，用评测数据验证因果关系提取的准确率，再决定是否引入。

**引擎层能提供什么**：当前 6 种关系类型已覆盖核心场景。如果用户反馈"故障溯源"是高频需求，可以在 v2.2.0 中引入。

---

#### R-5 动态记忆混合（Dynamic Mixture of Latent Memories 论文）

**方案价值**：把场景隔离从"二值"（全局/本场景）升级为"动态加权混合"（70% 本场景 + 20% 相似场景 + 10% 全局）。

**为什么不在引擎层做**：动态混合的核心决策——"哪些场景相关、各自权重多少"——是编排层逻辑。引擎层不知道"当前用户在哪个场景""哪些场景相似""权重应该怎么分配"。这些信息来自 lcm-graph-extra 的会话管理。

**如果要做应该在哪做**：lcm-graph-extra。它知道当前场景，可以调用 `Recaller` 多次（每次传不同 sceneId 和 weight），然后合并结果。引擎层提供按 sceneId 过滤的能力，编排层做混合决策。

**引擎层能提供什么**：`sceneId` 字段 + `Recaller` 支持 `sceneId` 参数。动态混合是编排层对引擎层 API 的组合调用。

---

#### L-3 边权重调整

**方案价值**：根据 I-2 裁判反馈，调整边的 weight（被用到的边加权重，未被用到的边减权重）。

**为什么不在引擎层做**：两个原因——

1. **权重调整需要重建 GDS 投影**：边的 weight 影响 PageRank 和社区检测。调整 weight 后，GDS 投影需要重建（或至少重新计算）。GDS 投影创建是 Neo4j 中最昂贵的操作之一，频繁重建会导致维护周期显著延长。

2. **反馈信号稀疏**：边的反馈信号比节点稀疏得多。用户可能 100 次召回中只有 5 次需要特定的边，导致边权重调整的统计显著性不足。在反馈稀疏的情况下，边权重调整的噪声比信号大。

**如果要做应该在哪做**：在 graph-memory-pro 的 maintenance.ts 中做，但需要反馈数据积累到足够量（建议至少 500 次裁判反馈），且需要设计增量更新机制（避免每次重建投影）。

**引擎层能提供什么**：当前维护周期已包含 PageRank 和社区检测。边权重调整是这两个模块的升级，但需要更充分的反馈数据积累。

---

#### L-4 反向记忆项

**方案价值**：主动弱化过度强化的关联（"这个节点总是被召回，但实际上不太有用"），防止热门节点挤压冷门节点的召回空间。

**为什么不在引擎层做**：两个原因——

1. **与 L-2 衰减耦合，但信号不同**：L-2 节点衰减基于"不活跃"（长时间未使用），L-4 反向记忆项基于"过度活跃但无用"（频繁召回但从未被裁判标记为有效）。这两种信号需要不同的检测机制——L-2 看时间，L-4 看"召回频次 vs 有效频次"的比值。在当前反馈数据量下（I-2 刚刚建立），这个比值在统计上不可靠。

2. **召回多样性已有保障**：当前 recall.ts 的多路召回（FTS + 向量 + 图游走 + PPR + 社区）天然提供了多样性——热门节点可能在向量搜索中排名高，但在图游走中可能被冷门邻居替代。引入反向记忆项可能破坏这种天然平衡。

**如果要做应该在哪做**：在 graph-memory-pro 的 recall.ts 中做，但需要——①I-2 裁判反馈积累 > 500 条 ②建立"召回频次 vs 有效频次"的统计基线 ③设计降权策略（不是删除，而是降权）。

**引擎层能提供什么**：当前 L-2 衰减已提供节点活跃度管理。L-4 是 L-2 的扩展，但需要更多数据积累。

---

### 不入引擎总结

| 编号 | 不入原因类别 | 核心判断 |
|---|---|---|
| S-12 | **数据不在引擎层** | 跨轨迹抽象的输入是原始对话，不是图谱节点 |
| S-8 | **功能在编排层** | 自然语言摘要生成 + UI 展示 ≠ 引擎层职责 |
| S-7 | **蒸馏在编排层，存储在引擎层** | 画像蒸馏需要对话历史，引擎层只提供存储 API |
| S-4 | **成本/收益不匹配** | 3x 计算成本，典型规模下收益不明显 |
| S-2 | **依赖 S-13 先落地** | S-13 的 state 字段是前提，v2.2.0 更合适 |
| S-5 | **提取准确率待验证** | 因果链提取需要跨轮推理，先建 Benchmark 再决定 |
| R-5 | **决策在编排层** | 场景权重分配是编排层逻辑，引擎层提供 sceneId 过滤 |
| L-3 | **反馈稀疏** | 边反馈比节点稀疏得多，需要 >500 条反馈才有统计意义 |
| L-4 | **数据积累不足** | 需要召回频次 vs 有效频次的统计基线，当前反馈量不足 |

---

## 三、v2.1.10 聚焦方案（T1+T2 共 7 项）

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
│          │    │ + S-3 来源标记    │    │ + L-1 M 矩阵     │
│          │    │ + S-13 状态追踪   │    │ + R-4 可进化嵌入  │
│          │    │ + S-14 过时检测   │    │                  │
└──────────┘    └──────────────────┘    └──────────────────┘
                             │
                    ┌────────▼─────────┐
                    │  S-10 Benchmark   │ ← 量化验证一切
                    │  (LoCoMo/        │
                    │   LongMemEval)   │
                    └──────────────────┘
```

### 依赖关系

```
S-1 (Bi-Temporal)  ──→  S-13 (状态追踪)  ──→  S-14 (过时检测)
S-3 (来源标记)     ──→  L-2 (节点衰减)

I-2 (裁判反馈)     ──→  L-1 (M 矩阵)    ──→  R-3 (边际效用奖励)
                                         ──→  R-4 (可进化嵌入)
                                         ──→  R-1 (自主调优)

S-10 (Benchmark)   ──→  验证 R-1/R-3/R-4 的效果
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

## 五、实施顺序

### 第一批：Schema 升级（无依赖，可并行）

```
S-1 + S-3  ──→  S-13 + S-14
```

**产出**：types.ts 扩展 6 个字段，store.ts 持久化，向后兼容

### 第二批：反馈闭环（依赖第一批的 S-1）

```
I-1 ──→  I-2 ──→  I-3
```

**产出**：缓存层 + 启发式裁判 + 反馈持久化

### 第三批：学习能力（依赖第二批的 I-2/I-3）

```
L-1 + R-3  ──→  R-4
```

**产出**：M 矩阵 + 边际效用奖励 + 可进化嵌入

### 第四批：验证闭环（依赖前面所有）

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

- [ ] S-1+S-3：节点有 validFrom/validTo/recordedAt/source 字段
- [ ] S-13：节点有 state 字段，召回时按 current/superseded 分类
- [ ] S-14：节点有 stalenessScore，过时节点在召回中降权
- [ ] I-1：相同 query 第二次延迟 < 10ms
- [ ] I-2：启发式裁判异步运行，准确率 > 80%
- [ ] I-3：反馈数据可查询
- [ ] L-1+R-3：M 矩阵冷启动后启用，邻域评估后更新
- [ ] R-4：节点 content 变更触发重嵌入，冲突可检测
- [ ] R-1：诊断循环可运行，revert-on-regression 生效
- [ ] S-10：LoCoMo P@1 > 50%，npm run benchmark 可运行

### 性能验收

- [ ] 召回延迟 P99 < 500ms（含缓存命中）
- [ ] 维护周期不因新阶段显著延长（< 30%）
- [ ] M 矩阵内存占用 < 50MB
- [ ] R-1 诊断循环单次 < 30s
- [ ] R-4 嵌入重算仅在 content 实质变化时触发

### 兼容性验收

- [ ] 旧数据（无新字段）可正常读写
- [ ] 关闭新功能时行为与 v2.2.0 一致
- [ ] 现有 HTTP API 不破坏向后兼容
- [ ] 现有 Re-exports 接口不变

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
- **预计实施周期**：4 批次，约 30-40 天