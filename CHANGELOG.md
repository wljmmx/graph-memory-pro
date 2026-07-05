# Changelog

本文档记录 Graph Memory Pro 各版本的显著变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [2.2.1] — 2026-07-05

### 总结

v2.2.0 工程化补强的延续版本，落地 P4 能力补齐（I-2 裁判 Tier 2/3、增量维护）与原降级未执行项（拆分 maintenance.ts / store.ts、结构化日志）。测试 298 → 334 用例（+36），tsc 0 错误，全部向后兼容。

### Added — 新增能力

- **I-2 裁判 Tier 2 LLM 裁判**（P4-1）：[src/recaller/judge.ts](src/recaller/judge.ts) 重构引入 `JudgeStrategy` 抽象接口 + 3 个内置策略：
  - Tier 1 `HeuristicJudgeStrategy`（默认，启发式 id/name 匹配）
  - Tier 2 `LlmJudgeStrategy`（构造 prompt 让 LLM 输出 JSON `{used, reasoning}`）
  - Tier 3 `CustomJudgeStrategy`（外部注入点，通过 `registerStrategy(name, fn)`）
  - 安全护栏：LLM 失败/超时/解析失败 → fallback Tier 1；节点数超 `llmJudgeMaxNodes` 截断
  - 新增配置：`judge.tier`（1/2/3）、`judge.llmJudgeMaxNodes`、`judge.llmJudgeTimeoutMs`、`judge.customStrategy`
- **增量维护（Incremental Maintenance）**（P4-2）：[src/graph/incremental-maintenance.ts](src/graph/incremental-maintenance.ts) — 仅对 `markDirty` 标记的脏节点执行节点级阶段（Phase 1/5/7/8/9），全图阶段仍走 `runMaintenance`
  - 脏节点持久化到 Neo4j（`:MaintenanceMeta { dirtyNodeIds }`）
  - 新增 HTTP 端点：`POST /api/maintain/incremental`、`POST /api/maintain/mark-dirty`、`GET /api/maintain/dirty-nodes`、`DELETE /api/maintain/dirty-nodes`
- **结构化日志**（P2-1）：[src/logger.ts](src/logger.ts) — 统一 `createLogger(namespace)` 接口
  - 分级 debug/info/warn/error，环境变量 `GM_LOG_LEVEL` 过滤
  - `GM_LOG_JSON=true` 输出 JSON 行（便于 Loki/ELK 采集）
  - `setTraceId` 跨模块关联请求链路
  - `setExternalLogger` 注入 OpenClaw SDK logger
  - 已迁移 maintenance.ts + 6 子模块（29 处）、recall.ts（10 处）、judge.ts（5 处）共 44 处 console 调用

### Changed — 重构（高风险项落地）

- **拆分 maintenance.ts**（P1-4）：1044 行 → 340 行 barrel + 6 个子模块（staleness/health/importance/conflict/edge-weights/reverse-memory，共 739 行）。所有现有 import 路径不变。
- **拆分 store.ts**（P1-5）：1128 行 → 69 行 barrel + 7 个子模块（schema/nodes/edges/feedback/community/vector/messages，共 1191 行）。所有现有 import 路径不变。
- **`matchedBy` 类型扩展**：`store.ts` 的 `GmFeedback.matchedBy` 联合类型新增 `"custom"`，匹配 Tier 3 裁判输出。

### Added — 测试

- **judge Tier 2/3 测试**：15 用例（LLM 判定 / 冷启动期不调 LLM / 失败 fallback / 非 JSON fallback / 节点截断 / Tier 3 注册/抛错/未注册/未配置/向后兼容）
- **增量维护测试**：10 用例（markDirty/getDirtyNodeIds/clearDirty 持久化、runIncrementalMaintenance 无脏节点/多阶段/配置跳过/并发锁）
- **结构化日志测试**：12 用例（缓存实例/child/info/warn/error 映射/级别过滤/JSON 输出/traceId/外部 logger 注入/fallback）
- 总测试数 298 → **334**（14 文件）

### Configuration Migration — 配置迁移（v2.2.0 → v2.2.1）

| 配置项 | 变化 | 默认值 | 说明 |
|---|---|---|---|
| `judge.tier` | 新增 | `1` | 1=启发式 / 2=LLM / 3=自定义 |
| `judge.llmJudgeMaxNodes` | 新增 | `10` | Tier 2 单次最大节点数 |
| `judge.llmJudgeTimeoutMs` | 新增 | `8000` | Tier 2 LLM 超时 |
| `judge.customStrategy` | 新增 | — | Tier 3 自定义策略名称 |
| 环境变量 `GM_LOG_LEVEL` | 新增 | `info` | 日志级别过滤 |
| 环境变量 `GM_LOG_JSON` | 新增 | `false` | JSON 输出开关 |

**迁移步骤**：
1. 现有 v2.2.0 配置无需任何改动即可继续工作（`judge.tier` 默认 `1`，行为与 v2.2.0 一致）。
2. 如需启用 Tier 2 LLM 裁判，配置 `judge.tier=2` 并确保 LLM 已注入。
3. 如需启用结构化 JSON 日志，设置环境变量 `GM_LOG_JSON=true`。
4. 如需在大图谱上降低维护成本，写入节点后调用 `POST /api/maintain/mark-dirty`，定期触发 `POST /api/maintain/incremental`。

## [2.2.0] — 2026-07-05

### 总结

