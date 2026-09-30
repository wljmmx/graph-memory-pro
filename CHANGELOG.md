# Changelog

本文档记录 Graph Memory Pro 各版本的显著变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [2.4.7] - 2026-09-29

**多模块缺陷审计后的整改批次。头条修复：重抽（re-extract）会改写节点状态与时间语义 —— 这是「问修改后的结果却答出旧事实」的直接机制。**

### Fixed — 写入路径按「权威归属」分层（重抽不再复活 superseded 节点）

`upsertNode` / `batchUpsertNodes` 此前对**全部**字段无条件 `SET`，而抽取路径恒定传
`pagerank: 0, validatedCount: 0` 且不传 `state/validTo`。于是每次重抽都会：

- 把已被 dedup / conflict 正确标记 `superseded` 的节点**复活**成 `current`（`validTo` 被清空）
  → 旧事实重新可召回。**支撑「超替关系」的前提本身会被下一次抽取抹掉**，所以只修召回过滤是不够的；
- 清空反馈累积的 `validatedCount`（而 dedup 的胜出判据正是它）、GDS 算出的 `pagerank`、
  维护算出的 `stalenessScore/importanceScore`；
- 把 `createdAt/validFrom/recordedAt` 刷成本次时间，销毁真实创建时间。

现按权威归属分层（[src/store/nodes.ts](src/store/nodes.ts)）：

| 层 | 字段 | 规则 |
|---|---|---|
| 创建/来源 | `createdAt` `validFrom` `recordedAt` `source` | `ON CREATE SET`，**写一次** |
| 内容 | `name` `description` `content` `type` `status` `embeddingModel` | 抽取方全权更新 |
| 派生/状态 | `pagerank` `validatedCount` `stalenessScore` `importanceScore` `state` | `COALESCE(n.x, $x)`，**只在缺失时补初值** |
| 超替 | `validTo` `supersededBy` | 移出更新 SET，抽取**不得**触碰 |
| 社区 | `communityId` | 本就只由 `updateCommunities` 写 —— 重抽保留既有社区归属（新增回归守卫） |

`updatedAt` 改为**内容真变化时才推进**（避免重抽刷新"新鲜度"，干扰 dedup 平局判据与时序项）。

### Fixed — 内容变化时失效旧向量

`batchUpsertNodes` 原来只更新 `embeddingHash` 而保留旧 `embedding`，而所有重嵌入路径都只查
`embedding IS NULL` → 「内容已是 B、向量还是 A」且**永不重算**，向量检索按旧语义命中。
现在内容变化（或新节点）时清空 `embedding`/`embeddingHash`，交给 `embedNodesMissing` /
`reEmbedNodes` 重算。检测查询失败时保守不清（并 warn 留痕）。

### Fixed — 核心初始化的「单向门」

`doGatewayInit` 体内任一处抛错都不会调用 `settleCoreInit(false)`，异常被调用方 `.catch` 吞掉后
`coreInitFailed` 永远为 false → `claimCoreInit()` 对所有后续实例永久返回 `"reuse"`
→ **全进程再也起不了 API/MCP**。现包一层包装器，失败时务必交还认领权（错误仍向上抛）。

### Fixed — 超替状态收敛为一致写法

同一「节点被取代」语义此前有**三套**实现：

- `conflict.ts` 合并策略：先 `SET loser.state='superseded', validTo, supersededBy`，
  紧接着 `DETACH DELETE loser` —— **等于把刚写的超替标记立刻物理销毁**（且与 dedup 的软替换语义分叉）。
  现移除物理删除并补 `stalenessScore = 1.0`，与另一条超替路径对齐。
- `incremental-maintenance.ts`：只设 `state`/`supersededBy`，**缺 `validTo`**（`temporalRecency`
  的过期判定与 `filterSupersededInRecall` 都依赖它）。现补齐 `validTo` + `stalenessScore`。

### Fixed — 社区 id 由排序下标改为成员指纹

`c-${i+1}` 把「按成员数排序后的下标」当作社区身份，而 GDS 原始 id 是运行相关的、等规模社区
没有稳定 tiebreaker。图一变动同一逻辑社区就换号 → 摘要成孤儿、或**同号落到另一社区被
「已有摘要→跳过」误判**，召回读到错误摘要。现改为「排序后成员 id 列表」的 64-bit 指纹：
成员集合不变 → id 不变（摘要可复用）；成员变化 → id 变化（摘要自然失效）。
代价是成员增删会重新摘要，这是正确性换 LLM 成本的取舍。

### Fixed — 召回结果缓存从不失效

`QueryCache` 只在手动 `/api/ops/cache` 时清空（对照：pagerank 投影缓存**有**在边写入后失效），
导致用户写入/更新记忆后同一 query 最长 30 分钟仍返回旧召回。现引入进程级「图修订号」
（[src/store/graph-revision.ts](src/store/graph-revision.ts)）：节点/边写入在**真正改变图内容**时递增，
缓存条目记录写入时的修订号、读取时比对。纯重复抽取不递增（否则缓存形同虚设）。
同时把缓存键由 32-bit djb2 换为 64-bit FNV-1a —— 旧键会碰撞并返回**另一条 query** 的结果。

