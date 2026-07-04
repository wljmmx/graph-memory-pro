# Graph Memory Pro 演进路线图

> 版本：2.1.10
> 模块定位：**记忆长期管理模块**（记忆提取/存储/检索/衰减/合并/长期沉淀/质量优化/自主进化）
> 压缩、上下文管理、prompt 组装由宿主/其他模块处理，不在本规划范围
> 基于 Graph-based Agent Memory 论文、自进化记忆系统实践文章、TencentDB Agent Memory 项目、RL4MEM 自主进化记忆前沿论文（2026）四方资料的综合规划

---

## 一、背景与思路来源

本规划融合四份参考资料的设计思路：

### 1. Graph-based Agent Memory 论文（结构维度）

**核心贡献**：提供"记忆如何组织"的结构化框架。

| 思路 | 核心价值 | 项目当前 |
|---|---|---|
| Bi-Temporal 时间建模 | 区分事件发生时间 vs 记录时间，支持时态查询 | 仅有 createdAt/updatedAt |
| 经验 vs 知识来源区分 | 不同来源可信度、衰减策略不同 | 全部混存 |
| 层次化社区 | 多级抽象树，自顶向下导航 | 仅一层 |
| 超图（关系节点模拟） | 表达 N 元关系 | 仅二元 |
| 软替换替代物理删除 | 保留历史版本 | merge 后 DETACH DELETE |

### 2. 自进化记忆系统实践文章（学习维度）

**核心贡献**：提供"记忆如何越用越准"的学习机制。

| 思路 | 核心价值 | 项目当前 |
|---|---|---|
| LLM 裁判反馈 | 收集"哪些记忆被真正用到"的信号 | 无反馈机制 |
| 关联矩阵 M（query 变换层） | 无需重训 embedding 即可优化召回 | 直接向量搜索 |
| Hebbian + Momentum + Adam | 噪声鲁棒（90% 反馈下只掉 0.4pp） | 无在线学习 |
| 历史查询缓存 | 相同/相似 query 直接返回 | 每次重算 |
| 历史相似度加权 | 利用过往成功召回 | 无 |
| 反向记忆项 | 主动弱化过度强化的关联 | validatedCount 只增不减 |
| 自适应学习率 + 衰减 | 长期运行不膨胀 | 无衰减 |

### 3. TencentDB Agent Memory 开源项目（层次沉淀维度）

**核心贡献**：提供长期记忆的端到端层次沉淀工程范式（本规划仅取与"长期记忆管理"职责相关的部分，压缩/画布/上下文卸载属宿主职责，不入本规划）。

**L0-L3 四层语义金字塔**（本规划仅纳入 L1/L2/L3，L0 原始对话全量保存属宿主上下文管理职责）：

| 层级 | 内容 | 价值 | 归属 |
|---|---|---|---|
| L0 | 原始对话全量保存 | 信息不丢失 | **宿主**（不入本规划） |
| L1 | 原子事实自动提取 | 非结构化→结构化 | **本项目**（extract.ts 已具备，待升级） |
| L2 | 场景分块聚类 | 场景隔离，防串场 | **本项目**（新增 S-6） |
| L3 | 用户画像融合 | 稳定偏好，个性化 | **本项目**（新增 S-7） |

设计哲学："上层提供方向，下层保留证据"，可追溯理念与论文 Bi-Temporal 一致。

### 4. RL4MEM 自主进化记忆前沿论文（自主进化维度，2026）

**核心贡献**：让记忆系统从"被动存查"升级为"主动思考记忆"——通过强化学习/LLM 诊断自主决策"什么该记、什么该改、什么该忘"，无需人工编写全部规则。

| 论文 | 核心机制 | 关键数据 | 可整合点 |
|---|---|---|---|
| **EvolveMem** (arxiv 2605.13941, Liu et al.) | 检索配置暴露为结构化动作空间；EVALUATE–DIAGNOSE–PROPOSE–GUARD 四步循环；revert-on-regression + explore-on-stagnation 安全护栏 | LoCoMo 30.5%→54.3%（+78%）；跨基准正向迁移 | 把召回参数作为可进化动作空间，LLM 诊断失败案例自动调优 |
| **U-Mem** (arxiv 2602.22406, Wu et al., NUS) | 成本感知 3 层提取级联：自监督→工具验证→专家反馈；语义感知 Thompson 采样平衡探索/利用；**主动获取**外部知识 | 半计算量超 RL 优化；HotpotQA +14.6pp | 提取升级为多级成本感知级联；召回用 Thompson 采样平衡熟悉/探索 |
| **UMEM** (arxiv 2602.10652, 厦大+阿里+通义) | 语义邻域建模+边际效用奖励+GRPO；**统一提取与管理**；避免"死记硬背"陷阱 | 多轮任务 +10.67%；单调增长曲线 | M 矩阵奖励升级为边际效用；语义邻域聚类防过拟合 |
| **EvoEmbedding** (南京大学 2026.06) | 可进化检索表示；嵌入随新信息迭代；解决静态嵌入无法识别时效性/冲突 | 解决静态嵌入核心缺陷 | L-1 的 M 矩阵升级为可进化嵌入 |
| **Dynamic Mixture of Latent Memories** (Yu et al.) | 动态隐式记忆单元组合；运行时自主适配；容量与效率动态平衡 | 动态平衡 | S-6 场景隔离从二值升级为动态记忆混合 |

### 5. 四方融合点

```
论文提供"骨架"（图结构如何组织）
文章提供"神经"（图如何自我优化）
TencentDB 提供"沉淀"（端到端层次化）
RL4MEM 提供"自主进化"（主动思考记忆）

graph-memory-pro = 骨架已备 + 神经缺失 + 沉淀缺失 + 自主进化缺失
```

关键融合洞察：

1. **裁判反馈信号**驱动三处：M 矩阵学习、节点衰减、边权重调整——一个反馈源，三个受益点
2. **Bi-Temporal** 让"反向记忆项"成为可能——不是删除，而是 `validTo = now` 标记失效（与 TencentDB 可追溯理念一致）
3. **TencentDB L1-L3 纵向沉淀**与论文层次化社区横向抽象互补，两者可叠加
4. **场景隔离（L2）**解决项目所有节点混在一个图谱、不同项目记忆互相干扰的问题
5. **用户画像（L3）**是项目完全缺失的节点类型——只有 TASK/SKILL/EVENT，没有用户偏好的沉淀
6. **来源区分**让衰减策略可差异化——知识记忆衰减慢，经验记忆衰减快
7. **EvolveMem 动作空间**让召回参数（recallMaxNodes/damping/dedupThreshold/M学习率）从静态配置升级为 LLM 自主调优
8. **U-Mem 成本感知级联**让 I-2 裁判从单层升级为多级（自监督→工具→专家），成本可控
9. **UMEM 边际效用奖励**让 M 矩阵奖励从二值（用/没用）升级为边际效用，避免死记硬背
10. **RL4MEM 整体**让记忆系统从"被动存查"升级为"主动思考记忆"——这是 v2.1.10 的核心范式升级

### 6. 记忆系统代际演进与核心教训

#### 三代记忆系统概述

| 代际 | 时间 | 代表系统 | 核心能力 | 核心教训 |
|---|---|---|---|---|
| Gen 1 | 2023-2024 | LangChain, Mem0 v0, 早期 RAG | 向量相似度检索 | **相似度 ≠ 召回**：向量距离近不代表答案准 |
| Gen 2 | 2024-2025 | MemGPT/Letta, Graphiti/Zep, Graphiti, graph-memory 原版 | 结构化图记忆 + 时间建模 | **关系和时间比相似度更重要**：图结构表达上下文 |
| Gen 3 | 2025-2026 | Mem0 Cloud, TencentDB, Evermind, Cognee, Mandol | 记忆作为被动基础设施，标准化 Benchmark | **记忆不应由 Agent 管理**：应作为架构层，Benchmark 是硬通货 |
| Gen 4 | 2026+ | RL4MEM, A-MEM, GAM, HeLa-Mem, Mandol | 自主进化 + 情节/语义分离 + 统一检索 | **自主整合**：Note→Link→Evolve→Retrieve 闭环 |

#### 核心教训

**Gen 1 → Gen 2**：向量相似度只做表面匹配。图结构能表达"这个 skill 解决了那个错误"的因果链，这也是 graph-memory 存在的根本原因。

