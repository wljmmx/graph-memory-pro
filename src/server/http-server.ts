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
import type { EmbedFn } from "../engine/embed.ts";
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
  close(): Promise<void>;
}

interface RouteMatcher {
  regex: RegExp;
  path: string;
  paramNames: string[];
  method: string;
  handler: (params: any) => Promise<{ status: number; body: any }>;
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
): Promise<ApiServerHandle> {
  const port = config.port ?? 7850;
  const host = config.host ?? "127.0.0.1";
  const authToken = config.authToken;

  logger.info?.(`[graph-memory-pro] API server starting on http://${host}:${port} ...`);

  // 初始化路由模块状态
  initRoutes(driver, cfg, llm, embed, recaller);

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

  const httpServer = http.createServer(async (req, res) => {
    // CORS 头
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

    // 路由匹配
    let matched: RouteMatcher | null = null;
    let matchedParams: Record<string, string> = {};

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
    const params: any = { ...matchedParams };
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
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });

  // 启动监听
  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      logger.error?.(`[graph-memory-pro] API server listen error: ${err.message}`);
      reject(err);
    });
    httpServer.listen(port, host, () => {
      logger.info?.(`[graph-memory-pro] API server listening on http://${host}:${port}`);
      resolve();
    });
  });

  // 自检：验证服务可达
  try {
    const resp = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const body = await resp.text();
      logger.info?.(`[graph-memory-pro] API server self-check OK: ${body}`);
    } else {
      logger.warn?.(`[graph-memory-pro] API server self-check returned ${resp.status}`);
    }
  } catch (err: any) {
    logger.warn?.(`[graph-memory-pro] API server self-check failed: ${err.message}`);
  }

  return {
    httpServer,
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