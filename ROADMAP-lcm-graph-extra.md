# LCM Graph Extra 演进路线图

> 版本：1.0.0
> 模块定位：**上层编排层**——上下文管理、prompt 组装、Agent 工作流、用户界面
> 依赖：graph-memory-pro v2.1.10（记忆底层引擎），通过 Re-exports API 调用
> 对等计划：[graph-memory-pro ROADMAP.md](file:///workspace/ROADMAP.md)
> 基线：lcm-graph-extra v2.1.9（已具备四层检索、经验层、TagRegistry、PressureTier、12 工具）

---

## 一、能力边界

```
┌─────────────────────────────────────────────────┐
│  lcm-graph-extra v2.1.9（上层编排层）← 本计划     │
│  四层检索 · 经验层 · TagRegistry · PressureTier  │
│  12 个 Agent 工具 · 熔断器 · debt-manager         │
│  调用 graph-memory-pro 的 Re-exports API        │
├─────────────────────────────────────────────────┤
│  graph-memory-pro（记忆底层引擎）                │
│  提取 · 存储 · 检索 · 去重 · 维护 · 质量 · 进化  │
└─────────────────────────────────────────────────┘
```

---

## 二、现有能力清单（v2.1.9 已实现）

| 维度 | 已实现能力 |
|---|---|
| **检索** | 四层并行（L1 lossless-claw DAG / L2 qmd BM25+vector / L3 Neo4j 图谱 / L4 EXPERIENCE）；qmd MCP+CLI 双模式降级；multiGet 批量文档；标签过滤 |
| **经验层** | 4 触发源（correction/failure/fix_success/explicit_save）；PENDING→DISTILLED 蒸馏；Query-aware 混合搜索（60% relevance + 40% queryMatch）；matchCount 命中计数；expiresAt TTL；distillOne LLM 蒸馏（heartbeat 2h） |
| **场景/标签** | QueryContext 推断（scenario/techStack/freeTags/projects/urgency）；TagRegistry 动态加载（Neo4j TAG_REGISTRY）；16 内置标签；freeTag 升格 |
| **压力/Token** | PressureTier 三级（low/medium/high）；maxContextChars 12k/6k/1.6k；retrievalLimits 分级；contextWindow 解析；tokenBudget 参数；0.85 budgetCeiling；applyTotalControl 优先级裁剪（L1<L2<L3<L4） |
| **压缩/维护** | compact lifecycle（300s timeout + AbortSignal）；debt-manager（60s 轮询 + 紧急度 0.7 + 2 并发）；TTL（90 天 + 24h cleanup）；applyWeightDecay（0.5^(days/halfLife)）；heartbeat（5min）；pre-emptive compaction（ratio>0.65） |
| **工具 (12)** | lcmg_search / lcmg_backup / lcmg_restore / lcmg_import / lcmg_pin / lcmg_sync / lcmg_qmd_status / lcmg_get_document / lcmg_batch_get / lcmg_maintain / lcmg_diagnose / lcmg_experience_report |
| **编排** | assemble 三引擎 Promise.all 并行；Merger 实体级去重（fuzzyMatch 0.85）；Merger 时间衰减（halfLife 30d）；Merger LLM 重排接口（未默认启用）；sessionDedupCache LRU（500/24/1h） |
| **故障保护** | 三个熔断器（lcm/qmd/neo4j）；自动重试；AbortSignal 全生命周期；validateBackupPath 路径校验；FTS5 转义；singleton DB |

---

## 三、对照评估结论

### 原 ROADMAP 11 项处置决策

| 原编号 | 处置 | 原因 |
|---|---|---|
| ~~G-11 Token 预算~~ | ❌ 剔除 | 重复度 90%：maxContextChars + applyTotalControl + tokenBudget + 0.85 budgetCeiling 已完整覆盖 |
| ~~S-12 跨轨迹抽象~~ | ❌ 剔除 | 重复度 85%：experience/ 整层即此能力（rawIds 关联多轨迹 + distillOne 蒸馏） |
| ~~G-9 记忆导出/导入~~ | ❌ 剔除 | 重复度 95%：lcmg_backup + lcmg_restore + lcmg_import 三工具已完整覆盖 |
| S-6 场景隔离 | ⚠️ 简化 | 重复度 50%：扩展 context-inference.projects 推断 + 搜索过滤，不新建 sceneId 体系 |
| S-7 用户画像 | ⚠️ 简化 | 重复度 40%：复用 TagRegistry + EXPERIENCE.tags，不建独立 GmProfile 节点 |
| S-9 情节缓冲 | ⚠️ 简化 | 重复度 70%：在 afterTurn 加语义边界判断，复用 lossless-claw compact |
| S-11 Zettelkasten | ⚠️ 简化 | 重复度 80%：增强 distillOne 的 link 生成 + 周期 evolve 旧经验 |
| R-5 动态混合 | ⚠️ 简化 | 重复度 60%：按 QueryContext.scenario 调整三引擎 retrievalLimits |
| R-2 成本感知级联 | ✅ 必做 | Tier 1 已有熔断，缺 Tier 2 LLM 判断 + Tier 3 工具验证 |
| G-8 验证回路 | ✅ 必做 | 现有只有 matchCount，缺 LLM 异步质量反馈 |
| G-10 主动遗忘 | ✅ 必做 | 现有只有反向 pin + 自动 TTL，缺正向"忘掉这个"工具 |
| S-8 记忆回顾 | ✅ 必做 | 现有经验报告无时间过滤，缺自然语言时间查询 |

### 新增建议项（基于现有能力短板）

| 新编号 | 短板 | 实现思路 |
|---|---|---|
| N-1 Sync 算法升级 | lcmg_sync 只查 orphan 节点，缺跨端时间戳一致性 | sync Phase 2 加 updatedAt 对比 + 增量 MERGE |
| N-2 Merger LLM 重排启用 | merger.llmRerank 接口已实现但 assemble 未调用 | 按 tokenBudget 触发（low tier 启用，high 跳过） |
| N-3 TTL-经验层集成 | findExpiredNodes 针对图节点；EXPERIENCE.expiresAt 字段未调度清理 | heartbeat 扩展 cleanupExpiredExperienceNodes |
| N-4 健康指标导出 | heartbeat 已收集 pressure signals，仅日志输出 | 暴露 Prometheus 指标 / 写入 lcm.db 供 lcmg_diagnose 查询 |

---

## 四、v1.0.0 演进方案（13 项，按依赖关系分三批）

### 第一批：补强现有能力（无 graph-memory-pro 新 API 依赖）

| 编号 | 方案 | 类型 | 核心机制 | 成本 |
|---|---|---|---|---|
| S-6' | 场景隔离扩展 | 简化 | context-inference.projects 推断 + 搜索过滤 projectName | 1-2天 |
| S-7' | 用户画像轻量版 | 简化 | projects 推断 + 长期偏好到 EXPERIENCE.tags | 2-3天 |
| S-9' | 情节缓冲扩展 | 简化 | afterTurn 语义边界 LLM 判断 → 触发 compact | 2-3天 |
| S-11' | Zettelkasten 增强 | 简化 | distillOne 主动 link 生成 + 周期 evolve 旧经验 tags | 2-3天 |
| R-5' | 动态混合简化 | 简化 | 按 QueryContext.scenario 调整三引擎 retrievalLimits | 1-2天 |
| N-1 | Sync 算法升级 | 新增 | sync Phase 2 updatedAt 对比 + 增量 MERGE | 1-2天 |
| N-2 | Merger LLM 重排启用 | 新增 | assemble 中按 tier 启用 merger.llmRerank | 1天 |
| N-3 | TTL-经验层集成 | 新增 | heartbeat 扩展 cleanupExpiredExperienceNodes | 1天 |

### 第二批：自主进化（依赖 graph-memory-pro v2.1.10）

| 编号 | 方案 | 类型 | 核心机制 | 成本 |
|---|---|---|---|---|
| R-2 | 成本感知级联 Tier 2/3 | 必做 | Tier 2 教师模型 LLM 判断 + Tier 3 工具验证 + Thompson 采样 | 4-5天 |
| G-8 | LLM 异步验证回路 | 必做 | LLM 判断召回有效性 → 写入 EXPERIENCE.matchCount/qualityScore | 2-3天 |
| S-8' | 时间范围回顾总结 | 必做 | 扩展 lcmg_experience_report 支持 from/to + LLM 摘要输出 | 2天 |
| N-4 | 健康指标导出 | 新增 | Prometheus 端点 / lcm.db 写入（依赖 graph-memory-pro G-5 图谱健康） | 1-2天 |

### 第三批：用户控制

| 编号 | 方案 | 类型 | 核心机制 | 成本 |
|---|---|---|---|---|
| G-10 | 主动遗忘命令 | 必做 | 新增 lcmg_forget 工具（复用 lcmg_pin 框架） | 2天 |

---

## 五、详细任务

### 第一批

#### S-6' 场景隔离扩展

**目标**：复用现有 sessionKey + TagRegistry，补齐 projects 推断与搜索过滤。

**实现要点**：
- 在 [context-inference.ts](file:///workspace/lcm-graph-extra/src/context-inference.ts) `inferQueryContext` 中实现 projects 推断（从 query 中正则匹配项目名/路径）
- 在 [retrieval-gateway.ts](file:///workspace/lcm-graph-extra/src/retrieval-gateway.ts) 经验搜索时按 `EXPERIENCE.projectName` 过滤
- qmd/graph 搜索时透传 projects 参数（可选过滤）
- 跨场景关联：复用 TagRegistry 场景标签，无需独立 sceneId 体系

**接入点**：[src/context-inference.ts](file:///workspace/lcm-graph-extra/src/context-inference.ts)、[src/retrieval-gateway.ts](file:///workspace/lcm-graph-extra/src/retrieval-gateway.ts)

**成本**：1-2 天

---

#### S-7' 用户画像轻量版

**目标**：复用 TagRegistry + EXPERIENCE.tags，无需独立 GmProfile 节点。

**实现要点**：
- 扫描对话历史，LLM 提取用户偏好（技术栈、工作习惯）→ 写入 `EXPERIENCE.tags.techStack`
- 偏好变化追踪：按时间窗口对比 tags 历史
- 召回时通过 TagRegistry 的 freeTag 升格机制影响 expResults 排序
- 不建独立 GmProfile 节点（避免 schema 膨胀）

**接入点**：[src/experience/storage.ts](file:///workspace/lcm-graph-extra/src/experience/storage.ts)、[src/context-inference.ts](file:///workspace/lcm-graph-extra/src/context-inference.ts)

**成本**：2-3 天

---

#### S-9' 情节缓冲扩展

**目标**：复用 lossless-claw DAG，仅在 afterTurn 加语义边界判断。

**实现要点**：
- 在 [src/index.ts](file:///workspace/lcm-graph-extra/src/index.ts) afterTurn 中加入 LLM 语义边界判断（话题切换/任务完成）
- 到达边界时显式调用 `_losslessClawAdapter.compact({ force: true })`
- 不另建缓冲区（lossless-claw 已有 2048 token 滑窗 + 层次化 summary）
- 失败回退到 token_count 模式

**接入点**：[src/index.ts](file:///workspace/lcm-graph-extra/src/index.ts) afterTurn

**成本**：2-3 天

---

#### S-11' Zettelkasten 增强

**目标**：增强现有 distillOne 的 link 生成与 evolve 能力。

**实现要点**：
- 在 [src/index.ts](file:///workspace/lcm-graph-extra/src/index.ts) `distillOne` 中让 LLM 主动生成 link 建议（扩展 rawIds）
- 周期性扫描新 distilled 经验，与历史经验对比，触发 evolve（更新 tags/context）
- Note→Link→Evolve→Retrieve 四步已映射到现有 saveDistilled/rawIds/saveDistilled ON MATCH/searchByQuery
- 仅增强 link 主动生成能力

**接入点**：[src/index.ts](file:///workspace/lcm-graph-extra/src/index.ts) distillOne

**成本**：2-3 天

---

#### R-5' 动态混合简化

**目标**：按 QueryContext.scenario 动态调整三引擎权重。

**实现要点**：
- 在 [src/index.ts](file:///workspace/lcm-graph-extra/src/index.ts) assemble 中调用 `inferQueryContext(qmdQuery)` 获取 scenario
- 按 scenario 调整 retrievalLimits（如 bug-fix → 提高 graph 权重；feature-dev → 提高 qmd 权重）
- 复用现有 PressureTier 机制，仅在 low tier 时启用动态调整
- 不建独立权重学习模块

**接入点**：[src/index.ts](file:///workspace/lcm-graph-extra/src/index.ts) assemble、[src/context-inference.ts](file:///workspace/lcm-graph-extra/src/context-inference.ts)

**成本**：1-2 天

---

#### N-1 Sync 算法升级

**目标**：补强 lcmg_sync 的跨端时间戳一致性校验。

**实现要点**：
- 在 [src/tools.ts](file:///workspace/lcm-graph-extra/src/tools.ts) `lcmg_sync` Phase 2 加 `updatedAt` 对比
- 跨端时间戳不一致时增量 MERGE
- 保留现有 orphan 检测能力

**接入点**：[src/tools.ts](file:///workspace/lcm-graph-extra/src/tools.ts) lcmg_sync

**成本**：1-2 天

---

#### N-2 Merger LLM 重排启用

**目标**：启用现有但未调用的 merger.llmRerank 接口。

**实现要点**：
- 在 [src/index.ts](file:///workspace/lcm-graph-extra/src/index.ts) assemble 中，按 tier 决定是否启用 LLM 重排
- low tier（token 充裕）→ 启用 merger.llmRerank
- medium/high tier → 跳过（避免 LLM 调用延迟）
- 复用现有 merger.llmRerank 接口（无需新代码，仅调用）

**接入点**：[src/index.ts](file:///workspace/lcm-graph-extra/src/index.ts) assemble、[src/merger.ts](file:///workspace/lcm-graph-extra/src/merger.ts)

**成本**：1 天

---

#### N-3 TTL-经验层集成

**目标**：补齐 EXPERIENCE.expiresAt 字段的调度清理。

**实现要点**：
- 在 [src/index.ts](file:///workspace/lcm-graph-extra/src/index.ts) heartbeat 中扩展 `cleanupExpiredExperienceNodes()`
- 调用 `experienceStorage.deleteById(id)` 清理过期经验
- 复用现有 `EXPERIENCE.expiresAt` 字段

**接入点**：[src/index.ts](file:///workspace/lcm-graph-extra/src/index.ts) heartbeat、[src/experience/storage.ts](file:///workspace/lcm-graph-extra/src/experience/storage.ts)

**成本**：1 天

---

### 第二批

#### R-2 成本感知级联 Tier 2/3

**目标**：在现有 Tier 1 熔断基础上，补齐 Tier 2/3。

**U-Mem 三层级联**：

| 层级 | 信号源 | 成本 | 负责方 | 现状 |
|---|---|---|---|---|
| Tier 1 | 启发式规则 + 熔断器 | 极低 | lcm-graph-extra | ✅ 已实现（withCircuitBreaker） |
| Tier 2 | 教师模型 LLM 判断 | 中 | lcm-graph-extra | ❌ 缺 |
| Tier 3 | 工具验证（代码执行/搜索） | 高 | lcm-graph-extra | ❌ 缺 |

**实现要点**：
- Tier 1 置信度 < 0.7 时触发 Tier 2
- Tier 2：调用更强的 LLM 判断"哪些记忆被真正用到"
- Tier 3：对事实性声明，调用代码解释器或搜索验证
- Thompson 采样：平衡"召回熟悉节点"（利用）vs"探索新节点"（探索）
- 与现有 withCircuitBreaker 解耦，不重复造熔断

**依赖 graph-memory-pro API**：`judgeRecall()` Tier 1 结果（v2.1.10 新增）

**成本**：4-5 天

---

#### G-8 LLM 异步验证回路

**目标**：补齐 LLM 异步质量反馈，复用现有 EXPERIENCE.matchCount。

**实现要点**：
- LLM 异步判断"这次召回是否被有效使用"
- 验证结果写入 `EXPERIENCE.matchCount` + 新增 `qualityScore` 字段
- 反馈信号驱动：
  - 成功 → 经验 relevanceScore +0.05
  - 失败 → 经验 relevanceScore -0.05（不低于 0.3）
- 与 R-2 级联协同：失败的召回触发 Tier 2/3 重新评估
- **不主动询问用户**（避免干扰）

**依赖 graph-memory-pro API**：`upsertFeedback`（v2.1.10 新增）

**成本**：2-3 天

---

#### S-8' 时间范围回顾总结

**目标**：扩展 lcmg_experience_report 支持时间范围 + LLM 摘要。

**实现要点**：
- 在 [src/tools.ts](file:///workspace/lcm-graph-extra/src/tools.ts) `lcmg_experience_report` 加 `from`/`to` 时间参数
- 自然语言查询解析："本周学会了什么" → from=本周一 / to=今天 / type=lesson|fix
- LLM 生成自然语言摘要（"本周共记录 N 条经验，主要涉及 X/Y/Z..."）
- 输出格式：text / markdown / summary（自然语言总结）

**依赖 graph-memory-pro API**：`getNodesByTimeRange(from, to)`（v2.1.10 新增）

**成本**：2 天

---

#### N-4 健康指标导出

**目标**：补齐 heartbeat 已收集指标的导出能力。

**实现要点**：
- heartbeat 已收集 pressure signals（pending_msgs/summary_frags/token_ratio）
- 暴露 Prometheus 指标端点（`/metrics`）或写入 lcm.db `health_metrics` 表
- `lcmg_diagnose` 工具查询历史指标
- 依赖 graph-memory-pro G-5 图谱健康（v2.1.10 新增）

**依赖 graph-memory-pro API**：`/api/health`（G-5 新增）

**成本**：1-2 天

---

### 第三批

#### G-10 主动遗忘命令

**目标**：补齐用户主动遗忘入口（与现有 lcmg_pin 反向）。

**实现要点**：
- 新增 `lcmg_forget` 工具（复用 [src/tools.ts](file:///workspace/lcm-graph-extra/src/tools.ts) lcmg_pin 的 Neo4j 连接 + 路径校验）
- 参数：nodeId 或查询条件；模式 soft（降权）/ hard（软删除）
- 调用 graph-memory-pro `evolveNode(id, { state: 'superseded' })`
- 与 graph-memory-pro S-2 软替换协同
- 与 graph-memory-pro G-3 重要性评分协同：遗忘后 importanceScore → 0

**依赖 graph-memory-pro API**：`evolveNode(id, updates)`（v2.1.10 新增）

**成本**：2 天

---

## 六、实施顺序

### 第一批：补强现有能力（无新 API 依赖，8 项）

```
S-6' (场景隔离扩展) + S-7' (用户画像轻量) + S-9' (情节缓冲扩展)
S-11' (Zettelkasten 增强) + R-5' (动态混合简化)
N-1 (Sync 升级) + N-2 (LLM 重排启用) + N-3 (TTL-经验集成)
```

**产出**：场景隔离 + 用户画像 + 情节缓冲 + Zettelkasten + 动态混合 + Sync 升级 + LLM 重排 + TTL 集成

### 第二批：自主进化（依赖 graph-memory-pro v2.1.10，4 项）

```
R-2 (成本感知级联 Tier 2/3) → G-8 (LLM 异步验证回路)
S-8' (时间范围回顾总结) + N-4 (健康指标导出)
```

**产出**：多级裁判 + 验证回路 + 时间回顾 + 健康指标

### 第三批：用户控制（依赖 graph-memory-pro v2.1.10 第四批，1 项）

```
G-10 (主动遗忘命令)
```

**产出**：用户主动遗忘工具

---

## 七、依赖关系

```
graph-memory-pro v2.1.10 第一批 (Schema升级+G-5图谱健康)
  └── lcm-graph-extra 第一批 (8项补强现有能力)

graph-memory-pro v2.1.10 第二批 (反馈闭环+G-6冷启动)
  └── lcm-graph-extra 第二批 (R-2 级联 + G-8 验证回路)

graph-memory-pro v2.1.10 第四批 (结构升级+G-2冲突消解+G-3重要性)
  └── lcm-graph-extra 第三批 (G-10 主动遗忘，依赖 G-3 重要性评分)
```

---

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| S-6' projects 推断误判 | 默认 soft 模式，仅作过滤提示，不强制隔离 |
| S-7' 用户画像过拟合历史偏好 | tags 带时间衰减，旧偏好降权（复用 Merger.applyDecayToResults） |
| S-9' 语义边界检测不准 | 回退到 token_count 模式（lossless-claw 已有） |
| R-2 Tier 2/3 级联触发过频 | Tier 1 置信度阈值可调，默认 0.7 |
| G-8 LLM 验证回路假阳性 | 仅 LLM 异步判断，不主动询问用户，权重 ≤ 0.3 |
| S-8' 时间范围查询图谱过大 | 限制返回上限（默认 50 节点） |
| G-10 误删 | 默认 soft 模式，hard 模式需二次确认；可恢复（state=superseded） |
| N-1 Sync 算法时间戳冲突 | 以 Neo4j updatedAt 为权威，lcm DB 跟随 |

---

## 九、版本信息

- **规划版本**：1.0.0
- **依赖**：graph-memory-pro v2.1.10
- **规划日期**：2026-07-04
- **模块定位**：上层编排层——上下文管理、prompt 组装、Agent 工作流、用户界面
- **基线**：lcm-graph-extra v2.1.9
- **方案来源**：基于现有能力对照 13 份文献后筛选，剔除已实现 3 项，简化 5 项，保留必做 3 项，新增 4 项补强短板
- **任务总数**：13 项（原 11 项 → 剔除 3 + 简化 5 + 必做 3 + 新增 4 = 13 项，工作量从 40-55 天压缩至 20-30 天）
- **预计实施周期**：3 批次，约 20-30 天