**Gen 2 → Gen 3**：Mem0 2026 报告指出，21 个框架零标准，但 Benchmark（LoCoMo/LongMemEval/BEAM）已成为行业共识。**没有 Benchmark 的记忆系统无法证明自己有效**。graph-memory-pro 当前完全没有 Benchmark 评估。

**Gen 3 → Gen 4**：A-MEM (NeurIPS 2025) 的 Zettelkasten 四步闭环（Note→Link→Evolve→Retrieve）和 GAM (ACL 2026) 的情节/语义分离，标志着记忆系统从"被动存储"到"自主思考"的范式跃迁。

#### graph-memory-pro 定位

graph-memory-pro 当前处于 **Gen 2 末期**（有图结构，但无 Benchmark、无情节/语义分离、无自主 Link/Evolve 能力）。v2.1.10 的目标是跨越 Gen 3（Benchmark + 质量度量）进入 Gen 4（自主进化 + 情节/语义分离 + 统一生命周期管理）。

#### 新文献（v2.1.10 补充吸收）

| 论文 | 来源 | 核心贡献 | 可整合点 |
|---|---|---|---|
| **GAM** (ACL 2026) | 浙大+UIC | 情节缓冲与语义整合分离；Semantic-Event-Triggered 状态切换；Graph-Guided Multi-Factor Retrieval | 新增 S-9 情节/语义分离 |
| **A-MEM** (NeurIPS 2025) | Rutgers+蚂蚁 | Zettelkasten 四步闭环：Note→Link→Evolve→Retrieve；记忆作为自主演化的知识网络 | 新增 S-11 自主 Link/Evolve 闭环 |
| **From Storage to Experience** survey (ICLR 2026 under review) | 匿名 | 三阶段进化框架：Storage→Reflection→Experience；跨轨迹抽象；主动探索 | 新增 S-12 跨轨迹抽象 |
| **Mem0 2026 State Report** | Mem0 | 行业 Benchmark 全景；三大开放问题：跨会话身份、时态抽象规模化、记忆过时检测 | 新增 S-10 Benchmark 评估、S-14 过时检测 |
| **A-TMA** (2026.07) | NUS | 幽灵记忆（ghost memory）检测；状态感知记忆覆盖层 | 新增 S-13 矛盾检测与消解 |
| **Mandol** (2026.06) | 华东师大 | 凝聚式记忆系统；统一混合检索；可逆记忆 | 升级 L-1 统一检索、S-8 可逆追溯 |

---

## 二、v2.1.10 总体目标

将以下六大方向**统一在 v2.1.10 版本内**完成：

| 方向 | 核心能力 | 来源 |
|---|---|---|
| 基础设施 | 反馈闭环与缓存层 | 文章 P0 |
| 学习能力 | 在线学习与衰减机制 | 文章 + 论文融合 |
| 结构升级 | 时态建模与层次沉淀 + 生命周期管理 + Benchmark | 论文 + TencentDB + GAM/A-MEM/Mem0 报告 |
| **自主进化** | **LLM 诊断调优 + 成本感知级联 + 边际效用奖励 + 可进化嵌入** | **RL4MEM（核心范式升级）** |

**设计原则**：

- **向后兼容**：所有 schema 演进通过可选字段实现，旧数据自动兼容
- **渐进启用**：新能力默认关闭，通过配置开启
- **降级安全**：反馈缺失时 M 不更新，裁判不可用时不阻塞召回，LLM 诊断失败时回退到上一次稳定配置
- **可观测**：所有学习行为有日志与指标
- **可追溯**：Bi-Temporal + 软替换保留历史，任何变更可回溯（论文 + TencentDB 理念）
- **自主但不失控**：RL4MEM 的 revert-on-regression 安全护栏，自主调优有回退机制

---

## 三、详细任务清单

### 模块 I：基础设施（反馈与缓存）

#### I-1 历史查询缓存

**目标**：降低重复 query 的召回延迟，缓解超时问题。

**实现要点**：

- LRU 缓存（默认容量 100）
- 相似度加权：query embedding cosine > 0.95 时直接返回历史结果
- 嵌入向量缓存：避免重复调用 embed 函数
- TTL 过期：默认 30 分钟

**接入点**：`src/recaller/recall.ts` `Recaller.recall()`

**配置项**：

```json
{
  "queryCache": {
    "enabled": true,
    "maxSize": 100,
    "ttlMs": 1800000,
    "similarityThreshold": 0.95
  }
}
```

**预计成本**：30 分钟

---

#### I-2 LLM 裁判反馈机制

**目标**：收集"哪些节点被真正用到"的反馈信号，为后续学习机制提供训练数据。

**实现要点**：

- 新增 `src/recaller/judge.ts`
- 异步运行（在 assistant 回复后），不阻塞用户
- 复用文章进化出的 7 条裁判规则：
  1. 必须包含具体事实
  2. 单条记忆就能回答
  3. 话题相关不算
  4. 必须有具体信息点
  5. 模糊引用不算
  6. 必须能直接回答问题
  7. 仅上下文相关不算
- 输出：`{ usedNodeIds: string[], score: number, reason: string }`

**接口设计**：

```typescript
export interface JudgeResult {
  usedNodeIds: string[];   // 真正被 LLM 用到的节点 ID
  unusedNodeIds: string[]; // 召回了但未用到的节点
  score: number;           // 召回质量分（0-1）
  reason: string;          // 判断理由
}

export async function judgeRecall(
  query: string,
  recalledNodes: GmNode[],
  assistantResponse: string,
  llm: CompleteFn,
): Promise<JudgeResult>;
```

**配置项**：

```json
{
  "judge": {
    "enabled": false,
    "asyncMode": true,
    "timeout": 10000
  }
}
```

**预计成本**：1-2 天

---

#### I-3 反馈持久化

**目标**：将裁判反馈结果持久化到 Neo4j，为 L-1/L-2/L-3 提供训练数据。

**实现要点**：

- 新增节点标签：`GmFeedback`
- Schema：
  ```
  (GmFeedback {
    id: string,
    query: string,
    queryEmbedding: number[],
    usedNodeIds: string[],
    unusedNodeIds: string[],
    score: number,
    createdAt: number
  })
  ```
- 关系：
  ```
  (GmFeedback)-[:JUDGED]->(GmNode)
  (GmFeedback)-[:ABOUT]->(GmQuery)
  ```
- 维护周期清理：保留最近 N 条（默认 10000）

**接入点**：`src/store/store.ts` 新增 `saveFeedback` / `getRecentFeedbacks`

**预计成本**：半天

---

### 模块 L：学习能力（在线学习与衰减）

#### L-1 关联记忆矩阵 M

**目标**：在向量检索前加一个学习层，无需重训 embedding 即可优化召回。

**算法结构**（文章进化出的最终形态）：

```
query_vec
  ↓
BatchNorm（减均值、除方差、L2 归一化、去中心化）
  ↓
M @ query_vec + bias          ← Linear 变换层
  ↓
× gain × row_scale            ← LayerNorm
  ↓
输出向量 → 向量搜索
```

**学习规则**（融合 70 年优化理论）：

- **Hebbian 学习**（1949）：强化正确关联
- **Widrow-Hoff**（1960）：纠正错误
- **Momentum**（1980s）：平滑学习方向，对抗噪声
- **Adam 优化器**（2014）：自适应学习率
- **BatchNorm**（2015）：输入归一化，稳定学习

**核心更新公式**：

```
M = M - lr × 误差 × query
```

**实现要点**：

- 新增 `src/recaller/associative.ts`
- 矩阵维度 = embedding 维度（默认 1024，可配置为 256 降维）
- 初始 M = 单位矩阵，bias = 0，gain = 1
- 在线更新：每次裁判反馈后调用 `update()`
- 冷启动策略：累计 100 次反馈后启用 M 变换

**接口设计**：

```typescript
export class AssociativeMemory {
  transform(queryVec: number[]): number[];  // query 变换
  update(queryVec: number[], correctNodeId: string, allNodeVecs: Map<string, number[]>): void;
  export(): ArrayBuffer;   // 导出矩阵
  import(buf: ArrayBuffer): void;
  getStats(): { updates: number; lastUpdate: number };
}
```

**接入点**：`src/store/store.ts` `vectorSearchWithScore()` 前插入 transform

**配置项**：

```json
{
  "associative": {
    "enabled": false,
    "dimensions": 1024,
    "learningRate": 0.01,
    "warmupFeedbacks": 100,
    "algorithm": "adam"  // "sgd" | "momentum" | "adam"
  }
}
```

**预计成本**：3-5 天

---

#### L-2 节点衰减机制

