# Graph Memory Pro

> Neo4j 知识图谱记忆引擎插件 for OpenClaw

基于 [adoresever/graph-memory](https://github.com/adoresever/graph-memory) 的 fork 增强版本，提供图内操作全栈能力：三元组提取 / 存储 / 检索 / 去重 / 维护 / 质量优化 / 自主进化。

## 定位

graph-memory-pro 是**记忆底层引擎**，只做"图内"操作：
- 提取（extract） · 存储（store） · 检索（recall） · 去重（dedup） · 维护（maintenance） · 质量（quality） · 进化（evolution）
- 不做"图外"编排（上下文管理 / prompt 组装 / Agent 工作流 / UI 由 lcm-graph-extra 负责）

通过 OpenClaw SDK 的 `registerMemoryCorpusSupplement` 暴露给 memory-core，以**工具 + 后台服务**模式运行（无槽位占用）。

## 特性

### 核心引擎
- **三元组提取**：从对话中自动提取 (实体, 关系, 实体) 知识三元组，支持 6 种边类型（含 S-5 因果关系 `CAUSED_BY`/`LEADS_TO`）
- **Neo4j 图数据库**：使用原生 Cypher，不依赖 APOC 插件
- **GDS 图算法**：PageRank、层次化社区检测（S-4 三层：社区→主题→领域）
- **向量索引**：语义搜索 + 去重（Neo4j 5.11+ 向量索引）
- **双路径召回**：精确召回（FTS + 向量 + 图游走 + PPR + L-1 关联矩阵 M 变换）+ 泛化召回（社区级）
- **图谱维护**：11 阶段管线（去重 → PageRank → 社区 → 摘要 → 过时 → 健康 → 重要性 → 冲突消解 → 边权重 → 反向记忆 → 嵌入迁移）

### v2.2.0 路线图成果（17 项能力）

**第一批：Schema 升级 + 监控基础**
- S-1 Bi-Temporal：`validFrom`/`validTo`/`recordedAt` 时间维度
- S-2 软替换：`state='superseded'` 替代物理删除，保留历史可追溯
- S-3 来源标记：`source` 字段（experience/knowledge/imported）
- S-5 因果关系：`CAUSED_BY`/`LEADS_TO` 边类型
- S-13 状态追踪：`state` 字段（current/superseded/transitional）
- S-14 过时检测：`stalenessScore` 启发式评分 + 召回降权
- G-5 图谱健康：连通性/密度/孤立节点/异常检测

**第二批：反馈闭环 + 冷启动**
- I-1 查询缓存：LRU + cosine 相似匹配（精确命中短路 / 相似命中降权）
- I-2 LLM 裁判：启发式匹配（id/name/both），冷启动期规则兜底
- I-3 反馈持久化：`GmFeedback` 节点 + `JUDGED` 关系 + `validatedCount` 奖励
- G-6 冷启动策略：M 矩阵冷启动用 BM25+向量混合，裁判冷启动用规则兜底

**第三批：在线学习 + 可进化嵌入**
- L-1 关联矩阵 M：`query_vec → BatchNorm → M @ vec + bias → × gain × rowScale`
- R-3 边际效用奖励：邻域评估 + 拒绝逻辑（防过拟合）
- R-4 可进化嵌入：content MD5 hash 对比 + `embeddingHistory` 归档
- G-3 重要性评分：`importanceScore = f(recency, frequency, centrality, source)`

**第四批：结构升级 + 冲突消解**
- S-4 层次化社区：3 层抽象 + Union-Find 贪心合并 + 自顶向下钻取
- G-2 冲突消解：4 策略链式 fallback（时态/来源/置信度/合并）
- G-4 嵌入版本化：`embeddingModel` 字段 + 自动迁移
- L-3 边权重调整：used 边强化 ×1.1 / unused 边衰减 ×0.95
- L-4 反向记忆：`unusedCount>=10 && importanceScore<0.2` → staleness 惩罚

**第五批：Benchmark + 自主调优**
- S-10 Benchmark：LoCoMo（1,540 题）+ LongMemEval（500 题），P@1/P@3/MRR/F1/P99/Tokens
- R-1 自主调优（EvolveMem）：EVALUATE → DIAGNOSE → PROPOSE → GUARD 四步循环
  - revert-on-regression（退步 >2pp → 自动回退）
  - explore-on-stagnation（5 轮无改进 → 探索新维度）
  - 8 参数动作空间 + LLM 诊断 + 启发式 fallback

### 测试覆盖
- 11 个测试文件，256 个用例（Neo4j mock 基础设施，CI 友好）
- 覆盖全部 5 批次核心功能：指标计算 / AutoTuner / 关联矩阵 / 裁判闭环 / 维护阶段 / 软替换 / 缓存 / 社区 / 类型配置

## 版本

**当前版本：2.2.0**

## 安装

```bash
npm install @openclaw/graph-memory-pro
```

## 配置

在 `openclaw.json` 中配置（31 项配置项，全部可选）：

```json
{
  "plugins": {
    "entries": {
      "graph-memory-pro": {
        "config": {
          "neo4j": {
            "uri": "bolt://localhost:7687",
            "user": "neo4j",
            "password": "your-password"
          },
          "llm": { "apiKey": "", "baseURL": "", "model": "gpt-4o-mini" },
          "embedding": { "baseURL": "http://localhost:11434", "model": "nomic-embed-text", "dimensions": 768 },
          "recallMaxNodes": 6,
          "recallMaxDepth": 2,
          "dedupThreshold": 0.90,
          "temporal": { "enabled": true },
          "staleness": { "enabled": true, "threshold": 0.7 },
          "state": { "enabled": true, "filterSupersededInRecall": true },
          "queryCache": { "enabled": true, "maxSize": 100, "ttlMs": 1800000 },
          "judge": { "enabled": true, "asyncMode": true, "heuristicMatch": "both" },
          "associationMatrix": { "enabled": true, "dimensions": 768, "learningRate": 0.01 },
          "importance": { "enabled": true },
          "hierarchicalCommunity": { "enabled": true, "depth": 3 },
          "conflictResolution": { "enabled": true },
          "edgeWeights": { "enabled": true, "strengthenFactor": 1.1, "decayFactor": 0.95 },
          "benchmark": { "enabled": false, "maxCases": 50 },
          "autoTuner": { "enabled": false, "regressionThreshold": 0.02 }
        }
      }
    }
  }
}
```

完整配置项参见 [openclaw.plugin.json](openclaw.plugin.json) 的 `configSchema`（31 项）。

## Agent 工具

| 工具 | 说明 |
|---|---|
| `gm_record` | 手动记录知识到图谱 |
| `gm_maintain` | 触发图谱维护（11 阶段管线） |
| `gm_reembed` | 批量为缺失向量的节点重新生成嵌入 |
| `gm_feedback` | 提交反馈（query + recalledNodeIds + assistantReply），驱动 I-2 裁判 + I-3 持久化 + L-1 M 更新 |
| `gm_benchmark` | 运行 S-10 Benchmark 评测（LoCoMo/LongMemEval） |
| `gm_tune` | 触发 R-1 EvolveMem 自主调优循环 |

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 插件状态 |
| GET | `/api/stats` | 图谱统计 |
| GET | `/api/health` | G-5 图谱健康报告（v2.1.2） |
| GET | `/api/nodes/:id` | 获取节点详情 |
| GET | `/api/search` | 搜索节点 |
| GET | `/api/top` | Top 节点（按 PageRank） |
| GET | `/api/nodes-by-type/:type` | 按类型获取节点 |
| POST | `/api/maintain` | 触发维护 |
| POST | `/api/staleness/refresh` | S-14 手动刷新过时评分（v2.1.2） |

## 知识图谱结构

### 节点类型
- **Task**：用户提出的具体任务需求
- **Skill**：完成任务使用的方法、工具、代码片段或最佳实践
- **Event**：发生的具体事件、错误、异常或问题
- **GmCommunity**：社区摘要节点
- **GmFeedback**：反馈记录节点（I-3 持久化）
- **GmDecision**：冲突消解决策记录（G-2）

### 节点字段（v2.2.0 完整）

| 字段 | 批次 | 说明 |
|---|---|---|
| `validFrom`/`validTo`/`recordedAt` | S-1 | Bi-Temporal 时间维度 |
| `source` | S-3 | 来源（experience/knowledge/imported） |
| `state` | S-13 | 状态（current/superseded/transitional） |
| `stalenessScore` | S-14 | 过时评分（0~1，召回降权） |
| `importanceScore` | G-3 | 重要性评分（recency+frequency+centrality+source） |
| `embeddingHash`/`embeddingHistory` | R-4 | 嵌入版本化 |
| `embeddingModel` | G-4 | 嵌入模型标识 |
| `topicId`/`domainId` | S-4 | 层次化社区归属 |
| `supersededBy` | S-2 | 被哪个新版本替代 |

### 关系类型
- `USED_SKILL`：TASK → SKILL
- `SOLVED_BY`：EVENT → SKILL
- `REQUIRES`：TASK → TASK
- `PATCHES`：SKILL → SKILL
- `CONFLICTS_WITH`：SKILL → SKILL
- `RELATES_TO`：跨领域关联
- `CAUSED_BY`：EVENT → EVENT（S-5 因果）
- `LEADS_TO`：TASK → EVENT（S-5 因果）
- `JUDGED`：GmFeedback → Task/Skill/Event（I-3 反馈）

## 开发

```bash
npm install      # 安装依赖
npm run build    # 构建（tsup）
npm test         # 运行测试（vitest）
npx tsc --noEmit # 类型检查
```

## 项目结构

```
src/
├── engine/
│   ├── llm.ts              # LLM 引擎（带重试和超时）
│   └── embed.ts           # Embedding 引擎
├── extractor/
│   └── extract.ts         # 三元组提取器（含 S-5 因果关系）
├── format/
│   ├── assemble.ts       # 上下文组装
│   └── transcript-repair.ts
├── graph/
│   ├── community.ts      # 社区检测（含 S-4 层次化）
│   ├── dedup.ts          # 向量去重
│   ├── maintenance.ts    # 11 阶段维护管线
│   ├── pagerank.ts       # PageRank
│   └── reembed.ts        # 批量重嵌入（含 G-4 迁移）
├── recaller/
│   ├── recall.ts         # 召回（含 L-1 M 变换 + I-1 缓存）
│   ├── query-cache.ts    # I-1 LRU + cosine 缓存
│   ├── judge.ts          # I-2 LLM 裁判
│   └── association-matrix.ts  # L-1 关联矩阵 + R-3 边际效用
├── evolution/
│   └── auto-tuner.ts     # R-1 EvolveMem 自主调优
├── benchmark/
│   ├── types.ts          # S-10 指标计算
│   ├── datasets.ts       # S-10 LoCoMo/LongMemEval 适配器
│   └── runner.ts        # S-10 评测运行器
├── routes/
│   └── crud.ts           # HTTP 路由（含 /api/health, /api/staleness/refresh）
├── store/
│   ├── db.ts             # Neo4j 连接管理
│   └── store.ts         # 数据操作层（含 R-4 可进化嵌入）
├── timing.ts             # 延迟分布统计
└── types.ts              # 类型定义（GmConfig 31 项 + GmNode 完整字段）
test/
├── helpers/
│   └── neo4j-mock.ts     # Neo4j mock 测试基础设施
├── benchmark-metrics.test.ts
├── auto-tuner.test.ts
├── association-matrix.test.ts
├── judge-feedback.test.ts
├── maintenance-phases.test.ts
├── store-softreplace-r4.test.ts
├── query-cache.test.ts
├── community.test.ts
└── types-config.test.ts
```

## 路线图

详见 [ROADMAP.md](ROADMAP.md) — v2.1.10 路线图（17 任务，5 批次，已全部落地）。

## 许可证

MIT
