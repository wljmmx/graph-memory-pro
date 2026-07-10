# Changelog

本文档记录 Graph Memory Pro 各版本的显著变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [2.3.5] — 2026-07-10

### Added — 集成测试

- **TEST-1 smoke test 骨架**：新增 [test/smoke.test.ts](test/smoke.test.ts) + [docker-compose.smoke.yml](docker-compose.smoke.yml) + [vitest.smoke.config.ts](vitest.smoke.config.ts)，连接真实 Neo4j 验证 schema/写入/读取/向量索引/连接池计数。Neo4j 不可用时自动 skip，不影响主测试套件。通过 `npm run test:smoke` 运行。

## [2.3.4] — 2026-07-10

### Changed — 架构优化

- **ARCH-1 拆分 index.ts**：extractInBackground 提取到 [src/services/extract-service.ts](src/services/extract-service.ts)，index.ts 从 1248→~1160 行
- **CB-1 熔断器时间窗口衰减**：新增 `failureWindowMs` 可选配置，窗口外旧失败自动过期（默认 0 不衰减，向后兼容）
- **SDK-1 runtime LLM 重探测**：/api/reload 在 llm 配置未变时也检查 runtime LLM 是否首次可用
- **SDK-2 supplement 类型标注**：search/read 方法添加显式返回类型，不再依赖 SDK 隐式约定

### Added — 测试

- CB-1 时间窗口衰减测试（2 用例）+ ARCH-1 拆分验证测试（2 用例）
- 总测试数 431 → **435**

## [2.3.3] — 2026-07-10

### Fixed — 可靠性与安全加固

- **ERR-1 runtimeComplete 超时**：runtime LLM complete 添加 `AbortSignal.timeout(30_000)`，probe 添加 10s 超时
- **SEC-1 HTTP 路由统一鉴权**：写操作 + 敏感读操作（/api/health/metrics/usage/doctor）在配置 `mcp.authToken` 时需要鉴权
- **MCP-1 MCP server 健康探测**：startMcpServer 成功后 GET /health 确认 server 真正就绪
- **MCP-2 tool execute 超时包装**：新增 withTimeout，5 个长操作 tool 添加超时（maintain/reembed 120s / feedback 60s / benchmark 300s / tune 120s）
- **DOCKER-1 npm ci 回退修复**：移除 `|| npm install` 回退，避免版本漂移
- **CB-2 熔断器状态变更日志**：transition() 时记录 info 级别日志
- **SEC-2 apiKey 环境变量注释**：config.example.json 新增 $comment_apiKey

### Added — 测试

- SEC-1 鉴权逻辑（3）+ MCP-2 withTimeout（2）+ CB-2 日志（1）
- 总测试数 425 → **431**

## [2.3.2] — 2026-07-10

### 总结

v2.3.2 聚焦**稳定性修复**。在 v2.3.1 性能优化（并行化/批量化）基础上，针对并发竞态、批量失败、timer 重入、配置硬编码、部分索引失败、重试雪崩 6 类稳定性风险完成 S1–S6 修复。全部向后兼容，无破坏性变更。

### Fixed — 稳定性修复（S1–S6）

- **S1 GDS 投影互斥锁**：[src/graph/pagerank.ts](src/graph/pagerank.ts) `preheatProjection` 新增 in-flight Promise 复用。并发 recall 同时触发 `preheatProjection` 时，复用同一执行而非各自触发 `gds.graph.drop` + `gds.graph.project`，消除 `gds.pageRank.stream` 执行期间图被删除的竞态。
- **S2 批量写入失败回退**：[index.ts](index.ts) `extractInBackground` 中 `batchUpsertNodes` / `batchUpsertEdges` 失败时回退到 `Promise.allSettled(nodes.map(upsertNode))`，保证批量失败时仍部分成功，防数据丢失。
- **S3 后台 timer 重入保护**：[index.ts](index.ts) extractor / maintenance 两个 `setInterval` 回调新增 `_extractorRunning` / `_maintenanceRunning` flag。单次执行超过 interval 时，下一次 tick 跳过执行，防重叠执行导致资源竞争与重复写入。
- **S4 archiveKeepCount 配置化**：[src/store/nodes.ts](src/store/nodes.ts) `upsertNode` 新增可选 `cfg` 参数，归档切片从硬编码 `[..3]` 改为参数化 `[..$keepCount]`，读取 `cfg.evolvableEmbedding.archiveKeepCount`（默认 3）。修复 v2.3.1 P0-4 合并 Cypher 时遗留的硬编码。
- **S5 vectorSearchWithScore 容错**：[src/store/nodes.ts](src/store/nodes.ts) 向量索引并行查询从 `Promise.all` 改为 `Promise.allSettled`。单个向量索引失败（损坏/重建中）不再导致整个 vec_search reject，合并成功索引结果；全部失败时返回空数组由上层 FTS 兜底。
- **S6 重试 jitter + 4xx 不重试**：[src/engine/embed.ts](src/engine/embed.ts) 与 [src/engine/llm.ts](src/engine/llm.ts) 重试延迟加 `Math.random() * 500ms` jitter，防并发失败时重试波峰对齐加剧下游过载；embed 引擎新增 4xx（非 429）不重试（与 llm 引擎已有逻辑对齐）。