**目标**：解决长期运行后图谱膨胀、召回噪声大的问题。

**实现要点**：

- 每次维护周期：
  - 经验记忆 `validatedCount × 0.95`
  - 知识记忆 `validatedCount × 0.99`（衰减更慢）
  - 召回命中 +1（基于 I-2 裁判反馈）
- 低于阈值（默认 0.1）→ `status: 'archived'`（不删，仅不参与召回）
- archived 节点保留历史，可通过显式查询访问

**实现要点**：

- 修改 `src/graph/maintenance.ts` 添加衰减阶段
- 依赖 I-3 的反馈数据驱动"+1"
- 依赖 S-3 的来源标记决定衰减速率

**配置项**：

```json
{
  "decay": {
    "enabled": false,
    "experienceRate": 0.95,
    "knowledgeRate": 0.99,
    "archiveThreshold": 0.1
  }
}
```

**预计成本**：1-2 天

---

#### L-3 边权重自适应调整

**目标**：基于裁判反馈动态调整边权重，强化有用关联，弱化无效关联。

**实现要点**：

- 裁判反馈"节点 A 被用到" → 强化 A 与当前 query 上下文节点的边权重
- 裁判反馈"节点 B 未被用到" → 弱化 B 的边权重（反向记忆项）
- 调整幅度受 Momentum 平滑，避免单次反馈剧变

**接入点**：`src/graph/maintenance.ts` 新增边权重调整阶段

**配置项**：

```json
{
  "edgeTuning": {
    "enabled": false,
    "reinforceRate": 0.1,
    "weakenRate": 0.05,
    "momentum": 0.9
  }
}
```

**预计成本**：2-3 天

---

#### L-4 反向记忆项

**目标**：主动弱化过度强化的关联，防止"信息茧房"。

**实现要点**：

- 检测"高频被召回但低使用率"的节点
- 主动降低其 pagerank 或社区代表权重
- 与 L-2 节点衰减协同

**预计成本**：1 天（与 L-2 协同实现）

---

### 模块 S：结构升级（时态与层次）

#### S-1 Bi-Temporal 时间字段

**目标**：支持时态查询，保留历史版本。

**Schema 演进**（向后兼容，所有新字段可选）：

```typescript
interface GmNode {
  // 现有字段...
  validFrom?: number;      // 事件实际发生时间
  validTo?: number;        // 失效时间（null = 仍有效）
  recordedAt: number;      // 写入图的时间（= 当前 createdAt）
  source?: "experience" | "knowledge" | "imported";
  supersededBy?: string;   // 被哪个新版本替代
}
```

**查询支持**：

```cypher
// 查询某时间点有效的节点
MATCH (n:Task|Skill|Event)
WHERE n.validFrom <= $at AND (n.validTo IS NULL OR n.validTo > $at)
RETURN n
```

**接入点**：`src/types.ts` `GmNode` 扩展，`src/store/store.ts` upsertNode 更新

**预计成本**：2-3 天

---

#### S-2 软替换替代物理删除

**目标**：merge 后保留历史版本，支持回溯。

**实现要点**：

- 修改 `src/store/store.ts` `mergeNodes()`：
  - 旧：`DETACH DELETE merge`（Phase 6）
  - 新：`SET merge.status = 'superseded', merge.supersededBy = $keepId, merge.validTo = timestamp()`
- 保留 merge 节点的所有边（标记为历史关系）
- 默认查询过滤 `status <> 'superseded'`

**依赖**：S-1

**预计成本**：1-2 天

---

#### S-3 来源标记字段

**目标**：区分经验记忆与知识记忆，支持差异化衰减。

**实现要点**：

- `GmNode.source: "experience" | "knowledge" | "imported"`
- 默认值：`"experience"`（从对话提取的）
- 未来支持导入文档时标记为 `"knowledge"`

**接入点**：

- `src/types.ts` 扩展
- `src/extractor/extract.ts` 提取时默认 `source = "experience"`
- `src/store/store.ts` upsertNode 持久化

**预计成本**：半天

---

#### S-4 层次化社区

**目标**：多级抽象树，支持自顶向下导航召回。

**结构**：

```
Layer 0: 原始节点
Layer 1: 社区（当前 Label Propagation）
Layer 2: 主题（社区代表的社区）
Layer 3: 领域（主题的代表）
```

**实现要点**：

- 在 `src/graph/community.ts` 的 `detectCommunities` 后追加递归调用
- 社区代表节点（GmCommunity）参与下一层 Label Propagation
- `recallGeneralized` 从 Layer 3 向下钻取：先匹配领域 → 主题 → 社区 → 节点

**配置项**：

```json
{
  "community": {
    "hierarchyDepth": 3,
    "minMembersPerCommunity": 3
  }
}
```

**预计成本**：3-5 天

---

#### S-5 因果关系扩展

**目标**：支持故障溯源等因果推理场景。

**新增边类型**：

```typescript
type EdgeType =
  | "USED_SKILL"
  | "SOLVED_BY"
  | "REQUIRES"
  | "PATCHES"
  | "CONFLICTS_WITH"
  | "RELATES_TO"
  | "CAUSED_BY"   // EVENT → EVENT，事件因果
  | "LEADS_TO";   // TASK → EVENT，任务导致事件
```

**接入点**：

- `src/types.ts` 扩展 EdgeType
- `src/extractor/extract.ts` 提示词补充新关系
- `src/graph/pagerank.ts` `ALL_REL_TYPES` 追加

**预计成本**：1-2 天

---

#### S-6 场景隔离（L2 场景分块）

**目标**：解决不同项目/会话的记忆互相干扰问题（TencentDB L2 痛点）。

**问题背景**：项目当前所有节点混在一个图谱里，不同项目的 TASK/SKILL/EVENT 可能因 RELATES_TO 误连，召回时出现串场。

**实现要点**：

- 节点添加 `sceneId: string` 字段（对应 sessionKey 或项目维度）
- 召回时支持场景过滤：`WHERE n.sceneId = $sceneId OR n.sceneId IS NULL`（全局记忆+本场景记忆）
- L2 场景分块：按 sceneId 聚类，形成场景级摘要
- 跨场景关联显式标记（避免误连）

**Schema 演进**：

```typescript
interface GmNode {
  // 现有字段...
  sceneId?: string;  // 场景/项目标识，null = 全局记忆
}
```

**接入点**：

- `src/types.ts` 扩展
- `src/store/store.ts` upsertNode 持久化 sceneId
- `src/recaller/recall.ts` 召回时按 sceneId 过滤
- `src/extractor/extract.ts` 提取时从 sessionKey 推导 sceneId

**配置项**：

```json
{
  "scene": {
    "enabled": false,
    "isolation": "soft"  // "soft"（全局+本场景） | "strict"（仅本场景）
  }
}
```

**预计成本**：2-3 天

---

#### S-7 用户画像（L3 画像融合）

**目标**：从历史对话中蒸馏用户偏好与工作风格，提供个性化召回方向（TencentDB L3）。

**问题背景**：项目只有 TASK/SKILL/EVENT 三类领域节点，完全没有用户偏好的沉淀。每次对话都像重新开始，无法形成个性化服务。

**实现要点**：

- 新增节点类型 `PROFILE`（或独立标签 `GmProfile`）
- Schema：
  ```
  (GmProfile {
    id: string,
    userId: string,
    preferences: { techStack, codeStyle, workStyle, ... },
    summary: string,           // 自然语言画像
    embedding?: number[],
    updatedAt: number
  })
  ```
- 蒸馏流程：
  1. 定期扫描历史对话（ConversationMessage）
  2. LLM 提取用户偏好（技术栈、代码风格、工作习惯）
  3. 合并到现有 GmProfile（避免冲突，取最新）
- 召回时优先匹配画像相关节点

**接入点**：

- `src/types.ts` 新增 GmProfile 类型
- `src/store/store.ts` 新增 upsertProfile / getProfile
- `src/graph/maintenance.ts` 新增画像蒸馏阶段
- `src/recaller/recall.ts` 召回时参考画像

**配置项**：

```json
{
  "profile": {
    "enabled": false,
    "distillInterval": 100,  // 每 N 次维护蒸馏一次
    "maxPreferences": 20
  }
}
```

**预计成本**：3-5 天

---

#### S-8 记忆回顾总结（时间范围汇总查询）

**目标**：支持"本周学会了什么""今年有什么特别记忆"等人类可读的记忆回顾，覆盖 HTTP API 和 Agent 工具双通道。

