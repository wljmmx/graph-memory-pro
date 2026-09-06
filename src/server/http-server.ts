/**
 * graph-memory-pro — Independent HTTP API Server
 *
 * 独立的 HTTP 服务器，不依赖 OpenClaw Gateway 的路由注册。
 * 直接使用 node:http 创建服务器，暴露所有 CRUD 路由。
 *
 * 默认端口：7850（与 MCP 7800 区分）
 */

import http from "node:http";
import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn, BatchEmbedFn } from "../engine/embed.ts";
import type { Recaller } from "../recaller/recall.ts";
import { initRoutes, getRoutes } from "../routes/crud.ts";
import { VERSION } from "../version.ts";

export interface ApiServerConfig {
  enabled?: boolean;
  port?: number;
  host?: string;
  authToken?: string;
}

export interface ApiServerHandle {
  httpServer: http.Server;
  /** 实际监听端口（EADDRINUSE 自动重试后可能 ≠ 配置端口） */
  port: number;
  close(): Promise<void>;
}

interface RouteMatcher {
  regex: RegExp;
  path: string;
  paramNames: string[];
  method: string;
  handler: (params: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
}

/**
 * 启动独立 HTTP API 服务器
 */
export async function startApiServer(
  driver: Driver,
  cfg: GmConfig,
  config: ApiServerConfig,
  logger: { info?: (msg: string) => void; error?: (msg: string) => void; warn?: (msg: string) => void },
  llm?: CompleteFn,
  embed?: EmbedFn,
  recaller?: Recaller,
  batchEmbed?: BatchEmbedFn,
): Promise<ApiServerHandle> {
  const port = config.port ?? 7850;
  const host = config.host ?? "127.0.0.1";
  const authToken = config.authToken;

  logger.info?.(`[graph-memory-pro] API server starting on http://${host}:${port} ...`);

  // 初始化路由模块状态
  initRoutes(driver, cfg, llm, embed, recaller, batchEmbed);

  const routes = getRoutes();
  logger.info?.(`[graph-memory-pro] API server loaded ${routes.length} routes`);

  // 构建路由匹配表
  // 将 /api/nodes/:id 转为正则 /^\/api\/nodes\/([^/]+)$/
  const routeMatchers: RouteMatcher[] = [];

  for (const route of routes) {
    const paramNames: string[] = [];
    const regexStr = route.path
      .replace(/:([^/]+)/g, (_, name) => {
        paramNames.push(name);
        return "([^/]+)";
      })
      .replace(/\//g, "\\/");
    routeMatchers.push({
      regex: new RegExp(`^${regexStr}$`),
      path: route.path,
      paramNames,
      method: route.method,
      handler: route.handler,
    });
  }

  // 需要鉴权的路径（非 GET 或敏感读路径）
  const SENSITIVE_READ_PATHS = new Set(["/api/health", "/api/metrics", "/api/usage", "/api/doctor"]);

  // v2.4.1: 禁用默认 5 分钟 requestTimeout，避免长任务（如 rebuild-all 全量重建）
  // 在 5 分钟时被 Node 强制断开，导致 openclaw 主进程判定插件"不可达: fetch failed"。
  const httpServer = http.createServer(
    { requestTimeout: 0, headersTimeout: 120_000, keepAliveTimeout: 5000 },
    async (req, res) => {
    // CORS 头
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // 健康检查端点（无需鉴权）
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "graph-memory-pro-api", version: VERSION }));
      return;
    }

    // v2.8.x: gm_reembed 流式进度端点（SSE）——特殊处理，路由 handler 模型只能返回
    // {status, body} JSON，无法表达流；此处直接接管 res 写 SSE 事件。
    if (req.method === "GET" && pathname === "/api/reembed/stream") {
      await handleReembedStream(req, res, url.searchParams.get("taskId") ?? "");
      return;
    }

    // v2.8.x: gm_maintain 流式进度端点（SSE，与 reembed 对称）
    if (req.method === "GET" && pathname === "/api/maintain/stream") {
      await handleMaintainStream(req, res, url.searchParams.get("taskId") ?? "");
      return;
    }

