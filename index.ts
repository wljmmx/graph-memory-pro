/**
 * graph-memory-pro — Neo4j Knowledge Graph Memory Plugin
 *
 * Version: 2.4.7
 *
 * 架构定位（A 方案）:
 *   - 不占用 slots（memory/contextEngine）
 *   - 不再使用 before_prompt_build 钩子（避免与 contextEngine 双注入）
 *   - 通过 registerMemoryCorpusSupplement 把图谱暴露给 memory-core 的 memory_search
 *   - 三元组提取 / 图谱维护通过 registerService 后台运行，不阻塞主流程
 *   - HTTP API 由内置 http server 自建（默认 127.0.0.1:7850），未走 registerHttpRoute
 *   - 保留专业工具：gm_record / gm_maintain / gm_reembed（gm_search/gm_stats 已合并）
 *
 * Latest OpenClaw Plugin SDK compliance:
 * - definePluginEntry from openclaw/plugin-sdk/plugin-entry
 * - api.config/api.pluginConfig 用于配置加载（不读文件系统）
 * - api.logger 用于结构化日志
 * - api.registerTool / registerService / registerMemoryCorpusSupplement
 */

import { definePluginEntry, buildJsonPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { Driver } from "neo4j-driver";
import type { GmConfig, GmNode, GmEdge, EdgeType, NodeType } from "./src/types.ts";
import type { CompleteFn } from "./src/engine/llm.ts";
import type { EmbedFn, BatchEmbedFn } from "./src/engine/embed.ts";
import { createCompleteFn, createRuntimeCompleteFn, type AgentModelContext } from "./src/engine/llm.ts";
import { createEmbedFn, createBatchEmbedFn } from "./src/engine/embed.ts";
import { initDriver, closeDriver, verifyWithRetry, verifyConnectivity, getDriver, setDriver as setDbDriver } from "./src/store/db.ts";
// v2.8.x: 消息取文本/过滤/稳定键的纯逻辑统一放在 store 层，index 与单测共用同一实现
import { extractMessageText, type AgentMessageLike } from "./src/store/messages.ts";
import { ensureSchema, getNodeCount, getEdgeCount, searchNodes, upsertNode, upsertEdge, findById, getNodesByTimeRange as getNodesByTimeRangeInternal } from "./src/store/store.ts";
import { Extractor } from "./src/extractor/extract.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { runMaintenance } from "./src/graph/maintenance.ts";
import { resolveBenchmarkDataDir } from "./src/benchmark/dataDir.ts";
import { setExternalLogger, createLogger } from "./src/logger.ts";
import { setTimingEnabled } from "./src/timing.ts";
import { extractInBackground, extractInterimTexts, writeExtractResult } from "./src/services/extract-service.ts";  // v2.3.4 ARCH-1: 从 index.ts 拆出 // v2.5.4: 中间 assistant 文本提取
import { getSessionRecallCache, resetSessionRecallCache } from "./src/recaller/session-recall-cache.ts";
import type { TuneCycleResult } from "./src/evolution/auto-tuner.ts";
import { startHeartbeat, type HeartbeatHandle, type HeartbeatProbe } from "./src/server/heartbeat.ts";  // v2.5.x 心跳自愈
import { embedNode } from "./src/store/embed-helper.ts";
import { runIncrementalMaintenance } from "./src/graph/incremental-maintenance.ts";
import type { IncrementalMaintenanceResult } from "./src/graph/incremental-maintenance.ts";
import type { JudgeResult } from "./src/recaller/judge.ts";
// v2.8.x: 进程级共享状态——消除同进程多模块实例的资源竞争（双绑定/端口漂移/心跳不收敛）
import {
  getProcessState,
  getInstanceId,
  claimCoreInit,
  beginCoreInit,
  settleCoreInit,
  waitForCoreInit,
  publishSharedState,
  releaseServerHandle,
} from "./src/process-state.ts";

const log = createLogger("index");

/**
 * 进程级共享状态。
 *
 * 宿主可在同一进程内加载本插件的多个模块实例（extensions 目录一份 + 被
 * lcm-graph-extra 按包名 import 的一份）。模块级 `let _x` 按实例各持一份，
 * 因此**资源**（driver / recaller / server 句柄 / 定时器）一律经此共享；
 * **注册**（tools / hooks / services）仍按宿主实际调用的实例各注册一次。
 */
const _ps = getProcessState();

// ─── 类型定义（SDK 不导出类型，此处定义最小化接口） ──────

interface LoggerLike {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

// v2.8.x: AgentMessageLike / AgentMessageContentBlock / extractMessageText 已迁至
// ./src/store/messages.ts（纯逻辑集中一处，单测直接覆盖真实实现，不再是镜像副本）。

// v2.5.4: 触发 after_tool_call 即时反馈的 memory 相关工具名。
// 这些工具调用后可能产生 get()/search() 展开信号，需即时更新 M。
const MEMORY_TOOL_NAMES = new Set([
  "memory_search",
  "gm_search",
  "gm_recall",
  "gm_stats",
  "gm_record",
  "recall_memory",
  "corpus_search",
]);

// v2.5.4: 中间轮 assistant 文本提取
//   INTERIM_MIN_LEN: 短于该长度的 assistant 文本（如"让我搜索一下"）无提取价值，直接跳过
//   INTERIM_MAX_LEN: 单条文本截断长度，避免超大文本灌入 LLM
//   INTERIM_SEEN_LIMIT: 内存去重集合上限（防内存无限增长）
//   INTERIM_TURNS_DEFAULT: 默认轮数阈值（v2.5.4: 5→15，本地 LLM 一般只能 1-2 轮对话，拉长节流避免后台 LLM 过载）
const INTERIM_MIN_LEN = 40;
const INTERIM_MAX_LEN = 4000;
const INTERIM_SEEN_LIMIT = 4000;
const INTERIM_TURNS_DEFAULT = 15;
// v2.5.4: 默认后台提取间隔从 5 分钟拉长到 20 分钟（本地 LLM 吞吐有限，避免后台 LLM 调用抢占主会话资源）
const EXTRACTOR_INTERVAL_DEFAULT = 20 * 60 * 1000; // 20min
// 内容 hash 去重集合（进程内，防同一段中间文本被反复提取入库）
const _interimSeen = new Set<string>();
// v2.5.4: 轮数节流缓冲 —— llm_output 累积最近若干轮的文本，满 N 轮才入队
let _interimTurnBuf: string[] = [];
let _interimTurnCount = 0;

// v2.5.4: 最近一次会话标识缓存（兜底用）。
//   after_tool_call / llm_output 钩子的 event 和 rawCtx 不一定携带 sessionKey，
//   但 corpusSupplement.search/get 调用时会通过 agentSessionKey 记录到 SessionRecallCache。
//   此变量在 search/get 被调用时更新，作为钩子中 sessionKey 缺失时的降级来源。
let _lastSessionKey: string | undefined = undefined;

/**
 * 读取中间轮 assistant 文本提取的轮数节流阈值
 * 优先使用 cfg.background.interimTurnsThreshold，回退到 INTERIM_TURNS_DEFAULT
 */
function getInterimTurnsThreshold(): number {
  const configured = _cfg?.background?.interimTurnsThreshold;
  if (typeof configured === "number" && configured >= 1 && configured <= 100) {
    return Math.round(configured);
  }
  return INTERIM_TURNS_DEFAULT;
}

/**
 * 读取 maintenance 首次启动延迟 ms（默认 30 分钟，避免启动时 compaction/community summary 抢 LLM）
 * 安全范围：[1min, 24h]
 */
const MAINTENANCE_INITIAL_DELAY_DEFAULT = 30 * 60 * 1000; // 30min
function getMaintenanceInitialDelayMs(): number {
  const configured = _cfg?.background?.maintenanceInitialDelayMs;
  const MIN = 60 * 1000;
  const MAX = 24 * 60 * 60 * 1000;
  if (typeof configured === "number" && configured >= MIN && configured <= MAX) {
    return configured;
  }
  return MAINTENANCE_INITIAL_DELAY_DEFAULT;
}

/**
 * 读取后台提取间隔 ms
 * 优先使用 cfg.background.extractorIntervalMs，回退到 EXTRACTOR_INTERVAL_DEFAULT
 * 安全范围：[1min, 24h]
 */
function getExtractorIntervalMs(): number {
  const configured = _cfg?.background?.extractorIntervalMs;
  const MIN = 60 * 1000;          // 1min
  const MAX = 24 * 60 * 60 * 1000; // 24h
  if (typeof configured === "number" && configured >= MIN && configured <= MAX) {
    return configured;
  }
  return EXTRACTOR_INTERVAL_DEFAULT;
}

/**
 * v2.8.x: 读取后台提取单 tick 消费上限（对话对）。
 * 优先使用 cfg.background.extractorMaxPairs，回退默认 8；
 * 安全范围 [1, 50]——本地 LLM 慢/熔断时可调低，堆积积压时调高。
 */
function getExtractorMaxPairs(): number {
  const configured = _cfg?.background?.extractorMaxPairs;
  if (typeof configured === "number" && configured >= 1 && configured <= 50) {
    return Math.round(configured);
  }
  return 8;
}

let _driver: Driver | null = null;
let _cfg: GmConfig | null = null;
let _llm: CompleteFn | null = null;
let _embed: EmbedFn | null = null;
// v2.4.0: 批量嵌入（正式流程全量重嵌入/模型迁移时一次请求携带多个文本，缓解 Ollama 503）
let _batchEmbed: BatchEmbedFn | null = null;
let _extractor: Extractor | null = null;
let _recaller: Recaller | null = null;
let _extractorTimer: ReturnType<typeof setInterval> | null = null;
let _maintenanceTimer: ReturnType<typeof setInterval> | null = null;
// v2.3.2 S3: 后台 timer 重入保护 — 防止单次执行超过 interval 时下一次 tick 重叠执行
let _extractorRunning = false;
let _maintenanceRunning = false;
let _mcpServerHandle: { port: number; close(): Promise<void> } | null = null;
let _apiServerHandle: { port: number; close(): Promise<void> } | null = null;
let _apiServerAutoStarted = false;
// 跟踪 API 服务器当前使用的 driver 实例
// 当 gateway_start 替换了自建 driver 时，需要重启 API 服务器
let _apiServerDriver: Driver | null = null;
// v2.5.x: 心跳自愈服务句柄（探测 API/MCP/driver，崩溃后自动重建）
let _heartbeatHandle: HeartbeatHandle | null = null;

// ─── 进程级资源共享访问器 ──────────────────────────────
//
// 下列函数把「句柄/定时器」的读写统一到进程级状态（_ps）。必要性：
//   - 非所有者实例自身未启动 server，其模块级 `_apiServerHandle/_mcpServerHandle`
//     恒为 null。若探针读模块变量，就会把「别人启动的服务」误判为不健康，
//     进而每 30s 触发一次注定 EADDRINUSE 的重建 → 永不收敛的死循环。
//   - 定时器同理：非所有者实例读到模块变量为 null 会再起一套 setInterval。

/** 取进程级 API server 句柄（任一实例均可观察到所有者的句柄） */
function currentApiHandle(): { port: number; close(): Promise<void> } | null {
  return _ps.apiServerHandle ?? _apiServerHandle;
}

/** 取进程级 MCP server 句柄（任一实例均可观察到所有者的句柄） */
function currentMcpHandle(): { port: number; close(): Promise<void> } | null {
  return _ps.mcpServerHandle ?? _mcpServerHandle;
}

/**
 * 非所有者实例：把所有者发布的核心资源引用搬进本实例，使本实例的
 * tools / hooks / registerMemoryCorpusSupplement 也能工作。
 *
 * 只读取不写入 —— 非所有者绝不能覆盖所有者已发布的引用。
 */
function adoptSharedState(): void {
  _driver = _ps.driver;
  _cfg = _ps.cfg;
  _llm = _ps.llm;
  _embed = _ps.embed;
  _batchEmbed = _ps.batchEmbed;
  _recaller = _ps.recaller;
  _extractor = _ps.extractor;
  _apiServerHandle = _ps.apiServerHandle;
  _mcpServerHandle = _ps.mcpServerHandle;
  _apiServerAutoStarted = _ps.apiServerAutoStarted;
}

/** 所有者实例：把本实例持有的核心资源引用发布到进程级状态供其他实例复用 */
function publishCoreResources(): void {
  publishSharedState({
    driver: _driver,
    cfg: _cfg,
    llm: _llm,
    embed: _embed,
    batchEmbed: _batchEmbed,
    recaller: _recaller,
    extractor: _extractor,
    apiServerHandle: _apiServerHandle,
    mcpServerHandle: _mcpServerHandle,
    apiServerAutoStarted: _apiServerAutoStarted,
  });
}

// ─── 辅助函数 ──────────────────────────────────────────

import { EMBEDDING_PRESETS } from "./src/types.ts";

function resolveEmbedDimension(cfg: GmConfig): number {
  // 1. 用户显式指定的维度
  if (cfg?.embedding?.dimensions && typeof cfg.embedding.dimensions === 'number') {
    return cfg.embedding.dimensions;
  }
  // 2. 按模型名匹配预设
  if (cfg?.embedding?.model) {
    const model = cfg.embedding.model;
    const modelKey = Object.keys(EMBEDDING_PRESETS).find(k => model.includes(k) || k.includes(model));
    if (modelKey && EMBEDDING_PRESETS[modelKey].dimensions) {
      return EMBEDDING_PRESETS[modelKey].dimensions;
    }
  }
  // 3. 回退 1024
  return 1024;
}

/**
 * v2.8.x: 「每条件只告警一次」。
 *
 * 用于可能被高频调用的钩子（after_tool_call / llm_output）的**配置态**早退分支：
 * 既让「某条链路从未生效」在日志上可见，又不至于逐次调用刷屏。
 */
const _warnedOnce = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (_warnedOnce.has(key)) return;
  _warnedOnce.add(key);
  log.warn(message);
}

/**
 * v2.3.5: 从 agent_end 事件的 messages[] 提取最后一轮 user query + assistant reply
 *
 * AgentMessage 结构因 SDK 版本而异（content 可能是 string / array of content blocks），
 * 这里做防御性宽松解析，覆盖以下常见形态：
 *   - { role: "user", content: "..." }
 *   - { role: "user", content: [{ type: "text", text: "..." }] }
 *   - { role: "assistant", content: "..." }
 *   - { role: "assistant", content: [{ type: "text", text: "..." }, { type: "tool_use", ... }] }
 *
 * 仅提取最后一条 user 和最后一条 assistant 消息的文本。
 */
function extractLastTurn(messages: AgentMessageLike[]): { userQuery: string; assistantReply: string } {
  let userQuery = "";
  let assistantReply = "";

  // 从后往前找最后一条 assistant 和 user 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const role = msg.role ?? msg.type ?? "";
    const text = extractMessageText(msg);
    if (!text) continue;

    if (!assistantReply && /assistant/i.test(role)) {
      assistantReply = text;
    } else if (!userQuery && /user|human/i.test(role)) {
      userQuery = text;
    }
    if (userQuery && assistantReply) break;
  }

  return { userQuery, assistantReply };
}

/**
 * v2.8.x: 把整轮 messages[] 中的 user/assistant 消息落库到 Neo4j :GmMessage。
 *
 * 背景：saveMessage 此前只有定义、无任何运行时调用点，导致 :GmMessage 自
 * 引导导入后再无新增，markMessagesByContent 退化为空操作（MATCH 匹配不到）。
 * 本函数补上写端，由 agent_end 钩子调用，为增量重建 / 内容标记提供原文落地。
 *
 * v2.8.x 修正（三处）：
 *   1. **稳定键**：id 不再含 `turnIndex` 位置分量（宿主 compaction 会改写历史数组，
 *      位置位移会让同一消息换 id → 重复行）。改为 sessionKey + role + 全文指纹 + seq。
 *   2. **增量**：先按 (role, 内容指纹) 与库中已有份数对账，只写「库里还没有的第 N 份」——
 *      既不会在键方案切换时把历史重插一遍，也把每轮写入量从 O(历史长度) 降到 O(新增)。
 *   3. **工作预算**：宿主对 `agent_end` 有 30s 硬超时且不会取消插件自有 I/O，
 *      故设软预算主动收尾；未写完的下一轮重放会补齐（稳定键保证重放安全）。
 *
 * 幂等：同输入重放算出同一 id，MERGE 命中已有节点；`createdAt` 只在新建时写。
 * 降级：任何异常只 warn，不阻塞会话（与 autoFeedback 风格一致）。
 */
async function persistSessionMessages(
  driver: Driver,
  sessionKey: string,
  messages: AgentMessageLike[],
): Promise<number> {
  let saved = 0;
  try {
    const { saveMessage, planMessagePersist } = await import("./src/store/messages.ts");

    // 会话级对账基线（进程内缓存；首次触达该会话时查一次库）
    const baseline = await getPersistBaseline(driver, sessionKey);

    // 过滤 + 稳定键 + 对账全部走纯函数 planMessagePersist（与单测同一实现）
    const plan = planMessagePersist(messages, sessionKey, baseline.byGroup, baseline.truncated);

    const deadline = Date.now() + PERSIST_BUDGET_MS;
    let deferred = 0;

    for (const item of plan) {
      if (item.alreadyPresent) continue; // 已在库（含旧位置键写入的历史）→ 不重插
      if (Date.now() > deadline) {
        deferred++;
        continue;
      }
      try {
        await saveMessage(driver, {
          id: item.id,
          sessionKey,
          turnIndex: item.turnIndex,
          role: item.role,
          content: item.content,
          createdAt: Date.now(),
        });
        // 记入基线，避免同轮后续同名份数重复写（group 由 planner 给出，无需在此重算指纹）
        baseline.byGroup.set(item.group, (baseline.byGroup.get(item.group) ?? 0) + 1);
        saved++;
      } catch (err) {
        log.warn("saveMessage failed (id=" + item.id + "): " + ((err as Error)?.message ?? err));
      }
    }

    if (deferred > 0) {
      log.warn(
        `persistSessionMessages: 超过 ${PERSIST_BUDGET_MS}ms 工作预算，${deferred} 条留待下一轮补齐（session=${sessionKey}）`,
      );
    }
  } catch (err) {
    log.warn("persistSessionMessages failed: " + ((err as Error)?.message ?? err));
  }
  return saved;
}

/**
 * v2.8.x: 会话级写入对账基线（进程内缓存）。
 *
 * 首次触达某会话时查一次 (role, 内容指纹) 分组计数，之后复用并随写入自增。
 * 超出 PERSIST_BASELINE_MAX_SESSIONS 后按最旧淘汰；被淘汰的会话下次触达会重查一次，
 * 正确性不受影响（仅多一次查询）。
 */
const PERSIST_BASELINE_MAX_SESSIONS = 100;

/**
 * v2.8.x: 单次 agent_end 写入的**软预算**。
 *
 * 宿主对 agent_end 有 30s per-handler 硬超时，且超时**不会**取消插件自有的网络 I/O
 * （见 openclaw 2026.9.6：docs/plugins/hooks/reference.md、hooks/prompt-and-session.md）。
 * 因此设一个明显小于 30s 的软预算主动收尾，避免「钩子已判超时而写还在跑」的重叠。
 * 未写完的条目在下一轮 agent_end 由稳定键重放补齐，故提前收尾是安全的。
 */
const PERSIST_BUDGET_MS = 20_000;

const _persistBaselines = new Map<string, { byGroup: Map<string, number>; truncated: boolean }>();

async function getPersistBaseline(
  driver: Driver,
  sessionKey: string,
): Promise<{ byGroup: Map<string, number>; truncated: boolean }> {
  const cached = _persistBaselines.get(sessionKey);
  if (cached) return cached;
  let baseline: { byGroup: Map<string, number>; truncated: boolean };
  try {
    const { getSessionMessageGroupCounts } = await import("./src/store/messages.ts");
    baseline = await getSessionMessageGroupCounts(driver, sessionKey);
  } catch (err) {
    // 查询失败 → 退化为「不跳过」，只保证幂等（稳定键 + createdAt 只建不改，重放无害）
    log.warn("persist baseline query failed (falling back to idempotent replay): " + ((err as Error)?.message ?? err));
    baseline = { byGroup: new Map(), truncated: true };
  }
  if (_persistBaselines.size >= PERSIST_BASELINE_MAX_SESSIONS) {
    const oldest = _persistBaselines.keys().next().value;
    if (oldest !== undefined) _persistBaselines.delete(oldest);
  }
  _persistBaselines.set(sessionKey, baseline);
  return baseline;
}

/** 供测试/诊断重置写入对账缓存 */
export function __resetPersistBaselines(): void {
  _persistBaselines.clear();
}