### Added — 测试

- **S6 embed 4xx 不重试测试**：2 用例（400 不重试直接抛出 / 429 仍重试 3 次）
- **并发稳定性测试**：新增 [test/concurrency-stability.test.ts](test/concurrency-stability.test.ts) 覆盖投影预热互斥（S1）/ archiveKeepCount 配置化（S4）/ vectorSearchWithScore 部分索引容错（S5）/ 熔断器三态转换（P3-2）。S2 批量回退、S3 timer 重入为 index.ts 私有闭包内简单 try/catch + flag 模式，由代码审查覆盖。
- **P2-1 embed LRU 缓存测试**：4 用例（缓存命中不重复 fetch / TTL 过期重新请求 / 容量淘汰最旧条目 / cacheSize=0 禁用缓存）
- **P2-2 LLM 并发控制测试**：3 用例（maxConcurrency=1 串行执行 / maxConcurrency=2 并行执行 / 请求失败时信号量释放）
- **P2-3 GDS 自动失效测试**：2 用例（invalidateProjectionCache 后投影重建 / 边数变化触发 hash 变化重建）
- **P3-1 连接池监控测试**：3 用例（getPoolMetrics 返回结构 / Session 计数增减 / 多并发 session 计数）
- **P3-3 配置热更新测试**：12 用例（diffConfigSegments 段变化检测 6 用例 / checkReloadAuth 鉴权 4 用例 / normalizeReloadConfig 默认值填充 2 用例），覆盖 [src/routes/reload.ts](src/routes/reload.ts) 提取的纯函数
- 总测试数 401 → **425**（17 文件）

### Performance — 阶段二性能优化（P2-1 ~ P2-4）

- **P2-1 embed LRU 缓存**：[src/engine/embed.ts](src/engine/embed.ts) `createEmbedFn` 内置 LRU 缓存（默认 256 条 / 10min TTL），命中缓存直接返回避免重复调用 Ollama。可配置 `embedding.cacheSize` / `embedding.cacheTtlMs`，设为 0 禁用。主要收益：associationMatrix 对同一 query 再次 embed、doctor 探测固定文本。
- **P2-2 LLM 并发控制**：[src/engine/llm.ts](src/engine/llm.ts) 新增信号量限流，防 Ollama 单流排队级联超时。默认 `maxConcurrency=1`（本地 Ollama），可配置 `llm.maxConcurrency` 提高（云端 API）。同 baseURL+model 共享同一信号量，runtime LLM 与 fallback 独立限流避免双重限制。
- **P2-3 GDS 自动失效**：[src/graph/pagerank.ts](src/graph/pagerank.ts) 投影 hash 纳入边数（`relTypeHash(types, edgeCount)`），修复旧实现仅基于 type 集合导致新增/删除同类型边不触发重建的缺陷。新增 `invalidateProjectionCache()` 导出函数，在 [src/store/edges.ts](src/store/edges.ts) 的 `upsertEdge` / `batchUpsertEdges` 成功后调用，主动失效让下次 PPR 重建投影反映新拓扑。
- **P2-4 向量索引合并**：[src/store/schema.ts](src/store/schema.ts) 新增合并索引 `gm_node_embedding`（多 label Task|Skill|Event），[src/store/nodes.ts](src/store/nodes.ts) `vectorSearchWithScore` 优先用合并索引单 session 查询，省 2 个 session + 去重逻辑。兼容回退：合并索引不存在时回退到 3 索引并行（旧环境）。保留旧索引创建语句确保向后兼容。

### Performance — 阶段三可观测与韧性（P3-1 ~ P3-3）