### Changed — 可观测性

- **`logger.ts`：接入宿主 logger 时把 `fields` 内联进 `msg`（超长截断）**。
  宿主插件 logger 只渲染第一个参数，此前 `fields` 仅作为第二个参数传出 → 生产日志里
  `batch sub-batch failed (8 texts)` 之后本应跟随的 `{ url, apiFormat, model, error }`
  整段消失，嵌入全失败时看不到真正的 HTTP 响应体。这是**全局性**的：所有模块的结构化
  上下文在宿主日志中都不可见。
- `embed.ts`：批量子批次失败日志补 `url` / `apiFormat` / `expectedDim`（此前只有 `baseURL`）
- `graph/reembed.ts`：失败提示不再硬编码「is pulled in Ollama」—— 非 Ollama 后端
  （OVMS / OpenAI 兼容）会被误导到错误方向；改为后端无关的排查指引
- `extractor/extract.ts`：LLM 异常不再静默返回空结果（此前无法区分「LLM 不可用」与「确实无可提取内容」）
- `incremental-maintenance.ts`：脏节点读取失败不再静默返回空集（「读取失败」与「无脏节点」同形）
- `graph/community.ts`：社区检测顶层吞错不再静默返回空（维护日志的 `community: 0` 与「确无社区」同形）
- `graph/reembed.ts`：批量嵌入失败计入 `failed`（此前恒为 0，未写向量的节点被算进 `skipped`）
- `index.ts`：`after_tool_call` / `llm_output` 两处早退补日志（`warnOnce` 防高频刷屏）
- `mcp/server.ts`：每请求新建的 transport 在响应结束后关闭（长跑进程的累积泄漏）

### 测试

新增 [test/node-write-invariants.test.ts](test/node-write-invariants.test.ts) 12 个不变式用例
（创建字段写一次、派生字段不可清空、超替字段不可复活、`communityId` 归属保留、向量失效、`contentChanged` 判定）。
[test/community.test.ts](test/community.test.ts) 由断言字面序号 `c-1` 改为断言「形状 + 成员归属 + 跨运行稳定」。
[test/maintenance-phases.test.ts](test/maintenance-phases.test.ts) 新增「禁止物理删除」回归守卫。

### Changed — 版本对齐

`src/version.ts`、`package.json`、`openclaw.plugin.json`、`package-lock.json`、
[index.ts](index.ts) 头部版本注释、[README.md](README.md) 示例、
[test/version.test.ts](test/version.test.ts) 由 **2.4.6** 对齐至 **2.4.7**。

### 未纳入本批次（需先决策，见审计清单）

以下项已定位但**未改**，因为都涉及行为契约变更，需要先确定阈值/保留策略：

- 无界 handler 加 limit/预算（`/api/nodes-by-type` 无 limit 全表返回、`/api/feedback` 对
  `recalledNodeIds` 无上限并发查库、`requestTimeout: 0`）
- 维护类阶段的全量逐条往返（`staleness`/`importance`/`self-heal`）与后台工作预算
- `crud.ts` 的 `rebuildJobs` Map 永不淘汰

## [2.4.6] - 2026-09-29

**修复 `agent_end` 写端的三类缺陷：全量重放导致 O(n²) 写入、`createdAt` 被每轮覆盖、位置键在宿主 compaction 后产生重复行；并补齐排查所需的可观测性。**

### Fixed — 稳定消息键（不再把「数组下标」写进身份）

旧 id = `gm:<sessionKey>:<turnIndex>:<role>:<hash(content 前 200 字)>`，把位置分量当作消息身份。
宿主存在 compaction（`before_compaction` / `after_compaction` 钩子可观测且不可 veto），会改写历史数组；
数组位移后同一逻辑消息算出新 id → 插入重复行。

- 新 id = `gm:<sessionKey>:<role>:<全文 64-bit 指纹>:<同内容出现序号>`（[src/store/messages.ts](src/store/messages.ts) `buildMessageId`）
- 内容指纹由 32-bit djb2 + **仅前 200 字** 改为 **64-bit FNV-1a 全文**（`messageContentHash`）——
  旧实现对「前 200 字相同的不同消息」会算出同一 id，MERGE 直接相互覆盖（真丢数据）
- 同内容重复消息（如连发两次「继续」）用 `seq` 区分，不再互相覆盖

### Fixed — `createdAt` 只在新建时写

`saveMessage` 原为 `MERGE {id} SET … m.createdAt = $createdAt`（无条件覆盖）。每轮 `agent_end`
全量重放会把整段历史的时间戳刷成本轮时间：

- 真实时间戳被摧毁（不可恢复）
- `markMessagesByContent` 依赖 `u.createdAt < a.createdAt` **严格小于**配对；重放时同一毫秒内的
  user/assistant 会静默失配 → 该对话对永远标不上 `rebuildProcessedAt` → 每轮重复提取

