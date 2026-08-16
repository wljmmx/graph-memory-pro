/**
 * graph-memory-pro — Neo4j Knowledge Graph Memory Plugin
 *
 * Version: 2.3.2
 *
 * 架构定位（A 方案）:
 *   - 不占用 slots（memory/contextEngine）
 *   - 不再使用 before_prompt_build 钩子（避免与 contextEngine 双注入）
 *   - 通过 registerMemoryCorpusSupplement 把图谱暴露给 memory-core 的 memory_search
 *   - 三元组提取 / 图谱维护通过 registerService 后台运行，不阻塞主流程
 *   - HTTP 路由通过 api.registerHttpRoute 注册
 *   - 保留专业工具：gm_record / gm_maintain / gm_reembed（gm_search/gm_stats 已合并）
 *
 * Latest OpenClaw Plugin SDK compliance:
 * - definePluginEntry from openclaw/plugin-sdk/plugin-entry
 * - api.config 用于配置加载（不读文件系统）
 * - api.logger 用于结构化日志
 * - api.registerHttpRoute / registerService / registerMemoryCorpusSupplement
 */

import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { Driver } from "neo4j-driver";
import type { GmConfig, GmNode, NodeType } from "./src/types.ts";
import type { CompleteFn } from "./src/engine/llm.ts";
import type { EmbedFn, BatchEmbedFn } from "./src/engine/embed.ts";
import { createCompleteFn, createRuntimeCompleteFn } from "./src/engine/llm.ts";
import { createEmbedFn, createBatchEmbedFn } from "./src/engine/embed.ts";
import { initDriver, closeDriver, verifyWithRetry, verifyConnectivity, getDriver, setDriver as setDbDriver } from "./src/store/db.ts";
import { ensureSchema, getNodeCount, getEdgeCount, searchNodes, upsertNode, findById } from "./src/store/store.ts";
import { Extractor } from "./src/extractor/extract.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { runMaintenance, type GraphHealthReport } from "./src/graph/maintenance.ts";
import { resolveBenchmarkDataDir } from "./src/benchmark/dataDir.ts";
import { reEmbedNodes } from "./src/graph/reembed.ts";
import { setExternalLogger, createLogger } from "./src/logger.ts";
import { setTimingEnabled } from "./src/timing.ts";
import { extractInBackground } from "./src/services/extract-service.ts";  // v2.3.4 ARCH-1: 从 index.ts 拆出
import { getSessionRecallCache, resetSessionRecallCache } from "./src/recaller/session-recall-cache.ts";
import type { TuneCycleResult } from "./src/evolution/auto-tuner.ts";
import { startHeartbeat, type HeartbeatHandle, type HeartbeatProbe } from "./src/server/heartbeat.ts";  // v2.5.x 心跳自愈

const log = createLogger("index");

// ─── 类型定义（SDK 不导出类型，此处定义最小化接口） ──────

