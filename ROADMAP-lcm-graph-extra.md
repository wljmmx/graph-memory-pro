# LCM Graph Extra 演进路线图

> 版本：1.0.0
> 模块定位：**上层编排层**——上下文管理、prompt 组装、Agent 工作流、用户界面
> 依赖：graph-memory-pro v2.1.10（记忆底层引擎），通过 Re-exports API 调用
> 对等计划：[graph-memory-pro ROADMAP.md](file:///workspace/ROADMAP.md)

---

## 一、能力边界

```
┌─────────────────────────────────────────────────┐
│  lcm-graph-extra（上层编排层）← 本计划           │
│  上下文管理 · prompt 组装 · Agent 工作流 · UI     │
│  调用 graph-memory-pro 的 Re-exports API         │
├─────────────────────────────────────────────────┤
│  graph-memory-pro（记忆底层引擎）                │
│  提取 · 存储 · 检索 · 去重 · 维护 · 质量 · 进化  │
│  暴露：Recaller / upsertNode / runMaintenance 等  │
└─────────────────────────────────────────────────┘
```

**graph-memory-pro 提供的 Re-exports API**（v2.1.10 后）：
`Recaller`, `upsertNode`, `upsertEdge`, `mergeNodes`, `runMaintenance`, `Extractor`, `extractTriplets`, `searchNodes`, `getTopNodes`, `dedup`, `personalizedPageRank`, `computeGlobalPageRank`, `detectCommunities`, `summarizeCommunities`, `getCommunityPeers`, `getVectorHash`, `createEmbedFn`, `getDriver`, `getNodesByTimeRange`, `upsertProfile`, `getProfile`, `consolidateBuffer`, `linkNodes`, `evolveNode`, `judgeRecall`

---

## 二、v1.0.0 演进方案（14 项）

按依赖关系分为五个批次：

### 第一批：基础设施（无 graph-memory-pro 新增 API 依赖）

| 编号 | 方案 | 论文 | 核心机制 | 成本 |
|---|---|---|---|---|
| S-6 | 场景隔离 | 自研 | 场景划分、隔离策略、跨场景关联 | 3-4天 |
| S-8 | 记忆回顾总结 | 用户需求 | 时间范围查询 + LLM 摘要 + UI | 3-4天 |
| G-11 | Token 预算管理 | TencentDB | 召回结果 token 预算控制，按重要性裁剪 | 2-3天 |

### 第二批：反馈与学习（依赖 graph-memory-pro I-2 裁判反馈）

| 编号 | 方案 | 论文 | 核心机制 | 成本 |
|---|---|---|---|---|
| S-7 | 用户画像 | TencentDB L3 | 对话历史蒸馏 → GmProfile → 个性化召回 | 4-5天 |
| R-2 | 成本感知级联 | U-Mem | Tier 2（教师模型）+ Tier 3（工具验证）+ Thompson 采样 | 4-5天 |
| S-12 | 跨轨迹抽象 | From Storage to Experience | 多对话模式发现 → 经验节点蒸馏 | 4-5天 |
| G-8 | 记忆验证回路 | 闭环反馈 | Agent 使用记忆后验证结果，反馈给 L-3/L-4 | 3-4天 |

### 第三批：自主编排（依赖 graph-memory-pro 新增 API）

| 编号 | 方案 | 论文 | 核心机制 | 成本 |
|---|---|---|---|---|
| S-9 | 情节缓冲 | GAM (ACL 2026) | 缓冲管理 + 语义边界检测 + 触发整合 | 4-5天 |
| S-11 | Zettelkasten | A-MEM (NeurIPS 2025) | Note 构建 + Link 触发 + Evolve 调度 + 记忆簇 Box | 5-7天 |
| R-5 | 动态记忆混合 | Dynamic Mixture | 场景权重学习 + 动态混合召回 | 3-4天 |

### 第四批：编辑性功能（依赖前面批次）

| 编号 | 方案 | 论文 | 核心机制 | 成本 |
|---|---|---|---|---|
| G-7 | 主动记忆建议 | 编辑性 | proactively suggest "你学过 X，与当前任务相关" | 3-4天 |
| G-10 | 主动遗忘命令 | 用户控制 | 用户主动"忘掉这个"命令，触发引擎层降权 | 2-3天 |

### 第五批：运维能力（独立）

| 编号 | 方案 | 论文 | 核心机制 | 成本 |
|---|---|---|---|---|
| G-9 | 记忆导出/导入 | 运维需求 | 备份/恢复/迁移，JSON 格式导出 | 2-3天 |
| G-12 | 记忆簇 Box | A-MEM 核心概念 | 相关记忆打包成簇，召回时按簇扩展 | 2-3天 |

---

## 三、详细任务

### 第一批

#### S-6 场景隔离

**目标**：按项目/会话维度隔离记忆，防止不同项目的记忆互相干扰。

**实现要点**：
- 每次对话开始时，生成或复用 sceneId（基于项目名/会话标识）
- 调用 graph-memory-pro 的 `Recaller` 时传入 `sceneId` 参数
- 跨场景关联：LLM 判断两个场景是否相关，关联时创建显式 link
- 隔离策略：默认 soft（全局+本场景），可切换 strict（仅本场景）

**依赖 graph-memory-pro API**：`Recaller(sceneId)`、`sceneId` 字段（已有）

**成本**：3-4 天

---

#### S-8 记忆回顾总结

**目标**：支持"本周学会了什么""今年有什么特别记忆"等人类可读的记忆回顾。

**实现要点**：
- 自然语言查询解析："本周"→时间范围、"学会了什么"→TASK/SKILL 过滤
- 调用 graph-memory-pro 的 `getNodesByTimeRange(from, to)` 获取数据
- 按 S-4（层次化社区，如果已启用）分组，LLM 生成自然语言摘要
- 新增 Agent 工具 `gm_summary`，输出格式化的记忆回顾

**依赖 graph-memory-pro API**：`getNodesByTimeRange(from, to)`（v2.1.10 新增）

**成本**：3-4 天

---

### 第二批

#### S-7 用户画像

**目标**：从历史对话中蒸馏用户偏好，用于个性化召回。

**实现要点**：
- 扫描对话历史，LLM 提取用户偏好（技术栈、代码风格、工作习惯）
- 偏好变化追踪：按时间窗口对比，检测偏好漂移
- 蒸馏完成后，调用 graph-memory-pro 的 `upsertProfile(profile)` 存储
- 召回时，调用 `Recaller` 传入 `profileWeight` 参数影响排序

**依赖 graph-memory-pro API**：`upsertProfile(profile)`、`getProfile(userId)`、`Recaller(profileWeight)`（v2.1.10 新增）

**成本**：4-5 天

---

#### R-2 成本感知级联（Tier 2/3）

**目标**：把 I-2 启发式裁判升级为多级成本感知级联（Tier 1 在 graph-memory-pro，Tier 2/3 在 lcm-graph-extra）。

**U-Mem 三层级联**：

| 层级 | 信号源 | 成本 | 负责方 |
|---|---|---|---|
| Tier 1 | 启发式规则（字符串匹配） | 极低 | graph-memory-pro（I-2） |
| Tier 2 | 教师模型（更强的 LLM） | 中 | **lcm-graph-extra** |
| Tier 3 | 工具验证（代码执行/搜索） | 高 | **lcm-graph-extra** |

**实现要点**：
- 接收 graph-memory-pro 的 Tier 1 结果（置信度 < 0.7 时触发）
- Tier 2：调用更强的 LLM 判断"哪些记忆被真正用到"
- Tier 3：对事实性声明，调用代码解释器或搜索验证
- Thompson 采样：平衡"召回熟悉节点"（利用）vs"探索新节点"（探索）

**依赖 graph-memory-pro API**：`judgeRecall()` Tier 1 结果（v2.1.10 新增）

**成本**：4-5 天

---

#### S-12 跨轨迹抽象

**目标**：从多个独立对话轨迹中提取可复用的经验模式。

**From Storage to Experience 三阶段**：

```
Storage    → 忠实记录每个对话轨迹（lcm-graph-extra 已有）
Reflection → 评估轨迹质量，去噪（R-2 级联反馈）
Experience → 跨轨迹抽象，提取可复用模式（本任务）
```

**实现要点**：
- 定期扫描 I-3 反馈数据（从 graph-memory-pro 查询）
- 发现"多次出现的成功模式"（如"某类问题总是用某种方法解决"）
- 将模式蒸馏为经验节点，通过 graph-memory-pro 的 `upsertNode` 写入图谱
- MDL（Minimum Description Length）压缩比评估：压缩比越高，经验越普遍

**依赖 graph-memory-pro API**：`upsertNode`、`searchNodes`（已有）

**成本**：4-5 天

---

### 第三批

#### S-9 情节缓冲（GAM 启发）

**目标**：把"每轮对话直接写全局图谱"改为"缓冲→语义边界检测→整合"。

**GAM 双阶段**：

| 阶段 | 职责 | 负责方 |
|---|---|---|
| Episodic Buffering | 实时捕获对话，构建局部事件图 | **lcm-graph-extra** |
| Semantic Boundary Detection | LLM 判断话题是否完成 | **lcm-graph-extra** |
| Semantic Consolidation | 将完整事件图压缩为摘要节点，整合到全局图谱 | graph-memory-pro (`consolidateBuffer`) |

**实现要点**：
- 维护 2048 token 滑窗缓冲区
- 每轮对话后，LLM 判断是否到达语义边界（话题切换/任务完成）
- 到达边界时，调用 graph-memory-pro 的 `consolidateBuffer(nodes)` 整合
- 缓冲区清空，开始下一轮

**依赖 graph-memory-pro API**：`consolidateBuffer(nodes)`（v2.1.10 新增）

**成本**：4-5 天

---

#### S-11 Zettelkasten（A-MEM 启发）

**目标**：实现 Note→Link→Evolve→Retrieve 四步闭环的编排层逻辑。

**A-MEM 四步闭环**：

| 步骤 | 引擎层提供 | 编排层实现 |
|---|---|---|
| Note | extract.ts 三元组提取 | **LLM 增强：生成 keywords、tags、contextual description** |
| Link | `linkNodes(fromId, toId, type)` | **LLM 判断新记忆与历史记忆的语义关联，触发 link** |
| Evolve | `evolveNode(id, updates)` | **新记忆加入时，触发相关旧记忆的 context/tags 更新** |
| Retrieve | `Recaller` | **通过链接扩展召回范围（Box 概念：记忆簇）** |

**实现要点**：
- Note：在 graph-memory-pro 提取三元组后，LLM 补充 keywords/tags
- Link：LLM 周期性扫描新节点，判断与历史节点的语义关联
- Evolve：新记忆加入时，检查相关旧记忆是否需要更新（如新的 context 补充）
- Retrieve：召回时，通过 link 扩展候选集（记忆簇）

**依赖 graph-memory-pro API**：`linkNodes(fromId, toId, type)`、`evolveNode(id, updates)`（v2.1.10 新增）

**成本**：5-7 天

---

#### R-5 动态记忆混合

**目标**：按场景动态加权混合召回结果。

**实现要点**：
- 场景权重学习：根据历史成功率，学习各场景的贡献权重
- 召回时，调用 `Recaller` 多次（每次传不同 sceneId），按权重合并结果
- 初始均匀分布，通过 R-1 诊断循环学习最优权重

**依赖 graph-memory-pro API**：`Recaller(sceneId)`（已有）

**成本**：3-4 天

---

#### G-7：主动记忆建议

**目标**：proactively suggest "你学过 X，与当前任务相关"，从被动召回升级为主动建议。

**实现要点**：
- 监听当前对话上下文（不只是 query，还包括 assistant 正在生成的回复）
- 实时调用 graph-memory-pro 的 `searchNodes` 找相关节点
- 若发现高相关性且未被召回的节点，主动提示用户
- 触发条件：相关性 > 0.85 且当前 prompt 中未包含该节点
- 防干扰：每个对话最多主动建议 3 次

**依赖 graph-memory-pro API**：`searchNodes`（已有）

**成本**：3-4 天

---

#### G-8：记忆验证回路

**目标**：Agent 使用记忆后，验证使用结果（成功/失败），反馈给 L-3/L-4 用于权重调整。

**实现要点**：
- 监听 assistant 回复后的用户反馈（"对"/"错"/"没用"等）
- 或通过 LLM 判断"这次任务是否成功完成"
- 验证结果写入 graph-memory-pro 的 `GmFeedback` 节点
- 反馈信号驱动：
  - 成功 → 召回路径上的边 weight +1（L-3）
  - 失败 → 召回路径上的节点 stalenessScore +0.1（L-4）
- 与 R-2 级联协同：失败的召回触发 Tier 2/3 重新评估

**依赖 graph-memory-pro API**：`upsertFeedback`（v2.1.10 新增）

**成本**：3-4 天

---

#### G-9：记忆导出/导入

**目标**：备份/恢复/迁移，支持 JSON 格式导出。

**实现要点**：
- 导出：调用 `getNodesByTimeRange` + `getEdgesForNodes`，序列化为 JSON
- 导入：解析 JSON，调用 `upsertNode` + `upsertEdge` 批量写入
- 支持增量导出（按时间范围）和全量导出
- 支持选择性导出（按场景、按类型、按社区）
- 用于：环境迁移、备份恢复、跨用户共享

**依赖 graph-memory-pro API**：`getNodesByTimeRange`、`upsertNode`、`upsertEdge`（已有/v2.1.10 新增）

**成本**：2-3 天

---

#### G-10：主动遗忘命令

**目标**：用户主动"忘掉这个"命令，触发引擎层降权或软删除。

**实现要点**：
- Agent 工具 `gm_forget`：
  - 参数：nodeId 或查询条件
  - 模式：soft（仅降权）/ hard（软删除 state=superseded）
- 调用 graph-memory-pro 的 `evolveNode(id, { state: 'superseded' })`
- 与 S-2 软替换协同：被遗忘的节点 state → superseded
- 与 G-3 重要性评分协同：遗忘后 importanceScore → 0

**依赖 graph-memory-pro API**：`evolveNode(id, updates)`（v2.1.10 新增）

**成本**：2-3 天

---

#### G-11：Token 预算管理

**目标**：召回结果 token 预算控制，按重要性裁剪，参考 TencentDB 的 token 优化策略。

**实现要点**：
- 配置 `recallTokenBudget`（默认 2000 token）
- 召回结果按 `importanceScore × (1 - stalenessScore)` 排序
- 按 token 累加裁剪，超出预算的低重要性节点只保留摘要
- 与 G-12 记忆簇协同：同一簇内的节点共享 token 预算
- 监控：记录每次召回的实际 token 消耗

**依赖 graph-memory-pro API**：`Recaller` 返回的节点带 importanceScore（v2.1.10 G-3 新增）

**成本**：2-3 天

---

#### G-12：记忆簇 Box

**目标**：相关记忆打包成簇，召回时按簇扩展，参考 A-MEM 的 Box 概念。

**实现要点**：
- 簇定义：通过 link 关联的节点集合，或同社区的节点
- 簇存储：在 graph-memory-pro 中作为虚拟结构，通过 `linkNodes` 创建的边识别
- 召回时扩展：召回一个节点 → 检查同簇节点 → 按相关性排序追加
- 簇大小限制：每簇最多 5 个节点，超出时按重要性裁剪
- 与 S-11 Zettelkasten 协同：Link 创建时自动归簇

**依赖 graph-memory-pro API**：`getEdgesForNodes`、`getCommunityPeers`（已有）

**成本**：2-3 天

---

## 四、实施顺序

### 第一批：基础设施（无新增 API 依赖）

```
S-6 (场景隔离) + S-8 (记忆回顾总结) + G-11 (Token 预算)
```

**产出**：场景隔离策略 + 记忆回顾工具 + token 控制

### 第二批：反馈与学习（依赖 graph-memory-pro v2.1.10 第一批）

```
S-7 (用户画像) → R-2 (成本感知级联) → S-12 (跨轨迹抽象) → G-8 (记忆验证回路)
```

**产出**：用户画像 + 多级裁判 + 经验节点 + 验证回路

### 第三批：自主编排（依赖 graph-memory-pro v2.1.10 第四批）

```
S-9 (情节缓冲) → S-11 (Zettelkasten) → R-5 (动态混合) → G-12 (记忆簇 Box)
```

**产出**：情节缓冲 + 自主链接 + 动态混合召回 + 记忆簇

### 第四批：编辑性功能（依赖前面批次）

```
G-7 (主动记忆建议) + G-10 (主动遗忘命令)
```

**产出**：主动建议 + 用户控制遗忘

### 第五批：运维能力（独立）

```
G-9 (记忆导出/导入)
```

**产出**：备份/恢复/迁移能力

---

## 五、依赖关系

```
graph-memory-pro v2.1.10 第一批 (Schema升级+G-5图谱健康)
  └── lcm-graph-extra 第一批 (场景隔离 + 回顾总结 + Token预算)

graph-memory-pro v2.1.10 第二批 (反馈闭环+G-6冷启动)
  └── lcm-graph-extra 第二批 (画像 + 级联 + 经验 + 验证回路)

graph-memory-pro v2.1.10 第四批 (结构升级+G-1深度整合+G-2冲突消解+G-3重要性)
  └── lcm-graph-extra 第三批 (情节缓冲 + Zettelkasten + 动态混合 + 记忆簇Box)
  └── lcm-graph-extra 第四批 (主动建议 + 主动遗忘，依赖 G-3 重要性评分)

graph-memory-pro v2.1.10 全部
  └── lcm-graph-extra 第五批 (导出/导入)
```

---

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| 场景隔离误判全局记忆 | 默认 soft 模式（全局+本场景），strict 模式可选 |
| 用户画像过拟合历史偏好 | 画像带时间衰减，旧偏好降权 |
| Tier 2/3 级联触发过频 | Tier 1 置信度阈值可调，默认 0.7 |
| 跨轨迹抽象过度泛化 | MDL 压缩阈值过滤低质量抽象 |
| 语义边界检测不准 | 回退到 token_count 模式 |
| Zettelkasten LLM 调用成本高 | 仅对新活跃节点触发，批量处理 |
| 动态混合权重不收敛 | 初始均匀分布，逐步收敛 |
| 主动建议干扰用户 | 每对话最多 3 次，相关性 > 0.85 才触发 |
| 记忆验证回路假阳性 | 双信号确认（用户反馈 + LLM 判断） |
| Token 预算过紧导致召回不全 | 按 importanceScore 裁剪，保留 top-K 摘要 |
| 记忆簇过度扩张 | 每簇最多 5 个节点，按重要性裁剪 |
| 导出数据量过大 | 支持增量导出，按场景/类型选择性导出 |

---

## 七、版本信息

- **规划版本**：1.0.0
- **依赖**：graph-memory-pro v2.1.10
- **规划日期**：2026-07-04
- **模块定位**：上层编排层——上下文管理、prompt 组装、Agent 工作流、用户界面
- **方案来源**：GAM (ACL 2026)、A-MEM (NeurIPS 2025)、U-Mem、Dynamic Mixture、From Storage to Experience、TencentDB、用户需求、闭环反馈设计
- **任务总数**：14 项（原 8 项 + 补充 6 项 G-7~G-12）
- **预计实施周期**：5 批次，约 45-60 天