改为 `MERGE … ON CREATE SET m.createdAt = $createdAt`，其余字段仍幂等 `SET`。

### Changed — 增量写入替代全量重放

原先每轮遍历**整个** `messages` 数组并逐条 `saveMessage`（每条各开/关一个 session），
会话生命周期内写入量 ≈ N²/2。现按 `(role, 内容指纹)` 与库中已有份数对账，只写「库里还没有的第 N 份」：

- 每轮写入量从 O(历史长度) 降到 O(本轮新增)
- 键方案切换时**不会把历史重插一遍**（台账与 id 方案无关，旧位置键写入的行同样被识别为已在库）
- 纯逻辑抽为 `planMessagePersist`（[src/store/messages.ts](src/store/messages.ts)），
  index 与单测共用同一实现

### Fixed — 单次钩子的工作预算

宿主对 `agent_end` 有 **30s per-handler 硬超时**，且超时**不取消**插件自有的网络 I/O
（openclaw 2026.9.6：`docs/plugins/hooks/reference.md`、`docs/plugins/hooks/prompt-and-session.md`）。
新增长会话下写不完会被截断，且可能与下一轮重叠。现设 20s 软预算主动收尾，未写完的条目由下一轮
重放补齐（稳定键保证重放安全）。

### Changed — 可观测性（排查「写入中断」不再是黑盒）

- `agent_end` 的两处静默 `return`（`driver`/`recaller` 未就绪、`sessionKey` 取不到）改为显式 warn，
  并区分「组件未就绪」与「写入逻辑失败」
- `persisted messages:` 日志去掉 `GM_DEBUG` 门控，并同时输出 `total` 与 `saved` ——
  `saved` 长期 ≪ `total` 之外仍持平即为「全量重放回归」的信号
- 收到空 `messages` 时提示核验宿主授权：非捆绑插件读会话内容需要
  `plugins.entries["graph-memory-pro"].hooks.allowConversationAccess: true`

### Added — 审计与去重工具

[scripts/gm-message-audit.ts](scripts/gm-message-audit.ts)（`npm run audit:messages`）：
只读量化重复行、`createdAt` 塌缩程度、id 方案分布；`--dedup --apply` 可清理完全重复行。
**刻意不做 id 迁移** —— `:GmMessage.id` 被持久化引用在磁盘队列（`{user, assistant, sessionKey?, id?|msgIds?}`，
由外部插件写入，本插件读 `msgIds` 回传 `markMessagesProcessed`），就地改写 id 会留下孤儿引用。

### Fixed — 清单 `contracts.tools` 同步

`contracts` 是工具归属（ownership）快照，2.4.5 新增的 `gm_embed_bench` 漏登记，现补齐。

### Changed — 版本对齐

`src/version.ts`、`package.json`、`openclaw.plugin.json`、`package-lock.json`、
[index.ts](index.ts) 头部版本注释、[README.md](README.md) 示例、
[test/version.test.ts](test/version.test.ts) 由 **2.4.5** 对齐至 **2.4.6**。

### 测试

[test/session-message-persist.test.ts](test/session-message-persist.test.ts) 由「镜像副本」改为
直接覆盖真实纯函数（原先把实现复制一份在测试里断言，真实实现改了也照样通过），
新增 compaction 位移、同内容重复、旧键台账对账、指纹碰撞等 13 个用例。

## [2.4.5] - 2026-09-29

**修复「:GmMessage 原文写端长期零新增」——插件在真实宿主中加载正常、召回与提取链路均可跑通，唯独消息原文从不落库。**

### Fixed — agent_end 写端被提前 return 跳过

`agent_end` 钩子中，`persistSessionMessages(...)` 原先排在
`getSessionRecallCache().consume(sessionKey)` + `if (!recallRecord) return` **之后**。
因此只有当本轮对话恰好触发过召回检索（召回缓存里有 nodeIds）时才会执行写库；
常规回合召回缓存为空，钩子在 consume 处提前 return，**写端永不执行**。

连带后果（均已观测到）：

- `:GmMessage` 长期零新增 —— 生产环境最新 `createdAt` 停滞在 2026-08-13 11:07:58；
- `extract-queue.jsonl` 长期 0 字节（不是积压，是根本未入队）；
- `markMessagesByContent` / `rebuildSessionMessages` 因 MATCH 不到消息而空转。

修复：把「messages 提取 + persistSessionMessages 调用」整块上移到 `sessionKey` 判空之后、
`consume()` 之前，使原文落库不再依赖本轮是否发生召回，与函数自身注释（明确要求放在召回缓存
判断之前）及 `MERGE` 幂等语义一致。`userQuery` / `assistantReply` 的提取因依赖 `messages`
一并上移，`assistantReply` 空判仍留在 `consume()` 之后不变。

### Changed — 版本对齐

`src/version.ts`、`package.json`、`openclaw.plugin.json`、`package-lock.json`、
[index.ts](index.ts) 头部版本注释、[README.md](README.md) 示例、
[test/version.test.ts](test/version.test.ts) 由 **2.4.4** 对齐至 **2.4.5**。

