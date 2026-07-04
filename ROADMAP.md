# Graph Memory Pro 演进路线图

> 版本：2.1.10
> 基于 Graph-based Agent Memory 论文（arxiv 2602.05665）与自进化记忆系统实践文章的综合规划

---

## 一、背景与思路来源

本规划融合两份参考资料的设计思路：

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

### 3. 两者融合点

```
论文提供"骨架"（图结构如何组织）
文章提供"神经"（图如何自我优化）

graph-memory-pro = 骨架已备 + 神经缺失
```

关键融合洞察：

1. **裁判反馈信号**不仅可驱动 M 矩阵学习，还可驱动**节点衰减**和**边权重调整**——一个反馈源，三个受益点
2. **Bi-Temporal** 让"反向记忆项"成为可能——不是删除，而是 `validTo = now` 标记失效
3. **层次化社区** + **历史相似度加权**结合，可实现"从社区代表向下钻取到具体节点"的层次化召回
4. **来源区分**让衰减策略可差异化——知识记忆衰减慢，经验记忆衰减快

---

## 二、v2.1.10 总体目标

将以下四大方向**统一在 v2.1.10 版本内**完成：

| 方向 | 核心能力 | 来源 |
|---|---|---|
| 基础设施 | 反馈闭环与缓存层 | 文章 P0 |
| 学习能力 | 在线学习与衰减机制 | 文章 + 论文融合 |
| 结构升级 | 时态建模与层次化 | 论文 |
| 智能进化（评估） | 评测集与防过拟合 | 文章教训 |

**设计原则**：

- **向后兼容**：所有 schema 演进通过可选字段实现，旧数据自动兼容
- **渐进启用**：新能力默认关闭，通过配置开启
- **降级安全**：反馈缺失时 M 不更新，裁判不可用时不阻塞召回
- **可观测**：所有学习行为有日志与指标

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

### 模块 E：智能进化（评估与防过拟合）

#### E-1 标准评测集构建

**目标**：为后续进化提供评测基准，没有评测集就无法验证改进。

**关键教训**（来自文章）：评测目标比进化策略更重要。

**实现要点**：

- 从 I-3 反馈数据中提取"成功召回案例"和"失败召回案例"
- 标注 query → 正确节点 ID 的映射
- 形成 graph-memory 专属评测集（初始目标 200 条）
- 评测指标：P@1、P@3、MRR

**预计成本**：3-5 天（数据积累 + 标注）

---

#### E-2 随机抽样评测机制

**目标**：防止过拟合到特定评测集。

**关键教训**（来自文章）：

- 500 题上"进步"了 0.8，全量上退步了 19
- 同一个算法每次面对不同的题目——想过拟合也没有固定目标可以拟合

**实现要点**：

- 每次评测随机抽不同的子集（如从 200 条中抽 50 条）
- 全量验证集作为最终把关
- 监控"小集涨 + 大集跌"的过拟合信号
- 触发阈值：小集提升 > 2pp 且大集下降 > 1pp → 标记为过拟合

**预计成本**：1-2 天

---

#### E-3 评测指标扩展

**目标**：建立多维度的评测体系。

**指标维度**：

| 指标 | 含义 | 目标 |
|---|---|---|
| P@1 | 第一个结果就是正确的概率 | > 60% |
| P@3 | 前三个结果包含正确的概率 | > 80% |
| MRR | 平均倒数排名 | > 0.7 |
| Recall@K | 召回率 | > 90% |
| Latency P99 | 99 分位延迟 | < 500ms |
| Feedback Coverage | 有反馈的召回比例 | > 70% |

**预计成本**：1 天

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

### 第一批：基础设施（无依赖）

1. **S-3 来源标记** → schema 扩展，最简单
2. **I-1 历史查询缓存** → 立即缓解超时
3. **I-3 反馈持久化** → schema 准备

### 第二批：反馈闭环（依赖第一批）

4. **I-2 LLM 裁判反馈** → 依赖 I-3 持久化
5. **S-1 Bi-Temporal 字段** → schema 扩展
6. **S-5 因果关系扩展** → schema 扩展

