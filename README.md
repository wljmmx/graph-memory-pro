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

### v2.2.1 工程化补强（5 项落地）

**P4-1：I-2 裁判 Tier 2/3 接入点** — 引入 `JudgeStrategy` 抽象接口 + 3 个内置策略：
- Tier 1 `HeuristicJudgeStrategy`（默认，启发式 id/name 匹配，与 v2.2.0 行为一致）
- Tier 2 `LlmJudgeStrategy`（构造 prompt 让 LLM 输出 JSON `{used, reasoning}`，节点超 `llmJudgeMaxNodes` 截断）
- Tier 3 `CustomJudgeStrategy`（外部注入点，通过 `registerStrategy(name, fn)`）
- 安全护栏：LLM 失败/超时/JSON 解析失败 → 自动 fallback Tier 1；冷启动期（< `judgeWarmupFeedbacks`）不调 LLM

**P4-2：增量维护（Incremental Maintenance）** — 仅对 `markDirty` 标记的脏节点执行节点级阶段（Phase 1/5/7/8/9），全图阶段仍走 `runMaintenance`：
- 脏节点持久化到 Neo4j（`:MaintenanceMeta { dirtyNodeIds }`）
- 4 个 HTTP 端点：`POST /api/maintain/incremental` / `POST /api/maintain/mark-dirty` / `GET /api/maintain/dirty-nodes` / `DELETE /api/maintain/dirty-nodes`
- 适用场景：大图谱降低维护成本，写入节点后 mark-dirty，定期触发增量维护

**P1-4：拆分 maintenance.ts** — 1044 行 → 340 行 barrel + 6 个子模块（staleness/health/importance/conflict/edge-weights/reverse-memory，共 739 行），所有现有 import 路径不变。

**P1-5：拆分 store.ts** — 1128 行 → 69 行 barrel + 7 个子模块（schema/nodes/edges/feedback/community/vector/messages，共 1191 行），所有现有 import 路径不变。

**P2-1：结构化日志** — 统一 `createLogger(namespace)` 接口，分级 debug/info/warn/error，环境变量 `GM_LOG_LEVEL` 过滤、`GM_LOG_JSON=true` 输出 JSON 行（便于 Loki/ELK 采集），`setTraceId` 跨模块关联请求链路，`setExternalLogger` 注入 OpenClaw SDK logger。已迁移 maintenance + recall + judge 共 44 处 console 调用。

### 测试覆盖
- 17 个测试文件，425 个用例（Neo4j mock 基础设施，CI 友好）
- 覆盖全部 5 批次核心功能 + v2.3.2 新增（稳定性修复 S1–S6 / 性能优化 P2-1~P2-4 / 可观测韧性 P3-1~P3-3）：指标计算 / AutoTuner / 关联矩阵 / 裁判闭环 / 维护阶段 / 软替换 / 缓存 / 社区 / 类型配置 / HTTP API 路由 / LLM-Embedding 引擎 / 三元组抽取 / 增量维护 / 结构化日志 / PageRank 容错 / runtime LLM provider 探测 / 并发稳定性 / embed LRU 缓存 / LLM 信号量 / GDS 自动失效 / 连接池监控 / 配置热更新

## 版本

**当前版本：2.3.2**

## 安装

```bash
npm install @openclaw/graph-memory-pro
```

## 配置

在 `openclaw.json` 中配置（32 项配置项，全部可选）：

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
          "judge": { "enabled": true, "asyncMode": true, "heuristicMatch": "both", "tier": 1, "llmJudgeMaxNodes": 10, "llmJudgeTimeoutMs": 8000 },
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

完整配置项参见 [openclaw.plugin.json](openclaw.plugin.json) 的 `configSchema`（32 项，含 v2.2.0 MCP）。

## Agent 工具

| 工具 | 说明 |
|---|---|
| `gm_record` | 手动记录知识到图谱（type/name/description/content，可选 source: experience/knowledge/imported） |
| `gm_maintain` | 触发图谱维护（11 阶段管线） |
| `gm_reembed` | 批量为缺失向量的节点重新生成嵌入 |
| `gm_feedback` | 提交反馈（query + recalledNodeIds + assistantReply），驱动 I-2 裁判 + I-3 持久化 + L-1 M 更新 |
| `gm_benchmark` | 运行 S-10 Benchmark 评测（LoCoMo/LongMemEval） |
| `gm_tune` | 触发 R-1 EvolveMem 自主调优循环 |

## MCP Server（v2.2.0 新增）

通过 Model Context Protocol 对外暴露图谱能力，供 lcm-graph-extra dashboard 或任意 MCP client（Claude Desktop / Cursor / 自研 client）调用。

### 启用配置

```json
{
  "mcp": {
    "enabled": true,
    "port": 7800,
    "host": "127.0.0.1",
    "path": "/mcp",
    "authToken": "your-secret-token",
    "enabledTools": ["gm_status", "gm_stats", "gm_search"]
  }
}
```