## [2.4.4] — 2026-09-26

本轮集中修复「插件在真实宿主中加载失败 / 永久降级」的三类问题：构建产物不自包含、同进程多模块实例资源竞争、清单假声明迁移义务。

### Fixed — 构建产物必须自包含（宿主捕获丢文件）

**现象**：宿主日志出现 `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../graph-memory-pro/dist/recall-NXFO5YHD.js' imported from '.../graph-memory-pro/dist/index.js'`，以及同类的 `http-server-S6HL4RCG.js`；表现为 `self-init: Recaller init failed` 与 `API server start failed`，报错点分散且与业务逻辑无关。

**根因**：宿主按「源目录捕获 + 惰性物化」加载插件——先把入口 `dist/index.js` 复制到 `plugin-captures/.../` 下，其余文件在该运行时真正 `import` 时才按需复制。tsup 默认开启代码分割，`dist/` 会产出 57 个内容哈希命名的兄弟 chunk（本次复现出的 chunk 名与线上报错**逐字一致**：`recall-NXFO5YHD.js` / `http-server-S6HL4RCG.js`，哈希相同即内容相同）。一旦 `clean` 与捕获竞争，入口里写死的 chunk 名在捕获目录中不存在，即触发上述错误。

**修复**：
- [tsup.config.ts](tsup.config.ts) 关闭代码分割（`splitting: false`）→ 产物为单文件 `dist/index.js`，入口不依赖任何兄弟 `.js`。本插件只有一个入口，原本也不存在跨入口去重的收益。
- 新增 [scripts/verify-dist-selfcontained.mjs](scripts/verify-dist-selfcontained.mjs) 与 `npm run verify:dist`，作为 CI / Release 的**阻断门禁**，断言三件事：入口存在；`dist/` 内 JS 产物有且仅有入口一个；入口内不存在相对模块引用。负向验证：把 `splitting` 改回 `true` 时该步骤 exit=1 并逐个列出 57 个兄弟 chunk。
- 新增 [scripts/publish-dist.mjs](scripts/publish-dist.mjs) 并接入 `npm run build`：非 watch 构建先完整落在 `dist.staging`，成功后再替换 `dist`（watch 模式仍直接写 `dist`，避免打断宿主热读）。

**已知边界**：POSIX 无法对非空目录做单次原子替换，替换仍是「两次 rename」，因此捕获空窗由秒级（含 dts 生成的构建期）收窄到微秒级，而非彻底消除；彻底消除需宿主侧原子物化。

### Fixed — 同进程多模块实例资源竞争（端口占用 / 端口漂移 / 心跳不收敛）

**现象**：同一 gateway 进程内 `module loaded` 出现 3 次、`register() called by Gateway` 出现 2 次、两套完整 self-init 序列；API server 由 7850 漂移到 7852 / 7853，MCP 由 7800 漂移到 7803；`MaxListenersExceededWarning: 11 exit listeners added to [process]`；`[graph-adapter] gm-pro getRecaller() returned null, falling back to self-built Recaller`；随后 `mcp-server` 探针每 30s 报 `unhealthy (N consecutive), recovering...` 并在 7800→7803 上反复 `EADDRINUSE`，**永不收敛**。

**根因**：宿主同进程加载本插件的两个模块实例（`~/.openclaw/extensions/graph-memory-pro/dist/index.js` 一份，被 lcm-graph-extra 按包名 import 的副本另一份）。ESM 模块缓存按 specifier 隔离，模块级 `let _x` 各持一份，因此 `_apiServerHandle` / `_mcpServerHandle` / `_apiServerAutoStarted` / `_heartbeatHandle` / 定时器等守卫全部失效。第二个实例抢 MCP 端口失败后 `_mcpServerHandle` 恒为 null，其心跳探针恒判不健康 → 每 30s 触发一次注定失败的重建。`getRecaller()` 返回模块级变量，另一个实例恒为 null，正是 [index.ts](index.ts) 注释预警的「双实例 / 关联矩阵 M 分叉」。

**修复**：
- 新增 [src/process-state.ts](src/process-state.ts)：以 `globalThis` + `Symbol.for` 建立**进程级共享状态**并实现 claim-or-reuse 所有权——**资源全局唯一，注册按实例各一份**：只有所有者实例创建资源（driver / LLM / Embedding / Recaller / server 句柄 / 定时器），其余实例复用并跳过创建；tools / hooks / services 是宿主 API，仍按宿主实际调用的实例各注册一次。
- [index.ts](index.ts) 的 server 句柄、后台定时器、心跳句柄统一经进程级状态读写；非所有者实例不再对共享资源发起重启。
- [src/server/heartbeat.ts](src/server/heartbeat.ts)：`recover()` 返回 ≠ 已恢复，故恢复后**立即复检**；未恢复则按 `base → 2× → 4× → … → 封顶 5min` 指数退避，恢复成功即清零。原先等间隔重试的抖动循环由此收敛。
- 顺带修复同类漏改点：`registerService("graph-memory-mcp")` 启动后的健康探测原先仍探配置端口（`cfg.mcp.port`），端口漂移后必然误报；改用 `handle.port`（心跳探针早已如此，此处漏改）。
- 设计易错点（写测试时发现）：实例身份必须在**模块作用域**求值。若把 `instanceId` 放进共享对象，第二个实例会读到第一个实例的 id，`coreOwnerId === instanceId` 对两者同时成立，两个都会自认为所有者，单例守卫形同虚设。

