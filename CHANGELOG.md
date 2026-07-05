# Changelog

本文档记录 Graph Memory Pro 各版本的显著变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