- `host: "127.0.0.1"` 仅本机；`"0.0.0.0"` 对外开放
- `authToken` 设置后客户端需在 `Authorization: Bearer <token>` 头携带
- `enabledTools` 省略则启用全部 13 个工具

### 端点
- `POST http://<host>:<port>/mcp` — MCP JSON-RPC
- `GET http://<host>:<port>/health` — 健康探活（无需鉴权）

### 暴露的 13 个 MCP tools

| 工具 | 类型 | 说明 |
|---|---|---|
| `gm_status` | read | Neo4j 连接状态 + 版本 |
| `gm_stats` | read | 节点/边总数 |
| `gm_health` | read | G-5 健康报告 |
| `gm_get_node` | read | 按 ID 取节点 |
| `gm_search` | read | 全文搜索 + 关联边 |
| `gm_top` | read | PageRank Top-N |
| `gm_nodes_by_type` | read | 按类型筛选 |
| `gm_record` | write | 手动记录节点（含 source 参数） |
| `gm_maintain` | write | 触发维护管线 |
| `gm_reembed` | write | 批量重嵌入 |
| `gm_feedback` | write | 提交召回反馈 |
| `gm_benchmark` | write | S-10 评测 |
| `gm_tune` | write | R-1 调优循环（需 autoTuner.enabled） |

### Dashboard 接入示例

```typescript
const res = await fetch("http://127.0.0.1:7800/mcp", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer your-secret-token",
  },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1,
    method: "tools/call",
    params: { name: "gm_search", arguments: { query: "React hooks", limit: 5 } },
  }),
});
const { result } = await res.json();
```

### Claude Desktop / Cursor 接入

```json
{
  "mcpServers": {
    "graph-memory-pro": {
      "url": "http://127.0.0.1:7800/mcp",
      "headers": { "Authorization": "Bearer your-secret-token" }
    }
  }
}
```

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
| POST | `/api/maintain/incremental` | 增量维护（仅对脏节点执行节点级阶段）（v2.2.1） |
| POST | `/api/maintain/mark-dirty` | 标记节点为脏（v2.2.1） |
| GET | `/api/maintain/dirty-nodes` | 读取脏节点列表（v2.2.1） |
| DELETE | `/api/maintain/dirty-nodes` | 清空脏节点标记（v2.2.1） |
| POST | `/api/staleness/refresh` | S-14 手动刷新过时评分（v2.1.2） |
| GET | `/api/metrics` | Prometheus 指标导出（v2.2.0） |
| GET | `/api/auto-tuner/state` | AutoTuner 调优状态（v2.2.0） |
| GET | `/api/association-matrix/state` | 关联矩阵 M 状态（v2.2.0） |
| POST | `/api/reload` | 配置热更新（diff-based 部分重建 driver/llm/embed）（v2.3.2） |

### Prometheus 指标

`/api/metrics` 输出 Prometheus text exposition format，可直接被 Prometheus / Grafana 抓取：

```
# HELP graph_memory_nodes_total Total nodes in the graph.
# TYPE graph_memory_nodes_total gauge
graph_memory_nodes_total{plugin="graph-memory-pro",version="2.2.1"} 5
# HELP graph_memory_cache_hit_rate Query cache hit rate [0,1].
# TYPE graph_memory_cache_hit_rate gauge
graph_memory_cache_hit_rate{plugin="graph-memory-pro",version="2.2.1"} 0.123
# HELP graph_memory_association_matrix_updates_applied Total accepted M updates.
# TYPE graph_memory_association_matrix_updates_applied gauge
graph_memory_association_matrix_updates_applied{plugin="graph-memory-pro",version="2.2.1"} 42
```

覆盖指标：`graph_memory_up` / `nodes_total` / `edges_total` / `feedback_total` / `cache_size` / `cache_hit_rate` / `judge_cold_start` / `association_matrix_t` / `association_matrix_updates_applied` / `association_matrix_updates_rejected` / `neo4j_pool_active_sessions` / `neo4j_pool_total_sessions` / `neo4j_pool_max_size` / `neo4j_pool_driver_active` / `circuit_breaker_state` / `circuit_breaker_failures_total`（v2.3.2 新增连接池 + 熔断器指标）。

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
npm install          # 安装依赖
npm run build        # 构建（tsup）
npm test            # 运行测试（vitest）
npx tsc --noEmit     # 类型检查
npm run benchmark    # 运行 S-10 Benchmark 评测（需 Neo4j + LLM 配置）
npm run lint         # ESLint
```

### Benchmark 评测

```bash
# 1. 启动 Neo4j（推荐 docker-compose）
docker-compose up -d neo4j

# 2. 通过配置文件运行
npm run benchmark -- --config=./config.example.json --max-cases=10

# 3. 或通过环境变量
GM_NEO4J_URI=bolt://localhost:7687 \
GM_NEO4J_USER=neo4j \
GM_NEO4J_PASSWORD=testpass \
GM_LLM_API_KEY=sk-xxx \
GM_LLM_MODEL=gpt-4o-mini \
GM_EMBED_BASE_URL=http://localhost:11434 \
GM_EMBED_MODEL=nomic-embed-text \
npm run benchmark -- --max-cases=10 --no-build-graph
```

### Docker

```bash
# 启动 Neo4j + 插件开发环境
docker-compose up -d neo4j