### Fixed — 清单假声明迁移义务（永久降级告警）

**现象**：每次启动均有
`[config] warnings: plugins.entries.graph-memory-pro: Plugin "graph-memory-pro" settings cannot be checked until its data/settings upgrade finishes.`
与
`[state-migrations] Plugin "graph-memory-pro" data/settings upgrade is unfinished ...`，且 `openclaw doctor --fix` 无法修复。

**根因**：[openclaw.plugin.json](openclaw.plugin.json) 声明了 `doctorContract.stateMigrations: true`，但本插件从未提供 doctor contract 实现。宿主据此把插件判为「有未完成的迁移义务」，而该标记一旦落库**只增不减**（宿主 `mergeDeferredPluginMigration` 保留 `requiresStateMigration`），且没有任何 CLI 能清除；唯一能覆盖它的是插件真的报告一次「迁移已完成」。

**修复**：
- 新增 [doctor-contract-api.js](doctor-contract-api.js)（**插件根目录**，非 `dist/`）：零 import 的 ESM，导出 `stateMigrations` 一条，`detectLegacyState()` 恒返回 `null`（= 无遗留状态可迁）、`migrateLegacyState()` 返回零变更。不读写任何文件、数据库或插件状态，属 fail-closed。
- [openclaw.plugin.json](openclaw.plugin.json) 改为数组声明 `doctorContract.stateMigrations: [{ id: "graph-memory-pro-plugin-state-v1" }]`（id 与产物逐字一致）。宿主校验要求 manifest 声明与产物导出逐项一致（id / doctorOnly / phase），故新增 [test/doctor-contract.test.ts](test/doctor-contract.test.ts) 守护该一致性。
- 放根目录而非 `dist/`：宿主的产物解析顺序为 `[filename, dist/filename]`、根目录优先，因此不进入 `dist/`，不破坏上面的单文件自包含不变式。
- [package.json](package.json) `files` 加入 `doctor-contract-api.js`，否则 npm 发布时被丢弃。

**为何「数组声明 + 产物」是唯一可结清的组合**（四种组合均在宿主分类代码上核对）：`stateMigrations: true` → 永不完成的义务；只删声明不建产物 → 分类为 stateless，但仍被已落库的 sticky 标记一票否决；只建产物不声明 → 被判 `requiresDoctorInspection` 显式拒绝；声明空数组 + 产物 → 同上。只有「非空数组声明 + 可加载产物 + 无迁移计划」能进入宿主的 `completedPluginIds`，从而覆盖 sticky 标记并把记录翻为 completed。

### Fixed — 插件 SDK 契约合规

- **放弃类型契约**：[index.ts](index.ts) `register(api: any)` → `register(api: OpenClawPluginApi)`，恢复编译期检查（本次即暴露并修正了 5 处 API 误用）。
- **typed hook 从未触发**：`api.registerHook` 对 `PluginHookName`（`agent_end` / `after_tool_call` / `llm_output`）不会被调用，改用 `api.on` 并修正 handler 签名。此为「学习曲线长期恒空」的根因——hook 从未触发。
- **`supplement.get` 语义**：未找到时原返回带 `status: "not_found"` 的对象，与宿主 `if (!result) return null` 的判定不符，现改为直接返回 `null`。
- **注释与实现不符**：文件头「HTTP 路由通过 api.registerHttpRoute 注册」与实际自建 `http.createServer`（默认 127.0.0.1:7850）不符，已按实现修正注释。

### Changed — 版本元数据统一

`src/version.ts`（2.4.2 → 2.4.4）、[package.json](package.json)、[openclaw.plugin.json](openclaw.plugin.json)（2.4.3 → 2.4.4）三处版本对齐；`openclaw.build.openclawVersion` / `pluginSdkVersion` 由 2026.8.1 更新为实跑版本 **2026.9.6**；`peerDependencies.openclaw` 保持 `>=2026.8.1`。[test/version.test.ts](test/version.test.ts) 与 [README.md](README.md) 同步。

### Added — 测试