v2.1.10 路线图（22 项方案，5 批次）全部落地，发布为 v2.2.0。本次发布补齐 MCP Server 对外接口、可观测性指标（Prometheus）、自主调优与关联矩阵的状态查询入口，并补全 HTTP API / LLM 引擎 / 抽取器的单元测试覆盖。

### Added — 新增能力

- **MCP Server**（v2.2.0 新增）：通过 Streamable HTTP 暴露 13 个 tools（7 read + 6 write），供 dashboard 或任意 MCP client（Claude Desktop / Cursor）调用。配置项 `mcp.enabled / port / host / path / authToken / enabledTools`。
- **指标导出 `/api/metrics`**（P2-2）：输出 Prometheus text exposition format，覆盖节点/边/反馈计数、查询缓存命中率、裁判冷启动状态、关联矩阵 M 的更新统计。可直接被 Prometheus / Grafana 抓取。
- **AutoTuner 状态查询 `/api/auto-tuner/state`**（P2-3）：读取持久化的 EvolveMem 调优状态（snapshots / currentAction / tuneRound）。
- **关联矩阵 M 状态查询 `/api/association-matrix/state`**（P2-4）：返回内存中 AssociationMatrix 的 dim / t / applied / rejected / historySize 统计。
- **Benchmark CLI**（P2-5）：`npm run benchmark` 一键运行 S-10 评测，支持 `--config` / `--datasets` / `--max-cases` / `--no-build-graph` 参数，及 `GM_NEO4J_*` / `GM_LLM_*` / `GM_EMBED_*` 环境变量。
- **配置示例文件** `config.example.json`：覆盖全部 32 项配置（含 MCP），可直接复制使用。
- **单元测试补全**（P1-1/P1-2/P1-3）：
  - `test/crud-routes.test.ts`：HTTP API 路由 17 → 24 用例（新增 metrics / auto-tuner / association-matrix 端点测试）
  - `test/engine-llm-embed.test.ts`：LLM / Embedding 引擎 24 用例
  - `test/extract.test.ts`：三元组抽取 20 用例
  - 总测试数 230 → 298（12 文件）

### Changed — 变更

- **版本号统一**（P0-1）：`package.json` / `openclaw.plugin.json` / `README.md` / `ROADMAP.md` / 代码注释 5 处全部对齐到 `2.2.0`。
- **README 全面修正**（P0-3）：测试数、路线图任务数、MCP 章节、项目结构、HTTP API 表均同步更新。
- **`initRoutes` 签名扩展**：新增可选 `recaller` 参数，供 metrics / association-matrix 端点读取缓存与矩阵状态。

### Fixed — 修复

- **MCP Server 实现丢失**（P0-2）：v2.1.10 时期的 MCP 实现（commit `113e43a`）游离于主线之外，本次重新创建 `src/mcp/server.ts`（约 540 行），包含 Bearer Token 鉴权、`GET /health` 健康探活、无状态模式。
- **`StreamableHTTPServerTransport.handleRequest` 签名**：改为先解析 body 再传入 `handleRequest(req, res, parsedBody)`，避免 SDK 类型不匹配。
- **`Recaller.processFeedback` 签名**：MCP `gm_feedback` 工具改为先 `findById` 获取 `GmNode[]` 再传入，匹配 `(query, GmNode[], reply, sessionId)` 签名。
- **`AutoTuner` 构造与调用**：修正为 `new AutoTuner(cfg.autoTuner, llm)` + `runTuneCycle(recaller, driver, cfg)`，统计 `applied` / `isImprovement` 字段。
- **`BenchmarkRunResult.aggregate` 字段名**：`p1` → `avgP1`、`mrr` → `avgMrr` 等汇总字段名修正。
- **`McpServer.registerTool` structuredContent 类型**：添加 `asStructured<T>` helper 包装强类型对象为 `Record<string, unknown>`。

### Infrastructure — 工程化

- **Dockerfile**（P3）：基于 `node:20-alpine`，集成 Neo4j 5.x 与本插件，开箱即用。
- **GitHub Actions CI**（P3）：`.github/workflows/ci.yml`，runs-on ubuntu-latest，执行 `tsc --noEmit` / `npm run build` / `npm test`，覆盖 Node 20/22。

### Configuration Migration — 配置迁移

v2.1.2 → v2.2.0 配置变更：

| 配置项 | 变化 | 默认值 | 说明 |
|---|---|---|---|
| `mcp.enabled` | 新增 | `false` | 启用 MCP Server |
| `mcp.port` | 新增 | `7800` | MCP 监听端口 |
| `mcp.host` | 新增 | `127.0.0.1` | MCP 监听地址 |
| `mcp.path` | 新增 | `/mcp` | MCP HTTP 路径 |
| `mcp.authToken` | 新增 | — | Bearer Token 鉴权 |
| `mcp.enabledTools` | 新增 | — | 启用的工具列表（空则全部） |

**迁移步骤**：

1. 现有 v2.1.2 配置无需任何改动即可继续工作（所有新增配置项默认值安全）。
2. 如需启用 MCP Server，在 `openclaw.json` 的 `plugins.entries.graph-memory-pro.config` 中添加：

```json
{
  "mcp": {
    "enabled": true,
    "port": 7800,
    "host": "127.0.0.1",
    "authToken": "your-secret-token"
  }
}
```

3. 参考 `config.example.json` 获取完整配置示例。

## [2.1.2] — 2026-03-24

v2.1.10 路线图（22 项方案，5 批次）实现版本。详见 [ROADMAP.md](ROADMAP.md)。