async function getOrCreateDriver(cfg: GmConfig, logger: LoggerLike): Promise<Driver | null> {
  const uri = cfg.neo4j?.uri ?? "(unknown)";
  try {
    log.info(`connecting to Neo4j at ${uri}...`);
    const d = initDriver(cfg.neo4j);
    const ok = await verifyWithRetry(d);
    if (!ok) {
      log.error(`Neo4j connection FAILED at ${uri} — plugin disabled`);
      logger?.warn?.(`[graph-memory-pro] Neo4j connection failed at ${uri} — plugin disabled`);
      closeDriver();
      return null;
    }
    log.info(`Neo4j connected to ${uri}`);
    logger?.info?.(`[graph-memory-pro] Neo4j connected to ${uri}`);

    // v2.3.5: 核实实际 Neo4j 版本，记录日志并告警 power() 等 5.x 函数可用性
    try {
      const { getNeo4jVersion, isNeo4j5Plus, getNeo4jEdition, supportsMultipleDatabases, setCachedEdition } = await import("./src/store/db.ts");
      const neo4jVersion = await getNeo4jVersion(d);
      log.info(`Neo4j version detected: ${neo4jVersion ?? "(unknown)"} (5.x+ supports power(): ${isNeo4j5Plus(neo4jVersion)})`);
      logger?.info?.(`[graph-memory-pro] Neo4j version detected: ${neo4jVersion ?? "(unknown)"}`);
      if (neo4jVersion && !isNeo4j5Plus(neo4jVersion)) {
        log.warn(`Neo4j ${neo4jVersion} < 5.x: power(), vector indexes, and other 5.x-only features are unavailable`);
        logger?.warn?.(`[graph-memory-pro] Neo4j ${neo4jVersion} < 5.x: power()/vector-index unavailable — external plugins using power() will fail`);
      }

      // v2.4.1: 检测 Neo4j 版本代号（Enterprise/Community），条件启用企业版特性
      const edition = await getNeo4jEdition(d);
      setCachedEdition(edition);
      const multiDb = supportsMultipleDatabases(edition);
      log.info(`Neo4j edition detected: ${edition ?? "(unknown)"} (multi-database isolation: ${multiDb ? "enabled" : "not available — falling back to logical isolation"})`);
      logger?.info?.(`[graph-memory-pro] Neo4j edition: ${edition ?? "unknown"}${multiDb ? " (multi-database isolation enabled)" : " (multi-database isolation NOT available — using logical isolation)"}`);
      if (edition === "Community") {
        logger?.info?.(`[graph-memory-pro] Community edition: vector index advanced HNSW/quantization options limited; database-level isolation unavailable`);
      }
    } catch { /* 版本/代号检测失败不阻塞连接 */ }

    return d;
  } catch (err) {
    log.error(`Neo4j init failed at ${uri}: ${err}`);
    logger?.warn?.(`[graph-memory-pro] Neo4j init failed at ${uri}: ${err}`);
    return null;
  }
}

// ─── 模块级自动启动 API 服务器 ──────────────────────
//
// graph-memory-pro 可能被 graph-adapter 作为库导入（不走 register()），
// 也可能被 Gateway 作为插件加载。无论哪种情况，都需要在 Driver 就绪后
// 自动启动独立 HTTP API 服务器。
//
// 策略（三阶段）：
//   1. 密集轮询 30 秒（2s 间隔）— 等待 register() / gateway_start 设置 driver
//   2. 自驱动初始化 — 轮询失败后尝试用环境变量/默认配置自建 driver
//   3. 慢速重试（10s 间隔）— 持续重试直到 driver 可用

let _autoStartRetryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 从 openclaw.json 读取 graph-memory-pro 插件配置中的 neo4j 连接信息。
 *
 * 配置查找路径（优先级从高到低）：
 *   1. 环境变量 NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD
 *   2. ~/.openclaw/openclaw.json → plugins.entries["graph-memory-pro"].config.neo4j
 *   3. ~/.openclaw/openclaw.json → plugins.entries["graph-memory-pro"].config.neo4j (兼容)
 *
 * 不再使用硬编码的 bolt://localhost:37687 作为默认值。
 */
async function readNeo4jConfigFromFile(): Promise<{ uri: string; user: string; password: string } | null> {
  // 1. 环境变量优先
  if (process.env.NEO4J_URI) {
    return {
      uri: process.env.NEO4J_URI,
      user: process.env.NEO4J_USER || "neo4j",
      password: process.env.NEO4J_PASSWORD || "",
    };
  }

  // 2. 读取 openclaw.json
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const os = await import("node:os");
    const home = process.env.HOME || process.env.USERPROFILE || os.default.homedir();
    const configPath = join(home, ".openclaw", "openclaw.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);

    // 查找 graph-memory-pro 插件配置
    const entries = config?.plugins?.entries;
    if (entries) {
      // entries 可能是数组或对象
      let pluginEntry = null;
      if (Array.isArray(entries)) {
        pluginEntry = entries.find((e: { id?: string; name?: string }) =>
          e?.id === "graph-memory-pro" || e?.name === "graph-memory-pro",
        );
      } else if (typeof entries === "object") {
        pluginEntry = entries["graph-memory-pro"] ?? entries["graph_memory_pro"];
      }

      const neo4j = pluginEntry?.config?.neo4j ?? pluginEntry?.neo4j;
      if (neo4j?.uri) {
        log.info(`config loaded from openclaw.json: neo4j.uri=${neo4j.uri}`);
        return {
          uri: neo4j.uri,
          user: neo4j.user || "neo4j",
          password: neo4j.password || "",
        };
      }
    }

    log.warn("no neo4j config found in openclaw.json");
    return null;
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      log.warn("openclaw.json not found, cannot self-init driver");
    } else {
      log.warn(`failed to read openclaw.json: ${(err as Error)?.message ?? err}`);
    }
    return null;
  }
}

/**
 * 从 openclaw.json 读取 graph-memory-pro 的完整插件配置。
 * 用于 self-init 模式下启动 API 服务器时获取完整配置（embedding/llm/judge 等）。
 */
async function readFullConfigFromFile(): Promise<GmConfig | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const os = await import("node:os");
    const home = process.env.HOME || process.env.USERPROFILE || os.default.homedir();
    const configPath = join(home, ".openclaw", "openclaw.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);

    const entries = config?.plugins?.entries;
    let pluginConfig = null;
    if (Array.isArray(entries)) {
      const entry = entries.find((e: { id?: string; name?: string }) =>
        e?.id === "graph-memory-pro" || e?.name === "graph-memory-pro",
      );
      pluginConfig = entry?.config ?? entry;
    } else if (typeof entries === "object") {
      pluginConfig = entries["graph-memory-pro"]?.config ?? entries["graph-memory-pro"];
    }

    if (pluginConfig?.neo4j?.uri) {
      // 填充默认值
      return {
        ...pluginConfig,
        compactTurnCount: pluginConfig.compactTurnCount ?? 6,
        recallMaxNodes: pluginConfig.recallMaxNodes ?? 6,
        recallMaxDepth: pluginConfig.recallMaxDepth ?? 2,
        freshTailCount: pluginConfig.freshTailCount ?? 10,
        dedupThreshold: pluginConfig.dedupThreshold ?? 0.90,
        pagerankDamping: pluginConfig.pagerankDamping ?? 0.85,
        pagerankIterations: pluginConfig.pagerankIterations ?? 20,
        apiServer: pluginConfig.apiServer ?? { enabled: true, port: 7850, host: "127.0.0.1" },
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 尝试从 openclaw.json 配置自建 Neo4j driver。
 * 不再使用硬编码默认值，必须从配置文件或环境变量获取连接信息。
 */
async function trySelfInitDriver(): Promise<Driver | null> {
  const neo4jCfg = await readNeo4jConfigFromFile();
  if (!neo4jCfg) {
    log.warn("self-init: no neo4j config available, skipping");
    return null;
  }

  try {
    log.info(`self-init: connecting to ${neo4jCfg.uri}...`);
    const d = initDriver(neo4jCfg);
    const ok = await verifyWithRetry(d);
    if (ok) {
      log.info(`self-init: connected to ${neo4jCfg.uri}`);
      return d;
    }
    log.warn(`self-init: connection failed to ${neo4jCfg.uri}`);
    closeDriver();
    return null;
  } catch (err) {
    log.warn(`self-init: error: ${err}`);
    closeDriver();
    return null;
  }
}

/**
 * 用已就绪的 driver 启动 API 服务器，并同步 index.ts 模块级 _driver。
 * 同时初始化 LLM/Embedding/Recaller 等组件，确保 API 接口可用。
 */
async function startApiServerFromDriver(driver: Driver): Promise<void> {
  // v2.5.x fix: 幂等强单例 — 与 register()→doGatewayInit 并发时，仅允许一条链真正启动。
  //   调用方（autoStartApiServer）在调用前已同步置位 _apiServerAutoStarted；此处再复查
  //   句柄，若已由其它链启动则直接返回，避免重复 startApiServer → EADDRINUSE 端口漂移
  //   （7850→7852）与双监听泄漏。
  if (currentApiHandle()) {
    log.info("startApiServerFromDriver: API server already started, skipping (idempotent guard)");
    return;
  }

  // v2.8.x 进程级认领：模块级守卫只能防「同实例内」并发，防不住「同进程多实例」。
  //   非所有者实例必须复用所有者的资源，否则会再起一套 server/池/定时器 →
  //   EADDRINUSE + 端口漂移（7850→7852、7800→7803）+ 双份 Neo4j 连接池。
  if (claimCoreInit() === "reuse") {
    const waited = await waitForCoreInit();
    adoptSharedState();
    log.info(
      `auto-start: reusing core resources from instance #${_ps.coreOwnerId} (${waited}); this instance #${getInstanceId()} will not start servers`,
    );
    return;
  }
  beginCoreInit();

  // 同步 index.ts 的 _driver（供 tools / services 使用）
  if (!_driver) {
    _driver = driver;
  }
  _apiServerDriver = driver;

  try {
    // 从 openclaw.json 读取完整插件配置
    const cfg = await readFullConfigFromFile();
    if (!cfg) {
      log.error("no config available for API server, aborting");
      // 必须在放弃初始化时兑现 in-flight promise，否则并发实例会白等到超时
      settleCoreInit(false);
      return;
    }

    // 确保 _cfg 被设置（crud.ts 的 handleConfig 等依赖它）
    _cfg = cfg;

    // 1. 确保 Schema 已初始化
    try {
      const embedDimension = resolveEmbedDimension(cfg);
      await ensureSchema(driver, embedDimension);
    } catch (err) {
      log.warn(`self-init schema: ${err}`);
    }

    // 2. 初始化 LLM
    if (!_llm && cfg.llm) {
      try {
        _llm = createCompleteFn(cfg.llm);
        log.info("self-init: LLM initialized");
      } catch (err) {
        log.warn(`self-init: LLM init failed: ${err}`);
      }
    }

    // 3. 初始化 Embedding
    if (!_embed && cfg.embedding) {
      try {
        _embed = createEmbedFn(cfg.embedding);
        _batchEmbed = createBatchEmbedFn(cfg.embedding);
        log.info("self-init: Embedding initialized");
      } catch (err) {
        log.warn(`self-init: Embedding init failed: ${err}`);
      }
    }

    // 4. 初始化 Recaller（含 JudgeManager + AssociationMatrix）
    if (!_recaller) {
      try {
        const { Recaller } = await import("./src/recaller/recall.ts");
        _recaller = new Recaller(driver, cfg);
        if (_embed) _recaller.setEmbedFn(_embed);
        if (_batchEmbed) _recaller.setBatchEmbedFn(_batchEmbed);

        // 注入 JudgeManager
        if (cfg.judge?.enabled !== false) {
          const { JudgeManager } = await import("./src/recaller/judge.ts");
          const { getFeedbackCount } = await import("./src/store/store.ts");
          const jm = new JudgeManager(cfg.judge, _llm ?? undefined);
          try {
            const persistedCount = await getFeedbackCount(driver);
            for (let i = 0; i < persistedCount; i++) jm.incrementFeedback();
          } catch { /* DB 可能还没有数据 */ }
          _recaller.setJudgeManager(jm);
          log.info("self-init: JudgeManager initialized");
        }

        // 注入 AssociationMatrix
        if (cfg.associationMatrix?.enabled === true) {
          const { createAssociationMatrixPersisted } = await import("./src/recaller/association-matrix-persist.ts");
          const amDim = resolveEmbedDimension(cfg);
          const { am, loaded, path } = await createAssociationMatrixPersisted(amDim, cfg);
          if (!am) {
            settleCoreInit(false);
            return;
          }
          _recaller.setAssociationMatrix(am);
          log.info(`self-init: AssociationMatrix initialized (dim=${amDim}, persistedRestored=${loaded}, path=${path})`);
        }

        log.info("self-init: Recaller initialized");
      } catch (err) {
        log.warn(`self-init: Recaller init failed: ${err}`);
      }
    }

    // 5. 初始化 Extractor
    if (!_extractor) {
      try {
        _extractor = new Extractor(driver);
      } catch (err) {
        log.warn(`self-init: Extractor init failed: ${err}`);
      }
    }

    // 6. 启动 API 服务器，传入所有组件
    const { startApiServer } = await import("./src/server/http-server.ts");
    const apiLogger = { info: (m: string) => log.info(m), error: (m: string) => log.error(m), warn: (m: string) => log.warn(m) };
    const apiServerCfg = cfg.apiServer ?? { enabled: true, port: 7850, host: "127.0.0.1" };
    _apiServerHandle = await startApiServer(
      driver, cfg,
      {
        enabled: true,
        port: apiServerCfg.port ?? 7850,
        host: apiServerCfg.host ?? "127.0.0.1",
        authToken: apiServerCfg.authToken,
      },
      apiLogger,
      _llm ?? undefined,
      _embed ?? undefined,
      _recaller ?? undefined,
      _batchEmbed ?? undefined,
    );
    log.info("API server started (module-level, full init)");
    // v2.8.x: 立即发布句柄，让并发中的其他实例的守卫/探针能看到真实句柄
    publishCoreResources();

    // 7. 启动 MCP Server（7800）— v2.5.x: self-init 路径此前遗漏 MCP 启动，
    //    仅 doGatewayInit 的 registerService 会启动，导致 self-init 部署下 7800 无监听。
    //    现与 apiServer 对称，在 self-init 模式下按 cfg.mcp.enabled 显式启动。
    if (cfg.mcp?.enabled === true) {
      try {
        const { startMcpServer } = await import("./src/mcp/server.ts");
        _mcpServerHandle = await startMcpServer(
          driver, cfg,
          _llm ?? undefined,
          _embed ?? undefined,
          _recaller ?? undefined,
          _batchEmbed ?? undefined,
        );
        // v2.3.3 MCP-1: 启动后健康探测，确认 server 真正就绪（非仅 listen 成功）
        // v2.5.x fix: 用 handle.port（自动重试后可能 ≠ cfg.mcp.port），避免端口漂移时误判
        const actualPort = _mcpServerHandle.port;
        publishCoreResources();
        const host = cfg.mcp?.host ?? "127.0.0.1";
        try {
          const resp = await fetch(`http://${host}:${actualPort}/health`, { signal: AbortSignal.timeout(3000) });
          if (resp.ok) {
            log.info(`[graph-memory-pro] MCP server started + health OK (port=${actualPort})`);
          } else {
            log.warn(`[graph-memory-pro] MCP server started but /health returned ${resp.status} (port=${actualPort})`);
          }
        } catch (probeErr) {
          log.warn(`[graph-memory-pro] MCP server started but health probe failed: ${probeErr} (port=${actualPort})`);
        }
      } catch (err) {
        log.error(`[graph-memory-pro] MCP server start failed: ${err}`);
      }
    } else {
      log.info(`[graph-memory-pro] MCP server disabled via config (mcp.enabled=${cfg.mcp?.enabled})`);
    }

    // 8. 启动后台周期服务（extractor / maintenance）
    //
    // v2.5.x: 与 MCP 同理，这些后台服务原本仅通过 doGatewayInit 的
    // api.registerService 启动；在 self-init 部署下宿主未调用 register()，
    // 导致后台提取与图谱维护定时器缺失。此处按 registerService 的 start
    // 逻辑对称启动，并用模块级 timer + 防重复保护避免与宿主注册重复。
    if (!_extractorTimer && !_ps.extractorTimer) {
      try {
        const interval = getExtractorIntervalMs();
        _extractorTimer = startBackgroundExtractor(interval, apiLogger);
        _ps.extractorTimer = _extractorTimer;
        log.info(`[graph-memory-pro] background extractor scheduled (interval=${interval}ms)`);
      } catch (err) {
        log.warn(`[graph-memory-pro] background extractor start failed: ${err}`);
      }
    }
    if (!_maintenanceTimer && !_ps.maintenanceTimer) {
      try {
        const interval = cfg.background?.maintenanceIntervalMs ?? 6 * 3600_000;
        // v2.5.4: initialDelay 从 5min→30min（默认），可配置。避免启动初期
        // lossless-claw compaction 与 community summary 同时调 LLM 把 Ollama 打成 503
        const initialDelay = getMaintenanceInitialDelayMs();
        _maintenanceTimer = startBackgroundMaintenance(interval, initialDelay, apiLogger);
        _ps.maintenanceTimer = _maintenanceTimer;
        log.info(`[graph-memory-pro] background maintenance scheduled (interval=${interval}ms, initialDelay=${initialDelay}ms)`);
      } catch (err) {
        log.warn(`[graph-memory-pro] background maintenance start failed: ${err}`);
      }
    }

    // 9. 启动心跳自愈服务（v2.5.x）
    startHeartbeatMonitor();

    // 10. 初始化完成 —— 兑现 in-flight promise，并发布全部核心资源供其他实例复用。
    //     缺失这步会让并发实例在 waitForCoreInit 上白等到超时。
    publishCoreResources();
    settleCoreInit(true);
  } catch (err) {
    log.error(`API server start failed: ${err}`);
    settleCoreInit(false);
  }
}

/**
 * 启动后台提取定时器（消费待提取队列）。
 *
 * v2.5.x: 从 api.registerService("graph-memory-extractor") 的 start 逻辑抽取，
 * 供 self-init 路径复用。返回句柄用于赋值 _extractorTimer。
 */
function startBackgroundExtractor(
  interval: number,
  logger: LoggerLike,
): ReturnType<typeof setInterval> {
  const timer = setInterval(async () => {
    if (!_driver || !_extractor || !_llm) return;
    if (_extractorRunning) return;
    _extractorRunning = true;
    try {
      const { readFile, writeFile, mkdir } = await import('node:fs/promises');
      const { join, dirname } = await import('node:path');
      const queuePath = join(
        process.env.HOME || process.env.USERPROFILE || '.',
        '.openclaw', 'graph-memory-pro', 'extract-queue.jsonl'
      );
      let queueContent = '';
      try {
        queueContent = await readFile(queuePath, 'utf-8');
      } catch {
        return;
      }
      if (!queueContent || !queueContent.trim()) return;
      const lines = queueContent.split('\n').filter(Boolean);
      const pairs: Array<{ user: string; assistant: string; sessionKey?: string; ids?: string[] }> = [];
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (!item.user || !item.assistant) continue;
          const ids = Array.isArray(item.msgIds)
            ? item.msgIds.map(String).filter(Boolean)
            : (typeof item.id === 'string' && item.id ? [item.id] : []);
          pairs.push({
            user: item.user,
            assistant: item.assistant,
            sessionKey: typeof item.sessionKey === 'string' && item.sessionKey ? item.sessionKey : undefined,
            ids: ids.length ? ids : undefined,
          });
        } catch { /* 跳过损坏行 */ }
      }
      if (pairs.length === 0) return;
      // v2.8.x: 单 tick 消费上限可配（extractorMaxPairs 默认 8）；熔断/慢 LLM 时可调低
      const extractorMaxPairs = getExtractorMaxPairs();
      const processed = await extractInBackground(_extractor, _driver, _llm, _cfg, logger, pairs, _embed ?? undefined, _batchEmbed ?? undefined, extractorMaxPairs);
      let marked = 0;
      if (processed > 0) {
        const { markMessagesProcessed, markMessagesByContent } = await import('./src/store/messages.ts');
        for (let i = 0; i < Math.min(processed, pairs.length); i++) {
          const p = pairs[i];
          try {
            if (p.sessionKey && p.ids?.length) {
              await markMessagesProcessed(_driver!, p.sessionKey, p.ids);
            } else {
              await markMessagesByContent(_driver!, p.user, p.assistant, p.sessionKey);
            }
            marked++;
          } catch { /* 标记失败不影响提取结果 */ }
        }
      }
      const remaining = lines.slice(processed).join('\n');
      const pendingCount = Math.max(0, lines.length - processed);
      await mkdir(dirname(queuePath), { recursive: true }).catch(() => {});
      await writeFile(queuePath, remaining).catch(() => {});
      if (marked > 0 || processed > 0) {
        logger?.info?.(`[graph-memory-pro] extractor: ${processed} pairs processed, ${marked} GmMessage marked, ${pendingCount > 0 ? `kept ${pendingCount} pending` : 'queue drained'}`);
      }

      // v2.5.3: 刷新陈旧会话反馈（长任务期间 M 矩阵增量更新）
      // agent_end 只在整轮对话结束时触发；长任务中 agent 进行多轮工具调用时
      // agent_end 尚未触发，SessionRecallCache 中的 get() 信号一直堆积。
      // 此处周期性消费静默超过 90s 的 session，用 get() 信号直接更新 M。
      await flushStaleFeedback(90_000, logger);

      // v2.5.4: 消费活跃 session 的积压 get 信号（不依赖静默时间）。
      //   长任务中 agent 持续调用 memory_search/get → lastAccess 不断更新 →
      //   consumeStale(90s) 永远不触发。但 get() 信号（确定性正反馈）已堆积，
      //   M 矩阵应在此间隔内增量更新，而非等 agent_end。
      //   consumeActiveGetSignals 只取 get 信号、保留 records 供 agent_end judge。
      await flushActiveGetSignals(logger);

      // v2.5.4: 消费中间 assistant 文本队列并入库（长任务期间关键数据及时入图）
      await processInterimQueue(logger);
    } catch (err) {
      logger?.warn?.(`[graph-memory-pro] extractor tick failed: ${err}`);
    } finally {
      _extractorRunning = false;
    }
  }, interval);
  return timer;
}

/**
 * v2.5.4: 刷新陈旧会话的 get() 信号反馈（长任务期间 M 矩阵增量更新）。
 *
 * 从 extractor 定时器抽出，供定时器与 after_tool_call 钩子复用：
 *   - 定时器：consumeStale(maxAgeMs) 消费静默超时的 session（兜底）
 *   - after_tool_call：consumeGetSignals() 即时消费一个 session 的 get 信号
 *
 * 统一用 get() 确定性信号更新 M，不依赖 judge / assistantReply；
 * 完整 judge 仍由 agent_end 负责。
 */
async function flushGetSignals(
  sessionKey: string,
  query: string,
  getNodeIds: string[],
  nodeIds: string[],
  logger: LoggerLike,
): Promise<void> {
  if (!_recaller || _cfg?.associationMatrix?.enabled !== true) return;
  if (getNodeIds.length === 0) return;
  try {
    await _recaller.processGetBasedFeedback(query, nodeIds, getNodeIds, sessionKey);
    logger?.info?.(`[graph-memory-pro] get-signal feedback flushed (session=${sessionKey}, getHits=${getNodeIds.length}, recalled=${nodeIds.length})`);
  } catch (flushErr) {
    logger?.warn?.(`[graph-memory-pro] get-signal feedback flush failed: ${flushErr}`);
  }
}

/**
 * v2.6.1: 维护后持久化关联矩阵 M（学习曲线随 serialize 一起落盘）。
 *
 * 统一在 runMaintenance 成功返回后调用，补齐后台定时维护 / service 定时维护 /
 * MCP gm_maintain 三处此前不落盘的缺口（仅 gateway gm_maintain 与优雅关闭保存）。
 * M 未启用或无 Recaller 时静默跳过；保存失败仅告警不影响主流程。
 */
async function persistAssociationMatrixAfterMaintenance(logger?: LoggerLike): Promise<void> {
  if (!_recaller || _cfg?.associationMatrix?.enabled !== true) return;
  try {
    const { saveRecallerAssociationMatrix } = await import("./src/recaller/association-matrix-persist.ts");
    const saved = await saveRecallerAssociationMatrix(_recaller);
    if (saved) {
      logger?.info?.(`[graph-memory-pro] association matrix persisted after maintenance (${(saved.bytes / 1024).toFixed(1)}KB @ ${saved.path})`);
    }
  } catch (err) {
    logger?.warn?.(`[graph-memory-pro] association matrix persist failed after maintenance: ${err}`);
  }
}

/**
 * v2.5.3/4: 分摊陈旧会话反馈刷新（定时器路径）。
 */
async function flushStaleFeedback(maxAgeMs: number, logger: LoggerLike): Promise<void> {
  if (!_recaller || _cfg?.associationMatrix?.enabled !== true) return;
  try {
    const staleSessions = getSessionRecallCache().consumeStale(maxAgeMs);
    for (const { sessionKey, consumed } of staleSessions) {
      if (consumed.getNodeIds.length === 0) continue;
      await _recaller.processGetBasedFeedback(
        consumed.query,
        consumed.nodeIds,
        consumed.getNodeIds,
        sessionKey,
      );
      logger?.info?.(`[graph-memory-pro] stale-session feedback flushed (session=${sessionKey}, getHits=${consumed.getNodeIds.length}, recalled=${consumed.nodeIds.length})`);
    }
  } catch (flushErr) {
    logger?.warn?.(`[graph-memory-pro] stale-session feedback flush failed: ${flushErr}`);
  }
}

/**
 * v2.5.4: 刷新活跃 session 的积压 get 信号（不依赖静默时间）。
 *
 * 与 flushStaleFeedback 不同，此方法调用 consumeActiveGetSignals()，
 * 对每个有积压 getNodeIds 的活跃 session 直接消费 get 信号更新 M。
 * 解决长任务中 agent 持续调用工具导致 lastAccess 不断更新、
 * consumeStale(90s) 永远不触发、M 矩阵一直不更新的问题。
 *
 * 只取 get 信号（确定性正反馈），保留 records 供 agent_end 做完整 judge。
 */
async function flushActiveGetSignals(logger: LoggerLike): Promise<void> {
  if (!_recaller || _cfg?.associationMatrix?.enabled !== true) return;
  try {
    const activeSessions = getSessionRecallCache().consumeActiveGetSignals();
    for (const { sessionKey, query, getNodeIds, nodeIds } of activeSessions) {
      if (getNodeIds.length === 0) continue;
      await _recaller.processGetBasedFeedback(
        query,
        nodeIds,
        getNodeIds,
        sessionKey,
      );
      logger?.info?.(`[graph-memory-pro] active-session feedback flushed (session=${sessionKey}, getHits=${getNodeIds.length}, recalled=${nodeIds.length})`);
    }
  } catch (flushErr) {
    logger?.warn?.(`[graph-memory-pro] active-session feedback flush failed: ${flushErr}`);
  }
}

/**
 * v2.5.4: 计算文本内容 hash（用于中间 assistant 文本去重）。
 */
function simpleHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/**
 * v2.5.4: 将中间轮 assistant 文本追加到中间提取队列（fire-and-forget，不阻塞）。
 *
 * 供 llm_output 钩子调用。过滤短文本、截断超长文本、内容 hash 去重，
 * 然后异步追加到 extract-interim-queue.jsonl，由后台 extractor 消费提取入库。
 */
async function enqueueInterimAssistant(
  sessionKey: string | undefined,
  texts: string[],
): Promise<void> {
  if (texts.length === 0) return;
  const allowed = texts
    .filter((t): t is string => typeof t === "string" && t.trim().length >= INTERIM_MIN_LEN)
    .slice(0, 10)
    .map((t) => t.trim().slice(0, INTERIM_MAX_LEN))
    .filter((t) => {
      const h = simpleHash(t);
      if (_interimSeen.has(h)) return false;
      if (_interimSeen.size >= INTERIM_SEEN_LIMIT) _interimSeen.clear();
      _interimSeen.add(h);
      return true;
    });
  if (allowed.length === 0) return;

  try {
    const { appendFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const queuePath = join(
      process.env.HOME || process.env.USERPROFILE || '.',
      '.openclaw', 'graph-memory-pro', 'extract-interim-queue.jsonl'
    );
    const lines = allowed.map((t) => JSON.stringify({ sessionKey: sessionKey ?? null, text: t, ts: Date.now() }));
    await appendFile(queuePath, lines.join("\n") + "\n");
  } catch (err) {
    log.warn(`[graph-memory-pro] enqueue interim assistant failed: ${err}`);
  }
}

/**
 * v2.5.4: 消费中间 assistant 提取队列并入库。
 *
 * 由后台 extractor 定时器调用。读取 extract-interim-queue.jsonl，
 * 用 extractInterimTexts 逐条提取写入 Neo4j，处理完的部分清出队列。
 */
async function processInterimQueue(logger: LoggerLike): Promise<void> {
  if (!_driver || !_extractor || !_llm) return;
  try {
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const queuePath = join(
      process.env.HOME || process.env.USERPROFILE || '.',
      '.openclaw', 'graph-memory-pro', 'extract-interim-queue.jsonl'
    );
    let content = '';
    try {
      content = await readFile(queuePath, 'utf-8');
    } catch {
      return;
    }
    if (!content || !content.trim()) return;
    const lines = content.split("\n").filter(Boolean);
    if (lines.length === 0) return;

    const texts: string[] = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (typeof item?.text === "string" && item.text.trim()) texts.push(item.text);
      } catch { /* 跳过损坏行 */ }
    }
    if (texts.length === 0) return;

    const extracted = await extractInterimTexts(_extractor, _driver, _llm, _cfg, texts, _embed ?? undefined, _batchEmbed ?? undefined);
    // v2.5.4: 只移除本批已处理的条目（extractInterimTexts 有单次上限），剩余写回队列，
    // 避免批量丢失未处理数据。
    await mkdir(dirname(queuePath), { recursive: true }).catch(() => {});
    const processedCount = Math.min(lines.length, 5);
    const remaining = lines.slice(processedCount).join("\n");
    await writeFile(queuePath, remaining ? remaining + "\n" : "").catch(() => {});
    if (extracted > 0) {
      logger?.info?.(`[graph-memory-pro] interim extractor: ${extracted} assistant turns extracted to graph`);
    }
  } catch (err) {
    logger?.warn?.(`[graph-memory-pro] interim queue processing failed: ${err}`);
  }
}