- 新增 [test/process-state.test.ts](test/process-state.test.ts) 7 用例：以 `vi.resetModules()` + 二次动态 import 制造**两个真实模块实例**，覆盖「共享同一状态对象」「实例身份互不相同」「只有首个可认领、其余一律 reuse」「所有者失败后可重新认领」「`waitForCoreInit` 的 ready / failed / 有界超时」「`releaseServerHandle` 并发只关闭一次」。
- [test/heartbeat.test.ts](test/heartbeat.test.ts) 新增 2 用例：恢复后仍不健康时的指数退避；恢复成功后退避清零（fake timers 断言具体间隔）。
- 新增 [test/doctor-contract.test.ts](test/doctor-contract.test.ts) 6 用例：产物形状符合宿主判定 / manifest 与产物逐项一致 / `detectLegacyState` 返回 null / `migrateLegacyState` 零变更 / 产物零 import / 已列入 `files`。
- 总测试数 697 → **712**。

### Configuration Migration — 配置迁移（v2.4.0 → v2.4.4）

无破坏性变更，现有 `plugins.entries.graph-memory-pro` 配置无需任何改动。

**部署注意**：
- `doctor-contract-api.js` 需存在于插件根目录（npm 安装会自动包含；若手工只同步 `dist/` 需补齐），否则宿主会拒绝该轮插件迁移执行。
- CI / Release 新增 `npm run verify:dist` 阻断步骤：构建产物不再允许代码分割或相对模块引用。
- 升级后首次启动建议跑一次 `openclaw doctor --fix`，以结清历史遗留的迁移义务记录。

## [2.4.0] — 2026-08-12

### Added — 检索质量与输出增强（6 项能力）

针对 benchmark 暴露的检索质量 / 长文本匹配 / 输出篡改问题，新增 `recall` 配置段统一控制（[src/types.ts](src/types.ts) `GmConfig.recall`）。

**点1 — 向量缓存 / 分页（减少全图遍历）**
- 复用 I-1 [query-cache.ts](src/recaller/query-cache.ts)（LRU + cosine 相似命中短路 + `similarityScanLimit` 限制扫描量），避免重复嵌入与全图遍历，无需新增配置。

**点2 — 记忆切片长度配置化**
- 新增 [src/recaller/chunk.ts](src/recaller/chunk.ts) `buildEmbedTexts`，嵌入文本切片长度由 `recall.memorySliceChars`（默认 800）控制，替换旧版硬编码 500，避免长描述/内容尾部关键上下文被切断。仅作用于嵌入文本构造，不改变节点 content 存储。

**点3 — 标准格式化输出**
- 新增 [src/format/assemble.ts](src/format/assemble.ts) `buildOutputGuidance`，并接入 `buildSystemPromptAddition` 的 `outputFormat` 参数，为系统提示注入「简洁 / 贴近原文 / 减少自由篡改」policy（`recall.outputFormat`，默认开启，`enabled=false` 可关）。

**点4 — 时序权重 + 关联矩阵 M**
- 新增 [src/recaller/rerank.ts](src/recaller/rerank.ts) `temporalRecency`（基于 validTo/updatedAt/state 新鲜度，指数衰减）+ `combineScore`（融合向量相似度 / 重要性 / 过时惩罚 / 时序新鲜度）。
- [src/recaller/recall.ts](src/recaller/recall.ts) `mergeResults` 与多阶段检索均接入 `recall.temporalWeight`（默认 0.3），与关联矩阵 M 的关联分共同加权，避免过期（validTo 过去 / superseded）或冲突（transitional）节点被错误排前。

**点5 — 多阶段检索**
- [src/recaller/recall.ts](src/recaller/recall.ts) 新增 `recallMultiStage`：Stage 1 先 FTS 种子 → `graphWalk` 图邻域筛选候选节点；Stage 2 在候选集内做向量相似度排序（支持分块向量）+ 综合重排。由 `recall.multiStage` 开启，减少全局向量搜索带来的无关节点干扰。

**点6 — 长文本分段嵌入**
- 新增 [src/store/embed-helper.ts](src/store/embed-helper.ts) `embedNode` 统一处理记忆切片与分段嵌入；超长文本按 `recall.chunking.chunkSize`（含 `chunkOverlap` 重叠）切分逐段 embed，分块向量存 `chunkEmbeddings` / `chunkTexts`（[src/store/vector.ts](src/store/vector.ts) `saveChunkVectors`），主向量仍写 `embedding` 供向量索引。由 `recall.chunking.enabled` 开启，提升长文本局部匹配能力。

### Changed — 工程

- [src/timing.ts](src/timing.ts) `TimingPhase` 新增 `multi_stage_fts` / `multi_stage_graph_filter` / `recall_multi_stage` 三个阶段。
- [src/store/schema.ts](src/store/schema.ts) `recordToNode` 反序列化 `chunkTexts` / `chunkEmbeddings`。
- [config.example.json](config.example.json) / [config.presets/](config.presets/)（minimal/balanced/full）/ [openclaw.plugin.json](openclaw.plugin.json) `configSchema` 新增 `recall` 段（full 开启 chunking + multiStage，balanced/minimal 关闭）。

### Added — 测试

- 新增 [test/chunk-rerank.test.ts](test/chunk-rerank.test.ts) 19 用例（chunkText 分段 / buildEmbedTexts / temporalRecency / combineScore / computeChunkSimilarities / cosineSimilarity）
- 新增 [test/format-assemble.test.ts](test/format-assemble.test.ts) 3 用例（output policy 默认注入 / enabled=false 关闭 / 仅 faithful）
- 总测试数 506 → **544**