**问题背景**：当前项目没有任何按时间范围汇总记忆的能力。HTTP API 和 Agent 工具都只能做点查询（单节点/搜索/Top K），无法回答"过去一个月学了什么"这类回顾性问题。

**GAM 启发**：GAM 的 Topic Associative Network 天然支持按主题+时间范围聚合。S-4 的层次化社区可以按社区分组，S-1 的 Bi-Temporal 字段提供时间过滤基础。

**实现要点**：

- 新增 `GET /api/summary?from=&to=&sceneId=&type=` — 时间范围内的记忆摘要
- 新增 `GET /api/timeline?limit=&sceneId=` — 记忆时间线
- 新增 `GET /api/changes?since=` — 自某时间点以来的变更（可逆追溯，Mandol 启发）
- 新增 Agent 工具 `gm_summary`：

```typescript
registerTool("gm_summary", {
  description: "回顾和总结记忆。支持按时间范围、类型生成记忆摘要",
  parameters: {
    period: "week" | "month" | "year" | "custom",
    type: "learned" | "events" | "all",
    from: "timestamp?",
    to: "timestamp?",
    sceneId: "string?",
  },
  handler: async (params) => {
    // 1. 按时间范围 + 社区分组查询节点
    // 2. LLM 生成自然语言摘要
    // 3. 返回结构化结果
  }
});
```

**接入点**：

- `src/routes/crud.ts` 新增 API 路由
- `src/index.ts` 注册 gm_summary 工具
- 新增 `src/recaller/summary.ts` 汇总逻辑

**配置项**：

```json
{
  "summary": {
    "enabled": false,
    "defaultPeriod": "week",
    "maxNodesPerSummary": 50
  }
}
```

**预计成本**：2-3 天

---

#### S-9 情节缓冲与语义整合分离（GAM 启发）

**目标**：把当前"所有对话直接写全局图谱"的单流模式，改为"情节缓冲 → 语义边界检测 → 全局整合"的双阶段模式。