/**
 * 启动后台维护定时器（去重 / PageRank / 社区检测）。
 *
 * v2.5.x: 从 api.registerService("graph-memory-maintenance") 的 start 逻辑抽取，
 * 供 self-init 路径复用。返回句柄用于赋值 _maintenanceTimer。
 */
function startBackgroundMaintenance(
  interval: number,
  initialDelay: number,
  logger: LoggerLike,
): ReturnType<typeof setInterval> {
  const runOnce = async () => {
    if (!_driver || !_cfg) return;
    if (_maintenanceRunning) return;
    _maintenanceRunning = true;
    try {
      logger?.info?.("[graph-memory-pro] background maintenance start");
      const result = await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined, _batchEmbed ?? undefined);
      logger?.info?.(`[graph-memory-pro] maintenance done: ${result.dedup.merged} merged, ${result.community.count} communities`);
      // v2.6.1: 维护后持久化 M（此前后台定时维护不落盘，学习曲线可能丢失）
      await persistAssociationMatrixAfterMaintenance(logger);
    } catch (err) {
      logger?.warn?.(`[graph-memory-pro] maintenance error: ${err}`);
    } finally {
      _maintenanceRunning = false;
    }
  };
  setTimeout(runOnce, initialDelay);
  return setInterval(runOnce, interval);
}

// ─── 心跳自愈（v2.5.x）────────────────────────────────
//
// 周期性探测关键能力并在降级/崩溃后自动重建，避免 API 接口丢失：
//   - api-server:  HTTP /health
//   - mcp-server:  HTTP /health（mcp.enabled=true 时）
//   - neo4j-driver: verifyConnectivity 握手
// 通过模块级 _heartbeatHandle 防重复启动（self-init 与宿主 register() 均会调用）。

/** 重建 API server（先关闭旧句柄，再以当前组件重新启动） */
async function restartApiServer(): Promise<void> {
  if (!_driver || !_cfg) return;
  // v2.8.x: 用进程级释放——句柄可能由所有者实例持有，避免"非所有者关不掉也起不来"
  if (currentApiHandle()) {
    await releaseServerHandle("api");
    _apiServerHandle = null;
  }
  const apiLogger = { info: (m: string) => log.info(m), error: (m: string) => log.error(m), warn: (m: string) => log.warn(m) };
  try {
    const { startApiServer } = await import("./src/server/http-server.ts");
    const apiServerCfg = _cfg.apiServer ?? { enabled: true, port: 7850, host: "127.0.0.1" };
    _apiServerHandle = await startApiServer(
      _driver, _cfg,
      {
        enabled: true,
        port: apiServerCfg.port ?? 7850,
        host: apiServerCfg.host ?? "127.0.0.1",
        authToken: apiServerCfg.authToken,
      },
      apiLogger,
      _llm ?? undefined,
      _embed ?? undefined,
      _recaller ?? undefined,
      _batchEmbed ?? undefined,
    );
    publishCoreResources();
    log.info(`[heartbeat] API server re-established (port=${_apiServerHandle.port})`);
  } catch (err) {
    log.error(`[heartbeat] API server restart failed: ${err}`);
  }
}