### Configuration Migration — 配置迁移（v2.3.5 → v2.4.0）

无破坏性变更，现有 v2.3.5 配置无需任何改动。

**新增可选配置**（`recall` 段，全部默认关闭或内置默认值）：
- `recall.memorySliceChars`（默认 800）：嵌入文本记忆切片长度
- `recall.chunking.enabled`（默认 false）/ `chunkSize`（400）/ `chunkOverlap`（40）：长文本分段嵌入
- `recall.multiStage`（默认 false）：多阶段检索
- `recall.temporalWeight`（默认 0.3）：时序权重
- `recall.outputFormat.enabled`（默认 true）/ `concise`（true）/ `faithful`（true）：标准格式化输出

## [2.3.5] — 2026-07-10

### Changed — 冷启动死循环破除（B1）

针对 `gm_feedback` 为手动工具导致反馈长期不达标、Judge / M 矩阵永久冷启动的问题，降低阈值并新增自动反馈采集，让系统在正常使用中即可退出冷启动。

- **冷启动阈值降低**：[src/recaller/judge.ts](src/recaller/judge.ts) `judgeWarmupFeedbacks` 50→20；[index.ts](index.ts) / [openclaw.plugin.json](openclaw.plugin.json) / [config.example.json](config.example.json) / [config.presets/](config.presets/) 中 `warmupFeedbacks` / `autoTuner.warmupFeedbacks` 100→40。旧值在纯手动 `gm_feedback` 下几乎不可达，配合 agent_end 自动反馈后 20/40 即可快速达标。
- **autoFeedback 自动反馈采集**：[config.example.json](config.example.json) / 预设文件新增 `autoFeedback` 段（默认启用），通过 `agent_end` hook 基于 Tier 1 启发式自动判定并落库反馈，破除"必须手动 gm_feedback"的死循环。
- **冗余配置清理**：移除 `warmup.judgeWarmupFeedbacks`（与 `judge.judgeWarmupFeedbacks` 重复且未使用），schema / 示例 / 预设三处对齐。
- **tier=2 预设参考**：[config.presets/full.json](config.presets/full.json) 设置 `judge.tier=2`，作为启用 LLM 裁判的参考配置（热启动后生效）。

### Fixed — LLM 判定鲁棒性（B2）

- **LLM 超时不取消底层请求**：[src/utils.ts](src/utils.ts) 新增 `withTimeoutSignal`（透传 AbortSignal）+ `combineSignals`（合并外部超时与内部 30s 安全超时）；[src/engine/llm.ts](src/engine/llm.ts) `CompleteFn` 新增可选 `signal` 参数并在 fetch / runtime LLM 调用中透传；[src/recaller/judge.ts](src/recaller/judge.ts) Tier 2 改用 `withTimeoutSignal`。超时后底层 fetch 被 abort，避免 orphan request 继续占用 LLM 配额与信号量槽位；外部 signal 已 abort 时不再无谓重试。
- **LLM JSON 解析鲁棒性**：[src/recaller/judge.ts](src/recaller/judge.ts) 新增 `parseLlmJudgeJson`，按"直接解析 → 去 markdown 围栏 → 提取首个 `{...}` 对象"三级回退，兼容 ```json 围栏、纯 ``` 围栏、JSON 前后含解释性文本等 LLM 输出格式。
- **节点截断静默**：Tier 2 节点数超 `llmJudgeMaxNodes` 时新增 warn 日志（总数 / 上限 / 溢出数），不再静默截断。
- **超时错误语义不清**：`withTimeout` / `withTimeoutSignal` 均传 `label`，错误信息明确（如 "Tier 2 LLM judge timed out after 8000ms"）。

### Fixed — LLM Token 用量端点与按用途统计（B3）

针对 dashboard 查询 LLM token 用量为空、`/api/usage` 端点在旧部署中返回 404 的问题，核实并修复实现与设计意图的偏差。

- **端点核实**：`/api/usage` 端点自 v2.3.0 起即存在于 [src/routes/crud.ts](src/routes/crud.ts) 路由表（含 `handleUsage`）与 [src/server/http-server.ts](src/server/http-server.ts) 鉴权白名单。dashboard 返回 404 的根因是部署运行的构建产物早于 v2.3.0（版本号停留在 2.3.3 未与 changelog 同步）。本次随版本统一到 2.3.5 并重新构建 `dist/` 修复。
- **purpose 硬编码 "unknown"**：[src/engine/llm.ts](src/engine/llm.ts) 两处 `recordUsage` 调用（config-llm / runtime 路径）原硬编码 `purpose: "unknown"`，注释声称"由上层调用方通过包装注入"但从未实现该包装，导致 `/api/usage` 的 `byPurpose` 维度始终只有 `unknown` 桶，dashboard 按用途分组视图无数据。现 `CompleteFn` 新增可选 `purpose` 参数（第 4 位，向后兼容默认 "unknown"），引擎层透传至 `recordUsage`。
- **调用点透传 purpose**：[src/extractor/extract.ts](src/extractor/extract.ts)（extract）、[src/recaller/judge.ts](src/recaller/judge.ts)（judge）、[src/graph/community.ts](src/graph/community.ts)（community）、[src/evolution/auto-tuner.ts](src/evolution/auto-tuner.ts)（diagnose）均传入真实用途；benchmark 路径经 extractor 故记为 extract。
- **文档补全**：[README.md](README.md) HTTP API 表补充 `/api/usage`、`/api/doctor`、`/api/config` 行，新增"LLM Token 用量"小节说明返回结构与 `byPurpose` 分组语义，Prometheus 指标列表补全 4 个 LLM 用量指标。