- **P3-1 连接池监控**：[src/store/db.ts](src/store/db.ts) `getSession` 包装 close 做应用层 Session 计数，新增 `getPoolMetrics()` 返回活跃会话数/总创建数/driver 内部活跃连接数（反射读取，防御性）。[/api/health](src/routes/crud.ts) 追加 `connectionPool` 字段，[/api/metrics](src/routes/crud.ts) 新增 4 个 Prometheus 指标（`graph_memory_neo4j_pool_active_sessions` 等）。
- **P3-2 降级熔断器**：新增 [src/engine/circuit-breaker.ts](src/engine/circuit-breaker.ts) 经典三态熔断器（CLOSED→OPEN→HALF_OPEN）。[src/recaller/recall.ts](src/recaller/recall.ts) embed 路径接入熔断器，OPEN 时跳过 ~9s 重试直接降级 FTS。[index.ts](index.ts) extractInBackground 接入 LLM 熔断器，OPEN 时跳过整个 tick。[/api/health](src/routes/crud.ts) 追加 `circuitBreakers` 状态，[/api/metrics](src/routes/crud.ts) 新增 `graph_memory_circuit_breaker_state` / `_failures_total` 指标。
- **P3-3 配置热更新**：新增 [/api/reload](index.ts) POST 端点，从 SDK 重新读取配置后 diff-based 部分重建：neo4j 段变化重建 driver + ensureSchema，llm 段变化重建 CompleteFn，embedding 段变化重建 EmbedFn，其余配置 `Object.assign` 原地合并让 Recaller/JudgeManager 持引用自动生效。reload 后自动重置所有熔断器。支持 authToken 鉴权（与 mcp.authToken 共用）。配置 diff / 鉴权 / 默认值填充逻辑提取为 [src/routes/reload.ts](src/routes/reload.ts) 纯函数，便于单元测试。

### Configuration Migration — 配置迁移（v2.3.1 → v2.3.2）

无破坏性变更，现有 v2.3.1 配置无需任何改动。`upsertNode` 新增第 3 个可选参数 `cfg`，未传入时行为与 v2.3.1 完全一致（archiveKeepCount 默认 3）。

---

## [2.3.1] — 2026-07-09

### 总结

v2.3.1 聚焦**召回与写入性能优化**。分两轮落地 11 项优化：第一轮 5 项（vectorSearchWithScore 并行 / 社区查询合并 / QueryCache 扫描限制 / graphWalk LIMIT / FTS‖vec 并行），第二轮 6 项（P0-1 ~ P1-2）。召回延迟显著下降，写入吞吐提升。

### Performance — 性能优化（第一轮）

- **vectorSearchWithScore 并行**：3 个向量索引从 UNION ALL 串行改为 `Promise.all` 并行，耗时 ≈ 3T → max(T)。
- **社区查询合并**：`communityVectorSearchWithReps` 合并向量搜索 + 代表节点查询为单条 Cypher。
- **QueryCache 扫描限制**：`getSimilar` 限制扫描条目数为 `similarityScanLimit`（默认 20），倒序扫描。
- **graphWalk LIMIT**：加 `[..$maxNodes]` 切片限制返回节点数，防 PPR 排序开销爆炸。
- **FTS‖vec 并行**：recallPrecise 内全文搜索与向量搜索并行执行。

### Performance — 性能优化（第二轮 P0/P1）

- **P0-1 PPR type 探测去重**：`ensureSharedProjection` 接受预计算 types，消除重复 `getExistingRelTypes` 查询。
- **P0-2 recall 入口预热投影**：`recall()` 入口 `preheatProjection` 与 embed 并行，避免双路径各自触发 ensureSharedProjection。
- **P0-3 extractInBackground 批量化**：`batchUpsertNodes` / `batchUpsertEdges` 用 UNWIND + MERGE 批量写入。
- **P0-4 upsertNode 三步合并**：3 次串行 session.run 合并为单条 OPTIONAL MATCH + CASE WHEN + MERGE Cypher。
- **P1-1 searchNodes 4 索引并行**：UNION ALL 改为 4 个 fulltext 索引 `Promise.all` 并行。
- **P1-2 PPR seed 查找并行**：type 探测与 seed 查找 `Promise.all` 并行。

### Added — 测试

- 新增 [test/recall-perf.test.ts](test/recall-perf.test.ts) 12 项性能测试。
- 适配 R-4 软替换测试 / pagerank closeCalls / crud searchNodes 并行断言。

---

## [2.3.0] — 2026-07-06

### 总结