interface LoggerLike {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

interface AgentMessageContentBlock {
  type?: string;
  text?: string;
}

interface AgentMessageLike {
  role?: string;
  type?: string;
  content?: string | Array<AgentMessageContentBlock | string>;
  text?: string;
  body?: string;
}

interface AgentEndEvent {
  messages?: AgentMessageLike[];
}

interface AgentEndCtx {
  sessionKey?: string;
  sessionId?: string;
}

// ─── 全局状态 ──────────────────────────────────────────

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
let _mcpServerHandle: { close(): Promise<void> } | null = null;
let _apiServerHandle: { close(): Promise<void> } | null = null;
let _apiServerAutoStarted = false;
// 跟踪 API 服务器当前使用的 driver 实例
// 当 gateway_start 替换了自建 driver 时，需要重启 API 服务器
let _apiServerDriver: Driver | null = null;
// v2.5.x: 心跳自愈服务句柄（探测 API/MCP/driver，崩溃后自动重建）
let _heartbeatHandle: HeartbeatHandle | null = null;

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

function extractMessageText(msg: AgentMessageLike): string {
  if (!msg) return "";
  const content = msg.content ?? msg.text ?? msg.body ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (typeof b === "string" || b?.type === "text"))
      .map((b) => (typeof b === "string" ? b : b.text ?? ""))
      .join("\n");
  }
  return "";
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
          const { createAssociationMatrix } = await import("./src/recaller/association-matrix.ts");
          const { tryLoadAssociationMatrix } = await import("./src/recaller/association-matrix-persist.ts");
          const amDim = resolveEmbedDimension(cfg);
          const am = createAssociationMatrix(amDim, cfg);
          const { loaded, path } = await tryLoadAssociationMatrix(am);
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
    );
    log.info("API server started (module-level, full init)");

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
        const port = cfg.mcp?.port ?? 7800;
        const host = cfg.mcp?.host ?? "127.0.0.1";
        try {
          const resp = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(3000) });
          if (resp.ok) {
            log.info(`[graph-memory-pro] MCP server started + health OK (port=${port})`);
          } else {
            log.warn(`[graph-memory-pro] MCP server started but /health returned ${resp.status}`);
          }
        } catch (probeErr) {
          log.warn(`[graph-memory-pro] MCP server started but health probe failed: ${probeErr}`);
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
    if (!_extractorTimer) {
      try {
        const interval = cfg.background?.extractorIntervalMs ?? 60_000;
        _extractorTimer = startBackgroundExtractor(interval, apiLogger);
        log.info(`[graph-memory-pro] background extractor scheduled (interval=${interval}ms)`);
      } catch (err) {
        log.warn(`[graph-memory-pro] background extractor start failed: ${err}`);
      }
    }
    if (!_maintenanceTimer) {
      try {
        const interval = cfg.background?.maintenanceIntervalMs ?? 6 * 3600_000;
        const initialDelay = 5 * 60_000;
        _maintenanceTimer = startBackgroundMaintenance(interval, initialDelay, apiLogger);
        log.info(`[graph-memory-pro] background maintenance scheduled (interval=${interval}ms)`);
      } catch (err) {
        log.warn(`[graph-memory-pro] background maintenance start failed: ${err}`);
      }
    }

    // 9. 启动心跳自愈服务（v2.5.x）
    startHeartbeatMonitor();
  } catch (err) {
    log.error(`API server start failed: ${err}`);
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
      const processed = await extractInBackground(_extractor, _driver, _llm, _cfg, logger, pairs);
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
      }
    } catch (err) {
      logger?.warn?.(`[graph-memory-pro] extractor tick failed: ${err}`);
    } finally {
      _extractorRunning = false;
    }
  }, interval);
  return timer;
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
  if (_apiServerHandle) {
    try { await _apiServerHandle.close(); } catch { /* ignore */ }
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
    );
    log.info("[heartbeat] API server re-established");
  } catch (err) {
    log.error(`[heartbeat] API server restart failed: ${err}`);
  }
}

/** 重建 MCP server（先关闭旧句柄，再以当前组件重新启动） */
async function restartMcpServer(): Promise<void> {
  if (!_driver || !_cfg || _cfg.mcp?.enabled !== true) return;
  if (_mcpServerHandle) {
    try { await _mcpServerHandle.close(); } catch { /* ignore */ }
    _mcpServerHandle = null;
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
    log.info("[heartbeat] MCP server re-established");
  } catch (err) {
    log.error(`[heartbeat] MCP server restart failed: ${err}`);
  }
}