### 第三批：学习能力（依赖第二批）

7. **L-1 关联记忆矩阵 M** → 依赖 I-2 反馈
8. **L-2 节点衰减** → 依赖 I-2 反馈 + S-3 来源
9. **S-2 软替换** → 依赖 S-1

### 第四批：结构升级（依赖第三批）

10. **L-3 边权重调整** → 依赖 L-2
11. **L-4 反向记忆项** → 依赖 L-2
12. **S-4 层次化社区** → 独立

### 第五批：评估体系（依赖前面所有）

13. **E-1 评测集构建** → 依赖 I-3 反馈数据
14. **E-2 随机抽样评测** → 依赖 E-1
15. **E-3 评测指标扩展** → 依赖 E-1

---

## 六、关键风险与对策

| 风险 | 来源 | 对策 |
|---|---|---|
| 裁判反馈延迟/缺失 | 文章场景同步，项目异步 | I-2 设计兜底：无反馈时不更新 M |
| M 矩阵过拟合特定对话模式 | 文章明确教训 | E-2 随机抽样评测 |
| 裁判准确率上限（90%） | 文章数据 | L-1 用 Momentum 平滑噪声 |
| M 只对向量搜索有效 | 原创 | 明确边界：graphWalk/PPR 不受 M 影响 |
| Schema 演进破坏旧数据 | 论文 | S-1 所有新字段可选，向后兼容 |
| 衰减误删活跃节点 | 原创 | archived 而非删除，可恢复 |
| 层次化社区计算成本高 | 原创 | 限制 hierarchyDepth ≤ 3，缓存中间结果 |
| 反馈数据积累慢 | 原创 | 冷启动期用 BM25 + 向量搜索兜底 |

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

### 性能验收

- [ ] 召回延迟 P99 < 500ms（含缓存命中场景）
- [ ] 维护周期不因衰减/边调整显著延长（< 30%）
- [ ] M 矩阵内存占用 < 50MB（1024×1024 × 4 字节 ≈ 4MB）

### 兼容性验收

- [ ] 旧数据（无新字段）可正常读写
- [ ] 关闭新功能时行为与 v2.2.0 一致
- [ ] 现有 HTTP API 不破坏向后兼容

---

## 八、参考资料

### 论文

- **Graph-based Agent Memory: Taxonomy, Techniques, and Applications** (arxiv 2602.05665)
  - 提供记忆分类体系、Bi-Temporal 建模、层次化结构、超图等结构化框架
  - 核心论点：所有记忆形式都是"图记忆"的特殊情形

### 实践文章

- **我让三个 AI 互相竞争进化，两天后它们发明了一个我看不懂的算法**（方治宇，2026.03.17）
  - 提供自进化记忆系统的工程实践
  - 关键数据：26% → 92% 准确率提升
  - 关键教训：评测目标比进化策略更重要；进化会过拟合；90% 反馈下只掉 0.4pp
  - 代码：https://github.com/Fzhiyu1/meomory

### 项目内相关文件

- [src/recaller/recall.ts](file:///workspace/src/recaller/recall.ts) — 召回主逻辑，I-1/I-2/L-1 接入点
- [src/store/store.ts](file:///workspace/src/store/store.ts) — 数据层，I-3/S-1/S-2/S-3 接入点
- [src/graph/maintenance.ts](file:///workspace/src/graph/maintenance.ts) — 维护逻辑，L-2/L-3 接入点
- [src/graph/community.ts](file:///workspace/src/graph/community.ts) — 社区检测，S-4 接入点
- [src/types.ts](file:///workspace/src/types.ts) — 类型定义，S-1/S-3/S-5 接入点
- [src/extractor/extract.ts](file:///workspace/src/extractor/extract.ts) — 三元组提取，S-3/S-5 接入点

---

## 九、版本信息

- **规划版本**：2.1.10
- **基于版本**：2.2.0（当前已发布）
- **规划日期**：2026-07-04
- **预计实施周期**：根据优先级矩阵渐进推进，单版本内完成所有模块