/** 重建 MCP server（先关闭旧句柄，再以当前组件重新启动） */
async function restartMcpServer(): Promise<void> {
  if (!_driver || !_cfg || _cfg.mcp?.enabled !== true) return;
  // v2.8.x: 同 restartApiServer —— 经进程级状态释放，再短暂等待内核回收端口
  if (currentMcpHandle()) {
    await releaseServerHandle("mcp");
    _mcpServerHandle = null;
    // v2.5.x fix: close() 后短暂等待，给内核释放端口（TIME_WAIT → 释放）的时间窗口；
    //   MCP Streamable HTTP 常有 hold-sockets 场景，close 不等于端口立刻可用。
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  try {
    const { startMcpServer } = await import("./src/mcp/server.ts");
    _mcpServerHandle = await startMcpServer(
      _driver, _cfg,
      _llm ?? undefined,
      _embed ?? undefined,
      _recaller ?? undefined,
      _batchEmbed ?? undefined,
    );
    publishCoreResources();
    log.info(`[heartbeat] MCP server re-established (port=${_mcpServerHandle.port})`);
  } catch (err) {
    log.error(`[heartbeat] MCP server restart failed: ${err}`);
  }
}

/** 重建 Neo4j driver（成功后用新 driver 重建两个 server，保证引用一致） */
async function recoverDriver(): Promise<void> {
  if (!_cfg) return;
  try {
    // v2.4.4: 心跳恢复是真正需要重建的路径——旧 driver 已坏，必须强制 close→create。
    //   initDriver 默认幂等复用（同 uri 不重建），force:true 绕过。
    const d = initDriver(_cfg.neo4j, { force: true });
    const ok = await verifyWithRetry(d);
    if (ok) {
      _driver = d;
      setDbDriver(d);
      _apiServerDriver = d;
      // v2.5.x fix: 热替换持有旧 driver 的模块级单例（Recaller/Extractor）。
      //   之前只换 _driver + 重启 HTTP 路由，但 _recaller（被 graph-adapter/lcm 复用）
      //   与 _extractor 仍持有已被 close 的旧 driver → 恢复后所有经由它们的查询
      //   持续 session:query 连接错误，graph-adapter 反复进入 recovery 循环。
      //   setDriver 保持对象身份不变，外部复用引用不失效，内存态（judge/矩阵）不丢失。
      _recaller?.setDriver(d);
      _extractor?.setDriver(d);
      log.info("[heartbeat] Neo4j driver re-established; restarting servers with new driver");
      await restartApiServer();
      await restartMcpServer();
    } else {
      closeDriver(); // 新 driver 不可用，清空 db 层引用，下一轮心跳继续重试
      log.warn("[heartbeat] Neo4j re-init failed (will retry next tick)");
    }
  } catch (err) {
    log.error(`[heartbeat] Neo4j driver recover failed: ${err}`);
  }
}

/** 启动心跳自愈服务（进程级幂等：任一实例已启动则跳过） */
function startHeartbeatMonitor(): void {
  // v2.8.x: 读进程级句柄 —— 模块级守卫只能防同实例重复启动，
  //   多实例下会各自跑一套心跳，同一资源被 N 个心跳同时"恢复"。
  if (_ps.heartbeatHandle || _heartbeatHandle) return;
  if (_cfg?.heartbeat?.enabled === false) {
    log.info("[heartbeat] monitor disabled via config");
    return;
  }

  const intervalMs = _cfg?.heartbeat?.intervalMs ?? 30_000;
  const probes: HeartbeatProbe[] = [];

  // API server 探针
  const apiHost = _cfg?.apiServer?.host ?? "127.0.0.1";
  probes.push({
    name: "api-server",
    check: async () => {
      // v2.8.x: 用进程级句柄 —— 非所有者实例自身没启动 server，但必须能
      //   观察到所有者的句柄，否则会把健康服务误判为不健康并反复重建。
      const handle = currentApiHandle();
      if (!handle) return false;
      // v2.5.x fix: 用 handle.port（自动重试后可能 ≠ cfg.apiServer.port），避免
      //   端口漂移（EADDRINUSE → 7851/7852）后仍探测 7850 持续 false → 抖动重启循环
      const port = handle.port;
      try {
        const resp = await fetch(`http://${apiHost}:${port}/health`, { signal: AbortSignal.timeout(3000) });
        return resp.ok;
      } catch { return false; }
    },
    recover: restartApiServer,
  });

  // MCP server 探针（仅启用时）
  if (_cfg?.mcp?.enabled === true) {
    const mcpHost = _cfg.mcp?.host ?? "127.0.0.1";
    probes.push({
      name: "mcp-server",
      check: async () => {
        const handle = currentMcpHandle();
        if (!handle) return false;
        // v2.5.x fix: 用 handle.port（自动重试后可能 ≠ cfg.mcp.port），避免
        //   端口漂移后仍探测 7800 持续 false → 反复触发重启
        const port = handle.port;
        try {
          const resp = await fetch(`http://${mcpHost}:${port}/health`, { signal: AbortSignal.timeout(3000) });
          return resp.ok;
        } catch { return false; }
      },
      recover: restartMcpServer,
    });
  }

  // Neo4j driver 探针
  probes.push({
    name: "neo4j-driver",
    check: async () => {
      const driver = _ps.driver ?? _driver;
      if (!driver) return false;
      return verifyConnectivity(driver);
    },
    recover: recoverDriver,
  });

  _heartbeatHandle = startHeartbeat(probes, {
    intervalMs,
    logger: {
      info: (m: string) => log.info(m),
      warn: (m: string) => log.warn(m),
      error: (m: string) => log.error(m),
      debug: (m: string) => log.debug?.(m),
    },
  });
  _ps.heartbeatHandle = _heartbeatHandle;
  log.info(`[heartbeat] monitor started (interval=${intervalMs}ms, probes=[${probes.map(p => p.name).join(", ")}])`);
}

async function autoStartApiServer(): Promise<void> {
  // v2.8.x: 同时看进程级状态 —— 其他实例已认领时，本实例不再启动任何 server
  if (_apiServerAutoStarted || _ps.apiServerAutoStarted) return;

  // v2.3.5 fix: 缩短纯轮询窗口（30s→10s），尽快尝试 self-init。
  //   原逻辑 30s 纯轮询期间 driver 为 null，quickHealth 误报 "driver unavailable"。
  //   新逻辑：10s 快速探测外部 driver，找不到就立即 self-init。
  const FAST_ATTEMPTS = 5;   // 5 × 2s = 10s
  const FAST_POLL_MS = 2000;
  const SLOW_POLL_MS = 10_000;

  log.info("auto-start: polling for gateway driver (10s fast phase)...");

  // 阶段 1：快速轮询 — 等待 register()/gateway_start 设置 driver
  for (let i = 0; i < FAST_ATTEMPTS; i++) {
    // v2.5.x fix: 每轮复查，避免 register()→doGatewayInit 已在上一轮 await 期间
    // 声明占用（_apiServerAutoStarted=true）后，本循环仍启动第二个 API server。
    if (_apiServerAutoStarted || currentApiHandle()) {
      log.info("auto-start: API server already started, skipping fast-loop");
      return;
    }
    const driver = getDriver();
    if (driver) {
      _apiServerAutoStarted = true;
      _ps.apiServerAutoStarted = true;
      await startApiServerFromDriver(driver);
      return;
    }
    await new Promise(r => setTimeout(r, FAST_POLL_MS));
  }

  // 阶段 2：自驱动初始化 — 轮询失败，尝试自建 driver
  log.warn("auto-start: gateway driver not ready after 10s, trying self-init...");
  if (_apiServerAutoStarted || currentApiHandle()) return;
  const selfDriver = await trySelfInitDriver();
  if (selfDriver) {
    _apiServerAutoStarted = true;
    _ps.apiServerAutoStarted = true;
    await startApiServerFromDriver(selfDriver);
    return;
  }

  // 阶段 3：慢速重试 — 自建失败，持续等待外部 driver 就绪
  log.warn("auto-start: self-init failed, switching to slow retry (every 10s)");
  // v2.8.x: 进程级唯一 —— 多实例各起一个重试定时器只会放大启动期的端口争用
  if (_ps.autoStartRetryTimer) return;
  _autoStartRetryTimer = setInterval(async () => {
    if (_apiServerAutoStarted || _ps.apiServerAutoStarted) {
      if (_autoStartRetryTimer) { clearInterval(_autoStartRetryTimer); _autoStartRetryTimer = null; }
      _ps.autoStartRetryTimer = null;
      return;
    }

    // 检查外部 driver 是否已就绪（register() 延迟调用或 graph-adapter 调用了 setDriver）
    const driver = getDriver();
    if (driver) {
      _apiServerAutoStarted = true;
      _ps.apiServerAutoStarted = true;
      if (_autoStartRetryTimer) { clearInterval(_autoStartRetryTimer); _autoStartRetryTimer = null; }
      _ps.autoStartRetryTimer = null;
      await startApiServerFromDriver(driver);
      return;
    }

    // 再次尝试自建 driver（Neo4j 可能刚启动）
    const selfDriverRetry = await trySelfInitDriver();
    // v2.5.x fix: await 后复查——期间 doGatewayInit 可能已完成启动
    if (_apiServerAutoStarted || currentApiHandle()) return;
    if (selfDriverRetry) {
      _apiServerAutoStarted = true;
      _ps.apiServerAutoStarted = true;
      if (_autoStartRetryTimer) { clearInterval(_autoStartRetryTimer); _autoStartRetryTimer = null; }
      _ps.autoStartRetryTimer = null;
      await startApiServerFromDriver(selfDriverRetry);
    }
  }, SLOW_POLL_MS);
  _ps.autoStartRetryTimer = _autoStartRetryTimer;
}

/**
 * 供外部调用者（如 graph-adapter）注册已创建的 driver。
 * 设置后，autoStartApiServer 会检测到并启动 API 服务器。
 */
export function registerExternalDriver(driver: Driver): void {
  setDbDriver(driver);
  if (!_driver) {
    _driver = driver;
  }
  _apiServerDriver = driver;
  log.info("external driver registered via registerExternalDriver()");
}

/**
 * 返回进程级 Recaller 单例(A)，供外部插件（如 lcm-graph-extra）复用，
 * 避免各自 new Recaller 造成双实例 / 关联矩阵 M 分叉。
 * 未初始化时返回 null（调用方应降级或稍后重试）。
 *
 * v2.8.x: 改为读进程级状态。此前返回模块级 `_recaller`，而 lcm-graph-extra
 *   加载的是本插件的**另一个模块实例**，其 `_recaller` 恒为 null →
 *   graph-adapter 打印 "getRecaller() returned null, falling back to self-built
 *   Recaller" 并回退自建，正是本注释警告的 M 分叉场景。
 */
export function getRecaller(): Recaller | null {
  return _ps.recaller ?? _recaller;
}

/**
 * 返回模块级生效配置(GmConfig)，即 gm-pro 从 openclaw.json
 * `plugins.entries["graph-memory-pro"].config` 读取并填充默认值后实际使用的配置。
 * 供外部插件（如 lcm-graph-extra）复用，避免各自再维护一套重复的 Judge /
 * AssociationMatrix / Embedding 等参数（默认值易漂移）。
 * 未初始化时返回 null。
 */
export function getEffectiveConfig(): GmConfig | null {
  return _cfg;
}

/**
 * v2.4.2 顶层导出（薄封装，对齐 ROADMAP 第七节预留 API）：
 * 启发式召回质量评估（I-2，Tier 1）——判定召回节点是否被最终回答实际使用。
 *
 * 签名对齐 ROADMAP：judgeRecall(query, nodes, response)。
 * 依赖模块级 Recaller 单例（须在初始化后调用，未初始化抛错）。
 *
 * @param query 触发召回的原始 query（ROADMAP 契约保留参数：当前启发式判定
 *              仅对 assistant 回复做字符串匹配，query 暂不参与，保留以兼容
 *              lcm-graph-extra R-2 调用约定）
 * @param recalledNodes 召回节点列表
 * @param assistantReply 最终 assistant 回答
 * @returns Judge 判定结果（usedNodeIds / unusedNodeIds 等）
 */
export async function judgeRecall(
  query: string,
  recalledNodes: GmNode[],
  assistantReply: string,
): Promise<JudgeResult> {
  const jm = _recaller?.getJudgeManager();
  if (!jm) throw new Error("JudgeManager not initialized — call init() first");
  return jm.judge(recalledNodes, assistantReply);
}

/**
 * v2.4.2 顶层导出（薄封装，对齐 ROADMAP 第七节预留 API）：
 * 触发节点演化（S-11）——更新节点内容并重新嵌入。
 *
 * 更新节点字段（name/description/content 等），写入库并重新生成 embedding。
 *
 * @param id 节点 id
 * @param updates 需要更新的字段（部分更新）
 */
export async function evolveNode(
  id: string,
  updates: Partial<GmNode>,
): Promise<void> {
  if (!_driver || !_embed) throw new Error("Driver or embed not initialized — call init() first");
  const node = await findById(_driver, id);
  if (!node) throw new Error(`Node ${id} not found`);
  const updatedNode: GmNode = { ...node, ...updates, updatedAt: Date.now() };
  await upsertNode(_driver, updatedNode, _cfg ?? undefined);
  await embedNode(_driver, _embed, id, {
    name: updatedNode.name,
    description: updatedNode.description,
    content: updatedNode.content,
  }, _cfg ?? undefined, _batchEmbed ?? undefined);
}

/**
 * v2.4.2 顶层导出（薄封装）：按时间范围查询节点。
 *
 * @param params start/end（毫秒时间戳）、timeField（createdAt|updatedAt）、
 *              可选 type 与 limit
 * @returns 命中的节点列表（按 timeField 倒序）
 */
export async function getNodesByTimeRange(
  params: {
    start: number;
    end: number;
    timeField: "createdAt" | "updatedAt";
    type?: NodeType;
    limit?: number;
  },
): Promise<GmNode[]> {
  if (!_driver) throw new Error("Driver not initialized — call init() first");
  return getNodesByTimeRangeInternal(_driver, params);
}

/**
 * v2.4.2 顶层导出（薄封装）：将暂存节点内容合并为一次提取并写入图谱。
 *
 * 将 nodes 的 content 拼接后交给 Extractor 提取三元组，并把结果写入 Neo4j。
 *
 * @param nodes 待合并的节点（取其 content 作为提取输入）
 * @returns 本次提取落库的节点名列表
 */
export async function consolidateBuffer(nodes: GmNode[]): Promise<string[]> {
  if (!_driver || !_extractor || !_llm || !_cfg) {
    throw new Error("Dependencies not initialized — call init() first");
  }
  const result = await _extractor.extract(
    _llm,
    "",
    nodes.map((n) => n.content).join("\n"),
  );
  await writeExtractResult(_driver, _cfg, result);
  return result.nodes.map((n) => n.name);
}

/**
 * v2.4.2 顶层导出（薄封装）：在两个节点之间创建一条关系边。
 *
 * @param fromId 起点节点 id
 * @param toId 终点节点 id
 * @param type 边类型
 */
export async function linkNodes(
  fromId: string,
  toId: string,
  type: EdgeType,
): Promise<void> {
  if (!_driver) throw new Error("Driver not initialized — call init() first");
  const edge: GmEdge = {
    id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    fromId,
    toId,
    instruction: "",
    weight: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await upsertEdge(_driver, edge);
}

/**
 * v2.4.2 顶层导出（薄封装）：运行一次增量维护。
 *
 * 仅处理 markDirty 标记的脏节点（去重 / 陈旧性检查等），执行后清除标记。
 *
 * @returns 增量维护结果统计
 */
export async function incrementalMaintain(): Promise<IncrementalMaintenanceResult> {
  if (!_driver || !_cfg) throw new Error("Driver or config not initialized — call init() first");
  return runIncrementalMaintenance(
    _driver,
    _cfg,
    _llm ?? undefined,
    _embed ?? undefined,
  );
}

// 在模块加载时触发自动启动（不阻塞模块导入）
log.info("module loaded, auto-start scheduled");
autoStartApiServer();

// v2.3.4 ARCH-1: extractInBackground 已拆分到 src/services/extract-service.ts

/**
 * v2.3.5 fix: 从 api.pluginConfig 直接初始化插件（不依赖 gateway_start hook）。
 *
 * SDK 可能不触发 gateway_start 事件，导致 Neo4j driver 永远不初始化。
 * 此函数封装了完整的初始化逻辑，可从 register() 或 gateway_start hook 调用。
 */
/**
 * v2.8.x: 核心初始化的「单向门」保护。
 *
 * 缺陷背景：`doGatewayInitInner` 体内（`beginCoreInit()` 之后）任一处 throw 都不会调用
 * `settleCoreInit(false)`；异常被调用方的 `.catch(err => log.error)` 吞掉后：
 *   - `process-state` 里 `coreOwnerId` 已置为本实例、`coreInitFailed` 仍为 false；
 *   - 于是 `claimCoreInit()` 对**所有**后续实例永久返回 "reuse"，
 *   - 其他实例只能 `waitForCoreInit()` 白等到超时，且谁都不会启动 API/MCP。
 * 一次异常即可让全进程再也起不来，且日志上只看到一条 "direct init ... failed"。
 *
 * 修复：包一层 try/catch，失败时务必兑现 `settleCoreInit(false)`，把认领权交还出去
 * （错误仍向上抛，不改变调用方的失败处理）。
 */
async function doGatewayInit(api: unknown, logger: LoggerLike): Promise<void> {
  try {
    await doGatewayInitInner(api, logger);
  } catch (err) {
    try {
      settleCoreInit(false); // 交还认领权，允许其他实例/后续重试重新认领
      log.warn(`core init aborted — released core-init claim so it can be retried: ${(err as Error)?.message ?? err}`);
    } catch { /* settle 失败不应掩盖原始错误 */ }
    throw err;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function doGatewayInitInner(api: any, logger: LoggerLike): Promise<void> {
  const eventCfg = api.pluginConfig ?? api.config;
  log.info(`config check: neo4j.uri=${eventCfg?.neo4j?.uri ? "present" : "missing"}`);
  if (!eventCfg?.neo4j?.uri) {
    log.warn("No Neo4j config — plugin skipped");
    logger?.warn?.("[graph-memory-pro] No Neo4j config — plugin skipped");
    return;
  }
  const pluginConfig = eventCfg as GmConfig;

  // v2.2.0 fix: spread pluginConfig 保留全部 v2.1.2 扩展字段
  _cfg = {
    ...pluginConfig,
    compactTurnCount: pluginConfig.compactTurnCount ?? 6,
    recallMaxNodes: pluginConfig.recallMaxNodes ?? 6,
    recallMaxDepth: pluginConfig.recallMaxDepth ?? 2,
    freshTailCount: pluginConfig.freshTailCount ?? 10,
    dedupThreshold: pluginConfig.dedupThreshold ?? 0.90,
    pagerankDamping: pluginConfig.pagerankDamping ?? 0.85,
    pagerankIterations: pluginConfig.pagerankIterations ?? 20,
    apiServer: pluginConfig.apiServer ?? { enabled: true, port: 7850, host: "127.0.0.1" },
  };

  // v2.8.x 进程级认领：同一进程内多个模块实例时，只有所有者创建资源
  //   （driver / LLM / Embedding / Recaller / server / 定时器）。
  //   非所有者复用所有者发布的引用 —— 否则两套实例会争抢 7850/7800，
  //   且各自的 Recaller 会写同一份 association-matrix.json，导致 M 矩阵分叉。
  if (claimCoreInit() === "reuse") {
    const waited = await waitForCoreInit();
    if (_ps.driver) adoptSharedState();
    log.info(
      `gateway init: reusing core resources from instance #${_ps.coreOwnerId} (${waited}); instance #${getInstanceId()} skips driver/LLM/Recaller/server creation`,
    );
    if (!_driver) {
      log.warn("gateway init: owner resources not published yet; tools on this instance may be degraded until the owner finishes");
    }
    return;
  }
  beginCoreInit();

  // 1. 连接 Neo4j
  const driver = await getOrCreateDriver(_cfg, logger);
  if (!driver) {
    // v2.5.x fix: 连接失败也要启动心跳兜底自愈。此前直接 return，startHeartbeatMonitor()
    //   在函数末尾不会执行 → 冷启动时 Neo4j 短暂不可用，插件永久"禁用"，
    //   只能依赖 autoStartApiServer 的 10s 慢轮询恢复。心跳幂等，已有句柄则跳过；
    //   neo4j-driver 探针在 _driver 为 null 时返回 false，连续失败后由 recoverDriver 重连。
    startHeartbeatMonitor();
    // 兑现 in-flight promise 并标记失败：允许 Neo4j 恢复后由本实例或其他实例重新认领，
    // 同时避免并发实例在 waitForCoreInit 上白等到超时。
    settleCoreInit(false);
    return;
  }
  _driver = driver;

  // 2. 初始化 Schema
  try {
    const embedDimension = resolveEmbedDimension(pluginConfig);
    await ensureSchema(driver, embedDimension);
  } catch (err) {
    logger?.warn?.(`[graph-memory-pro] Schema init: ${err}`);
  }

  // 3. 初始化 LLM / Embedding
  const runtimeLlm = api.runtime?.llm;
  // v2.6.x: 从 SDK 运行时上下文提取 agent 当前生效模型 + provider 注册表，供
  // createRuntimeCompleteFn 解析真实 provider 端点（绕过 OpenClaw 网关）。
  // 当前生效模型优先取 runtime.llm.model（runtimeContext.llm.model，可反映会话级
  // /model override，区别于配置默认的 agents.defaults.model.primary）。
  const getAgentModelCtx = (): AgentModelContext => {
    try {
      const snapshot = api.runtime?.config?.current?.() ?? {};
      const providers = snapshot?.models?.providers ?? snapshot?.providers ?? {};
      const runtimeModel =
        runtimeLlm?.model?.toString?.() ??
        snapshot?.llm?.model?.toString?.() ??
        snapshot?.runtimeContext?.llm?.model?.toString?.() ??
        "";
      const primary = (
        snapshot?.agents?.defaults?.model?.primary ??
        snapshot?.agents?.defaults?.model ??
        ""
      ).toString();
      const currentModel = (runtimeModel || primary).trim() || undefined;
      return { currentModel, providers };
    } catch {
      return {};
    }
  };
  if (runtimeLlm && typeof runtimeLlm.complete === "function") {
    _llm = createRuntimeCompleteFn(runtimeLlm, _cfg.llm, logger as unknown as Parameters<typeof createRuntimeCompleteFn>[2], getAgentModelCtx);
    logger?.info?.("[graph-memory-pro] LLM initialized via runtime (provider detection deferred to first call)");
  } else {
    _llm = createCompleteFn(_cfg.llm);
    if (_llm) {
      logger?.info?.("[graph-memory-pro] LLM initialized via plugin config (api.runtime.llm unavailable)");
    }
  }
  _embed = _cfg.embedding ? createEmbedFn(_cfg.embedding) : null;
  _batchEmbed = _cfg.embedding ? createBatchEmbedFn(_cfg.embedding) : null;

  // 4. 初始化 Recaller / Extractor
  _recaller = new Recaller(driver, _cfg);
  if (_embed) _recaller.setEmbedFn(_embed);
  if (_batchEmbed) _recaller.setBatchEmbedFn(_batchEmbed);

  // v2.1.2 第二批 I-2：注入 JudgeManager
  if (_cfg.judge?.enabled !== false) {
    const { JudgeManager } = await import("./src/recaller/judge.ts");
    const { getFeedbackCount } = await import("./src/store/store.ts");
    const jm = new JudgeManager(_cfg.judge, _llm ?? undefined);
    try {
      const persistedCount = await getFeedbackCount(driver);
      for (let i = 0; i < persistedCount; i++) jm.incrementFeedback();
      logger?.info?.(`[graph-memory-pro] judge enabled (warmup=${_cfg.judge?.judgeWarmupFeedbacks ?? 50}, persisted=${persistedCount})`);
    } catch (err) {
      logger?.warn?.(`[graph-memory-pro] judge feedback count restore failed: ${err}`);
    }
    _recaller.setJudgeManager(jm);
  }

  // v2.1.2 第三批 L-1：注入 AssociationMatrix（关联矩阵 M）
  // v2.3.6: 创建后从持久化文件恢复 M（若存在），避免进程重启丢失在线学习成果
  if (_cfg.associationMatrix?.enabled === true) {
    const { createAssociationMatrixPersisted } = await import("./src/recaller/association-matrix-persist.ts");
    const amDim = resolveEmbedDimension(_cfg);
    const { am, loaded, path } = await createAssociationMatrixPersisted(amDim, _cfg);
    if (!am) {
      settleCoreInit(false);
      return;
    }
    _recaller.setAssociationMatrix(am);
    logger?.info?.(`[graph-memory-pro] association-matrix enabled (dim=${amDim}, warmup=${_cfg.associationMatrix?.warmupFeedbacks ?? _cfg.warmup?.warmupFeedbacks ?? 40}, persistedRestored=${loaded}, path=${path})`);
  }

  _extractor = new Extractor(driver);

  if (_cfg.timing?.enabled) {
    setTimingEnabled(true);
  }

  // 5. 启动独立 HTTP API 服务器
  //
  // v2.3.5 fix: 双重初始化竞态修复
  //   原逻辑：self-init 已启动 API server → register() 到达 → 关闭旧 server → 重启 → EADDRINUSE
  //   新逻辑：self-init 和 gateway 连的是同一个 Neo4j，API server 不需要重启！
  //   只需用 gateway 提供的 LLM/Embed/Recaller 重新注入 routes 即可。
  //   driver 引用也直接替换为 gateway driver（同一个 Neo4j 连接池更规范）。
  if (_apiServerAutoStarted) {
    if (_apiServerDriver && _apiServerDriver !== driver) {
      // 不再关闭 API server！只重新注入组件 + 更新 driver 引用
      logger?.info?.("[graph-memory-pro] API server already running (self-init), re-injecting gateway components (no restart needed)");
      _apiServerDriver = driver;
      try {
        const { initRoutes } = await import("./src/routes/crud.ts");
        initRoutes(driver, _cfg, _llm ?? undefined, _embed ?? undefined, _recaller ?? undefined, _batchEmbed ?? undefined);
        logger?.info?.("[graph-memory-pro] gateway components re-injected into API routes");
      } catch (err) {
        logger?.warn?.(`[graph-memory-pro] component re-injection failed: ${err}`);
      }
    } else {
      // 同一个 driver，只重新注入组件
      logger?.info?.("[graph-memory-pro] API server already started, re-injecting components (LLM/Embed/Recaller)");
      try {
        const { initRoutes } = await import("./src/routes/crud.ts");
        initRoutes(driver, _cfg, _llm ?? undefined, _embed ?? undefined, _recaller ?? undefined, _batchEmbed ?? undefined);
        logger?.info?.("[graph-memory-pro] components re-injected into API routes");
      } catch (err) {
        logger?.warn?.(`[graph-memory-pro] component re-injection failed: ${err}`);
      }
    }
  }

  if (!_apiServerAutoStarted) {
    // v2.5.x fix: 委托 startApiServerFromDriver 统一做 full init（API + MCP + 后台
    // extractor/maintenance），与模块顶层 autoStartApiServer 共用同一条启动链。
    //   1) 同步置位声明"我正启动"，避免两条链（register→doGatewayInit 与
    //      autoStartApiServer 轮询）在 await 期间都读到 false → 各启动一个 API server
    //      （7850→7851/7852 端口漂移 + 双监听泄漏）。
    //   2) full init 只发生一次，MCP（=7800）与后台服务不会因另一条链被跳过而缺失。
    _apiServerAutoStarted = true;
    if (_cfg.apiServer?.enabled === false) {
      logger?.info?.("[graph-memory-pro] API server disabled via config (apiServer.enabled=false)");
    } else {
      try {
        await startApiServerFromDriver(driver);
      } catch (err) {
        // 启动失败：回滚声明，允许后续 autoStart 重试
        _apiServerAutoStarted = false;
        logger?.error?.(`[graph-memory-pro] API server failed to start: ${err}`);
      }
    }
  }

  log.info("initialized");
  logger?.info?.("[graph-memory-pro] initialized");

  // v2.5.x: 启动心跳自愈服务（幂等，self-init 已启动则跳过）
  startHeartbeatMonitor();

  // v2.8.x: 发布核心资源并兑现 in-flight promise
  //   —— 并发/后到的其他模块实例据此复用同一套 driver/Recaller/句柄，
  //   不会再各自起一套 server 去争抢 7850/7800。
  publishCoreResources();
  settleCoreInit(true);
}

// ─── Plugin Entry ──────────────────────────────────────

export default definePluginEntry({
  id: "graph-memory-pro",
  name: "Graph Memory Pro",
  description: "Neo4j knowledge graph memory engine for OpenClaw",
  configSchema: buildJsonPluginConfigSchema(Type.Object({
    neo4j: Type.Object({
      uri: Type.String({ default: "bolt://localhost:37687" }),
      user: Type.String({ default: "neo4j" }),
      password: Type.String({ default: "" }),
      // v2.3.5: 允许用户配置连接池大小（影响 getPoolMetrics 返回值）
      maxConnectionPoolSize: Type.Optional(Type.Number({ default: 50 })),
      connectionAcquisitionTimeout: Type.Optional(Type.Number({ default: 10000 })),
    }),
    compactTurnCount: Type.Optional(Type.Number({ default: 6 })),
    recallMaxNodes: Type.Optional(Type.Number({ default: 6 })),
    recallMaxDepth: Type.Optional(Type.Number({ default: 2 })),
    freshTailCount: Type.Optional(Type.Number({ default: 10 })),
    dedupThreshold: Type.Optional(Type.Number({ default: 0.90 })),
    pagerankDamping: Type.Optional(Type.Number({ default: 0.85 })),
    pagerankIterations: Type.Optional(Type.Number({ default: 20 })),
    llm: Type.Optional(Type.Object({
      apiKey: Type.Optional(Type.String({ default: "" })),
      baseURL: Type.Optional(Type.String({ default: "" })),
      model: Type.Optional(Type.String({ default: "" })),
      keepAlive: Type.Optional(Type.Union([Type.String({ default: "" }), Type.Number({ default: -1 })])),
      maxConcurrency: Type.Optional(Type.Number({ default: 1, description: "v2.3.2 阶段二: 最大并发请求数（默认 1 for Ollama 本地，可调高 for 云端 API）" })),
      thinking: Type.Optional(Type.Boolean({ description: "v2.4.1: 思考模式开关（true=开启 reasoning，false=关闭快速），仅对支持的服务生效" })),
    })),
    embedding: Type.Optional(Type.Object({
      apiKey: Type.Optional(Type.String({ default: "" })),
      baseURL: Type.Optional(Type.String({ default: "" })),
      model: Type.Optional(Type.String({ default: "" })),
      dimensions: Type.Optional(Type.Number({ default: 1024 })),
      keepAlive: Type.Optional(Type.Union([Type.String({ default: "" }), Type.Number({ default: -1 })])),
      cacheSize: Type.Optional(Type.Number({ default: 256, description: "v2.3.2 阶段二: embed LRU 缓存容量（默认 256，0 禁用缓存）" })),
      cacheTtlMs: Type.Optional(Type.Number({ default: 600_000, description: "v2.3.2 阶段二: embed LRU 缓存 TTL ms（默认 10min，0 禁用缓存）" })),
      maxConcurrency: Type.Optional(Type.Number({ default: 3, description: "v2.4.0: embed 最大并发请求数（默认 3 for 本地 Ollama，过高会触发 503 server busy）" })),
      batchSize: Type.Optional(Type.Number({ default: 32, description: "v2.8.x: 批量嵌入单请求最大文本数（默认 32，服务端批处理；本地弱 CPU 可调小降低超时风险）" })),
      maxBatchChars: Type.Optional(Type.Number({ default: 0, description: "v2.8.x: 动态批处理总长度阈值（单请求累计字符数预算，0=关闭）。开启后条数 ≤ batchSize 且累计字符超阈值即封箱转下一子批次，用于稳定单请求耗时；建议用 scripts/embed-batch-bench.ts 实测取值" })),
      apiFormat: Type.Optional(Type.Union([Type.Literal("ollama"), Type.Literal("openai")], { description: "v2.8.x: 嵌入接口格式。ollama=/api/embed；openai=/embeddings（OVMS 内网服务 /v3、OpenAI /v1 等）。留空自动判定" })),
      requestIntervalMs: Type.Optional(Type.Number({ default: 0, description: "v2.8.x: 相邻两次嵌入请求的最小间隔 ms（0=不节流）。maxConcurrency 只管同时在飞的数量，释放许可后下一子批次立即补位、正常路径零间隔；部分后端（实测 OVMS 的 MediaPipe 图）在背靠背连续请求流下会间歇返回 404 graph definition not found。现象特征：并发仅 2 却失败、而手动 8~16 并发压测全部成功、加间隔后不再报错 → 触发点是持续速率而非并发上限。建议从 50~200 起试，吞吐上限约 1000/N 次/秒" })),
      efSearch: Type.Optional(Type.Number({ default: 48, description: "v2.8.x: 向量检索 efSearch（默认 48）。属于**检索阶段**参数，只传给 db.index.vector.queryNodes，不在建索引时配置 —— Neo4j 2026.x 起 HNSW/量化参数必须写在建索引参数里，不再走全局 dbms.index.vector.default.* 环境变量；插件刻意**不指定 indexProvider**（官方已废弃显式 provider，且 2026.07+ 改为版本化命名如 vector-2026.07，硬编码会随版本过期）。efSearch 不属建索引参数。越大召回越高、检索越慢。旧版本 Neo4j 不认识该参数时自动回落重试" })),
      options: Type.Optional(Type.Object({}, { additionalProperties: true, default: {} })),
    })),
    timing: Type.Optional(Type.Object({
      enabled: Type.Boolean({ default: false }),
      maxSamples: Type.Optional(Type.Number({ default: 1000 })),
      reportEveryN: Type.Optional(Type.Number({ default: 50 })),
    })),
    background: Type.Optional(Type.Object({
      extractorIntervalMs: Type.Optional(Type.Number({ default: 1_200_000, description: "v2.5.4: 后台三元组提取定时器间隔 ms（默认 20min，本地 LLM 吞吐有限，避免抢占主会话资源）" })),
      maintenanceIntervalMs: Type.Optional(Type.Number({ default: 6 * 3600_000 })),
      maintenanceInitialDelayMs: Type.Optional(Type.Number({ default: 1_800_000, description: "v2.5.4: maintenance 首次启动延迟 ms（默认 30min，避免启动初期 compaction/community summary 抢 LLM 导致 503）" })),
      interimTurnsThreshold: Type.Optional(Type.Number({ default: 15, description: "v2.5.4: 中间轮 assistant 文本提取的轮数节流阈值（默认 15 轮），满 N 轮才批量入队，纳入 autoTurn 调优" })),
    })),
    // ── v2.5.4 社区摘要节流配置 ────────────
    communitySummary: Type.Optional(Type.Object({
      maxPerBatch: Type.Optional(Type.Number({ default: 5, description: "单次 maintenance 最多摘要的社区数（默认 5，超过留到下次 maintenance）" })),
      interCallSleepMs: Type.Optional(Type.Number({ default: 3_000, description: "两个社区摘要之间的间隔 ms（默认 3s，避免连打 LLM）" })),
    })),
    // ── v2.5.x 心跳自愈 ────────────
    heartbeat: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      intervalMs: Type.Optional(Type.Number({ default: 30_000, description: "心跳探测周期 ms（默认 30s）" })),
    })),
    // ── v2.1.2 第一批 Schema 升级 + 监控基础 ────────────
    temporal: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      defaultSource: Type.Optional(Type.Union([
        Type.Literal("experience"),
        Type.Literal("knowledge"),
        Type.Literal("imported"),
      ], { default: "experience" })),
    })),
    state: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      filterSupersededInRecall: Type.Optional(Type.Boolean({ default: false })),
    })),
    staleness: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      threshold: Type.Optional(Type.Number({ default: 0.7 })),
      mode: Type.Optional(Type.Union([
        Type.Literal("heuristic"),
        Type.Literal("llm"),
      ], { default: "heuristic" })),
    })),
    causalEdges: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      extract: Type.Optional(Type.Boolean({ default: true })),
    })),
    graphHealth: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      alertOnAnomaly: Type.Optional(Type.Boolean({ default: true })),
      // v2.8.x: 补齐 —— 此前 TypeBox 缺 scoring，与 openclaw.plugin.json / types.ts 不一致
      scoring: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean({ default: true })),
        historyKeep: Type.Optional(Type.Number({ default: 200, description: "v2.6.0: 图谱健康评分历史保留条数（默认 200）" })),
      })),
    })),
    // ── v2.8.x: 补齐此前 TypeBox 缺失的三整段 ────────────────────
    // 背景：index.ts 的 TypeBox 与 openclaw.plugin.json 的 configSchema 曾不同步，
    // 缺 recall / sparseHeal / timestampBackfill 三整段。宿主若改用 TypeBox 派生校验，
    // 这些整段配置会被判为「不存在」而整体拒绝（sparseHeal 已实际发生）。
    recall: Type.Optional(Type.Object({
      memorySliceChars: Type.Optional(Type.Number({ default: 800, description: "v2.3.x: 单条记忆送入嵌入的切片字符数（默认 800）" })),
      chunking: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean({ default: false })),
        chunkSize: Type.Optional(Type.Number({ default: 400 })),
        chunkOverlap: Type.Optional(Type.Number({ default: 40 })),
      })),
      multiStage: Type.Optional(Type.Boolean({ default: false })),
      temporalWeight: Type.Optional(Type.Number({ default: 0.3 })),
      outputFormat: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean({ default: true })),
        concise: Type.Optional(Type.Boolean({ default: true })),
        faithful: Type.Optional(Type.Boolean({ default: true })),
      })),
    })),
    sparseHeal: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true, description: "v2.6.0: 稀疏图自维护（Maintenance Phase 12），默认开启" })),
      scoreThreshold: Type.Optional(Type.Number({ default: 60, description: "触发稀疏判定：健康评分低于此值视为稀疏（默认 60）" })),
      isolatedRatioThreshold: Type.Optional(Type.Number({ default: 0.3, description: "触发稀疏判定：孤立节点比例高于此值视为稀疏（默认 0.3）。注意健康报告 healthCheck 的告警阈值固定为 0.3（无 config 入参）—— 触发阈值与告警阈值有意分离" })),
      inferSimMin: Type.Optional(Type.Number({ default: 0.7, description: "补边相似度下限（默认 0.70）" })),
      inferSimMax: Type.Optional(Type.Number({ default: 0.9, description: "补边相似度上限（默认 0.90，须低于 dedupThreshold）" })),
      maxEdgesPerNode: Type.Optional(Type.Number({ default: 5, description: "每节点补边上限（默认 5）" })),
      maxEdgesPerCycle: Type.Optional(Type.Number({ default: 50, description: "每周期补边上限（默认 50）" })),
      mergeSimThreshold: Type.Optional(Type.Number({ default: 0.85, description: "孤立节点自动合并相似度阈值（默认 0.85）" })),
      confidenceFactor: Type.Optional(Type.Number({ default: 1, description: "补边权重 = 相似度 × 该系数（默认 1.0）" })),
      cjkWeight: Type.Optional(Type.Number({ default: 0.3, description: "中文 CJK 文本相似度融合权重（默认 0.3）" })),
    })),
    timestampBackfill: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
    })),

    // ── v2.1.2 第二批 反馈闭环 + 冷启动 ────────────
    queryCache: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      maxSize: Type.Optional(Type.Number({ default: 100 })),
      ttlMs: Type.Optional(Type.Number({ default: 30 * 60 * 1000 })),
      similarityThreshold: Type.Optional(Type.Number({ default: 0.95 })),
    })),
    judge: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      asyncMode: Type.Optional(Type.Boolean({ default: true })),
      judgeWarmupFeedbacks: Type.Optional(Type.Number({ default: 20, description: "v2.3.5 B1: Judge 冷启动阈值（50→20）" })),
      heuristicMatch: Type.Optional(Type.Union([
        Type.Literal("id"),
        Type.Literal("name"),
        Type.Literal("both"),
      ], { default: "both" })),
      // v2.2.0 Tier 1/2/3
      tier: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)], { default: 1 })),
      llmJudgeMaxNodes: Type.Optional(Type.Number({ default: 10 })),
      llmJudgeTimeoutMs: Type.Optional(Type.Number({ default: 8000 })),
      customStrategy: Type.Optional(Type.String({ default: "" })),
    })),
    feedback: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      retentionDays: Type.Optional(Type.Number({ default: 90 })),
    })),
    autoFeedback: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true, description: "v2.3.5 B1: agent_end 自动反馈采集，破除冷启动死循环" })),
      trackGetExpansion: Type.Optional(Type.Boolean({ default: true })),
      maxRecallRecordsPerSession: Type.Optional(Type.Number({ default: 5 })),
    })),
    warmup: Type.Optional(Type.Object({
      // v2.3.5: judgeWarmupFeedbacks 已迁移到 judge 段（避免冗余）
      warmupFeedbacks: Type.Optional(Type.Number({ default: 40, description: "v2.3.5 B1: M 矩阵冷启动阈值（100→40）" })),
    })),
    // ── v2.1.2 第三批 在线学习 + 可进化嵌入 + 重要性评分 ────────
    associationMatrix: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      learningRate: Type.Optional(Type.Number({ default: 0.01 })),
      momentum: Type.Optional(Type.Number({ default: 0.9 })),
      adamBeta1: Type.Optional(Type.Number({ default: 0.9 })),
      adamBeta2: Type.Optional(Type.Number({ default: 0.999 })),
      warmupFeedbacks: Type.Optional(Type.Number({ default: 40, description: "v2.3.5 B1: M 矩阵冷启动阈值（100→40）" })),
    })),
    marginalUtility: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      neighborhoodSize: Type.Optional(Type.Number({ default: 5 })),
      minImprovement: Type.Optional(Type.Number({ default: 0.0 })),
    })),
    evolvableEmbedding: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      reembedOnContentChange: Type.Optional(Type.Boolean({ default: true })),
      archiveKeepCount: Type.Optional(Type.Number({ default: 3 })),
    })),
    importance: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      weights: Type.Optional(Type.Object({
        recency: Type.Optional(Type.Number({ default: 0.3 })),
        frequency: Type.Optional(Type.Number({ default: 0.3 })),
        centrality: Type.Optional(Type.Number({ default: 0.2 })),
        source: Type.Optional(Type.Number({ default: 0.2 })),
      })),
      recencyDecayDays: Type.Optional(Type.Number({ default: 30 })),
      frequencySaturation: Type.Optional(Type.Number({ default: 10 })),
    })),
    // ── v2.1.2 第四批 结构升级 + 冲突消解 + 嵌入版本 ────────────
    hierarchicalCommunity: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      depth: Type.Optional(Type.Union([
        Type.Literal(1),
        Type.Literal(2),
        Type.Literal(3),
      ], { default: 3 })),
    })),
    conflictResolution: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      temporalPriority: Type.Optional(Type.Boolean({ default: true })),
      sourcePriority: Type.Optional(Type.Boolean({ default: true })),
      confidencePriority: Type.Optional(Type.Boolean({ default: true })),
    })),
    edgeWeights: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      strengthenFactor: Type.Optional(Type.Number({ default: 1.1 })),
      decayFactor: Type.Optional(Type.Number({ default: 0.95 })),
      minWeight: Type.Optional(Type.Number({ default: 0.1 })),
      maxWeight: Type.Optional(Type.Number({ default: 5.0 })),
    })),
    reverseMemory: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      recallThreshold: Type.Optional(Type.Number({ default: 10 })),
      stalenessPenalty: Type.Optional(Type.Number({ default: 0.1 })),
      importanceFloor: Type.Optional(Type.Number({ default: 0.2 })),
    })),
    // ── v2.1.2 第五批 Benchmark + 自主调优 ────────────
    benchmark: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      dataDir: Type.Optional(Type.String({ default: "" })),
      maxCases: Type.Optional(Type.Number({ default: 0 })),
      buildGraph: Type.Optional(Type.Boolean({ default: true })),
      caseTimeoutMs: Type.Optional(Type.Number({ default: 30_000 })),
    })),
    autoTuner: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      regressionThreshold: Type.Optional(Type.Number({ default: 0.02 })),
      stagnationThreshold: Type.Optional(Type.Number({ default: 5 })),
      maxRounds: Type.Optional(Type.Number({ default: 10 })),
      benchmarkMaxCases: Type.Optional(Type.Number({ default: 50 })),
      llmDiagnosis: Type.Optional(Type.Boolean({ default: true })),
      warmupFeedbacks: Type.Optional(Type.Number({ default: 40, description: "v2.3.5 B1: autoTuner 冷启动阈值（100→40）" })),
    })),
    // ── v2.2.0 MCP Server ────────────
    mcp: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      port: Type.Optional(Type.Number({ default: 7800 })),
      host: Type.Optional(Type.String({ default: "127.0.0.1" })),
      path: Type.Optional(Type.String({ default: "/mcp" })),
      authToken: Type.Optional(Type.String({ default: "" })),
      enabledTools: Type.Optional(Type.Array(Type.String({ default: "" }))),
    })),
    apiServer: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      port: Type.Optional(Type.Number({ default: 7850 })),
      host: Type.Optional(Type.String({ default: "127.0.0.1" })),
      authToken: Type.Optional(Type.String({ default: "" })),
    })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any),
  register(api: OpenClawPluginApi) {
    log.info("register() called by Gateway");
    const logger = api.logger ?? console;
    // v2.2.0 P2-1：把 SDK logger 注入到结构化日志模块
    setExternalLogger(api.logger ?? null);

    // v2.3.5 fix: SDK 可能不触发 gateway_start hook，导致 driver 永远不初始化。
    // 在 register() 中直接从 api.pluginConfig 检测并启动初始化（fire-and-forget）。
    const eventCfg = (api.pluginConfig ?? api.config) as GmConfig | undefined;
    if (eventCfg?.neo4j?.uri) {
      log.info(`config detected in register(): neo4j.uri=${eventCfg.neo4j.uri}`);
      doGatewayInit(api, logger).catch(err => {
        log.error(`direct init from register() failed: ${err}`);
      });
    } else {
      log.info("no neo4j config in register(), waiting for gateway_start hook or auto-start");
    }

    // ── Gateway 启动时初始化（fallback） ──────────────────────
    api.on("gateway_start", async () => {
      log.info("gateway_start hook fired");
      if (_driver) {
        log.info("gateway_start: already initialized via register(), skipping");
        return;
      }
      await doGatewayInit(api, logger);
    });

    // ── Gateway 停止时清理 ──────────────────────
    // v2.3.5 fix: compaction 会触发 gateway_stop → 再 register()，导致全量重建竞态。
    //   修复策略：gateway_stop 只清 timer 和 session cache，保留 driver 和 API server。
    //   - driver: Neo4j 连接池创建成本高（~100ms），compaction 后立即复用
    //   - API server: 端口已绑定，关了再开会 EADDRINUSE
    //   - 真正的进程退出时 OS 会自动回收连接和端口
    api.on("gateway_stop", async () => {
      log.info("gateway_stop: soft cleanup (preserving driver + API server for compaction resilience)");
      // v2.3.6: compaction/停止前持久化关联矩阵 M（避免在线学习成果丢失）
      try {
        const { saveRecallerAssociationMatrix } = await import("./src/recaller/association-matrix-persist.ts");
        const saved = await saveRecallerAssociationMatrix(_recaller);
        if (saved) {
          log.info(`gateway_stop: association matrix persisted (${(saved.bytes / 1024).toFixed(1)}KB @ ${saved.path})`);
          logger?.info?.(`[graph-memory-pro] association matrix persisted on stop (${(saved.bytes / 1024).toFixed(1)}KB)`);
        }
      } catch { /* 持久化失败不阻塞清理 */ }
      if (_extractorTimer) { clearInterval(_extractorTimer); _extractorTimer = null; }
      if (_maintenanceTimer) { clearInterval(_maintenanceTimer); _maintenanceTimer = null; }
      if (_autoStartRetryTimer) { clearInterval(_autoStartRetryTimer); _autoStartRetryTimer = null; }
      if (_heartbeatHandle) { _heartbeatHandle.stop(); _heartbeatHandle = null; }
      // v2.8.x: 同步清空进程级定时器句柄，否则其他实例的守卫会误判"仍在运行"而不再启动
      _ps.extractorTimer = null;
      _ps.maintenanceTimer = null;
      _ps.autoStartRetryTimer = null;
      _ps.heartbeatHandle = null;
      resetSessionRecallCache();
      // 注意：不再 closeDriver() / 关闭 API server / null 化组件
      // compaction 后 register() 会检测到 _driver 已存在并跳过重复初始化
    });

    // ── v2.3.5 方案 A: agent_end 自动反馈采集 ──────────────────────
    //
    // 破除"反馈冷启动死循环"：无需手动调用 gm_feedback。
    //
    // 触发链路：
    //   1. memory-core 调 corpusSupplement.search(query, agentSessionKey) → 记录召回节点到 SessionRecallCache
    //   2. corpusSupplement.get(lookup, agentSessionKey) → 记录"展开查看"强使用信号（方案 C 采集）
    //   3. Agent 生成回复后 SDK 触发 agent_end({messages[]}, ctx={sessionId, sessionKey})
    //   4. 本钩子从 messages 提取 lastUserQuery + lastAssistantReply，
    //      从 SessionRecallCache.consume(sessionKey) 取召回节点，
    //      自动调 _recaller.processFeedback(...) 完成判定（Tier 1 启发式零 LLM 成本）
    //
    // 设计说明（v2.3.5 修订）：
    //   - get() 展开信号仅"采集"不"事后覆盖"
    //   - processFeedback 内部统一执行：judge 判定 → upsertFeedback → incrementFeedback → updateAssociationMatrix
    //   - 不在钩子内重复调用 updateAssociationMatrix，避免：
    //     * M 矩阵同一次反馈被更新两次（计数错位）
    //     * DB 反馈记录（启发式判定）与 M 训练数据（get 信号覆盖）不一致
    //   - get() 信号已在 SessionRecallCache 中保留，未来 JudgeManager.judge() 扩展签名后
    //     可在判定阶段整合（作为"已知 used"传入），实现单一数据流
    //
    // 安全特性：
    //   - fire-and-forget，不阻塞会话；异常仅 warn
    //   - 仅当存在召回缓存时触发，无召回则跳过（避免空判定）
    //   - 可通过 cfg.autoFeedback.enabled 关闭
    // v2.8.x: 必须用 api.on 注册 typed hook——api.registerHook 仅用于 legacy 内部钩子，
    //   对 PluginHookName（agent_end/after_tool_call/llm_output/gateway_*）注册不会被调用
    //   （宿主仅打印 "dispatched by the typed hook runner only" 警告）。这正是学习曲线
    //   长期恒空的根因：hook 从未触发。
    //   key 对齐：write 端（corpusSupplement.search/get）用 params.agentSessionKey 写缓存，
    //   与宿主 ctx.sessionKey 同源，故此处用 ctx.sessionKey 消费，_lastSessionKey 兜底。
    api.on("agent_end", async (event, ctx) => {
      // 功能开关
      if (_cfg?.autoFeedback?.enabled === false) {
        log.info("agent_end 跳过：autoFeedback.enabled === false");
        return;
      }
      // v2.8.x: 早退必须留痕。此前这里静默 return，导致「Neo4j 未连上 → 写入停止」
      // 与「写入逻辑坏了」在日志上不可区分（排查 8-13 之后消息中断时即卡在此处）。
      if (!_driver || !_recaller) {
        log.warn(
          `agent_end 跳过：组件未就绪（driver=${_driver ? "ok" : "null"}, recaller=${_recaller ? "ok" : "null"}）——` +
            "本轮消息不会落库；若持续出现请检查 Neo4j 连接与启动日志",
        );
        return;
      }

      const sessionKey: string | undefined = ctx?.sessionKey ?? ctx?.sessionId ?? _lastSessionKey;
      if (!sessionKey) {
        log.warn("agent_end 跳过：无法取得 sessionKey（ctx.sessionKey / ctx.sessionId / _lastSessionKey 均为空）");
        return;
      }

      // 从 messages[] 提取最后一轮 user query + assistant reply
      const messages: AgentMessageLike[] = Array.isArray(event?.messages) ? (event.messages as AgentMessageLike[]) : [];
      // v2.8.x: 非捆绑插件读会话内容需要宿主显式授权
      // `plugins.entries.<id>.hooks.allowConversationAccess: true`；未授权时钩子可能被阻断或拿不到 messages。
      // 这里给出可执行的排查指引，避免把它误判为插件写端 bug。
      if (messages.length === 0) {
        log.warn(
          "agent_end 收到空 messages：若本插件为非捆绑安装，请确认 openclaw.json 中 " +
            'plugins.entries["graph-memory-pro"].hooks.allowConversationAccess = true' +
            "（可用 `openclaw plugins inspect graph-memory-pro --runtime --json` 核验）",
        );
      }

      // v2.8.x: 补齐写端——把整轮消息落库到 :GmMessage（此前 saveMessage 无调用点）。
      // 【必须在召回缓存判断之前】：即使用户本轮没触发召回（recallRecord 为空）也要落库，
      // 否则 markMessagesByContent / rebuildSessionMessages 会因 MATCH 不到而空转。
      // 历史 bug：本块曾被误置于 `consume()+return` 之后，导致仅在“本轮发生过召回”时才写库，
      // 表现为 :GmMessage 长期零新增（召回缓存空 -> 提前 return -> 写端永不执行）。
      try {
        const savedCount = await persistSessionMessages(_driver, sessionKey, messages);
        // v2.8.x: 不再用 GM_DEBUG 门控 —— 写入量是判断「全量重放是否回归」与
        // 「是否有新增」的关键信号，生产必须可见（写入量长期 ≫ 新增量即为回归信号）。
        log.info(`persisted messages: session=${sessionKey}, total=${messages.length}, saved=${savedCount}`);
      } catch (err) {
        log.warn(`persist messages failed: ${(err as Error)?.message ?? err}`);
      }

      // 消费该 session 的召回缓存（取完即清，避免重复采集）
      const recallRecord = getSessionRecallCache().consume(sessionKey);
      if (!recallRecord || recallRecord.nodeIds.length === 0) return;

      const { userQuery, assistantReply } = extractLastTurn(messages);
      if (!assistantReply || !assistantReply.trim()) return;

      try {
        // 加载召回的节点（JudgeManager 需要 GmNode[] 做判定）
        const recalledNodes = (await Promise.all(
          recallRecord.nodeIds.map(id => findById(_driver!, id)),
          )).filter(Boolean) as GmNode[];

        if (recalledNodes.length === 0) return;

        // 统一调用 processFeedback，内部完整执行：
        //   judge 判定 → upsertFeedback → incrementFeedback → updateAssociationMatrix
        // get() 展开信号已记录在 SessionRecallCache 中（供未来 JudgeManager 扩展使用），
        // 此处不重复调用 M 更新，保证 DB 反馈记录与 M 训练数据一致。
        const query = recallRecord.query || userQuery;
        await _recaller.processFeedback(
          query,
          recalledNodes,
          assistantReply,
          ctx?.sessionId ?? sessionKey,
        );

        if (process.env.GM_DEBUG) {
          log.info(`auto-feedback collected: session=${sessionKey}, recalled=${recalledNodes.length}, getHits=${recallRecord.getNodeIds.length}`);
        }
      } catch (err) {
        log.warn(`auto-feedback failed: ${(err as Error)?.message ?? err}`);
      }
    });

    // ─────────────────────────────────────────────────────────────────
    // v2.5.4 L0: after_tool_call 实时反馈（长任务期间 M 矩阵即时更新）
    //
    // 长任务中 agent 进行多轮工具调用，agent_end 迟迟不触发，M 无法及时反映
    // 已用记忆。此处每次 memory 相关工具调用结束后，即时消费该 session 的
    // get() 展开信号（确定性正反馈）更新 M，不依赖 judge / assistantReply。
    //
    // 与 agent_end 的分工：
    //   - 本钩子：get() 确定性信号 → 即时更新 M（L0 实时层）
    //   - agent_end：完整 judge 判定 used/unused + M 更新（L1 完整层）
    // consumeGetSignals 只取 get 信号、保留召回记录，避免与 agent_end 冲突。
    // ─────────────────────────────────────────────────────────────────
    // v2.8.x: 改用 api.on（api.registerHook 对 PluginHookName 不会被调用）。
    api.on("after_tool_call", async (event, ctx) => {
      if (_cfg?.autoFeedback?.enabled === false) return;
      // v2.8.x: 「M 未启用 / 组件未注入」是配置态而非故障，但静默 return 会让
      // 「关联矩阵学习长期不生效」在日志上不可见。用 warnOnce 避免逐次工具调用刷屏。
      if (!_recaller || _cfg?.associationMatrix?.enabled !== true) {
        warnOnce(
          "after_tool_call:am-disabled",
          "after_tool_call 跳过：associationMatrix 未启用或 Recaller 未注入 —— get 展开信号不会被学习（如需启用请设 associationMatrix.enabled=true）",
        );
        return;
      }
      const toolName = event?.toolName ?? "";
      if (!MEMORY_TOOL_NAMES.has(toolName)) return;

      // v2.5.4: sessionKey 从 ctx 提取；_lastSessionKey 兜底
      //   （corpusSupplement.search/get 被调用时会更新 _lastSessionKey）。
      const sessionKey = ctx?.sessionKey ?? ctx?.sessionId ?? _lastSessionKey;
      if (!sessionKey) return;

      const signals = getSessionRecallCache().consumeGetSignals(sessionKey);
      if (!signals || signals.getNodeIds.length === 0) return;
      await flushGetSignals(sessionKey, signals.query, signals.getNodeIds, [], log);
    });

    // ─────────────────────────────────────────────────────────────────
    // v2.5.4 L0: llm_output 实时提取（长任务中间轮 assistant 数据及时入图）
    //
    // llm_output 在模型每次输出后触发（含中间轮工具调用），assistantTexts 携带
    // 该轮 assistant 文本。长任务中关键数据往往出现在中间轮 assistant 输出，
    // 而现有提取链路只消费最终 user/assistant 对话对，导致这些数据不入库、
    // 后续轮次 recall 无法命中。
    //
    // 本钩子将中间轮 assistant 文本过滤去重后写入 extract-interim-queue.jsonl，
    // 由后台 extractor 定时器消费提取入库（不阻塞主流程）。
    // ─────────────────────────────────────────────────────────────────
    // v2.8.x: 改用 api.on（api.registerHook 对 PluginHookName 不会被调用）。
    api.on("llm_output", async (event, ctx) => {
      // v2.8.x: 依赖缺失时留痕（warnOnce 防止逐次 LLM 输出刷屏）。
      // 静默 return 会让「中间轮文本提取从未生效」与「本轮确实没有可提取文本」无法区分。
      if (!_driver || !_extractor || !_llm) {
        warnOnce(
          "llm_output:deps-missing",
          `llm_output 跳过：组件未就绪（driver=${_driver ? "ok" : "null"}, extractor=${_extractor ? "ok" : "null"}, llm=${_llm ? "ok" : "null"}）—— 中间轮 assistant 文本不会入提取队列`,
        );
        return;
      }
      const texts = Array.isArray(event?.assistantTexts) ? event.assistantTexts : [];
      if (texts.length === 0) return;

      // v2.5.4: sessionKey 降级链——event.sessionId（SDK 必填）→ ctx → _lastSessionKey。
      const sessionKey = event?.sessionId ?? ctx?.sessionKey ?? ctx?.sessionId ?? _lastSessionKey;
      for (const t of texts) {
        if (typeof t !== "string" || t.trim().length < INTERIM_MIN_LEN) continue;
        const trimmed = t.trim().slice(0, INTERIM_MAX_LEN);
        const h = simpleHash(trimmed);
        if (_interimSeen.has(h)) continue;
        if (_interimSeen.size >= INTERIM_SEEN_LIMIT) _interimSeen.clear();
        _interimSeen.add(h);
        _interimTurnBuf.push(trimmed);
      }
      _interimTurnCount++;
      const threshold = getInterimTurnsThreshold();
      if (_interimTurnCount >= threshold) {
        if (_interimTurnBuf.length > 0) {
          await enqueueInterimAssistant(sessionKey, _interimTurnBuf);
        }
        _interimTurnBuf = [];
        _interimTurnCount = 0;
      }
    });

    // ─────────────────────────────────────────────────────────────────
    // P0-1: 移除 before_prompt_build 钩子
    //
    // 上下文注入完全由 contextEngine（lcm-graph-extra）的 assemble() 负责：
    //   - lcm-graph-extra 通过 Re-exports API 调用 Recaller
    //   - 返回 systemPromptAddition 注入
    //
    // graph-memory-pro 不再主动注入上下文，避免双注入冲突。
    // ─────────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────────
    // P0-3: 三元组提取改为后台服务
    //
    // 通过 api.registerService 注册，周期性消费待提取消息队列。
    // 注意：graph-memory-pro 作为无槽位插件，不直接接入 OpenClaw 会话消息流，
    // 因此这里通过 lcm-graph-extra 的 afterTurn 钩子写入的"待提取队列"
    // （~/.openclaw/graph-memory-pro/extract-queue.jsonl）来传递消息对。
    // 如果该队列为空，后台服务空转。
    // ─────────────────────────────────────────────────────────────────
    api.registerService({
      id: "graph-memory-extractor",
      async start(_ctx: unknown) {
        // v2.5.x: self-init 已启动定时器，避免宿主 register() 重复 setInterval（旧 timer 泄漏）
        // v2.8.x: 同时看进程级句柄——多实例下否则会各起一套提取定时器
        if (_extractorTimer || _ps.extractorTimer) return;
        const interval = getExtractorIntervalMs();
        _extractorTimer = setInterval(async () => {
          if (!_driver || !_extractor || !_llm) return;
          // v2.3.2 S3: 重入保护 — 上一次 tick 仍在执行时跳过本次
          if (_extractorRunning) return;
          _extractorRunning = true;
          try {
            // 从队列文件读取待提取消息对（由 lcm-graph-extra 写入）
            const { readFile } = await import('node:fs/promises');
            const { join } = await import('node:path');
            const queuePath = join(
              process.env.HOME || process.env.USERPROFILE || '.',
              '.openclaw', 'graph-memory-pro', 'extract-queue.jsonl'
            );
            let queueContent = '';
            try {
              queueContent = await readFile(queuePath, 'utf-8');
            } catch {
              // 队列文件不存在时静默返回
              return;
            }
            if (!queueContent || !queueContent.trim()) return;

            const lines = queueContent.split('\n').filter(Boolean);
            // 统一数据格式：队列项以 {user, assistant, sessionKey?, id?|msgIds?} 区分管理。
            // sessionKey 用于精确限定到具体会话（GmMessage 按 sessionKey 建有索引），
            // id/msgIds 可用于按 id 精确标记；外部写入方若未提供则回退内容反查。
            const pairs: Array<{ user: string; assistant: string; sessionKey?: string; ids?: string[] }> = [];
            for (const line of lines) {
              try {
                const item = JSON.parse(line);
                if (!item.user || !item.assistant) continue;
                const ids = Array.isArray(item.msgIds)
                  ? item.msgIds.map(String).filter(Boolean)
                  : (typeof item.id === 'string' && item.id ? [item.id] : []);
                pairs.push({
                  user: item.user,
                  assistant: item.assistant,
                  sessionKey: typeof item.sessionKey === 'string' && item.sessionKey ? item.sessionKey : undefined,
                  ids: ids.length ? ids : undefined,
                });
              } catch { /* 跳过损坏行 */ }
            }

            if (pairs.length === 0) return;
            // v2.4.2: 返回本批实际处理的对数（内部 maxPairs 限流），据此：
            //   1. 标记已处理消息（有 id 按 id，否则按 sessionKey+内容反查，避免下一轮/重建重复处理）
            //   2. 只清掉已处理的行，剩余行保留待下一轮（避免一次性清空导致超限数据丢失）
            // v2.8.x: 单 tick 消费上限可配（extractorMaxPairs 默认 8）
            const extractorMaxPairs = getExtractorMaxPairs();
            const processed = await extractInBackground(_extractor, _driver, _llm, _cfg, logger, pairs, _embed ?? undefined, _batchEmbed ?? undefined, extractorMaxPairs);

            let marked = 0;
            if (processed > 0) {
              const { markMessagesProcessed, markMessagesByContent } = await import('./src/store/messages.ts');
              for (let i = 0; i < Math.min(processed, pairs.length); i++) {
                const p = pairs[i];
                try {
                  if (p.sessionKey && p.ids?.length) {
                    await markMessagesProcessed(_driver!, p.sessionKey, p.ids);
                  } else {
                    await markMessagesByContent(_driver!, p.user, p.assistant, p.sessionKey);
                  }
                  marked++;
                } catch { /* 标记失败不影响提取结果 */ }
              }
            }

            const remaining = lines.slice(processed).join('\n');
            const pendingCount = Math.max(0, lines.length - processed);
            const { writeFile, mkdir } = await import('node:fs/promises');
            const { dirname } = await import('node:path');
            await mkdir(dirname(queuePath), { recursive: true }).catch(() => {});
            await writeFile(queuePath, remaining).catch(() => {});
            if (marked > 0 || processed > 0) {
              logger?.info?.(`[graph-memory-pro] extractor: ${processed} pairs processed, ${marked} GmMessage marked, ${pendingCount > 0 ? `kept ${pendingCount} pending` : 'queue drained'}`);
            }

            // v2.5.3: 刷新陈旧会话反馈（长任务期间 M 矩阵增量更新）
            if (_recaller && _cfg?.associationMatrix?.enabled === true) {
              try {
                const staleSessions = getSessionRecallCache().consumeStale(90_000);
                for (const { sessionKey, consumed } of staleSessions) {
                  if (consumed.getNodeIds.length === 0) continue;
                  await _recaller.processGetBasedFeedback(
                    consumed.query,
                    consumed.nodeIds,
                    consumed.getNodeIds,
                    sessionKey,
                  );
                  logger?.info?.(`[graph-memory-pro] stale-session feedback flushed (session=${sessionKey}, getHits=${consumed.getNodeIds.length}, recalled=${consumed.nodeIds.length})`);
                }
              } catch (flushErr) {
                logger?.warn?.(`[graph-memory-pro] stale-session feedback flush failed: ${flushErr}`);
              }
              // v2.5.4: 消费活跃 session 的积压 get 信号（不依赖静默时间）
              try {
                const activeSessions = getSessionRecallCache().consumeActiveGetSignals();
                for (const { sessionKey, query, getNodeIds, nodeIds } of activeSessions) {
                  if (getNodeIds.length === 0) continue;
                  await _recaller.processGetBasedFeedback(query, nodeIds, getNodeIds, sessionKey);
                  logger?.info?.(`[graph-memory-pro] active-session feedback flushed (session=${sessionKey}, getHits=${getNodeIds.length}, recalled=${nodeIds.length})`);
                }
              } catch (flushErr) {
                logger?.warn?.(`[graph-memory-pro] active-session feedback flush failed: ${flushErr}`);
              }
            }

            // v2.5.4: 消费中间 assistant 文本队列并入库（长任务期间关键数据及时入图）
            await processInterimQueue(logger);
          } catch (err) {
            logger?.warn?.(`[graph-memory-pro] extractor tick failed: ${err}`);
          } finally {
            _extractorRunning = false;
          }
        }, interval);
        _ps.extractorTimer = _extractorTimer;
      },
      async stop(_ctx: unknown) {
        if (_extractorTimer) { clearInterval(_extractorTimer); _extractorTimer = null; }
        _ps.extractorTimer = null;
      },
    });

    // ─────────────────────────────────────────────────────────────────
    // P0-4 / P1-2: 图谱维护改为后台周期服务
    //
    // 不再使用 session_end 钩子（会阻塞会话结束），改为周期性运行。
    // ─────────────────────────────────────────────────────────────────
    api.registerService({
      id: "graph-memory-maintenance",
      async start(_ctx: unknown) {
        // v2.5.x: self-init 已启动定时器，避免宿主 register() 重复 setInterval（旧 timer 泄漏）
        // v2.8.x: 同时看进程级句柄——多实例下否则会各起一套维护定时器
        if (_maintenanceTimer || _ps.maintenanceTimer) return;
        const interval = _cfg?.background?.maintenanceIntervalMs ?? 6 * 3600_000;
        // v2.5.4: 启动后延迟从 5min→30min（默认），可配置。避免启动初期
        // lossless-claw compaction 与 community summary 抢 LLM 导致 503
        const initialDelay = getMaintenanceInitialDelayMs();
        const runOnce = async () => {
          if (!_driver || !_cfg) return;
          // v2.3.2 S3: 重入保护 — 上一次 tick 仍在执行时跳过本次
          if (_maintenanceRunning) return;
          _maintenanceRunning = true;
          try {
            logger?.info?.("[graph-memory-pro] background maintenance start");
            const result = await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined, _batchEmbed ?? undefined);
            logger?.info?.(`[graph-memory-pro] maintenance done: ${result.dedup.merged} merged, ${result.community.count} communities`);
            // v2.6.1: 维护后持久化 M（同 startBackgroundMaintenance）
            await persistAssociationMatrixAfterMaintenance(logger);
          } catch (err) {
            logger?.warn?.(`[graph-memory-pro] maintenance error: ${err}`);
          } finally {
            _maintenanceRunning = false;
          }
        };
        setTimeout(runOnce, initialDelay);
        _maintenanceTimer = setInterval(runOnce, interval);
        _ps.maintenanceTimer = _maintenanceTimer;
      },
      async stop(_ctx: unknown) {
        if (_maintenanceTimer) { clearInterval(_maintenanceTimer); _maintenanceTimer = null; }
        _ps.maintenanceTimer = null;
      },
    });

    // ─────────────────────────────────────────────────────────────────
    // v2.2.0: MCP Server（对外暴露 14 个 tools，供 dashboard 调用）
    //
    // 通过 api.registerService 注册，复用宿主进程的 _driver/_cfg/_recaller。
    // 启用条件：cfg.mcp.enabled === true
    // ─────────────────────────────────────────────────────────────────
    if (_cfg?.mcp?.enabled === true) {
      api.registerService({
        id: "graph-memory-mcp",
        async start(_ctx: unknown) {
          if (!_driver || !_cfg) return;
          // v2.5.x: self-init 已启动 MCP，避免重复监听 EADDRINUSE
          // v2.8.x: 同时看进程级句柄——多实例下否则会再来抢 7800 并漂移到 7803
          if (currentMcpHandle()) return;
          try {
            const { startMcpServer } = await import("./src/mcp/server.ts");
            _mcpServerHandle = await startMcpServer(
              _driver, _cfg,
              _llm ?? undefined,
              _embed ?? undefined,
              _recaller ?? undefined,
              _batchEmbed ?? undefined,
            );
            publishCoreResources();
            // v2.3.3 MCP-1: 启动后健康探测，确认 server 真正就绪（非仅 listen 成功）
            // v2.5.x fix（同一类问题的漏改点）：必须用 handle.port —— 端口漂移后
            //   （7800→7803）仍探测配置端口会误报 "health returned 404/failed"。
            const port = _mcpServerHandle.port;
            const host = _cfg.mcp?.host ?? "127.0.0.1";
            try {
              const resp = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(3000) });
              if (resp.ok) {
                logger?.info?.(`[graph-memory-pro] MCP server started + health OK (port=${port})`);
              } else {
                logger?.warn?.(`[graph-memory-pro] MCP server started but /health returned ${resp.status}`);
              }
            } catch (probeErr) {
              // 健康探测失败不回滚（server 可能已正常工作，仅 /health 路径不可达）
              logger?.warn?.(`[graph-memory-pro] MCP server started but health probe failed: ${probeErr}`);
            }
          } catch (err) {
            logger?.error?.(`[graph-memory-pro] MCP server start failed: ${err}`);
          }
        },
        async stop(_ctx: unknown) {
          if (currentMcpHandle()) {
            await releaseServerHandle("mcp");
            _mcpServerHandle = null;
          }
        },
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // P1-1: 注册为 memory-core 的语料补充
    //
    // 让 memory_search 工具能搜索到 Neo4j 图谱节点，无需另建 gm_search。
    //
    // SDK 合规（v2.3.6）：
    // - search(params): { query, maxResults, agentSessionKey } → MemoryCorpusSearchResult[]
    // - get(params):    { lookup, fromLine, lineCount, agentSessionKey } → MemoryCorpusGetResult | null
    // ─────────────────────────────────────────────────────────────────
    api.registerMemoryCorpusSupplement({
      async search(params: {
        query: string;
        maxResults?: number;
        agentSessionKey?: string;
      }): Promise<Array<{
        corpus: string;
        path: string;
        title?: string;
        kind?: string;
        score: number;
        snippet: string;
        id?: string;
        startLine?: number;
        endLine?: number;
        citation?: string;
      }>> {
        if (!_driver) return [];
        try {
          const limit = Math.min(params.maxResults ?? 5, 20);
          const nodes = await searchNodes(_driver, params.query, limit);
          // v2.3.5 方案 A: 记录会话级召回，供 agent_end 自动反馈采集
          if (params.agentSessionKey) {
            _lastSessionKey = params.agentSessionKey; // v2.5.4: 缓存供钩子降级
            getSessionRecallCache().recordRecall(
              params.agentSessionKey,
              params.query,
              nodes.map(n => n.id),
            );
          }
          return nodes.map(n => ({
            corpus: "graph-memory-pro",
            path: n.id,
            title: n.name,
            kind: n.type,
            score: n.pagerank ?? 0,
            snippet: `[${n.type}] ${n.name}: ${n.description}\n${n.content ?? ''}`,
            id: n.id,
          }));
        } catch {
          return [];
        }
      },
      async get(params: {
        lookup: string;
        fromLine?: number;
        lineCount?: number;
        agentSessionKey?: string;
      }): Promise<{
        corpus: string;
        path: string;
        title?: string;
        kind?: string;
        content: string;
        fromLine: number;
        lineCount: number;
        id?: string;
        provenanceLabel?: string;
        sourceType?: string;
        // v2.4.4 SDK 2026.9.6 合规：Memory 结果契约
        //   宿主（2026.8.1 起行为一致）用 `if (!result) return null` 判定“未找到”，
        //   并对非空结果自行附加 status:"ok"。因此“不存在”必须返回 null 表达，
        //   不能返回带 status 的对象——否则会被 compat 层当作“成功读取空内容”。
      } | null> {
        if (!_driver) return null;
        try {
          const n = await findById(_driver, params.lookup);
          if (!n) {
            // v2.4.4 SDK 2026.9.6：返回 null 明确报告“不存在”。
            return null;
          }
          // v2.3.5 方案 C: get() 展开视为强使用信号，记录到 session 缓存
          if (params.agentSessionKey) {
            _lastSessionKey = params.agentSessionKey; // v2.5.4: 缓存供钩子降级
            getSessionRecallCache().recordGet(params.agentSessionKey, n.id);
          }
          return {
            corpus: "graph-memory-pro",
            path: n.id,
            title: n.name,
            kind: n.type,
            content: `[${n.type}] ${n.name}: ${n.description}\n${n.content ?? ''}`,
            fromLine: 0,
            lineCount: 0,
            id: n.id,
          };
        } catch {
          return null;
        }
      },
    });

    // ── 注册 Agent 工具 ───────────────────────────
    // P1-4: 移除 gm_search（已通过 registerMemoryCorpusSupplement 由 memory_search 覆盖）
    //       移除 gm_stats（合并到 gm_maintain 输出）

    // gm_record: 手动记录知识到图谱
    api.registerTool({
      name: "gm_record",
      label: "Graph Memory Record",
      description: "手动记录一条知识到 Graph Memory Pro 图谱中。当你发现重要的技能、经验或事件时使用。节点类型: SKILL(技能/方案) / TASK(任务/需求) / EVENT(事件/错误)",
      parameters: Type.Object({
        type: Type.String({ description: "节点类型: SKILL / TASK / EVENT" }),
        name: Type.String({ description: "节点英文名" }),
        description: Type.String({ description: "描述" }),
        content: Type.String({ description: "详细内容" }),
      }),
      async execute(_callId: string, params: { type: string; name: string; description: string; content: string }) {
        if (!_driver) {
          return { content: [{ type: "text", text: "Graph Memory Pro 未连接" }], details: {} };
        }
        try {
          const p = params;
          const now = Date.now();
          const id = `manual-${now}-${Math.random().toString(36).slice(2, 8)}`;
          const nodeType = p.type.toUpperCase();
          if (!["TASK", "SKILL", "EVENT"].includes(nodeType)) {
            return { content: [{ type: "text", text: `无效的节点类型: ${p.type}` }], details: {} };
          }
          await upsertNode(_driver, {
            id,
            type: nodeType as NodeType,
            name: p.name,
            description: p.description,
            content: p.content,
            status: "active",
            communityId: undefined,
            pagerank: 0,
            validatedCount: 0,
            createdAt: now,
            updatedAt: now,
            embeddingModel: _cfg?.embedding?.model,
          });
          // v2.8.x 根因修复: 手动记录节点后补算 embedding（此前只写 embeddingModel 字段，
          // 导致该类节点全缺向量，recall 向量检索无法命中）
          if (_embed && _cfg?.embedding?.model) {
            try {
              await embedNode(_driver, _embed, id, {
                name: p.name,
                description: p.description,
                content: p.content,
                embeddingModel: _cfg.embedding.model,
              }, _cfg, _batchEmbed ?? undefined);
            } catch {
              // 嵌入失败不影响节点记录（下次 gm_reembed 会补）
            }
          }
          return { content: [{ type: "text", text: `已记录知识节点: ${id}` }], details: { id } };
        } catch (err) {
          return { content: [{ type: "text", text: `记录失败: ${(err as Error).message}` }], details: {} };
        }
      },
    });

    // gm_maintain: 手动触发维护（含统计输出）
    api.registerTool({
      name: "gm_maintain",
      label: "Graph Memory Maintain",
      description: "Start a background graph maintenance (dedup + PageRank + community + staleness + health + importance + conflict + edge weights + reverse memory + embedding migration + sparse self-heal). Returns a taskId immediately (does not block the session); progress is polled via GET /api/maintain/status?taskId=... or streamed via GET /api/maintain/stream?taskId=... .",
      parameters: Type.Object({}),
      async execute() {
        if (!_driver || !_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro 未连接" }], details: {} };
        }
        try {
          // v2.8.x: 异步后台任务——立即返回 taskId，避免同步调用阻塞会话触发 stalled-session。
          // 进度经 API server 查询/SSE 流式输出（14 个 phase 流水线，含 progress%/当前 phase）。
          const [nodeCount, edgeCount] = await Promise.all([
            getNodeCount(_driver),
            getEdgeCount(_driver),
          ]);
          const { startMaintainTask } = await import("./src/graph/maintenance-task.ts");
          const snapshot = startMaintainTask(
            _driver, _cfg, _llm ?? undefined, _embed ?? undefined, _batchEmbed ?? undefined,
          );
          const lines = [
            "🚀 维护任务已启动 (async)",
            `TaskId: ${snapshot.taskId}`,
            `节点总数: ${nodeCount}`,
            `关系总数: ${edgeCount}`,
            `Phase: 0/${snapshot.phaseTotal}`,
            `Progress: GET /api/maintain/status?taskId=${snapshot.taskId}`,
            `Stream: GET /api/maintain/stream?taskId=${snapshot.taskId}`,
            "Poll until status=done; result summary (merged/communities/self-heal/...) appears in snapshot.result once finished.",
          ];
          return { content: [{ type: "text", text: lines.join("\n") }], details: { nodeCount, edgeCount, ...snapshot } };
        } catch (err) {
          return { content: [{ type: "text", text: `维护启动失败: ${(err as Error).message}` }], details: {} };
        }
      },
    });

    // gm_reembed: 批量重新向量化
    api.registerTool({
      name: "gm_reembed",
      label: "Graph Memory Re-Embed",
      description: "Start a background re-embed of all active nodes missing an embedding vector (only processes status=active with empty/null embedding). Returns a taskId immediately (does not block the session); progress is polled via GET /api/reembed/status?taskId=... or streamed via GET /api/reembed/stream?taskId=... .",
      parameters: Type.Object({}),
      async execute() {
        if (!_driver || !_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro not connected" }], details: {} };
        }
        if (!_embed) {
          return { content: [{ type: "text", text: "Embedding engine not configured" }], details: {} };
        }
        try {
          // v2.8.x: 异步后台任务——立即返回 taskId，避免同步调用阻塞会话触发 stalled-session。
          // 进度经 API server 查询/SSE 流式输出（每批 400 节点，含 progress%/批次/数量）。
          const { startReembedTask } = await import("./src/graph/reembed-task.ts");
          const snapshot = startReembedTask(
            _driver, _cfg, _embed ?? undefined, _batchEmbed ?? undefined,
            { batchSize: _cfg.background?.reembedBatchSize ?? 400 },
          );
          const lines = [
            "Re-Embed task started (async)",
            `TaskId: ${snapshot.taskId}`,
            `BatchSize: ${snapshot.batchSize}`,
            `Progress: GET /api/reembed/status?taskId=${snapshot.taskId}`,
            `Stream: GET /api/reembed/stream?taskId=${snapshot.taskId}`,
            "Poll until status=done; totals (totalNodes/totalBatches) appear once counting finishes (~seconds).",
          ];
          return { content: [{ type: "text", text: lines.join("\n") }], details: snapshot };
        } catch (err) {
          return { content: [{ type: "text", text: "Re-Embed start failed: " + String(err) }], details: {} };
        }
      },
    });

    // v2.1.2 第二批 I-2/I-3: 反馈提交工具
    // Agent 在收到 assistant 回复后调用，记录哪些召回节点被实际使用
    api.registerTool({
      name: "gm_feedback",
      label: "Graph Memory Feedback",
      description: "Submit feedback on which recalled nodes were actually used in the assistant reply. Triggers I-2 heuristic judge + I-3 persistence.",
      parameters: Type.Object({
        query: Type.String({ description: "Original user query" }),
        recalledNodeIds: Type.Array(Type.String({ default: "" }), { description: "Node IDs returned by recall" }),
        assistantReply: Type.String({ description: "Assistant's reply content", default: "" }),
        sessionId: Type.Optional(Type.String({ default: "" })),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async execute(_callId: string, params: any) {
        if (!_driver || !_recaller) {
          return { content: [{ type: "text", text: "Graph Memory Pro not connected" }], details: {} };
        }
        try {
          // 加载召回的节点（用于裁判判断）
          const { findById } = await import("./src/store/store.ts");
          const driver = _driver;
          const recalledNodes = (await Promise.all(
            (params.recalledNodeIds as string[]).map(id => findById(driver, id)),
          )).filter(Boolean) as GmNode[];

          // 调用 Recaller.processFeedback（I-2 判断 + I-3 持久化）
          await _recaller.processFeedback(
            params.query,
            recalledNodes,
            params.assistantReply,
            params.sessionId,
          );

          const jm = _recaller.getJudgeManager();
          const text = [
            "✅ Feedback submitted",
            `Recalled: ${recalledNodes.length} nodes`,
            `Cold start: ${jm?.isColdStart() ? "yes (heuristic only)" : "no"}`,
            `Total feedbacks: ${jm?.getFeedbackCount() ?? 0}`,
          ].join("\n");
          return { content: [{ type: "text", text }], details: { submitted: true } };
        } catch (err) {
          return { content: [{ type: "text", text: `Feedback failed: ${(err as Error).message}` }], details: {} };
        }
      },
    });

    // v2.3.5 B2: Bootstrap 反馈工具
    // 用历史节点合成 warmup 反馈，快速突破冷启动死循环
    api.registerTool({
      name: "gm_bootstrap",
      label: "Graph Memory Bootstrap Feedback",
      description: "Bootstrap feedback by synthesizing warmup data from existing graph nodes. Breaks the cold-start deadlock when the graph has historical nodes but zero feedback. Uses each node's name as both query and reply so Tier 1 heuristic judge always marks it as 'used'. Run ONCE to exit cold start; do not call repeatedly.",
      parameters: Type.Object({
        maxNodes: Type.Optional(Type.Number({
          description: "Max nodes to bootstrap (default 100, max 500)",
          minimum: 10,
          maximum: 500,
        })),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async execute(_callId: string, params: any) {
        if (!_driver || !_recaller) {
          return { content: [{ type: "text", text: "Graph Memory Pro not connected" }], details: {} };
        }
        try {
          const maxNodes = Math.min(Math.max(params?.maxNodes ?? 100, 10), 500);
          const { getTopNodes } = await import("./src/store/store.ts");
          const nodes = await getTopNodes(_driver, maxNodes);
          if (nodes.length === 0) {
            return { content: [{ type: "text", text: "No nodes in graph to bootstrap" }], details: { bootstrapped: 0 } };
          }

          const jm = _recaller.getJudgeManager();
          const before = jm?.getFeedbackCount() ?? 0;
          const beforeCold = jm?.isColdStart() ?? true;

          let bootstrapped = 0;
          let failed = 0;
          for (const node of nodes) {
            try {
              const reply = `${node.name} ${node.description ?? ""} ${node.content ?? ""}`.slice(0, 1000);
              // v2.3.6 fix: 强制同步执行，保证每条反馈的持久化 + 计数在下一条前完成，
              // 使下方 before/after 计数与冷启动判断准确（默认 asyncMode=true 时计数会滞后）。
              await _recaller.processFeedback(node.name, [node], reply, "bootstrap", { sync: true });
              bootstrapped++;
            } catch {
              failed++;
            }
          }

          const after = jm?.getFeedbackCount() ?? 0;
          const afterCold = jm?.isColdStart() ?? true;
          const lines = [
            `Bootstrapped: ${bootstrapped}/${nodes.length} (failed: ${failed})`,
            `Feedback count: ${before} → ${after}`,
            `Cold start: ${beforeCold ? "yes" : "no"} → ${afterCold ? "yes" : "no (exited)"}`,
            afterCold
              ? `Still in cold start. Need ${jm?.getConfig().judgeWarmupFeedbacks ?? 20} total to exit.`
              : `Cold start exited. Judge will now use Tier ${jm?.getConfig().tier ?? 1}.`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }], details: { bootstrapped, failed, feedbackCount: after } };
        } catch (err) {
          return { content: [{ type: "text", text: `Bootstrap failed: ${(err as Error).message}` }], details: {} };
        }
      },
    });

    // v2.1.2 第五批 S-10: Benchmark 评测工具
    // Agent 触发标准评测（LoCoMo / LongMemEval），输出量化指标
    api.registerTool({
      name: "gm_benchmark",
      label: "Graph Memory Benchmark",
      description: "Run S-10 Benchmark evaluation (LoCoMo + LongMemEval) on the current graph memory. Outputs P@1 / P@3 / MRR / F1 / P99 latency / token consumption. Use to quantify recall quality before/after tuning.",
      parameters: Type.Object({
        datasets: Type.Optional(Type.Union([
          Type.Literal("all"),
          Type.Array(Type.String({ default: "" })),
        ])),
        maxCases: Type.Optional(Type.Number({ description: "Max cases per dataset (0 = all)" })),
        buildGraph: Type.Optional(Type.Boolean({ description: "Build graph from conversation history before evaluation (default true)" })),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async execute(_callId: string, params: any) {
        if (!_recaller || !_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro not connected" }], details: {} };
        }
        try {
          const { runBenchmark, formatAggregateReport } = await import("./src/benchmark/runner.ts");
          const result = await runBenchmark(_recaller, _driver, _cfg, {
            datasets: params.datasets ?? "all",
            maxCases: params.maxCases ?? _cfg.benchmark?.maxCases ?? 0,
            buildGraph: params.buildGraph ?? _cfg.benchmark?.buildGraph ?? true,
            caseTimeoutMs: _cfg.benchmark?.caseTimeoutMs ?? 30_000,
            dataDir: resolveBenchmarkDataDir(undefined),
            llm: _llm ?? undefined,
            embedFn: _embed ?? undefined,
          });
          const text = formatAggregateReport(result);
          return { content: [{ type: "text", text }], details: result.aggregate };
        } catch (err) {
          return { content: [{ type: "text", text: `Benchmark failed: ${(err as Error).message}` }], details: {} };
        }
      },
    });

    // v2.1.2 第五批 R-1: 自主调优（EvolveMem）工具
    // Agent 触发一次 EvolveMem 四步循环：EVALUATE → DIAGNOSE → PROPOSE → GUARD
    api.registerTool({
      name: "gm_tune",
      label: "Graph Memory Auto-Tune",
      description: "Run one EvolveMem auto-tuning cycle (R-1). Evaluates current config on benchmark, diagnoses failures via LLM/heuristic, proposes parameter adjustments, and guards against regressions. Requires benchmark + autoTuner enabled.",
      parameters: Type.Object({
        rounds: Type.Optional(Type.Number({ description: "Number of tune cycles to run (default 1, max bounded by config maxRounds)" })),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async execute(_callId: string, params: any) {
        if (!_recaller || !_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro not connected" }], details: {} };
        }
        if (_cfg.autoTuner?.enabled !== true) {
          return { content: [{ type: "text", text: "AutoTuner disabled. Set autoTuner.enabled=true in config." }], details: {} };
        }
        try {
          const { AutoTuner } = await import("./src/evolution/auto-tuner.ts");
          // 持久化 AutoTuner 状态到本地文件，跨 gm_tune 调用保留 snapshots/bestMetrics
          // 修复 R-1 设计缺陷：旧实现每次新建 AutoTuner，导致 revert-on-regression 永不触发
          const { readFile, writeFile, mkdir } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const statePath = join(
            process.env.HOME || process.env.USERPROFILE || ".",
            ".openclaw", "graph-memory-pro", "auto-tuner-state.json",
          );
          const tuner = new AutoTuner(_cfg.autoTuner, _llm ?? undefined);
          tuner.setInitialAction(_cfg);
          // 尝试从持久化文件恢复状态
          try {
            const saved = await readFile(statePath, "utf-8");
            if (saved && saved.trim()) tuner.deserialize(saved);
          } catch { /* 首次运行无状态文件 */ }

          const rounds = Math.max(1, Math.min(params.rounds ?? 1, _cfg.autoTuner?.maxRounds ?? 10));
          const results: TuneCycleResult[] = [];
          for (let i = 0; i < rounds; i++) {
            // v2.3.6 fix: 透传 embedFn，使调优评测建图带 embedding（与 gm_benchmark 一致）
            const r = await tuner.runTuneCycle(_recaller, _driver, _cfg, _embed ?? undefined);
            results.push(r);
            if (!r.applied) break;
          }
          // 持久化最新状态
          try {
            await mkdir(join(statePath, "..").replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {});
            await writeFile(statePath, tuner.serialize()).catch(() => {});
          } catch { /* 持久化失败不影响调优结果 */ }

          const lines = [
            "🔧 EvolveMem Auto-Tuning",
            `Rounds executed: ${results.length}`,
            `Total tune rounds (persisted): ${tuner.getTuneRound()}`,
            `Snapshots: ${tuner.getSnapshots().length}`,
            "",
            ...results.map((r, i) =>
              `Round ${i + 1}: ${r.applied ? "applied" : "skipped"} — ${r.reason}${r.isImprovement ? " ✨ improvement" : ""}${r.metrics ? ` | P@1=${(r.metrics.p1 * 100).toFixed(1)}%` : ""}`,
            ),
            "",
            `Current action: ${JSON.stringify(tuner.getCurrentAction())}`,
            "",
            "✅ 调优参数已自动应用到 Recaller，即时生效。",
          ];
          return { content: [{ type: "text", text: lines.join("\n") }], details: { rounds: results, finalAction: tuner.getCurrentAction(), totalRounds: tuner.getTuneRound(), snapshots: tuner.getSnapshots().length } };
        } catch (err) {
          return { content: [{ type: "text", text: `Auto-tune failed: ${(err as Error).message}` }], details: {} };
        }
      },
    });

    // v2.8.x: embed 批处理容量实测工具
    // 直接读取**当前生效配置**（_cfg.embedding），在本机实测出 maxBatchChars 参考值。
    // 与 CLI（npm run bench:embed-batch）共用 src/engine/embed-bench.ts，逻辑不漂移。
    api.registerTool({
      name: "gm_embed_bench",
      label: "Graph Memory Embed Batch Bench",
      description:
        "Measure the safe per-request char budget for batch embedding (embedding.maxBatchChars) on THIS machine, using the live config. Tested across three profiles: short (~40 chars/item), mixed (40/400/800 rotating), long (~800 chars/item). Item-count steps are derived from the configured embedding.batchSize (not hardcoded), and requests never exceed batchSize. Returns a recommended maxBatchChars = most conservative passing value across profiles x safety factor. By default read-only (measures and recommends only). Pass apply:true to also hot-apply the resulting maxBatchChars/batchSize to the RUNNING engine (rebuilds the batch embed fn, re-injects into Recaller/API routes/shared state) — this takes effect immediately without a Gateway restart, but is RUNTIME-ONLY: it does not write the config file, so a restart reverts it. Persist manually with the printed config line if the value proves good.",
      parameters: Type.Object({
        targetMs: Type.Optional(Type.Number({
          description: "Latency budget per request in ms (default: half of the batch timeout, 60000). Lower = more conservative recommendation.",
        })),
        safety: Type.Optional(Type.Number({
          description: "Extra safety factor applied to the passing budget (default 0.9). targetMs already carries ~2x headroom over the 120s timeout.",
        })),
        repeats: Type.Optional(Type.Number({
          description: "Repeat each step and take the slowest success (default 2). Higher = less noisy but slower.",
        })),
        profiles: Type.Optional(Type.Array(Type.String(), {
          description: "Restrict profiles: subset of [\"short\",\"mixed\",\"long\"] (default: all three).",
        })),
        batchSize: Type.Optional(Type.Number({
          description: "Override embedding.batchSize. Without apply it only affects this run's steps; with apply:true it is also written to the running config.",
        })),
        maxBatchChars: Type.Optional(Type.Number({
          description: "Explicit maxBatchChars to use instead of the measured recommendation (only meaningful with apply:true). 0 disables the char budget.",
        })),
        apply: Type.Optional(Type.Boolean({
          description: "Default false (measure only). When true, apply the value to the running engine immediately (runtime-only, reverts on restart).",
        })),
        persist: Type.Optional(Type.Boolean({
          description: "Default false. When true, also write the value into ~/.openclaw/openclaw.json (plugins.entries[\"graph-memory-pro\"].config.embedding) so it survives restarts. Safety: only writes when the file is strict JSON and the plugin's embedding section is already present (never creates structure); backs up to <path>.bak-<timestamp> first and replaces atomically. Combine with apply:true to get both immediate effect and persistence.",
        })),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async execute(_callId: string, params: any) {
        if (!_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro not connected" }], details: {} };
        }
        const embedCfg = _cfg.embedding;
        if (!embedCfg?.baseURL && !embedCfg?.model) {
          return { content: [{ type: "text", text: "embedding 未配置（baseURL / model 均为空），无法实测。" }], details: {} };
        }
        try {
          const { runEmbedBatchBench } = await import("./src/engine/embed-bench.ts");
          const overrideBatchSize = Number.isFinite(params?.batchSize) && params.batchSize >= 1
            ? Math.floor(params.batchSize)
            : undefined;
          // 覆盖项：不带 apply 时只作用于本次实测的档位推导
          const runCfg = overrideBatchSize ? { ...embedCfg, batchSize: overrideBatchSize } : embedCfg;
          const report = await runEmbedBatchBench(runCfg, {
            targetMs: params?.targetMs ? Math.floor(params.targetMs) : undefined,
            safety: params?.safety ? Number(params.safety) : undefined,
            repeats: params?.repeats ? Math.max(1, Math.floor(params.repeats)) : undefined,
            profiles: Array.isArray(params?.profiles) && params.profiles.length
              ? params.profiles.filter((p: unknown) => p === "short" || p === "mixed" || p === "long")
              : undefined,
          });

          const rec = report.recommendedMaxBatchChars;
          const header = [
            "Embed batch capacity bench（读取当前配置实测）",
            `端点: ${report.endpoint}`,
            `模型: ${report.config.model}｜batchSize=${report.config.batchSize}（配置值）｜当前 maxBatchChars=${report.config.maxBatchChars || "0（未启用）"}`,
            `目标单请求耗时: ≤ ${report.targetMs}ms｜安全系数: ${report.safety}`,
            "",
          ];
          const tail = rec === undefined
            ? ["", "未测出结论：无档位达标，请检查服务可用性或放宽 targetMs。"]
            : rec === 0
              ? ["", "结论：保持 maxBatchChars = 0（关闭）——条数上限本身已能兜住最坏载荷，启用反而会把安全请求切碎。"]
              : [
                  "",
                  "将参考值写入 embedding 配置即可生效（持久化，需重启）：",
                  `  "embedding": { "maxBatchChars": ${rec} }`,
                ];

          // ── 可选：应用到运行时（apply）与/或落盘（persist），默认两者都不做 ──
          const applyLines: string[] = [];
          // 应用后的实际值（供 details 回传）；null = 本次未应用
          let appliedChars: number | null = null;
          let appliedSize: number | null = null;
          let persisted: { ok: boolean; path: string; changed?: boolean; backupPath?: string; error?: string } | null = null;

          const wantsApply = params?.apply === true;
          const wantsPersist = params?.persist === true;
          const explicitTarget = Number.isFinite(params?.maxBatchChars) && params.maxBatchChars >= 0
            ? Math.floor(params.maxBatchChars)
            : undefined;
          // apply 与 persist 共用同一个目标值：显式指定优先，否则用实测结论
          const target = explicitTarget ?? rec;

          if (wantsApply || wantsPersist) {
            if (target === undefined) {
              applyLines.push("", "⚠ 未执行：没有可用值（无档位达标）。请放宽 targetMs 或检查 embedding 服务后重试。");
            } else {
              // ① 热应用到运行中的引擎
              if (wantsApply) {
                const beforeChars = embedCfg.maxBatchChars ?? 0;
                const beforeSize = embedCfg.batchSize ?? 32;
                // 替换为新的 embedding 对象（_cfg 被 publishSharedState 按引用共享，故各实例可见）
                _cfg.embedding = {
                  ...embedCfg,
                  maxBatchChars: target,
                  ...(overrideBatchSize !== undefined ? { batchSize: overrideBatchSize } : {}),
                };
                const { createBatchEmbedFn } = await import("./src/engine/embed.ts");
                _batchEmbed = createBatchEmbedFn(_cfg.embedding);
                // 重新注入：Recaller 持有函数引用、API routes 持有函数引用，都必须换新
                if (_recaller) _recaller.setBatchEmbedFn(_batchEmbed);
                if (_driver) {
                  try {
                    const { initRoutes } = await import("./src/routes/crud.ts");
                    initRoutes(_driver, _cfg, _llm ?? undefined, _embed ?? undefined, _recaller ?? undefined, _batchEmbed ?? undefined);
                  } catch (err) {
                    applyLines.push(`⚠ routes 重新注入失败（不影响 Recaller 路径）：${(err as Error).message}`);
                  }
                }
                publishCoreResources();
                appliedChars = target;
                appliedSize = _cfg.embedding.batchSize ?? 32;
                applyLines.push(
                  "",
                  "✅ 已热应用到运行中的引擎（即时生效，无需重启）：",
                  `  maxBatchChars: ${beforeChars} → ${target}`,
                  `  batchSize: ${beforeSize} → ${appliedSize}`,
                  "  已重建 batch embed 引擎，并重新注入 Recaller / API routes / 进程内共享状态。",
                );
              }

              // ② 自动落盘到 openclaw.json（重启后依然生效）
              if (wantsPersist) {
                const { persistEmbeddingParams } = await import("./src/config-file.ts");
                const r = await persistEmbeddingParams({
                  maxBatchChars: target,
                  ...(overrideBatchSize !== undefined ? { batchSize: overrideBatchSize } : {}),
                });
                persisted = { ok: r.ok, path: r.path, changed: r.changed, backupPath: r.backupPath, error: r.error };
                const manual = `   "embedding": { "maxBatchChars": ${target}${overrideBatchSize !== undefined ? `, "batchSize": ${overrideBatchSize}` : ""} }`;
                if (!r.ok) {
                  applyLines.push(
                    "",
                    `⚠ 落盘失败：${r.error}`,
                    `  目标文件：${r.path}`,
                    "  如需手工落盘，请写入：",
                    manual,
                  );
                } else if (r.changed === false) {
                  applyLines.push("", `✅ 配置文件已是目标值，无需改动：${r.path}`);
                } else {
                  applyLines.push(
                    "",
                    "✅ 已自动落盘到配置文件（重启后依然生效）：",
                    `  ${r.path}`,
                    `  embedding.maxBatchChars = ${target}${overrideBatchSize !== undefined ? `, embedding.batchSize = ${overrideBatchSize}` : ""}`,
                    ...(r.backupPath ? [`  原文件已备份：${r.backupPath}`] : []),
                    "  注意：宿主当前生效配置来自内存，重启 Gateway 后才会读到本次写入的值。",
                  );
                }
              }
            }
          } else if (rec !== undefined) {
            applyLines.push(
              "",
              "如需即时生效（不改配置文件、重启前有效）可传 apply:true；",
              "如需写入 openclaw.json 持久化（重启后仍生效）可传 persist:true；两者可同时传。",
            );
          }

          return {
            content: [{ type: "text", text: [...header, report.summary, ...tail, ...applyLines].join("\n") }],
            details: {
              endpoint: report.endpoint,
              config: report.config,
              targetMs: report.targetMs,
              safety: report.safety,
              recommendedMaxBatchChars: rec,
              recommendationReason: report.recommendationReason,
              beneficial: report.beneficial,
              results: report.results,
              applied: params?.apply === true,
              appliedMaxBatchChars: appliedChars,
              appliedBatchSize: appliedSize,
              persisted,
            },
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Embed bench failed: ${(err as Error).message}` }], details: {} };
        }
      },
    });

  },
});

// ─── Re-exports for lcm-graph-extra ─────────────────────────
export { ensureSchema, searchNodes, getEdgesForNodes, getTopNodes, getNodeCount, getEdgeCount } from "./src/store/store.js";
export { upsertNode, upsertEdge, mergeNodes, findById } from "./src/store/store.js";
export { Recaller } from "./src/recaller/recall.js";
export { getDriver, setDriver } from "./src/store/db.js";
// registerExternalDriver 已在模块级定义并导出（见上方）
export { runMaintenance } from "./src/graph/maintenance.js";
export { Extractor, extractTriplets } from "./src/extractor/extract.ts";

// ─── v2.1.2 G-5 图谱健康（供 lcm-graph-extra dashboard 调用）─────────
// dashboard-snapshot.ts 的 resolveGraphHealth 通过 withGmProFallback('getGraphHealth', ...)
// 调用本函数。返回 dashboard 期望的 { status, nodeCount, relationshipCount, ... } 格式。
// 内部委托给 healthCheck(driver)，并根据 anomalies 数量推断 status。
export async function getGraphHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  nodeCount: number;
  relationshipCount: number;
  staleNodeCount: number;
  lastMaintenanceAt?: number;
  avgQueryLatencyMs?: number;
  errorRate?: number;
  details?: Record<string, unknown>;
}> {
  // 动态 import 避免循环依赖（getDriver 从 store/db re-export，但不在此模块作用域）
  const { getDriver } = await import('./src/store/db.js');
  const driver = getDriver();
  if (!driver) {
    return {
      status: 'unknown',
      nodeCount: 0,
      relationshipCount: 0,
      staleNodeCount: 0,
      details: { reason: 'driver not initialized' },
    };
  }
  const { healthCheck } = await import('./src/graph/maintenance.ts');
  const report = await healthCheck(driver);
  // 根据 anomalies 数量推断 status：
  // - 0 个异常 → healthy
  // - 1-2 个异常 → degraded
  // - >=3 个异常 → unhealthy
  const anomalyCount = report.anomalies.length;
  const status: 'healthy' | 'degraded' | 'unhealthy' =
    anomalyCount === 0 ? 'healthy' : (anomalyCount >= 3 ? 'unhealthy' : 'degraded');
  return {
    status,
    nodeCount: report.nodes.total,
    relationshipCount: report.edges.total,
    staleNodeCount: report.highStaleNodes,
    details: {
      anomalies: report.anomalies,
      isolatedNodes: report.isolatedNodes,
      communities: report.communities,
      avgPageRank: report.avgPageRank,
      nodes: report.nodes,
      edges: report.edges,
      topNodes: report.topNodes,
      timestamp: report.timestamp,
    },
  };
}
export type { GraphHealthReport } from './src/graph/maintenance/health.ts';

// ─── Additional re-exports for lcm-graph-extra (Layer 1 fix) ────
export { personalizedPageRank, computeGlobalPageRank } from "./src/graph/pagerank.js";
export { detectCommunities, summarizeCommunities, getCommunityPeers } from "./src/graph/community.js";
export { getVectorHash, computeEmbeddingHash } from "./src/store/store.js";
export { dedup } from "./src/graph/dedup.js";
export type { GmConfig, NodeType, EdgeType, NodeStatus, GmNode, GmEdge, RecallResult, EmbeddingConfig } from "./src/types.js";
export { createEmbedFn } from "./src/engine/embed.js";
export { setTimingEnabled, printAllDistributions, resetAllDistributions, LatencyDistribution } from "./src/timing.js";
export type { EmbedFn } from "./src/engine/embed.js";

// ─── v2.1.2 第二批 反馈闭环 + 冷启动 Re-exports ─────────────────────────
export { upsertFeedback, getFeedbackCount, getNodeFeedbackStats } from "./src/store/store.js";
export type { GmFeedback } from "./src/store/store.js";
export { QueryCache } from "./src/recaller/query-cache.js";
export { JudgeManager, isMatrixColdStart, getColdStartSearchWeights } from "./src/recaller/judge.js";
export type { JudgeConfig, JudgeResult, JudgeFeedback, WarmupConfig } from "./src/recaller/judge.js";

// ─── v2.1.2 第三批 在线学习 + 可进化嵌入 + 重要性评分 Re-exports ─────────
export { AssociationMatrix, createAssociationMatrix } from "./src/recaller/association-matrix.js";
export type { AssociationMatrixConfig, MarginalUtilityConfig } from "./src/recaller/association-matrix.js";
// v2.3.6: 关联矩阵 M 持久化（供 lcm-graph-extra 等外部插件对接）
export {
  getAssociationMatrixPath,
  getDefaultBaseDir,
  saveAssociationMatrix,
  loadAssociationMatrix,
  tryLoadAssociationMatrix,
  createAssociationMatrixPersisted,
  saveRecallerAssociationMatrix,
} from "./src/recaller/association-matrix-persist.js";
export type { AssociationMatrixPersistOptions, AssociationMatrixSaveResult } from "./src/recaller/association-matrix-persist.js";
export { computeImportanceScores } from "./src/graph/maintenance.js";
export type { ImportanceConfig } from "./src/graph/maintenance.js";

// ─── v2.1.2 第四批 结构升级 + 冲突消解 + 嵌入版本 Re-exports ─────────
export { detectHierarchicalCommunities, drillDownCommunity } from "./src/graph/community.js";
export type { HierarchicalCommunityResult } from "./src/graph/community.js";
export { resolveConflicts, adjustEdgeWeights, applyReverseMemory } from "./src/graph/maintenance.js";
export type { ConflictResolutionConfig, EdgeWeightsConfig, ReverseMemoryConfig } from "./src/graph/maintenance.js";
export { detectAndMigrateEmbeddings } from "./src/graph/reembed.js";
export type { MigrationResult } from "./src/graph/reembed.js";

// ─── v2.1.2 第五批 Benchmark + 自主调优 Re-exports ─────────
export { runBenchmark, formatAggregateReport } from "./src/benchmark/runner.ts";
export { resolveBenchmarkDataDir, readBenchmarkDataDirFromOpenclaw, DEFAULT_BENCHMARK_DATA_DIR } from "./src/benchmark/dataDir.ts";
export type { BenchmarkOptions, BenchmarkRunResult } from "./src/benchmark/runner.ts";
export {
  computeP1, computeP3, computeMRR, computeF1, computeP99Latency, computeAvgTokenEstimate,
  evaluateCase, buildReport, formatReport,
} from "./src/benchmark/types.ts";
export type { BenchmarkCase, BenchmarkDataset, BenchmarkReport, CaseResult } from "./src/benchmark/types.ts";
export { loadAllDatasets, loadLoCoMo, loadLongMemEval, getBuiltinSampleDataset } from "./src/benchmark/datasets.ts";
export {
  AutoTuner, extractActionSpace, applyActionSpace, clampAction, ACTION_BOUNDS, DEFAULT_AUTOTUNER_CONFIG,
} from "./src/evolution/auto-tuner.ts";
export type {
  EvolveActionSpace, AutoTunerConfig, TuneCycleResult, DiagnosisResult, ConfigSnapshot,
} from "./src/evolution/auto-tuner.ts";

// ═══════════════════════════════════════════════════════════════════════
// v2.3.6 综合能力聚合导出（供 lcm-graph-extra 等外部插件完整对接）
//
// 按能力域分组，覆盖：反馈闭环 / 召回 / 在线学习 / 图操作 / 引擎 / 运维。
// 外部插件统一从包入口 `import { ... } from "graph-memory-pro"` 取用。
// ═══════════════════════════════════════════════════════════════════════

// ── 会话召回缓存（反馈自动采集链路：agent_end 记录 → processFeedback 消费）─
export { SessionRecallCache, getSessionRecallCache, resetSessionRecallCache } from "./src/recaller/session-recall-cache.js";
export type { RecallRecord, ConsumedRecall } from "./src/recaller/session-recall-cache.js";

// ── 熔断器（embed / LLM 失败降级监控）────────────────────────────
export { CircuitBreaker, getCircuitBreaker, getAllCircuitBreakers, resetAllCircuitBreakers } from "./src/engine/circuit-breaker.js";
export type { CircuitState, CircuitBreakerOptions, CircuitBreakerStatus } from "./src/engine/circuit-breaker.js";

// ── LLM 引擎（CompleteFn 补全函数，含重试/超时/取消）──────────────
export { createCompleteFn, createRuntimeCompleteFn } from "./src/engine/llm.js";
export type { CompleteFn, RuntimeLlm } from "./src/engine/llm.js";

// ── 图存储完整操作（store barrel 补充导出）────────────────────────
export {
  batchUpsertNodes,
  vectorSearchWithScore,
  graphWalk,
  getNodesByType,
  batchUpsertEdges,
  updateCommunities,
  getCommunitySummary,
  getAllCommunitySummaries,
  communityVectorSearch,
  communityVectorSearchWithReps,
  saveVector,
  saveMessage,
  getSessionMessages,
  getRecentDistinctMessages,
} from "./src/store/store.js";

// ── Neo4j 连接池 / 会话 / 版本探测 ────────────────────────────────
export {
  createDriver,
  initDriver,
  closeDriver,
  getConfig as getNeo4jConfig,
  getSession,
  getNeo4jVersion,
  isNeo4j5Plus,
  verifyConnectivity,
  verifyWithRetry,
  getPoolMetrics,
} from "./src/store/db.js";
export type { Neo4jConfig } from "./src/types.js";
export type { PoolMetrics } from "./src/store/db.js";

// ── 上下文组装（assemble：把召回节点组装成 system prompt / xml）─────
export { assembleContext, buildSystemPromptAddition } from "./src/format/assemble.js";
export { sanitizeToolUseResultPairing } from "./src/format/transcript-repair.js";

// ── 增量维护（脏标记驱动的局部维护）──────────────────────────────
export { markDirty, getDirtyNodeIds, clearDirty, runIncrementalMaintenance } from "./src/graph/incremental-maintenance.js";
export type { IncrementalMaintenanceResult } from "./src/graph/incremental-maintenance.js";

// ── 后台抽取服务（消息对 → 图谱三元组）────────────────────────────
export { extractInBackground } from "./src/services/extract-service.js";

// ── HTTP API Server（独立启动，供外部拉起 dashboard / crud）────────
export { startApiServer } from "./src/server/http-server.js";
export type { ApiServerConfig, ApiServerHandle } from "./src/server/http-server.js";

// ── 配置热重载（diff / 鉴权 / 规范化）────────────────────────────
export { diffConfigSegments, checkReloadAuth, normalizeReloadConfig } from "./src/routes/reload.js";
export type { ConfigSegmentDiff, AuthResult } from "./src/routes/reload.js";

// ── 图谱健康检查（healthCheck 原生报告）──────────────────────────
export { healthCheck } from "./src/graph/maintenance/health.js";

// ── 裁判策略（Tier 1/2/3 判定，供外部自定义 judge 组装）────────────
export {
  HeuristicJudgeStrategy,
  LlmJudgeStrategy,
  parseLlmJudgeJson,
  DEFAULT_JUDGE_CONFIG,
  DEFAULT_WARMUP_CONFIG,
} from "./src/recaller/judge.js";
export type { JudgeTier, JudgeMatchedBy, JudgeStrategy } from "./src/recaller/judge.js";

// ── 查询缓存配置类型 ─────────────────────────────────────────────
export type { QueryCacheConfig } from "./src/recaller/query-cache.js";