# 构建镜像（含本插件）
docker build -t graph-memory-pro:dev .
```

### CI

GitHub Actions 工作流定义在 `.github/workflows/ci.yml`，覆盖 Node 20/22，执行 `tsc --noEmit` / `npm run build` / `npm test`。

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
│   ├── incremental-maintenance.ts  # 增量维护（v2.2.1，仅对脏节点执行节点级阶段）
│   ├── maintenance.ts    # 11 阶段维护管线（barrel，340 行）
│   ├── maintenance/       # 维护子模块（v2.2.1 拆分，6 个）
│   │   ├── staleness.ts      # S-14 过时评分
│   │   ├── health.ts         # G-5 图谱健康
│   │   ├── importance.ts     # G-3 重要性评分
│   │   ├── conflict.ts      # G-2 冲突消解
│   │   ├── edge-weights.ts   # L-3 边权重调整
│   │   └── reverse-memory.ts # L-4 反向记忆项
│   ├── pagerank.ts       # PageRank
│   └── reembed.ts        # 批量重嵌入（含 G-4 迁移）
├── recaller/
│   ├── recall.ts         # 召回（含 L-1 M 变换 + I-1 缓存）
│   ├── query-cache.ts    # I-1 LRU + cosine 缓存
│   ├── judge.ts          # I-2 LLM 裁判（Tier 1/2/3 策略分发，v2.2.1）
│   └── association-matrix.ts  # L-1 关联矩阵 + R-3 边际效用
├── evolution/
│   └── auto-tuner.ts     # R-1 EvolveMem 自主调优
├── benchmark/
│   ├── types.ts          # S-10 指标计算
│   ├── datasets.ts       # S-10 LoCoMo/LongMemEval 适配器
│   ├── runner.ts         # S-10 评测运行器
│   └── cli.ts            # S-10 Benchmark CLI 入口（v2.2.0）
├── routes/
│   ├── crud.ts           # HTTP 路由（含 /api/metrics, /api/auto-tuner/state, /api/maintain/* 等）
│   └── reload.ts         # 配置热更新纯函数（diffConfigSegments/checkReloadAuth/normalizeReloadConfig）（v2.3.2）
├── mcp/
│   └── server.ts         # MCP Server（Streamable HTTP，13 个 tools）
├── store/
│   ├── db.ts             # Neo4j 连接管理
│   ├── store.ts          # 数据操作层 barrel（barrel，69 行）
│   ├── schema.ts         # Schema 初始化 + 共享工具（v2.2.1 拆分）
│   ├── nodes.ts          # 节点 CRUD（v2.2.1 拆分）
│   ├── edges.ts          # 边 CRUD + mergeNodes（v2.2.1 拆分）
│   ├── feedback.ts       # I-3 反馈持久化（v2.2.1 拆分）
│   ├── community.ts      # 社区管理（v2.2.1 拆分）
│   ├── vector.ts         # 向量索引（v2.2.1 拆分）
│   └── messages.ts       # 消息存储（v2.2.1 拆分）
├── logger.ts             # 结构化日志（v2.2.1：createLogger + 分级 + JSON + traceId）
├── timing.ts             # 延迟分布统计
└── types.ts              # 类型定义（GmConfig + GmNode + McpConfig + JudgeConfig）
test/
├── helpers/
│   └── neo4j-mock.ts     # Neo4j mock 测试基础设施
├── benchmark-metrics.test.ts
├── auto-tuner.test.ts
├── association-matrix.test.ts
├── test/judge-feedback.test.ts       # 裁判闭环 + Tier 2/3 策略（v2.2.1 扩展）
├── maintenance-phases.test.ts
├── incremental-maintenance.test.ts  # 增量维护（v2.2.1 新增）
├── pagerank.test.ts            # PageRank PPR closed session 容错（v2.2.1 新增）
├── logger.test.ts              # 结构化日志（v2.2.1 新增）
├── store-softreplace-r4.test.ts
├── query-cache.test.ts
├── community.test.ts
├── types-config.test.ts
├── crud-routes.test.ts          # HTTP API 路由测试（v2.2.0）
├── engine-llm-embed.test.ts     # LLM/Embedding 引擎测试（v2.2.0）
├── recall-perf.test.ts           # 召回性能测试（v2.3.1 新增）
├── concurrency-stability.test.ts # 并发稳定性 + P2/P3 补充测试（v2.3.2 新增）
└── extract.test.ts              # 三元组抽取测试（v2.2.0）
```

## 路线图

详见 [ROADMAP.md](ROADMAP.md) — v2.1.10 路线图（22 项方案，5 批次，已全部落地，发布为 v2.2.0）。

v2.2.1 工程化补强（P4 + 降级项落地）详见 [CHANGELOG.md](CHANGELOG.md#221--2026-07-05)。

## 许可证

MIT