/** 重建 Neo4j driver（成功后用新 driver 重建两个 server，保证引用一致） */
async function recoverDriver(): Promise<void> {
  if (!_cfg) return;
  try {
    const d = initDriver(_cfg.neo4j); // initDriver 内部先 close 旧 driver 再创建
    const ok = await verifyWithRetry(d);
    if (ok) {
      _driver = d;
      setDbDriver(d);
      _apiServerDriver = d;
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

/** 启动心跳自愈服务（幂等：已有句柄则跳过） */
function startHeartbeatMonitor(): void {
  if (_heartbeatHandle) return;
  if (_cfg?.heartbeat?.enabled === false) {
    log.info("[heartbeat] monitor disabled via config");
    return;
  }

  const intervalMs = _cfg?.heartbeat?.intervalMs ?? 30_000;
  const probes: HeartbeatProbe[] = [];

  // API server 探针
  const apiPort = _cfg?.apiServer?.port ?? 7850;
  const apiHost = _cfg?.apiServer?.host ?? "127.0.0.1";
  probes.push({
    name: "api-server",
    check: async () => {
      if (!_apiServerHandle) return false;
      try {
        const resp = await fetch(`http://${apiHost}:${apiPort}/health`, { signal: AbortSignal.timeout(3000) });
        return resp.ok;
      } catch { return false; }
    },
    recover: restartApiServer,
  });

  // MCP server 探针（仅启用时）
  if (_cfg?.mcp?.enabled === true) {
    const mcpPort = _cfg.mcp?.port ?? 7800;
    const mcpHost = _cfg.mcp?.host ?? "127.0.0.1";
    probes.push({
      name: "mcp-server",
      check: async () => {
        if (!_mcpServerHandle) return false;
        try {
          const resp = await fetch(`http://${mcpHost}:${mcpPort}/health`, { signal: AbortSignal.timeout(3000) });
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
      if (!_driver) return false;
      return verifyConnectivity(_driver);
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
  log.info(`[heartbeat] monitor started (interval=${intervalMs}ms, probes=[${probes.map(p => p.name).join(", ")}])`);
}

async function autoStartApiServer(): Promise<void> {
  if (_apiServerAutoStarted) return;

  // v2.3.5 fix: 缩短纯轮询窗口（30s→10s），尽快尝试 self-init。
  //   原逻辑 30s 纯轮询期间 driver 为 null，quickHealth 误报 "driver unavailable"。
  //   新逻辑：10s 快速探测外部 driver，找不到就立即 self-init。
  const FAST_ATTEMPTS = 5;   // 5 × 2s = 10s
  const FAST_POLL_MS = 2000;
  const SLOW_POLL_MS = 10_000;

  log.info("auto-start: polling for gateway driver (10s fast phase)...");

  // 阶段 1：快速轮询 — 等待 register()/gateway_start 设置 driver
  for (let i = 0; i < FAST_ATTEMPTS; i++) {
    const driver = getDriver();
    if (driver) {
      _apiServerAutoStarted = true;
      await startApiServerFromDriver(driver);
      return;
    }
    await new Promise(r => setTimeout(r, FAST_POLL_MS));
  }

  // 阶段 2：自驱动初始化 — 轮询失败，尝试自建 driver
  log.warn("auto-start: gateway driver not ready after 10s, trying self-init...");
  const selfDriver = await trySelfInitDriver();
  if (selfDriver) {
    _apiServerAutoStarted = true;
    await startApiServerFromDriver(selfDriver);
    return;
  }

  // 阶段 3：慢速重试 — 自建失败，持续等待外部 driver 就绪
  log.warn("auto-start: self-init failed, switching to slow retry (every 10s)");
  _autoStartRetryTimer = setInterval(async () => {
    if (_apiServerAutoStarted) {
      if (_autoStartRetryTimer) { clearInterval(_autoStartRetryTimer); _autoStartRetryTimer = null; }
      return;
    }

    // 检查外部 driver 是否已就绪（register() 延迟调用或 graph-adapter 调用了 setDriver）
    const driver = getDriver();
    if (driver) {
      _apiServerAutoStarted = true;
      if (_autoStartRetryTimer) { clearInterval(_autoStartRetryTimer); _autoStartRetryTimer = null; }
      await startApiServerFromDriver(driver);
      return;
    }

    // 再次尝试自建 driver（Neo4j 可能刚启动）
    const selfDriverRetry = await trySelfInitDriver();
    if (selfDriverRetry) {
      _apiServerAutoStarted = true;
      if (_autoStartRetryTimer) { clearInterval(_autoStartRetryTimer); _autoStartRetryTimer = null; }
      await startApiServerFromDriver(selfDriverRetry);
    }
  }, SLOW_POLL_MS);
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
 * 返回模块级 Recaller 单例(A)，供外部插件（如 lcm-graph-extra）复用，
 * 避免各自 new Recaller 造成双实例 / 关联矩阵 M 分叉。
 * 未初始化时返回 null（调用方应降级或稍后重试）。
 */
export function getRecaller(): Recaller | null {
  return _recaller;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function doGatewayInit(api: any, logger: LoggerLike): Promise<void> {
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

  // 1. 连接 Neo4j
  const driver = await getOrCreateDriver(_cfg, logger);
  if (!driver) return;
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
  if (runtimeLlm && typeof runtimeLlm.complete === "function") {
    _llm = createRuntimeCompleteFn(runtimeLlm, _cfg.llm, logger as unknown as Parameters<typeof createRuntimeCompleteFn>[2]);
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
    const { createAssociationMatrix } = await import("./src/recaller/association-matrix.ts");
    const { tryLoadAssociationMatrix } = await import("./src/recaller/association-matrix-persist.ts");
    const amDim = resolveEmbedDimension(_cfg);
    const am = createAssociationMatrix(amDim, _cfg);
    const { loaded, path } = await tryLoadAssociationMatrix(am);
    _recaller.setAssociationMatrix(am);
    logger?.info?.(`[graph-memory-pro] association-matrix enabled (dim=${amDim}, warmup=${_cfg.associationMatrix?.warmupFeedbacks ?? _cfg.warmup?.warmupFeedbacks ?? 100}, persistedRestored=${loaded}, path=${path})`);
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
    const apiServerCfg = _cfg.apiServer;
    if (apiServerCfg?.enabled !== false) {
      try {
        const { startApiServer } = await import("./src/server/http-server.ts");
        _apiServerHandle = await startApiServer(
          driver, _cfg,
          {
            enabled: true,
            port: apiServerCfg?.port ?? 7850,
            host: apiServerCfg?.host ?? "127.0.0.1",
            authToken: apiServerCfg?.authToken,
          },
          logger,
          _llm ?? undefined,
          _embed ?? undefined,
          _recaller ?? undefined,
        );
        _apiServerAutoStarted = true;
        _apiServerDriver = driver;
      } catch (err) {
        logger?.error?.(`[graph-memory-pro] API server failed to start: ${err}`);
      }
    } else {
      logger?.info?.("[graph-memory-pro] API server disabled via config (apiServer.enabled=false)");
    }
  }

  log.info("initialized");
  logger?.info?.("[graph-memory-pro] initialized");

  // v2.5.x: 启动心跳自愈服务（幂等，self-init 已启动则跳过）
  startHeartbeatMonitor();
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
      options: Type.Optional(Type.Object({}, { additionalProperties: true, default: {} })),
    })),
    timing: Type.Optional(Type.Object({
      enabled: Type.Boolean({ default: false }),
      maxSamples: Type.Optional(Type.Number({ default: 1000 })),
      reportEveryN: Type.Optional(Type.Number({ default: 50 })),
    })),
    background: Type.Optional(Type.Object({
      extractorIntervalMs: Type.Optional(Type.Number({ default: 60_000 })),
      maintenanceIntervalMs: Type.Optional(Type.Number({ default: 6 * 3600_000 })),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(api: any) {
    log.info("register() called by Gateway");
    const logger = api.logger ?? console;
    // v2.2.0 P2-1：把 SDK logger 注入到结构化日志模块
    setExternalLogger(api.logger ?? null);

    // v2.3.5 fix: SDK 可能不触发 gateway_start hook，导致 driver 永远不初始化。
    // 在 register() 中直接从 api.pluginConfig 检测并启动初始化（fire-and-forget）。
    const eventCfg = api.pluginConfig ?? api.config;
    if (eventCfg?.neo4j?.uri) {
      log.info(`config detected in register(): neo4j.uri=${eventCfg.neo4j.uri}`);
      doGatewayInit(api, logger).catch(err => {
        log.error(`direct init from register() failed: ${err}`);
      });
    } else {
      log.info("no neo4j config in register(), waiting for gateway_start hook or auto-start");
    }

    // ── Gateway 启动时初始化（fallback） ──────────────────────
    api.registerHook("gateway_start", async (_event: unknown) => {
      log.info("gateway_start hook fired");
      if (_driver) {
        log.info("gateway_start: already initialized via register(), skipping");
        return;
      }
      await doGatewayInit(api, logger);
    }, { name: "graph-memory-pro-init" });

    // ── Gateway 停止时清理 ──────────────────────
    // v2.3.5 fix: compaction 会触发 gateway_stop → 再 register()，导致全量重建竞态。
    //   修复策略：gateway_stop 只清 timer 和 session cache，保留 driver 和 API server。
    //   - driver: Neo4j 连接池创建成本高（~100ms），compaction 后立即复用
    //   - API server: 端口已绑定，关了再开会 EADDRINUSE
    //   - 真正的进程退出时 OS 会自动回收连接和端口
    api.registerHook("gateway_stop", async () => {
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
      resetSessionRecallCache();
      // 注意：不再 closeDriver() / 关闭 API server / null 化组件
      // compaction 后 register() 会检测到 _driver 已存在并跳过重复初始化
    }, { name: "graph-memory-pro-cleanup" });

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
    api.registerHook("agent_end", async (event: AgentEndEvent, ctx: AgentEndCtx) => {
      // 功能开关
      if (_cfg?.autoFeedback?.enabled === false) return;
      if (!_driver || !_recaller) return;

      const sessionKey: string | undefined = ctx?.sessionKey ?? ctx?.sessionId;
      if (!sessionKey) return;

      // 消费该 session 的召回缓存（取完即清，避免重复采集）
      const recallRecord = getSessionRecallCache().consume(sessionKey);
      if (!recallRecord || recallRecord.nodeIds.length === 0) return;

      // 从 messages[] 提取最后一轮 user query + assistant reply
      const messages: AgentMessageLike[] = Array.isArray(event?.messages) ? event.messages : [];
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
    }, { name: "graph-memory-pro-auto-feedback" });

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
        if (_extractorTimer) return;
        const interval = _cfg?.background?.extractorIntervalMs ?? 60_000;
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
            // v2.4.2: 返回本批实际处理的对数（内部 maxPairs=3 限流），据此：
            //   1. 标记已处理消息（有 id 按 id，否则按 sessionKey+内容反查，避免下一轮/重建重复处理）
            //   2. 只清掉已处理的行，剩余行保留待下一轮（避免一次性清空导致 >3 对数据丢失）
            const processed = await extractInBackground(_extractor, _driver, _llm, _cfg, logger, pairs);

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
            }
          } catch (err) {
            logger?.warn?.(`[graph-memory-pro] extractor tick failed: ${err}`);
          } finally {
            _extractorRunning = false;
          }
        }, interval);
      },
      async stop(_ctx: unknown) {
        if (_extractorTimer) { clearInterval(_extractorTimer); _extractorTimer = null; }
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
        if (_maintenanceTimer) return;
        const interval = _cfg?.background?.maintenanceIntervalMs ?? 6 * 3600_000;
        // 启动后延迟 5 分钟执行第一次，避免与初始化竞争
        const initialDelay = 5 * 60_000;
        const runOnce = async () => {
          if (!_driver || !_cfg) return;
          // v2.3.2 S3: 重入保护 — 上一次 tick 仍在执行时跳过本次
          if (_maintenanceRunning) return;
          _maintenanceRunning = true;
          try {
            logger?.info?.("[graph-memory-pro] background maintenance start");
            const result = await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined, _batchEmbed ?? undefined);
            logger?.info?.(`[graph-memory-pro] maintenance done: ${result.dedup.merged} merged, ${result.community.count} communities`);
          } catch (err) {
            logger?.warn?.(`[graph-memory-pro] maintenance error: ${err}`);
          } finally {
            _maintenanceRunning = false;
          }
        };
        setTimeout(runOnce, initialDelay);
        _maintenanceTimer = setInterval(runOnce, interval);
      },
      async stop(_ctx: unknown) {
        if (_maintenanceTimer) { clearInterval(_maintenanceTimer); _maintenanceTimer = null; }
      },
    });

    // ─────────────────────────────────────────────────────────────────
    // v2.2.0: MCP Server（对外暴露 13 个 tools，供 dashboard 调用）
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
          if (_mcpServerHandle) return;
          try {
            const { startMcpServer } = await import("./src/mcp/server.ts");
            _mcpServerHandle = await startMcpServer(
              _driver, _cfg,
              _llm ?? undefined,
              _embed ?? undefined,
              _recaller ?? undefined,
              _batchEmbed ?? undefined,
            );
            // v2.3.3 MCP-1: 启动后健康探测，确认 server 真正就绪（非仅 listen 成功）
            const port = _cfg.mcp?.port ?? 7800;
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
          if (_mcpServerHandle) {
            try { await _mcpServerHandle.close(); } catch { /* ignore */ }
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
      } | null> {
        if (!_driver) return null;
        try {
          const n = await findById(_driver, params.lookup);
          if (!n) return null;
          // v2.3.5 方案 C: get() 展开视为强使用信号，记录到 session 缓存
          if (params.agentSessionKey) {
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
      description: "手动触发 Graph Memory Pro 图谱维护（去重 + PageRank + 社区检测 + 过时检测 + 健康检查）并返回统计信息",
      parameters: Type.Object({}),
      async execute() {
        if (!_driver || !_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro 未连接" }], details: {} };
        }
        try {
          const [nodeCount, edgeCount] = await Promise.all([
            getNodeCount(_driver),
            getEdgeCount(_driver),
          ]);
          const result = await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined, _batchEmbed ?? undefined);

          // v2.1.2 G-5: 维护后追加健康报告
          let healthReport: GraphHealthReport | null = null;
          try {
            const { healthCheck } = await import("./src/graph/maintenance.ts");
            healthReport = await healthCheck(_driver);
          } catch {
            // 健康检查失败不影响主流程
          }

          // v2.1.2 第二批：缓存 + 反馈统计
          const cacheStats = _recaller?.getQueryCache()?.getStats();
          const judgeStats = _recaller?.getJudgeManager()
            ? {
                feedbackCount: _recaller.getJudgeManager()!.getFeedbackCount(),
                coldStart: _recaller.getJudgeManager()!.isColdStart(),
              }
            : null;

          // v2.1.2 第三批：L-1 关联矩阵 M 统计
          const amStats = _recaller?.getAssociationMatrix()?.getStats();

          // v2.3.6: 维护周期持久化关联矩阵 M（兑现 serialize 注释"仅在 gm_maintain 周期性保存"）
          let amPersist: { path: string; bytes: number } | null = null;
          try {
            const { saveRecallerAssociationMatrix } = await import("./src/recaller/association-matrix-persist.ts");
            const saved = await saveRecallerAssociationMatrix(_recaller);
            if (saved) amPersist = { path: saved.path, bytes: saved.bytes };
          } catch { /* M 持久化失败不影响维护结果 */ }

          const text = [
            "📊 Graph Memory Pro 统计",
            `节点总数: ${nodeCount}`,
            `关系总数: ${edgeCount}`,
            "",
            "✅ 维护完成",
            `去重合并: ${result.dedup.merged} 个`,
            `PageRank: ${result.pagerank.topK.length} 个节点已排序`,
            `社区: ${result.community.count} 个社区`,
            `社区摘要: ${result.communitySummaries} 个`,
            result.importance ? `重要性评分: scanned=${result.importance.scanned}, avg=${result.importance.avgScore.toFixed(3)}` : "",
            result.conflictResolution ? `冲突消解: scanned=${result.conflictResolution.scanned}, resolved=${result.conflictResolution.resolved} (合并=${result.conflictResolution.merged})` : "",
            result.edgeWeights && result.edgeWeights.scanned > 0 ? `边权重: 强化=${result.edgeWeights.strengthened}, 衰减=${result.edgeWeights.decayed}` : "",
            result.reverseMemory && (result.reverseMemory.watchlistAdded > 0 || result.reverseMemory.decayed > 0) ? `反向记忆: 衰减=${result.reverseMemory.decayed}, 恢复=${result.reverseMemory.watchlistRemoved}` : "",
            `耗时: ${result.durationMs}ms`,
            "",
            healthReport ? "🏥 图谱健康" : "",
            healthReport ? `活跃节点: ${healthReport.nodes.active}/${healthReport.nodes.total}` : "",
            healthReport ? `孤立节点: ${healthReport.isolatedNodes}` : "",
            healthReport ? `高过时节点: ${healthReport.highStaleNodes}` : "",
            healthReport ? `社区数: ${healthReport.communities}` : "",
            healthReport ? `平均 PageRank: ${healthReport.avgPageRank.toFixed(4)}` : "",
            healthReport && healthReport.anomalies.length > 0
              ? `⚠️ 异常: ${healthReport.anomalies.join("; ")}`
              : (healthReport ? "✅ 无异常" : ""),
            "",
            cacheStats ? "💾 查询缓存" : "",
            cacheStats ? `容量: ${cacheStats.size}/${cacheStats.capacity}` : "",
            cacheStats ? `命中率: ${cacheStats.hitRate}` : "",
            cacheStats ? `相似命中: ${cacheStats.similarityHits}` : "",
            "",
            judgeStats ? "📋 反馈系统" : "",
            judgeStats ? `累计反馈: ${judgeStats.feedbackCount}` : "",
            judgeStats ? `冷启动期: ${judgeStats.coldStart ? "是（仅启发式规则）" : "否（已启用 LLM）"}` : "",
            "",
            amStats ? "🧠 关联矩阵 M (L-1)" : "",
            amStats ? `维度: ${amStats.dim}` : "",
            amStats ? `时间步 t: ${amStats.t}` : "",
            amStats ? `已应用更新: ${amStats.updatesApplied}` : "",
            amStats ? `被拒更新: ${amStats.updatesRejected} (R-3 边际效用拒绝)` : "",
            amStats ? `历史样本: ${amStats.historySize}` : "",
            amPersist ? `💾 M 已持久化: ${(amPersist.bytes / 1024).toFixed(1)}KB @ ${amPersist.path}` : "",
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text", text }], details: { nodeCount, edgeCount, ...result, health: healthReport, cache: cacheStats, judge: judgeStats, associationMatrix: amStats, associationMatrixPersist: amPersist } };
        } catch (err) {
          return { content: [{ type: "text", text: `维护失败: ${(err as Error).message}` }], details: {} };
        }
      },
    });

    // gm_reembed: 批量重新向量化
    api.registerTool({
      name: "gm_reembed",
      label: "Graph Memory Re-Embed",
      description: "Batch re-embed all active nodes that are missing an embedding vector (only processes status=active with empty/null embedding)",
      parameters: Type.Object({}),
      async execute() {
        if (!_driver || !_cfg) {
          return { content: [{ type: "text", text: "Graph Memory Pro not connected" }], details: {} };
        }
        if (!_embed) {
          return { content: [{ type: "text", text: "Embedding engine not configured" }], details: {} };
        }
        try {
          // 传入 embeddingModel，避免清空所有节点的 embeddingModel 字段（G-4 修复）
          // v2.4.0: 传入 batchEmbedFn，正式流程全量重嵌入启用批量（缓解 Ollama 503）
          const result = await reEmbedNodes(_driver, _embed, 50, _cfg.embedding?.model, undefined, _batchEmbed ?? undefined);
          const lines = [
            "Re-Embed done",
            `Scanned: ${result.totalScanned} nodes`,
            `Embedded: ${result.reEmbedded} nodes`,
            `Failed: ${result.failed}`,
            `Skipped: ${result.skipped}`,
            `Duration: ${result.durationMs}ms`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }], details: result };
        } catch (err) {
          return { content: [{ type: "text", text: "Re-Embed failed: " + String(err) }], details: {} };
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