### Changed — 版本号统一（B3）

`version.ts` / `package.json` / `openclaw.plugin.json` / `package-lock.json` 由 **2.3.3 → 2.3.5**，与 CHANGELOG 记录的 v2.3.4（架构优化）/ v2.3.5（冷启动 + LLM 鲁棒性 + 用量修复）已落地代码对齐。旧部署因版本号滞后导致 `dist/` 未含 v2.3.0 起新增的 `/api/usage` 路由。

### Fixed — 配置 Schema 一致性（B4）

交叉比对 [openclaw.plugin.json](openclaw.plugin.json) 配置 schema ↔ [src/types.ts](src/types.ts) `GmConfig` 接口 ↔ [config.example.json](config.example.json) + 3 档预设，发现并修复 10 处不一致：

- **Schema 缺失项**（配置可用但 schema 未声明，Gateway UI 无法展示）：
  - `autoFeedback` — types.ts / example / 预设均有定义，[openclaw.plugin.json](openclaw.plugin.json) 与 [index.ts](index.ts) TypeBox schema 均未声明。现已补全（enabled / trackGetExpansion / maxRecallRecordsPerSession）。
  - `llm.maxConcurrency` — types.ts 定义，embed.ts 代码引用，但 schema 缺失。现已补全（默认 1）。
  - `embedding.cacheSize` / `embedding.cacheTtlMs` — types.ts 定义，embed.ts 代码引用，但 schema 缺失。现已补全（默认 256 / 600000ms）。
  - `embedding.options` — types.ts 定义，embed.ts 透传至 Ollama /api/embed，但 schema 缺失。现已补全（`additionalProperties: true` 透传对象）。
- **types.ts 残留字段**：`warmup.judgeWarmupFeedbacks` 已在 B1 中迁移到 `judge` 段并从 schema / 示例中移除，但 types.ts 仍保留该字段，现已清理。
- **示例/预设缺失项**（schema 已声明但示例未展示，用户无从知晓可用参数）：
  - `apiServer` — schema 已定义但 config.example.json 与 3 档预设均未包含。现已补全（example/balanced/full 启用，minimal 关闭）。
  - `neo4j.maxConnectionPoolSize` / `neo4j.connectionAcquisitionTimeout` — schema 已定义但 example 与预设均未包含。现已补全（默认 50 / 10000）。
  - `timing.maxSamples` — schema 与 example 已定义但 balanced/full 预设缺失。现已补全（默认 1000）。

### Added — 集成测试

- **TEST-1 smoke test 骨架**：新增 [test/smoke.test.ts](test/smoke.test.ts) + [docker-compose.smoke.yml](docker-compose.smoke.yml) + [vitest.smoke.config.ts](vitest.smoke.config.ts)，连接真实 Neo4j 验证 schema/写入/读取/向量索引/连接池计数。Neo4j 不可用时自动 skip，不影响主测试套件。通过 `npm run test:smoke` 运行。

### Added — 测试

- 新增 `withTimeoutSignal` / `combineSignals` 单元测试 10 用例（正常完成 / signal 透传 / 超时 abort / 多信号联动 / 监听器清理）
- 新增 `parseLlmJudgeJson` 单元测试 8 用例（纯 JSON / ```json 围栏 / 纯 ``` 围栏 / 前后文本 / 空输入 / 非 JSON）
- 新增 judge Tier 2 signal 透传 + 超时 fallback 测试 2 用例
- version.test 同步断言 2.3.5
- 总测试数 486 → **506**

### Configuration Migration — 配置迁移（v2.3.4 → v2.3.5）

无破坏性变更，现有 v2.3.4 配置无需任何改动。

**默认值变更**（仅影响未显式配置该项的部署）：
- `judge.judgeWarmupFeedbacks` 默认 50→20
- `warmup.warmupFeedbacks` / `associationMatrix.warmupFeedbacks` / `autoTuner.warmupFeedbacks` 默认 100→40

**新增可选配置**：
- `autoFeedback.enabled`（默认 true）：agent_end 自动反馈采集，无需手动调用 `gm_feedback` 即可退出冷启动。如需保持纯手动反馈，设为 `false`。

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