    // 路由匹配
    let matched: RouteMatcher | null = null;
    const matchedParams: Record<string, string> = {};

    for (const matcher of routeMatchers) {
      const m = pathname.match(matcher.regex);
      if (m && req.method === matcher.method) {
        matched = matcher;
        // 提取路径参数
        for (let i = 0; i < matcher.paramNames.length; i++) {
          matchedParams[matcher.paramNames[i]] = decodeURIComponent(m[i + 1]);
        }
        break;
      }
    }

    if (!matched) {
      // 检查是否有该路径的其他方法
      const hasMethod = routeMatchers.some(
        m => pathname.match(m.regex) && m.method !== req.method,
      );
      if (hasMethod) {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed" }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
      return;
    }

    // 鉴权检查（修复：用 path 而非 handler.toString()）
    const needsAuth = matched.method !== "GET" || SENSITIVE_READ_PATHS.has(matched.path);
    if (needsAuth && authToken) {
      const provided = req.headers["x-auth-token"] as string | undefined;
      if (provided !== authToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    // 合并查询参数
    const params: Record<string, unknown> = { ...matchedParams };
    for (const [k, v] of url.searchParams) {
      params[k] = v;
    }

    // 对非 GET 请求，解析 JSON body
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        const raw = await readBody(req);
        if (raw) {
          try {
            Object.assign(params, JSON.parse(raw));
          } catch {
            // body 不是 JSON，忽略
          }
        }
      } catch {
        // body 读取失败，忽略
      }
    }

    // 执行 handler
    try {
      const result = await matched.handler(params);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
    }
  });

  // 启动监听
  // v2.3.5 fix: EADDRINUSE 时自动尝试 +1/+2/+3 端口，避免因端口冲突导致
  // API server 永远起不来（根因：openclaw-node 老版本抢占 7850）
  const MAX_PORT_RETRIES = 3;
  let actualPort = port;
  let listenError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
    listenError = null;
    const tryPort = port + attempt;
    actualPort = tryPort;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        httpServer.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE" && attempt < MAX_PORT_RETRIES) {
          logger.warn?.(`[graph-memory-pro] API server port ${tryPort} in use (EADDRINUSE), trying ${tryPort + 1}...`);
          resolve(); // 不 reject，让循环尝试下一个端口
        } else {
          logger.error?.(`[graph-memory-pro] API server listen error on port ${tryPort}: ${err.message}`);
          listenError = err;
          reject(err);
        }
      };
      const onListening = () => {
        httpServer.removeListener("error", onError);
        actualPort = tryPort;
        logger.info?.(`[graph-memory-pro] API server listening on http://${host}:${tryPort}`);
        resolve();
      };

      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(tryPort, host);
    }).catch((err) => {
      listenError = err;
    });

    if (!listenError && httpServer.listening) break;
    if (listenError) throw listenError;
  }

  // 自检：验证服务可达（用实际监听端口）
  try {
    const resp = await fetch(`http://${host}:${actualPort}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const body = await resp.text();
      logger.info?.(`[graph-memory-pro] API server self-check OK: ${body}`);
    } else {
      logger.warn?.(`[graph-memory-pro] API server self-check returned ${resp.status}`);
    }
  } catch (err: unknown) {
    logger.warn?.(`[graph-memory-pro] API server self-check failed: ${(err as Error).message}`);
  }

  return {
    httpServer,
    port: actualPort,
    async close() {
      logger.info?.("[graph-memory-pro] API server closing...");
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => err ? reject(err) : resolve());
      });
      logger.info?.("[graph-memory-pro] API server closed");
    },
  };
}

/** 读取 HTTP 请求 body */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── v2.8.x: gm_reembed 流式进度（SSE）───────────────────────────────
//
// GET /api/reembed/stream?taskId=xxx
// 事件流（每行格式见 https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events）：
//   event: snapshot   data: {ReembedTaskSnapshot}（初始 + 状态变化时）
//   event: done       data: {ReembedTaskSnapshot}（终态：done/failed/cancelled，随后关闭连接）
//   : ping            （每 15s 心跳注释，防止代理/负载均衡断开空闲连接）
// 客户端断线即清理轮询定时器，不影响后台任务继续执行。

const REEMBED_STREAM_POLL_MS = 1000;
const REEMBED_STREAM_HEARTBEAT_MS = 15_000;

async function handleReembedStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  taskId: string,
): Promise<void> {
  if (!taskId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "taskId query param is required" }));
    return;
  }
  const { getReembedTask } = await import("../graph/reembed-task.ts");

  const first = getReembedTask(taskId);
  if (!first) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `reembed task not found: ${taskId}` }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // 禁用 nginx 缓冲，保证事件实时到达
  });
  res.write("retry: 3000\n\n");

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("snapshot", first);

  let lastJson = JSON.stringify(first);
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    try { res.end(); } catch { /* ignore */ }
  };
  req.on("close", finish);

  const pollTimer = setInterval(() => {
    if (closed) return;
    const snap = getReembedTask(taskId);
    if (!snap) {
      send("done", { taskId, status: "gone", error: "task no longer tracked" });
      finish();
      return;
    }
    const json = JSON.stringify(snap);
    if (json !== lastJson) {
      lastJson = json;
      send("snapshot", snap);
    }
    if (snap.status === "done" || snap.status === "failed" || snap.status === "cancelled") {
      send("done", snap);
      finish();
    }
  }, REEMBED_STREAM_POLL_MS);

  const heartbeatTimer = setInterval(() => {
    if (closed) return;
    try { res.write(": ping\n\n"); } catch { finish(); }
  }, REEMBED_STREAM_HEARTBEAT_MS);

  // 类型收窄：定时器在 finish() 中被 clear，此处仅为让 TS 认可已被引用
  void pollTimer;
  void heartbeatTimer;
}

// ── v2.8.x: gm_maintain 流式进度（SSE，与 reembed 对称）───────────────────
//
// GET /api/maintain/stream?taskId=xxx
// 事件流：
//   event: snapshot   data: {MaintainTaskSnapshot}（初始 + 状态变化时）
//   event: done       data: {MaintainTaskSnapshot}（终态：done/failed/cancelled，随后关闭连接）
//   : ping            （每 15s 心跳注释，防止代理/负载均衡断开空闲连接）
//
// 维护流水线 14 个 phase 间更新快照，phase 切换即推送；无需更高频轮询。

const MAINTAIN_STREAM_POLL_MS = 1000;
const MAINTAIN_STREAM_HEARTBEAT_MS = 15_000;

async function handleMaintainStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  taskId: string,
): Promise<void> {
  if (!taskId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "taskId query param is required" }));
    return;
  }
  const { getMaintainTask } = await import("../graph/maintenance-task.ts");

  const first = getMaintainTask(taskId);
  if (!first) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `maintain task not found: ${taskId}` }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // 禁用 nginx 缓冲，保证事件实时到达
  });
  res.write("retry: 3000\n\n");

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("snapshot", first);

  let lastJson = JSON.stringify(first);
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    try { res.end(); } catch { /* ignore */ }
  };
  req.on("close", finish);

  const pollTimer = setInterval(() => {
    if (closed) return;
    const snap = getMaintainTask(taskId);
    if (!snap) {
      send("done", { taskId, status: "gone", error: "task no longer tracked" });
      finish();
      return;
    }
    const json = JSON.stringify(snap);
    if (json !== lastJson) {
      lastJson = json;
      send("snapshot", snap);
    }
    if (snap.status === "done" || snap.status === "failed" || snap.status === "cancelled") {
      send("done", snap);
      finish();
    }
  }, MAINTAIN_STREAM_POLL_MS);

  const heartbeatTimer = setInterval(() => {
    if (closed) return;
    try { res.write(": ping\n\n"); } catch { finish(); }
  }, MAINTAIN_STREAM_HEARTBEAT_MS);

  // 类型收窄：定时器在 finish() 中被 clear，此处仅为让 TS 认可已被引用
  void pollTimer;
  void heartbeatTimer;
}