v2.3.0 聚焦工程化与用户体验增强。落地 eslint 阻塞 CI、Embedding 维度校验、gm_doctor 自检工具、3 档预设配置、QUICKSTART.md、LLM token 用量监控等 8 项能力。测试 367 → 370 用例（+3），tsc 0 错误，lint 0 errors，全部向后兼容。

### Added — 新增能力

- **gm_doctor 自检工具**：[src/routes/crud.ts](src/routes/crud.ts) 新增 `GET /api/doctor` 端点。一次性验证 Neo4j / LLM / Embedding 三大依赖的连通性 + 配置完整性，返回 5 项 checks（neo4j/graph_schema/llm/embedding/judge）的 ok/warn/error 状态 + 诊断 hint。降低新用户排查配置问题成本。
- **Embedding 维度校验**：[src/engine/embed.ts](src/engine/embed.ts) 在返回向量后校验 `vec.length === config.dimensions`。防止模型更换后维度与向量索引不一致（如 nomic-embed-text 768 → 1024）。未配置 dimensions 时不校验（向后兼容）。
- **LLM token 用量监控**：
  - [src/store/usage.ts](src/store/usage.ts) 新增进程级 usage 累计（按 provider/purpose 分组）
  - [src/engine/llm.ts](src/engine/llm.ts) 在 `createOpenAICompatibleComplete` 和 `createRuntimeCompleteFn` 中记录 token 用量
  - [src/routes/crud.ts](src/routes/crud.ts) 新增 `GET /api/usage` 端点查询累计用量
  - `/api/metrics` Prometheus 输出新增 4 个指标：`graph_memory_llm_calls_total` / `graph_memory_llm_tokens_total` / `graph_memory_llm_prompt_tokens_total` / `graph_memory_llm_completion_tokens_total`
- **3 档预设配置**：[config.presets/](config.presets/) 新增 minimal / balanced / full 三档预设配置 + README 选用指南。降低新用户面对 32 项配置的认知负担。
  - `minimal.json`：仅 neo4j + llm + embedding，19 项功能全关
  - `balanced.json`：8 项核心功能 ON（推荐生产起点）
  - `full.json`：17 项功能全开（评测/高级用户）
- **QUICKSTART.md**：[QUICKSTART.md](QUICKSTART.md) 新增 5 分钟端到端教程（前置准备 → 最小配置 → 启动自检 → 首次记录 → 下一步），含 3 个常见错误排查。

### Changed — 工程化增强

- **eslint 正式接入 CI**：[eslint.config.js](eslint.config.js) flat config + `@typescript-eslint/eslint-plugin`。`npm run lint` 覆盖 src/ + index.ts，CI lint job 移除 `continue-on-error: true`，lint 失败将阻塞 CI。清理 30 个历史 lint errors（未使用 import / 未使用 catch err / prefer-const）。
- **package-lock.json 入库**：从 .gitignore 移除 `package-lock.json`，确保 CI `npm ci` 可重现构建。
- **lint 脚本扩展**：`eslint src/` → `eslint src/ index.ts`，覆盖入口文件。

### Added — 测试

- **Embedding 维度校验测试**：3 用例（维度一致通过 / 维度不匹配抛错 / 未配置 dimensions 不校验）
- 总测试数 367 → **370**（15 文件）

### Configuration Migration — 配置迁移（v2.2.2 → v2.3.0）

无破坏性变更，现有 v2.2.2 配置无需任何改动。

**新增可选能力**：
- `embedding.dimensions` 现在会被引擎层校验（v2.2.2 仅用于 schema 初始化）。如维度不匹配会抛错，请核对模型实际维度。
- 新增 `GET /api/doctor` 和 `GET /api/usage` 两个只读端点，无需配置。

## [2.2.2] — 2026-07-06

### 总结

v2.2.1 发布阻断修复版本。修复 3 项 P0 阻断（类型声明缺失 / 文档数字不一致 / 插件清单未发布）+ 3 项 P1 警告（package.json 元数据 / actionlint 二进制入库 / ROADMAP checklist 未勾选），并补充主会话本地模型优先策略测试。测试 340 → 367 用例（+27），tsc 0 错误，全部向后兼容。

### Added — 新增能力

- **主会话本地模型优先策略**：[src/engine/llm.ts](src/engine/llm.ts) 新增 `createRuntimeCompleteFn` 工厂函数。当 `api.runtime.llm` 可用时，首次调用执行轻量 probe（~8 token）探测主会话 provider：
  - 本地模型（ollama/lmstudio/localai/llamafile/llama.cpp）→ 后续走 runtime LLM，避免云端调用
  - 云端模型 → 切换到插件配置的 fallback LLM（`createCompleteFn`）
  - probe 失败 → 降级到 fallback（如未配置仍用 runtime）
  - 并发安全：所有并发首次调用共享 `detectPromise`，避免重复探测
  - [index.ts](index.ts) LLM 初始化注入 `api.runtime.llm` 引用

