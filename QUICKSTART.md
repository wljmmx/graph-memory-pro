# Graph Memory Pro — 5 分钟快速开始

> 从零到召回，端到端跑通 graph-memory-pro。下方端点与工具名均为项目真实值。

## 1. 前置准备（1 分钟）

```bash
# Node.js 20+ / Neo4j 5.x / Ollama（本地 LLM+Embedding）或 OpenAI API Key
docker-compose up -d neo4j          # 启动 Neo4j 5.20（账号 neo4j / 密码 testpass）
npm install @openclaw/graph-memory-pro
```

## 2. 最小配置（1 分钟）

最小配置见 [`config.presets/minimal.json`](config.presets/minimal.json)，3 个必填项：`neo4j`（`uri`/`user`/`password`）/ `llm`（OpenAI 兼容；Ollama 用 `http://localhost:11434/v1`，**必含 `/v1`**，`apiKey` 留空）/ `embedding`（Ollama 原生 `http://localhost:11434`，**不含 `/v1`**；须为 embed 模型）。Ollama 用户先拉模型：

```bash
ollama pull qwen3.5:9b && ollama pull nomic-embed-text   # LLM + Embedding（768 维）
```

```json
{ "neo4j": { "uri": "bolt://localhost:7687", "user": "neo4j", "password": "testpass" },
  "llm": { "baseURL": "http://localhost:11434/v1", "model": "qwen3.5:9b" },
  "embedding": { "baseURL": "http://localhost:11434", "model": "nomic-embed-text", "dimensions": 768 } }
```

## 3. 启动 + 自检（1 分钟）

把 `minimal.json` 内容填入 `openclaw.json` → `plugins.entries.graph-memory-pro.config`，启动 OpenClaw 后调用自检（`<port>` 为 OpenClaw 网关 HTTP 端口）：

```bash
curl http://localhost:<port>/api/doctor
```

期望 `status` 为 `ok`/`warn`（首次启动 judge 处于冷启动会显示 `warn`）、`summary.total=5`，5 项 checks（`neo4j`/`graph_schema`/`llm`/`embedding`/`judge`）均为 ok/warn、**无 error**。常见错误排查：

| 现象 | 处理 |
|---|---|
| `neo4j`=error，拒绝连接 / `Could not perform discovery` | Neo4j 未起或账密错：`docker-compose up -d neo4j`，核对 `neo4j.uri`/`password`（compose 默认 `testpass`） |
| `llm`=error，或运行时 401 | `apiKey` 错 / `baseURL` 缺 `/v1` / 未拉模型：Ollama 加 `/v1` 且 `apiKey` 留空、`ollama pull` 拉模型；OpenAI 核对 `sk-` key |
| `embedding`=error，`dimension mismatch` | 维度不符：`nomic-embed-text=768`，使 `embedding.dimensions` 与模型实际维度一致 |

## 4. 首次记录 + 召回（1 分钟）

用 Agent 工具 `gm_record`（参数 `type`=SKILL/TASK/EVENT、`name`、`description`、`content`）记录一条：

```
gm_record(type="SKILL", name="react-hooks-cleanup", description="useEffect 清理副作用",
          content="在 useEffect 返回函数中取消订阅/定时器，避免内存泄漏")
```

或调 `POST /api/maintain` 触发记录与维护。然后召回（HTTP）：

```bash
curl 'http://localhost:<port>/api/search?q=react%20hooks'
```

跨对话召回用 memory-core 的 `memory_search`——graph-memory-pro 已通过 `registerMemoryCorpusSupplement` 注入，无需另建工具。

## 5. 下一步（1 分钟）

- 升级 balanced 配置：[`config.presets/balanced.json`](config.presets/balanced.json)（开启 queryCache / judge / associationMatrix / 层次化社区）
- 查看 Prometheus 指标：`GET /api/metrics`（`graph_memory_nodes_total` / `cache_hit_rate` 等）
- 完整功能：[README.md](README.md)
- 评测召回质量：`npm run benchmark -- --max-cases=10`（S-10 LoCoMo/LongMemEval）