**问题背景**：当前 [extract.ts](file:///workspace/src/extractor/extract.ts) 每轮对话提取三元组后直接 upsert 到全局图谱（[index.ts](file:///workspace/index.ts) 的 triplet persistence）。这导致：
- 临时噪声（如单次调试错误）污染全局图谱
- 语义漂移（不同话题混在一起）无法隔离
- 与 GAM 论文指出的 "Memory Loss" 和 "Semantic Drift" 问题一致

**GAM 核心机制**：

| 阶段 | 职责 | 存储 |
|---|---|---|
| Episodic Buffering | 实时捕获对话，构建局部事件图 | 临时缓冲（内存） |
| Semantic Boundary Detection | LLM 判断话题是否完成 | 触发信号 |
| Semantic Consolidation | 将完整事件图压缩为摘要节点，整合到全局图谱 | 全局 Topic Associative Network |

**实现要点**（针对 graph-memory-pro 场景简化）：

- 新增 `src/graph/episodic_buffer.ts` 情节缓冲
- 维护一个 2048 token 的滑窗缓冲区
- 当 LLM 检测到语义边界（话题切换/任务完成），触发整合
- 整合时：将缓冲区中的节点合并、去噪、生成摘要，然后写全局图谱
- 缓冲区清空，开始下一轮

**与现有维护的协同**：

- maintenance.ts 的 Phase 0（deriveRelatesFromMentions）在整合阶段触发
- R-1 诊断循环的评估数据可反馈到语义边界检测的准确性

**配置项**：

```json
{
  "episodicBuffer": {
    "enabled": false,
    "maxTokens": 2048,
    "consolidationMode": "semantic"  // "semantic" | "token_count" | "turn_count"
  }
}
```

**预计成本**：4-6 天

---

#### S-10 Benchmark 评估体系

**目标**：为 graph-memory-pro 建立标准 Benchmark 评估，填补 Gen 3 缺口。

**问题背景**：Mem0 2026 报告指出，LoCoMo/LongMemEval/BEAM 已成为行业标准。graph-memory-pro 当前没有任何 Benchmark 评估，无法证明其有效性，也无法与同行对比。

**Mem0 2026 Benchmark 全景**：

| Benchmark | 规模 | 类别 | 行业最佳 |
|---|---|---|---|
| LoCoMo | 1,540 题 | 单跳/多跳/开放域/时序 | 92.5 (Mem0 2026) |
| LongMemEval | 500 题 | 6 类（含知识更新/多会话） | 94.4 (Mem0 2026) |
| BEAM | 1M/10M token | 10 类（含矛盾消解/弃权） | 64.1/48.6 (Mem0 2026) |

**Mem0 2026 三大开放问题**：

1. **跨会话身份一致性**（Cross-session identity）—— 同一用户在不同会话中的身份锚定
2. **时态抽象规模化**（Temporal abstraction at scale）—— 大量记忆的时态聚合
3. **记忆过时检测**（Memory staleness）—— 长期记忆的数据新鲜度（S-14 对应）

**实现要点**：

- 新增 `benchmarks/` 目录
- 接入 LoCoMo 评测集（1,540 题，4 类）
- 接入 LongMemEval 评测集（500 题，6 类）
- 评估指标：F1、BLEU、LLM 评分、Token 消耗、Latency
- 新增 `npm run benchmark` 脚本
- 目标：在 LoCoMo 上达到行业平均水平（目标 P@1 > 50%），在 LongMemEval 上达到时序推理可用水平

**接入点**：

- 新增 `benchmarks/locomo.ts`
- 新增 `benchmarks/longmemeval.ts`
- `package.json` 新增 `benchmark` 脚本

**配置项**：

```json
{
  "benchmark": {
    "enabled": false,
    "dataset": "locomo",  // "locomo" | "longmemeval" | "both"
    "outputDir": "benchmarks/results"
  }
}
```

**预计成本**：4-6 天

---

#### S-11 自主 Link/Evolve 闭环（A-MEM 启发）

**目标**：把当前"提取→存储"的单向流程升级为 A-MEM 的 Note→Link→Evolve→Retrieve 四步闭环。

**问题背景**：当前 extract.ts 提取三元组后直接 upsert，没有"新记忆触发旧记忆更新"的自主演化能力。这与 A-MEM (NeurIPS 2025) 的核心设计原则矛盾——Zettelkasten 方法论要求新卡片促使重新审视旧卡片。

**A-MEM 四步闭环**：

| 步骤 | graph-memory-pro 当前 | 缺口 |
|---|---|---|
| Note | extract.ts 三元组提取 | 缺 keywords/tags/contextual description |
| Link | deriveRelatesFromMentions 仅基于共现 | 缺 LLM 驱动的语义链接 |
| Evolve | mergeNodes 仅合并相似节点 | 缺触发式旧记忆更新 |
| Retrieve | recall.ts 多路召回 | 已有 |

**实现要点**：

- 升级 extract.ts 为 Note Construction：LLM 生成 keywords、tags、contextual description
- 升级 deriveRelatesFromMentions 为 Link Generation：LLM 判断新记忆与历史记忆的语义关联
- 新增 Memory Evolution：新记忆加入时，触发相关旧记忆的 context/tags 更新
- 检索时通过链接扩展召回范围（Box 概念：记忆簇）

**与现有 R-3 协同**：R-3 的语义邻域建模可驱动 Link Generation 的候选范围，R-3 的边际效用奖励可验证 Evolution 是否有效。

**配置项**：

```json
{
  "zettelkasten": {
    "enabled": false,
    "noteConstruction": true,
    "linkGeneration": true,
    "memoryEvolution": true,
    "evolutionTrigger": "semantic"  // "semantic" | "always" | "manual"
  }
}
```

**预计成本**：5-7 天

---

#### S-12 跨轨迹抽象（From Storage to Experience 启发）

**目标**：从多个独立对话轨迹中提取可复用的经验模式，实现从"记忆"到"经验"的跃迁。

**问题背景**：当前每个对话的提取结果独立存储，无法跨对话发现"这个问题多次出现，已经形成了固定模式"。

**From Storage to Experience 三阶段框架**：

```
Storage    → 忠实记录每个对话轨迹（当前已实现）
Reflection → 评估轨迹质量，去噪（I-2 裁判反馈 + R-2 级联）
Experience → 跨轨迹抽象，提取可复用模式（当前缺失）
```

**实现要点**：

- 新增 `src/evolution/abstraction.ts`
- 定期扫描 I-3 反馈数据，发现"多次出现的成功模式"
- 将模式蒸馏为"经验节点"（GmExperience），与普通节点区分
- 经验节点在召回时权重更高
- 评估指标：跨轨迹抽象后的召回准确率提升

**Minimum Description Length (MDL) 直觉**（survey 论文核心）：
- 将多个独立轨迹压缩为紧凑的经验先验
- 压缩比越高，说明发现的经验越有普遍性

**接入点**：

- 新增 `src/evolution/abstraction.ts`
- `src/graph/maintenance.ts` 新增跨轨迹抽象阶段
- `src/types.ts` 新增 GmExperience 类型

**配置项**：

```json
{
  "abstraction": {
    "enabled": false,
    "minTrajectories": 5,
    "minPatternFrequency": 3,
    "mdlCompressionThreshold": 0.5
  }
}
```

**预计成本**：4-6 天

---

#### S-13 矛盾检测与消解（A-TMA 启发）

**目标**：检测并管理"幽灵记忆"（ghost memory）—— 旧事实、新事实、过渡态共存导致的记忆冲突。

**问题背景**：当前 mergeNodes 在 Phase 6 中 DETACH DELETE 旧节点（[store.ts](file:///workspace/src/store/store.ts)），历史被永久丢失。但 A-TMA (2026.07) 指出，即使软删除也存在问题：
- 旧事实和新事实同时存在于记忆库
- 检索时混合返回，误导 LLM
- 需要通过"状态感知"明确标注每条记忆的时态角色

**A-TMA 三层故障模型**：

| 层级 | 故障 | 表现 |
|---|---|---|
| Bank | 存储层冲突 | 旧/新/过渡态共存 |
| Retrieval | 检索层混合 | 检索同时返回新旧事实 |
| Answer | 答案层误导 | LLM 无法区分当前有效事实 |

**实现要点**：

- 在 S-1 Bi-Temporal 基础上添加 `state` 字段：`current` / `superseded` / `transitional`
- 召回时按 state 分类，明确标注："以下信息当前有效""以下信息已过时"
- 新增 `GET /api/conflicts?nodeId=` 查看某一节点的所有状态版本
- 新增 A-TMA 风格的 LTP (LoCoMo Temporal Plus) 评测

**接入点**：

- `src/types.ts` 添加 state 字段
- `src/store/store.ts` upsertNode 时设置 state
- `src/recaller/recall.ts` 召回时按 state 分类

**配置项**：

```json
{
  "contradiction": {
    "enabled": false,
    "stateTracking": true,
    "conflictDetection": true,
    "retrievalLabeling": true
  }
}
```

**预计成本**：3-4 天

---

#### S-14 记忆过时检测（Mem0 2026 报告三大开放问题之一）

**目标**：检测长期记忆中已过时的信息，防止"置信但错误"的检索。

**问题背景**：Mem0 2026 报告明确指出"staleness in long-term memory is unresolved"。当前项目 L-2 的衰减机制只处理"不活跃"节点，不处理"内容过时"节点——一个节点即使每天都用到，其内容可能已经过时。

**实现要点**：

- 新增 `stalenessScore` 字段（0~1，0=新鲜，1=过时）
- 过时检测信号：内容与最新对话的矛盾程度、S-13 的 state 变更频率、外部来源验证（如 R-2 的 Tier 3 工具验证）
- 过时节点在召回时降权或标注警告
- 与 S-13 矛盾检测协同：过时是矛盾的前兆

**接入点**：

- `src/types.ts` 添加 stalenessScore 字段
- `src/graph/maintenance.ts` 新增过时检测阶段
- `src/recaller/recall.ts` 召回时按 stalenessScore 降权

**配置项**：

```json
{
  "staleness": {
    "enabled": false,
    "threshold": 0.7,
    "detectionMode": "heuristic"  // "heuristic" | "llm" | "external"
  }
}
```

**预计成本**：2-3 天

---

### 模块 R：自主进化（RL4MEM 范式升级）

> 来源：EvolveMem / U-Mem / UMEM / EvoEmbedding / Dynamic Mixture 五篇 2026 前沿论文
> 定位：v2.1.10 核心范式升级——从"被动存查"到"主动思考记忆"
> 关系：R-1 吸收原 E 模块（评估体系），R-2 升级 I-2 裁判，R-3/R-4 升级 L-1，R-5 升级 S-6

#### R-1 自主调优动作空间 + LLM 诊断循环（EvolveMem）

**目标**：把召回参数从静态配置升级为 LLM 自主调优的动作空间，无需人工调参。

**问题背景**：当前 [types.ts](file:///workspace/src/types.ts) 的 recallMaxNodes/recallMaxDepth/pagerankDamping/dedupThreshold 等参数是静态配置，不同任务类型（事实查询 vs 多跳推理）需要不同策略，静态配置无法最优。

**EvolveMem 四步循环**（EVALUATE–DIAGNOSE–PROPOSE–GUARD）：

1. **EVALUATE**：在评测集/历史反馈上评估当前配置的表现（吸收原 E-1/E-2/E-3）
2. **DIAGNOSE**：LLM 读取失败案例，归类根因（如"向量搜索召回过多噪声""PPR 深度不足"）
3. **PROPOSE**：LLM 提出针对性配置调整（如"recallMaxNodes 6→10，dedupThreshold 0.90→0.85"）
4. **GUARD**：应用调整，若回退则自动 revert；若停滞则探索新维度（explore-on-stagnation）

**动作空间**（结构化）：

```typescript
interface EvolveActionSpace {
  recallMaxNodes: number;        // 3-15
  recallMaxDepth: number;        // 1-4
  pagerankDamping: number;      // 0.7-0.95
  pagerankIterations: number;    // 10-50
  dedupThreshold: number;        // 0.80-0.98
  freshTailCount: number;        // 5-20
  associativeLearningRate: number; // 0.001-0.1
  vectorSearchTopK: number;      // 5-30
  // 可进化出原配置不存在的维度
}
```

**安全护栏**（EvolveMem 核心贡献）：

- **revert-on-regression**：新配置在评测集上退步 > 阈值 → 自动回退到上一稳定配置
- **explore-on-stagnation**：连续 N 轮无改进 → 探索原动作空间外的新维度
- **配置版本快照**：每次变更存快照，可回溯（与 S-1 Bi-Temporal 呼应）

**接入点**：

- 新增 `src/evolution/diagnose.ts` LLM 诊断模块
- 新增 `src/evolution/action_space.ts` 动作空间定义
- 新增 `src/evolution/guard.ts` 安全护栏
- `src/graph/maintenance.ts` 维护周期末尾触发诊断循环

**配置项**：

```json
{
  "evolve": {
    "enabled": false,
    "intervalRounds": 10,       // 每 N 次维护触发一次诊断
    "revertThreshold": 0.02,    // 退步 > 2pp 触发回退
    "stagnationRounds": 5,      // 连续 N 轮无改进触发探索
    "configSnapshotKeep": 20    // 保留最近 N 个配置快照
  }
}
```

**吸收原 E 模块**：

- E-1 评测集构建 → R-1 的 EVALUATE 阶段
- E-2 随机抽样评测 → R-1 的 EVALUATE 防过拟合
- E-3 评测指标（P@1/P@3/MRR/Recall@K/Latency/Feedback Coverage）→ R-1 的评估指标

**预计成本**：5-7 天

---

#### R-2 成本感知提取级联（U-Mem）

**目标**：把 I-2 单层 LLM 裁判升级为多级成本感知级联，低成本信号优先，按需升级。

**问题背景**：当前规划的 I-2 裁判每次都调 LLM，成本高。不同难度案例需要不同强度的验证——简单案例自监督即可，复杂案例才需工具/专家。

**U-Mem 三层级联**：

| 层级 | 信号源 | 成本 | 触发条件 |
|---|---|---|---|
| Tier 1 | 自监督（启发式规则：节点是否在回复中被引用） | 极低 | 默认 |
| Tier 2 | 教师模型（更强的 LLM 判断） | 中 | Tier 1 置信度 < 0.7 |
| Tier 3 | 工具验证（代码解释器/搜索验证事实） | 高 | Tier 2 置信度 < 0.6 或涉及事实性声明 |

**语义感知 Thompson 采样**（U-Mem 核心贡献）：

- 用 Thompson 采样平衡"召回熟悉节点"（利用）vs"召回新节点"（探索）
- 缓解冷启动偏差——新部署时多探索，积累后多利用
- 每个节点维护 Beta 分布参数（α=命中，β=未命中）

```typescript
// 召回时按 Thompson 采样给节点加扰动
for (const node of candidates) {
  const sampled = betaSample(node.alpha, node.beta);  // Thompson 采样
  node.score = node.baseScore * 0.8 + sampled * 0.2;  // 平滑混合
}
```

**主动知识获取**（U-Mem 主动维度）：

- 当所有候选节点置信度都低时，记忆系统主动寻求外部输入（如调用工具验证、请求澄清）
- 区别于传统被动接收——这是"主动思考记忆"的核心体现

**接入点**：

- 升级 `src/recaller/judge.ts`（原 I-2）为级联结构
- 新增 `src/evolution/thompson.ts` Thompson 采样
- `src/recaller/recall.ts` 召回时应用采样

**配置项**：

```json
{
  "judgeCascade": {
    "enabled": false,
    "tier1Confidence": 0.7,
    "tier2Confidence": 0.6,
    "thompsonExploration": 0.2,
    "activeAcquisition": false
  }
}
```

**预计成本**：3-5 天

---

#### R-3 语义邻域建模 + 边际效用奖励（UMEM）

**目标**：把 L-1 M 矩阵的奖励从二值（用/没用）升级为边际效用，避免死记硬背。

**问题背景**：文章进化出的 M 矩阵用二值反馈，容易过拟合到特定案例（文章明确教训：500 题 88.4% → 全量 30.1%）。UMEM 的边际效用奖励可解决此问题。

**语义邻域建模**（UMEM 核心贡献）：

- 把 query 转成"语义指纹"（embedding）
- 找到相似 query 形成邻域簇
- 在整个邻域上验证经验，而非单一案例
- 强制学习普适规律，抛弃实例特定噪声

```typescript
// 语义邻域：找到与当前 query 相似的 N 个历史 query
const neighborhood = await findSemanticNeighbors(queryVec, history, k=5);
// 在邻域上评估 M 更新的边际效用
const marginalUtility = evaluateOnNeighborhood(mUpdate, neighborhood);
if (marginalUtility > threshold) applyUpdate(mUpdate);  // 只在邻域整体提升时更新
```

**边际效用奖励**（替代二值）：

- 奖励 = 该记忆对邻域内所有 query 的边际贡献
- 用 GRPO（Group Relative Policy Optimization）优化 M
- 确保提取的记忆是普适规律，而非实例噪声

**统一提取与管理**（UMEM 哲学）：

- 不再把 extract（提取）和 management（管理）分离
- L-1 的 M 矩阵学习与 I-1 提取统一优化
- 单调增长曲线——长期演进不退化

**接入点**：

- 升级 `src/recaller/associative.ts`（原 L-1）的奖励计算
- 新增 `src/evolution/neighborhood.ts` 语义邻域
- 新增 `src/evolution/grpo.ts` GRPO 优化（轻量版，避免重训练）

**配置项**：

```json
{
  "marginalUtility": {
    "enabled": false,
    "neighborhoodSize": 5,
    "updateThreshold": 0.05,
    "grpoEnabled": false
  }
}
```

**预计成本**：4-6 天

---

#### R-4 可进化嵌入（EvoEmbedding）

**目标**：让节点嵌入随信息更新而迭代，解决静态嵌入无法识别时效性/冲突的核心缺陷。

**问题背景**：当前 [store.ts](file:///workspace/src/store/store.ts) 的 embedding 在节点创建时计算一次，节点内容更新后不重算。导致：①时效性信息无法反映在嵌入中；②冲突事实（v1 和 v2 矛盾）的嵌入混在一起。

**可进化嵌入机制**：

- 节点 content 更新时（upsertNode），触发嵌入重算
- 维护"嵌入版本"（embeddingVersion），跟踪演化历史
- 冲突消解：当新事实与旧事实矛盾（通过 S-1 Bi-Temporal 检测），新嵌入覆盖旧嵌入，旧嵌入存档

```typescript
// upsertNode 时检查内容是否实质变化
if (contentChanged(node, newNode) || factsConflict(node, newNode)) {
  const newEmbedding = await embedFn(newNode.text);
  node.embeddingHistory = node.embeddingHistory || [];
  node.embeddingHistory.push({ version: node.embeddingVersion, embedding: node.embedding, validTo: now });
  node.embedding = newEmbedding;
  node.embeddingVersion = (node.embeddingVersion || 0) + 1;
}
```

**与 R-3 协同**：

- R-3 的语义邻域基于当前 embeddingVersion
- R-4 的嵌入演化反馈给 R-1 诊断（嵌入漂移可能提示概念演化）

**接入点**：

- 升级 `src/store/store.ts` upsertNode 嵌入演化
- 升级 `src/engine/embed.ts` 支持版本化嵌入
- `src/graph/reembed.ts` 批量重嵌入时考虑冲突消解

**配置项**：

```json
{
  "evoEmbedding": {
    "enabled": false,
    "reembedOnContentChange": true,
    "conflictDetection": true,
    "keepHistoryVersions": 5
  }
}
```

**预计成本**：3-4 天

---

#### R-5 动态记忆混合（Dynamic Mixture of Latent Memories）

**目标**：把 S-6 场景隔离从二值（全局/本场景）升级为动态记忆单元组合，运行时自主适配。

**问题背景**：S-6 的场景隔离是硬隔离——要么全局记忆，要么本场景记忆。但实际任务可能需要"70% 本场景 + 20% 相似场景 + 10% 全局"的动态混合。

**动态混合机制**（Dynamic Mixture 核心贡献）：

- 每个场景维护一个"记忆单元"（latent memory unit）
- 召回时根据当前任务特征，动态混合多个单元
- 容量与效率动态平衡——简单任务用小单元，复杂任务聚合多单元

```typescript
// 动态混合召回
const units = [
  { sceneId: currentScene, weight: 0.7 },      // 本场景主导
  { sceneId: similarScene, weight: 0.2 },        // 相似场景辅助
  { sceneId: null, weight: 0.1 },                // 全局兜底
];
const recalled = await dynamicMixRecall(queryVec, units);
```

**权重学习**：

- 混合权重通过 R-1 的诊断循环学习（哪个场景组合效果好）
- 初始均匀分布，逐步收敛到最优组合

**接入点**：

- 升级 S-6 `src/recaller/recall.ts` 的场景过滤为动态混合
- 新增 `src/evolution/mixture.ts` 记忆单元管理

**配置项**：

```json
{
  "dynamicMixture": {
    "enabled": false,
    "maxUnits": 5,
    "weightLearning": true
  }
}
```

**预计成本**：3-5 天

---

## 四、配置总览

v2.1.10 新增配置项（全部默认关闭，渐进启用）：

```json
{
  "plugins": {
    "entries": {
      "graph-memory-pro": {
        "config": {
          "neo4j": { /* 现有配置 */ },
          "llm": { /* 现有配置 */ },
          "embedding": { /* 现有配置 */ },

          "queryCache": {
            "enabled": true,
            "maxSize": 100,
            "ttlMs": 1800000,
            "similarityThreshold": 0.95
          },

          "judge": {
            "enabled": false,
            "asyncMode": true,
            "timeout": 10000
          },

          "associative": {
            "enabled": false,
            "dimensions": 1024,
            "learningRate": 0.01,
            "warmupFeedbacks": 100,
            "algorithm": "adam"
          },

          "decay": {
            "enabled": false,
            "experienceRate": 0.95,
            "knowledgeRate": 0.99,
            "archiveThreshold": 0.1
          },

          "edgeTuning": {
            "enabled": false,
            "reinforceRate": 0.1,
            "weakenRate": 0.05,
            "momentum": 0.9
          },

          "community": {
            "hierarchyDepth": 3,
            "minMembersPerCommunity": 3
          },

          "temporal": {
            "enabled": false,
            "softDelete": true
          },

          "scene": {
            "enabled": false,
            "isolation": "soft"
          },

          "profile": {
            "enabled": false,
            "distillInterval": 100,
            "maxPreferences": 20
          },

          "evolve": {
            "enabled": false,
            "intervalRounds": 10,
            "revertThreshold": 0.02,
            "stagnationRounds": 5,
            "configSnapshotKeep": 20
          },

          "judgeCascade": {
            "enabled": false,
            "tier1Confidence": 0.7,
            "tier2Confidence": 0.6,
            "thompsonExploration": 0.2,
            "activeAcquisition": false
          },

          "marginalUtility": {
            "enabled": false,
            "neighborhoodSize": 5,
            "updateThreshold": 0.05,
            "grpoEnabled": false
          },

          "evoEmbedding": {
            "enabled": false,
            "reembedOnContentChange": true,
            "conflictDetection": true,
            "keepHistoryVersions": 5
          },

          "dynamicMixture": {
            "enabled": false,
            "maxUnits": 5,
            "weightLearning": true
          },

          "summary": {
            "enabled": false,
            "defaultPeriod": "week",
            "maxNodesPerSummary": 50
          },

          "episodicBuffer": {
            "enabled": false,
            "maxTokens": 2048,
            "consolidationMode": "semantic"
          },

          "benchmark": {
            "enabled": false,
            "dataset": "locomo",
            "outputDir": "benchmarks/results"
          },

          "zettelkasten": {
            "enabled": false,
            "noteConstruction": true,
            "linkGeneration": true,
            "memoryEvolution": true,
            "evolutionTrigger": "semantic"
          },

          "abstraction": {
            "enabled": false,
            "minTrajectories": 5,
            "minPatternFrequency": 3,
            "mdlCompressionThreshold": 0.5
          },

          "contradiction": {
            "enabled": false,
            "stateTracking": true,
            "conflictDetection": true,
            "retrievalLabeling": true
          },

          "staleness": {
            "enabled": false,
            "threshold": 0.7,
            "detectionMode": "heuristic"
          }
        }
      }
    }
  }
}
```

---

## 五、实施顺序

v2.1.10 内部按依赖关系分批实施：

### 第一批：基础设施与 schema 扩展（无依赖）

1. **S-3 来源标记** → schema 扩展，最简单
2. **S-6 场景隔离字段** → schema 扩展（sceneId）
3. **I-1 历史查询缓存** → 立即缓解超时
4. **I-3 反馈持久化** → schema 准备
5. **S-7 用户画像 schema** → 新增 GmProfile 类型
6. **S-13 state 字段** → schema 扩展（current/superseded/transitional）
7. **S-14 stalenessScore 字段** → schema 扩展

### 第二批：反馈闭环与时态（依赖第一批）

8. **I-2 LLM 裁判反馈** → 依赖 I-3 持久化
9. **S-1 Bi-Temporal 字段** → schema 扩展
10. **S-5 因果关系扩展** → schema 扩展
11. **S-7 用户画像蒸馏** → 依赖 S-7 schema

### 第三批：学习能力（依赖第二批）

12. **L-1 关联记忆矩阵 M** → 依赖 I-2 反馈
13. **L-2 节点衰减** → 依赖 I-2 反馈 + S-3 来源
14. **S-2 软替换** → 依赖 S-1

### 第四批：结构升级与生命周期管理（依赖第三批）

15. **L-3 边权重调整** → 依赖 L-2
16. **L-4 反向记忆项** → 依赖 L-2
17. **S-4 层次化社区** → 独立
18. **S-6 场景隔离召回过滤** → 依赖 S-6 schema
19. **S-9 情节缓冲与语义整合分离** → 依赖 S-1 + extract.ts
20. **S-10 Benchmark 评估体系** → 独立（使用外部数据集）
21. **S-11 自主 Link/Evolve 闭环** → 依赖 extract.ts + I-2 + R-3
22. **S-12 跨轨迹抽象** → 依赖 I-3 反馈数据 + S-4 社区
23. **S-13 矛盾检测与消解** → 依赖 S-1 + S-13 schema
24. **S-14 记忆过时检测** → 依赖 S-1 + S-13

### 第五批：自主进化 + 回顾总结（依赖前面所有，v2.1.10 核心范式升级）

25. **R-2 成本感知提取级联** → 升级 I-2 裁判为多级级联
26. **R-4 可进化嵌入** → 升级 store.ts 嵌入演化
27. **R-3 语义邻域 + 边际效用奖励** → 升级 L-1 M 矩阵奖励
28. **R-1 自主调优动作空间 + LLM 诊断循环** → 吸收 E 模块，依赖 R-2/R-3/R-4
29. **R-5 动态记忆混合** → 升级 S-6 场景隔离为动态混合
30. **S-8 记忆回顾总结** → 依赖 S-1 + S-4 + S-7 + S-10

---

## 六、关键风险与对策

| 风险 | 来源 | 对策 |
|---|---|---|
| 裁判反馈延迟/缺失 | 文章场景同步，项目异步 | I-2 设计兜底：无反馈时不更新 M |
| M 矩阵过拟合特定对话模式 | 文章明确教训 | R-3 语义邻域 + 边际效用奖励防过拟合 |
| 裁判准确率上限（90%） | 文章数据 | L-1 用 Momentum 平滑噪声；R-2 多级级联分层验证 |
| M 只对向量搜索有效 | 原创 | 明确边界：graphWalk/PPR 不受 M 影响 |
| Schema 演进破坏旧数据 | 论文 | S-1 所有新字段可选，向后兼容 |
| 衰减误删活跃节点 | 原创 | archived 而非删除，可恢复 |
| 层次化社区计算成本高 | 原创 | 限制 hierarchyDepth ≤ 3，缓存中间结果 |
| 反馈数据积累慢 | 原创 | 冷启动期用 BM25 + 向量搜索兜底；R-2 Thompson 采样多探索 |
| 场景隔离误判全局记忆 | TencentDB L2 | S-6 默认 soft 模式（全局+本场景）；R-5 动态混合替代硬隔离 |
| 用户画像过拟合历史偏好 | TencentDB L3 | S-7 画像带时间衰减，旧偏好降权 |
| LLM 诊断误调优导致回退 | EvolveMem | R-1 revert-on-regression 自动回退上一稳定配置 |
| 自主进化陷入停滞 | EvolveMem | R-1 explore-on-stagnation 探索新动作维度 |
| 成本感知级联触发过频 | U-Mem | R-2 Tier 1 默认自监督，仅置信度低时升级 |
| 嵌入演化历史膨胀 | EvoEmbedding | R-4 限制 keepHistoryVersions，旧版本归档 |
| 动态混合权重不收敛 | Dynamic Mixture | R-5 权重学习限幅，初始均匀分布逐步收敛 |
| GRPO 轻量化实现偏差 | UMEM | R-3 grpoEnabled 默认关闭，先验证边际效用奖励效果 |
| **情节缓冲语义边界检测不准** | GAM | S-9 支持回退到 token_count 模式作为兜底 |
| **Benchmark 数据集不能直接用于 Neo4j 图谱** | Mem0 报告 | S-10 提供适配层，将对话转为 graph-memory 的提取格式 |
| **Zettelkasten LLM 调用成本过高** | A-MEM | S-11 仅对新活跃节点触发，批量处理 |
| **跨轨迹抽象过度泛化** | Survey | S-12 MDL 压缩阈值防止低质量抽象 |
| **幽灵记忆状态标注不准确** | A-TMA | S-13 基于 S-1 的 Bi-Temporal 自动推导 state |
| **过时检测假阳性** | Mem0 报告 | S-14 检测模式默认 heuristic，LLM 模式可选 |

---

## 七、验收标准

v2.1.10 发布需满足：

### 功能验收

- [ ] I-1 历史查询缓存：相同 query 第二次延迟 < 10ms
- [ ] I-2 LLM 裁判：异步运行，准确率 > 85%
- [ ] I-3 反馈持久化：可查询历史反馈
- [ ] L-1 关联矩阵 M：冷启动后启用，不破坏现有召回
- [ ] L-2 节点衰减：archived 节点不参与召回
- [ ] S-1 Bi-Temporal：支持 `?at=timestamp` 查询
- [ ] S-2 软替换：merge 后可查询历史版本
- [ ] S-3 来源标记：新节点默认 `source = "experience"`
- [ ] S-4 层次化社区：支持 3 层抽象
- [ ] S-5 因果关系：支持 CAUSED_BY/LEADS_TO
- [ ] S-6 场景隔离：召回支持 sceneId 过滤，不串场
- [ ] S-7 用户画像：可从历史对话蒸馏偏好，召回时参考画像
- [ ] R-1 自主调优：LLM 诊断循环可运行，revert-on-regression 生效
- [ ] R-2 成本感知级联：3 层级联按置信度触发，Tier 1 命中率 > 60%
- [ ] R-3 边际效用奖励：M 更新基于邻域评估，过拟合信号可检测
- [ ] R-4 可进化嵌入：节点 content 变更触发重嵌入，冲突可检测
- [ ] R-5 动态记忆混合：多场景权重可学习，召回结果按权重混合
- [ ] S-8 记忆回顾总结：gm_summary 工具可生成周/月/年摘要，HTTP API 支持时间范围查询
- [ ] S-9 情节缓冲：语义边界检测触发整合，全局图谱不受临时噪声污染
- [ ] S-10 Benchmark：LoCoMo P@1 > 50%，LongMemEval 时序 F1 可用
- [ ] S-11 自主 Link/Evolve：新记忆触发旧记忆更新，链接可扩展召回范围
- [ ] S-12 跨轨迹抽象：经验节点正确蒸馏，MDL 压缩比 > 0.5
- [ ] S-13 矛盾检测：state 字段正确标注，召回时区分 current/superseded
- [ ] S-14 过时检测：stalenessScore 正确计算，过时节点在召回中降权

### 性能验收

- [ ] 召回延迟 P99 < 500ms（含缓存命中场景）
- [ ] 维护周期不因衰减/边调整显著延长（< 30%）
- [ ] M 矩阵内存占用 < 50MB（1024×1024 × 4 字节 ≈ 4MB）
- [ ] R-1 诊断循环单次开销 < 30s（含 LLM 调用）
- [ ] R-2 级联整体成本 < 单层 LLM 裁判的 50%
- [ ] R-4 嵌入重算仅在 content 实质变化时触发（非每次 upsert）

### 兼容性验收

- [ ] 旧数据（无新字段）可正常读写
- [ ] 关闭新功能时行为与 v2.2.0 一致
- [ ] 现有 HTTP API 不破坏向后兼容
- [ ] R-1 关闭时回退到静态配置（与当前一致）
- [ ] R-2 关闭时回退到单层 I-2 裁判
- [ ] R-3/R-4 关闭时回退到 L-1 基础 M 矩阵
- [ ] R-5 关闭时回退到 S-6 硬隔离
- [ ] S-6 场景隔离关闭时行为与无 sceneId 一致

---

## 八、参考资料

### 论文（结构维度）

- **Graph-based Agent Memory: Taxonomy, Techniques, and Applications** (arxiv 2602.05665)
  - 提供记忆分类体系、Bi-Temporal 建模、层次化结构、超图等结构化框架
  - 核心论点：所有记忆形式都是"图记忆"的特殊情形

### 论文（情节/语义分离 + 生命周期管理）

- **GAM: Hierarchical Graph-based Agentic Memory for LLM Agents** (ACL 2026, 浙大+UIC)
  - 情节缓冲与语义整合分离；Semantic-Event-Triggered 状态切换
  - Graph-Guided Multi-Factor Retrieval（时间/置信度/角色三因子）
  - LoCoMo F1 40.00 vs Mem0 35.38 (+4.62)；Token 11% more efficient
  - 代码：https://github.com/orgs/GAM-memory

- **A-MEM: Agentic Memory for LLM Agents** (NeurIPS 2025, Rutgers+蚂蚁)
  - Zettelkasten 四步闭环：Note→Link→Evolve→Retrieve
  - LoCoMo Multi-Hop F1 27.02 vs ReadAgent 9.15；Token 2,520 vs 16,910
  - 代码：https://github.com/WujiangXu/AgenticMemory

- **From Storage to Experience: A Survey on the Evolution of LLM Agent Memory Mechanisms** (ICLR 2026 under review)
  - 三阶段进化框架：Storage→Reflection→Experience
  - 跨轨迹抽象 + 主动探索为核心创新机制
  - 论文：arxiv 2605.06716

- **A-TMA: Decoupling State-Aware Memory Failures** (2026.07, NUS)
  - 幽灵记忆三层故障模型：Bank/Retrieval/Answer
  - 状态感知记忆覆盖层；LTP (LoCoMo Temporal Plus) Benchmark
  - 论文：arxiv 2607.01935

- **Mandol: An Agglomerative Agent Memory System** (2026.06, 华东师大)
  - 凝聚式记忆系统；统一混合检索；可逆记忆
  - 5.4x retrieval speedup, 4.8x insertion speedup
  - 论文：arxiv 2606.29778

### 论文（自主进化维度，RL4MEM）

- **EvolveMem: Self-Evolving Memory Architecture via AutoResearch for LLM Agents** (arxiv 2605.13941, Liu et al., 2026.05)
  - 检索配置暴露为结构化动作空间；EVALUATE–DIAGNOSE–PROPOSE–GUARD 四步循环
  - revert-on-regression + explore-on-stagnation 安全护栏
  - LoCoMo 30.5%→54.3%（+78%）；跨基准正向迁移
  - 代码：https://github.com/aiming-lab/SimpleMem

- **Towards Autonomous Memory Agents (U-Mem)** (arxiv 2602.22406, Wu et al., NUS, 2026)
  - 成本感知 3 层提取级联：自监督→工具验证→专家反馈
  - 语义感知 Thompson 采样平衡探索/利用
  - 半计算量超 RL 优化；HotpotQA +14.6pp

- **UMEM: Unified Memory Extraction and Management Framework** (arxiv 2602.10652, 厦大+阿里+通义, 2026.02)
  - 语义邻域建模 + 边际效用奖励 + GRPO
  - 统一提取与管理，避免"死记硬背"陷阱
  - 多轮任务 +10.67%；单调增长曲线

- **EvoEmbedding: Evolvable Representations for Long-Context Retrieval and Agentic Memory** (南京大学, 2026.06)
  - 可进化检索表示，嵌入随新信息迭代
  - 解决静态嵌入无法识别时效性/冲突的核心缺陷

- **Dynamic Mixture of Latent Memories for Self-Evolving Agents** (Yu et al., 2026)
  - 动态隐式记忆单元组合，运行时自主适配
  - 记忆容量与检索效率的动态平衡

### 行业报告与 Benchmark

- **Mem0 State of AI Agent Memory 2026** (Mem0, 2026.04)
  - LoCoMo 92.5 / LongMemEval 94.4 / BEAM 64.1 @ 1M
  - 三大开放问题：跨会话身份、时态抽象规模化、记忆过时检测
  - 21 框架零标准，Benchmark 已成行业共识
  - 报告：https://mem0.ai/blog/state-of-ai-agent-memory-2026

### 实践文章

- **我让三个 AI 互相竞争进化，两天后它们发明了一个我看不懂的算法**（方治宇，2026.03.17）
  - 提供自进化记忆系统的工程实践
  - 关键数据：26% → 92% 准确率提升
  - 关键教训：评测目标比进化策略更重要；进化会过拟合；90% 反馈下只掉 0.4pp
  - 代码：https://github.com/Fzhiyu1/meomory

### 开源项目

- **TencentDB Agent Memory**（腾讯云数据库团队，2026.05 开源）
  - 提供 L0-L3 四层渐进式记忆架构（本规划仅纳入 L1/L2/L3）
  - 关键数据：长期记忆准确率 48% → 76%
  - 设计哲学："上层提供方向，下层保留证据"，可追溯理念
  - 代码：https://github.com/Tencent/TencentDB-Agent-Memory

### 项目内相关文件

- [src/recaller/recall.ts](file:///workspace/src/recaller/recall.ts) — 召回主逻辑，I-1/I-2/L-1/R-2/R-5/S-8/S-13/S-14 接入点
- [src/store/store.ts](file:///workspace/src/store/store.ts) — 数据层，I-3/S-1/S-2/S-3/S-13/S-14/R-4 接入点
- [src/graph/maintenance.ts](file:///workspace/src/graph/maintenance.ts) — 维护逻辑，L-2/L-3/L-4/S-12/S-14/R-1 接入点
- [src/graph/community.ts](file:///workspace/src/graph/community.ts) — 社区检测，S-4 接入点
- [src/types.ts](file:///workspace/src/types.ts) — 类型定义，S-1/S-3/S-5/S-13/S-14/R-1 动作空间 接入点
- [src/extractor/extract.ts](file:///workspace/src/extractor/extract.ts) — 三元组提取，S-3/S-5/S-9/S-11 接入点
- [src/engine/embed.ts](file:///workspace/src/engine/embed.ts) — Embedding 引擎，R-4 接入点
- [src/index.ts](file:///workspace/index.ts) — 插件入口，S-8/S-9 接入点

---

## 九、版本信息

- **规划版本**：2.1.10
- **基于版本**：2.2.0（当前已发布）
- **规划日期**：2026-07-04
- **模块定位**：记忆长期管理模块（压缩/上下文管理由宿主处理，不入本规划）
- **核心范式升级**：从"被动存查"到"主动思考记忆"（RL4MEM 自主进化）
- **预计实施周期**：根据优先级矩阵渐进推进，单版本内完成所有模块