### Added — 测试

- **createRuntimeCompleteFn 测试**：13 用例（ollama/openai/无 fallback/probe 失败/并发共享/probe 缓存/数组 content/空 content/参数透传/probe 极小化/logger info/warn）
- **isLocalProvider 测试**：9 用例（关键字命中/大小写/ollama-256k 变体/llama.cpp/空安全/关键字列表完整性）
- 总测试数 340 → **367**（15 文件）

### Fixed — 发布阻断修复

- **P0-1 类型声明缺失**：[tsup.config.ts](tsup.config.ts) `dts: false` → `dts: true`，dist/ 产出 `index.d.ts`。原 `package.json` `types` 字段指向不存在的文件，消费者无法获得 TypeScript 类型提示。
- **P0-2 文档测试数字不一致**：README/release.yml/AUDIT/ROADMAP 中 340 vs 334 混用，统一为 367（当前实际值）。AUDIT_REPORT 保留 v2.2.1 历史快照 340，但修正第十章 334 → 340 与第七章一致。
- **P0-3 插件清单未发布**：`package.json` `files` 字段未包含 `openclaw.plugin.json`，npm 发布后 OpenClaw Gateway 无法加载插件。现已加入 files。
- **P1-1 package.json 元数据缺失**：补 `author: "Ananas <Wywelljob@gmail.com>"` + `license: "MIT"`，与 `openclaw.plugin.json` 一致。LICENSE 版权人署名统一为 `Ananas`（原 `adoresever` 引起身份混淆）。
- **P1-2 actionlint 二进制入库**：移除 `/workspace/actionlint`（Go 编译产物，跨平台不可用），加入 `.gitignore`，CI 中改用 `go install` 下载。
- **P1-3 ROADMAP 验收 checklist 未勾选**：已落地项全部勾选 `[x]`，与顶部"已全部落地"声明一致。

### Configuration Migration — 配置迁移（v2.2.1 → v2.2.2）

无破坏性变更，现有 v2.2.1 配置无需任何改动。

**新增行为**：
- 当插件运行在 OpenClaw 容器内且 `api.runtime.llm` 可用时，会自动探测主会话 provider。本地模型优先用主会话，云端模型回退到插件配置的 `llm`。如不希望使用此行为，可不配置 `api.runtime.llm`（SDK 自动控制），或保持 `llm` 配置作为 fallback。

## [2.2.1] — 2026-07-05

### 总结

v2.2.0 工程化补强的延续版本，落地 P4 能力补齐（I-2 裁判 Tier 2/3、增量维护）与原降级未执行项（拆分 maintenance.ts / store.ts、结构化日志）。测试 298 → 340 用例（+42），tsc 0 错误，全部向后兼容。

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
- **PageRank session closed 容错测试**：5 用例（PPR closed session 优雅降级 / catch 路径不调 session.run / 空入参 early return / computeGlobalPageRank closed session / 无活跃节点）
- **embed 错误诊断测试**：1 用例（错误消息包含模型名 + 响应预览，便于定位 Ollama 配置错误）
- 总测试数 298 → **340**（15 文件）

### Fixed — 诊断增强

- **embed.ts 错误诊断增强**：[src/engine/embed.ts](src/engine/embed.ts) 抛错前打印 Ollama 实际返回内容（`responsePreview`）+ 模型名，便于诊断"模型不支持 embed""配置错误"等问题。原错误 "missing embedding in response" 升级为 `Ollama embedding API returned no embedding data (model=X, response=Y)`。
- **pagerank.ts PPR closed session 容错**：[src/graph/pagerank.ts](src/graph/pagerank.ts) catch 路径不再复用原 session 调 `gds.graph.drop`（避免 "You cannot run more transactions on a closed session" 二次错误掩盖原始错误）。GDS 图会在下次 `ensureSharedProjection` 自动 drop+recreate。
- **pagerank.ts finally 容错**：`session.close()` 包裹 try/catch，避免在已 closed session 上 close 时抛错。
- **结构化日志迁移**：pagerank.ts 的 `console.warn` 迁移到 `createLogger("pagerank").warn`，含上下文字段（error/seedCount/candidateCount）。

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
