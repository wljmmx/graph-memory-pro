/**
 * graph-memory-pro — MCP Server（v2.2.0 新增）
 *
 * 通过 Model Context Protocol 对外暴露图谱能力，供 lcm-graph-extra dashboard
 * 或任意 MCP client（Claude Desktop / Cursor / 自研 client）调用。
 *
 * 传输方式：Streamable HTTP
 * 部署形态：复用 OpenClaw 宿主进程，共享 _driver/_cfg/_recaller
 *
 * 暴露 13 个 tools：
 *   read:  gm_status / gm_stats / gm_health / gm_get_node / gm_search /
 *          gm_top / gm_nodes_by_type
 *   write: gm_record / gm_maintain / gm_reembed / gm_feedback /
 *          gm_benchmark / gm_tune（条件注册）
 */

import type { Driver } from "neo4j-driver";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn, BatchEmbedFn } from "../engine/embed.ts";
import type { Recaller } from "../recaller/recall.ts";
import {
  upsertNode, findById, searchNodes, getTopNodes, getNodesByType,
  getNodeCount, getEdgeCount, getEdgesForNodes,
  upsertFeedback,
} from "../store/store.ts";
import {
  runMaintenance, healthCheck,
} from "../graph/maintenance.ts";
import { reEmbedNodes } from "../graph/reembed.ts";
import { withTimeout } from "../utils.ts";
import { VERSION } from "../version.ts";

export interface McpServerHandle {
  httpServer: http.Server;
  /** 实际监听端口（EADDRINUSE 自动重试后可能 ≠ cfg.mcp.port） */
  port: number;
  close(): Promise<void>;
}

/** 将强类型对象转为 MCP SDK 要求的 Record<string, unknown> 结构 */
function asStructured<T>(obj: T): Record<string, unknown> {
  return obj as unknown as Record<string, unknown>;
}

/**
 * 优雅关闭 HTTP server，避免挂起的连接导致 close() 无法 resolve。
 *   - 先尝试正常 close（等待活跃 sockets 自然关闭）
 *   - 超时后调用 closeAllConnections / closeIdleConnections 强制回收
 *   - 无论超时与否最终都 resolve，保证重启链路不被卡住
 */
function closeHttpServer(server: http.Server, timeoutMs = 2000): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      try { server.closeIdleConnections?.(); } catch { /* ignore */ }
      // 二次尝试 close（如果仍抛出，直接放弃；启动方已经 null 化 handle 进入下一轮）
      try {
        server.close(() => done());
      } catch {
        done();
      }
    }, timeoutMs);
    try {
      server.close((_err) => {
        clearTimeout(timer);
        done();
      });
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

/**
 * 启动 MCP server
 *
 * @param driver Neo4j driver
 * @param cfg 插件配置
 * @param llm LLM complete 函数（可选）
 * @param embed Embedding 函数（可选）
 * @param recaller Recaller 实例（可选，gm_feedback 需要）
 * @returns McpServerHandle（含实际监听端口，便于心跳用真实端口探测）
 */
export async function startMcpServer(
  driver: Driver,
  cfg: GmConfig,
  llm?: CompleteFn,
  embed?: EmbedFn,
  recaller?: Recaller,
  batchEmbed?: BatchEmbedFn,
): Promise<McpServerHandle> {
  const basePort = cfg.mcp?.port ?? 7800;
  const host = cfg.mcp?.host ?? "127.0.0.1";
  const path = cfg.mcp?.path ?? "/mcp";
  const authToken = cfg.mcp?.authToken;
  const enabledTools = cfg.mcp?.enabledTools; // 省略 = 全部启用
  // v2.6.1: 维护类工具超时（gm_maintain / gm_reembed / gm_tune），默认 120s，可配
  const maintenanceTimeoutMs = cfg.background?.maintenanceTimeoutMs ?? 120_000;
  // v2.5.x fix: 与 API server 对称，EADDRINUSE 时自动 +1/+2/+3 重试
  const MAX_PORT_RETRIES = 3;

  /** 检查工具是否启用 */
  function toolEnabled(name: string): boolean {
    if (!enabledTools || enabledTools.length === 0) return true;
    return enabledTools.includes(name);
  }

  // ── 创建 MCP server ──────────────────────────────────────────────
  const mcpServer = new McpServer({
    name: "graph-memory-pro",
    version: VERSION,
  });

  // ── read-only tools ─────────────────────────────────────────────

  if (toolEnabled("gm_status")) {
    mcpServer.registerTool(
      "gm_status",
      {
        title: "Server Status",
        description: "Check Neo4j connection status and plugin version.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        try {
          await driver.verifyConnectivity();
          return {
            content: [{ type: "text", text: `connected, version=${VERSION}` }],
            structuredContent: asStructured({ status: "connected", version: VERSION }),
          };
        } catch (err: unknown) {
          const message = (err as Error).message;
          return {
            content: [{ type: "text", text: `disconnected: ${message}` }],
            structuredContent: { status: "disconnected", error: message },
          };
        }
      },
    );
  }

  if (toolEnabled("gm_stats")) {
    mcpServer.registerTool(
      "gm_stats",
      {
        title: "Graph Stats",
        description: "Get total node count and edge count.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        const [nodeCount, edgeCount] = await Promise.all([
          getNodeCount(driver), getEdgeCount(driver),
        ]);
        return {
          content: [{ type: "text", text: `nodes=${nodeCount}, edges=${edgeCount}` }],
          structuredContent: asStructured({ nodeCount, edgeCount }),
        };
      },
    );
  }

  if (toolEnabled("gm_health")) {
    mcpServer.registerTool(
      "gm_health",
      {
        title: "Graph Health Report",
        description: "G-5 graph health check: connectivity, density, isolated nodes, staleness, anomalies.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        const report = await healthCheck(driver);
        return {
          content: [{ type: "text", text: JSON.stringify(report) }],
          structuredContent: asStructured(report),
        };
      },
    );
  }

  if (toolEnabled("gm_get_node")) {
    mcpServer.registerTool(
      "gm_get_node",
      {
        title: "Get Node by ID",
        description: "Fetch a single node by its id.",
        inputSchema: { id: z.string().min(1).describe("Node id") },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ id }: { id: string }) => {
        const node = await findById(driver, id);
        if (!node) {
          return { content: [{ type: "text", text: `Node not found: ${id}` }] };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(node) }],
          structuredContent: asStructured(node),
        };
      },
    );
  }

  if (toolEnabled("gm_search")) {
    mcpServer.registerTool(
      "gm_search",
      {
        title: "Search Nodes",
        description: "Full-text search nodes and return associated edges.",
        inputSchema: {
          query: z.string().min(1).describe("Search query"),
          limit: z.number().int().positive().max(50).optional().describe("Max results (default 10, max 50)"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ query, limit }: { query: string; limit?: number }) => {
        const lim = Math.min(limit ?? 10, 50);
        const nodes = await searchNodes(driver, query, lim);
        const ids = nodes.map(n => n.id);
        const edges = await getEdgesForNodes(driver, ids);
        return {
          content: [{ type: "text", text: `Found ${nodes.length} nodes, ${edges.length} edges` }],
          structuredContent: asStructured({ nodes, edges }),
        };
      },
    );
  }

  if (toolEnabled("gm_top")) {
    mcpServer.registerTool(
      "gm_top",
      {
        title: "Top Nodes by PageRank",
        description: "Get top-N nodes ranked by PageRank score.",
        inputSchema: {
          limit: z.number().int().positive().max(100).optional().describe("N (default 20, max 100)"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ limit }: { limit?: number }) => {
        const lim = Math.min(limit ?? 20, 100);
        const nodes = await getTopNodes(driver, lim);
        return {
          content: [{ type: "text", text: `Top ${nodes.length} nodes` }],
          structuredContent: asStructured({ nodes }),
        };
      },
    );
  }

  if (toolEnabled("gm_nodes_by_type")) {
    mcpServer.registerTool(
      "gm_nodes_by_type",
      {
        title: "Nodes by Type",
        description: "List nodes filtered by type (TASK / SKILL / EVENT).",
        inputSchema: {
          type: z.enum(["TASK", "SKILL", "EVENT"]).describe("Node type"),
          limit: z.number().int().positive().max(50).optional().describe("Max results (default 10, max 50)"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ type, limit }: { type: "TASK" | "SKILL" | "EVENT"; limit?: number }) => {
        const lim = limit ? Math.min(limit, 50) : undefined;
        const nodes = await getNodesByType(driver, type, lim);
        return {
          content: [{ type: "text", text: `${nodes.length} ${type} nodes` }],
          structuredContent: asStructured({ type, nodes }),
        };
      },
    );
  }

  // ── write tools ──────────────────────────────────────────────────

  if (toolEnabled("gm_record")) {
    mcpServer.registerTool(
      "gm_record",
      {
        title: "Record Knowledge Node",
        description: "Manually record a knowledge node (TASK / SKILL / EVENT). Source: experience(default) / knowledge(external authoritative) / imported(manual).",
        inputSchema: {
          type: z.enum(["TASK", "SKILL", "EVENT"]).describe("Node type"),
          name: z.string().min(1).describe("Node name"),
          description: z.string().describe("Short description"),
          content: z.string().describe("Detailed content"),
          source: z.enum(["experience", "knowledge", "imported"]).optional().describe("S-3 source (default experience)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ type, name, description, content, source }: {
        type: "TASK" | "SKILL" | "EVENT";
        name: string; description: string; content: string;
        source?: "experience" | "knowledge" | "imported";
      }) => {
        try {
          const now = Date.now();
          const id = `mcp-${now}-${Math.random().toString(36).slice(2, 8)}`;
          await upsertNode(driver, {
            id, type, name, description, content,
            status: "active",
            communityId: undefined,
            pagerank: 0,
            validatedCount: 0,
            createdAt: now,
            updatedAt: now,
            embeddingModel: cfg.embedding?.model,
            source: source ?? "experience",
          }, cfg);
          return {
            content: [{ type: "text", text: `Recorded: ${id} (source=${source ?? "experience"})` }],
            structuredContent: asStructured({ id, source: source ?? "experience" }),
          };
        } catch (err: unknown) {
          return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_maintain")) {
    mcpServer.registerTool(
      "gm_maintain",
      {
        title: "Run Maintenance",
        description: "Trigger the 11-phase maintenance pipeline (dedup, pagerank, community, staleness, health, importance, conflict, edge weights, reverse memory, embedding migration).",
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async () => {
        try {
          const result = await withTimeout(() => runMaintenance(driver, cfg, llm, embed), maintenanceTimeoutMs, "gm_maintain");
          return {
            content: [{ type: "text", text: `Maintenance done: ${result.dedup.merged} merged, ${result.community.count} communities, ${result.durationMs}ms` }],
            structuredContent: asStructured(result),
          };
        } catch (err: unknown) {
          return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_reembed")) {
    mcpServer.registerTool(
      "gm_reembed",
      {
        title: "Re-embed Nodes",
        description: "Batch re-embed nodes with missing/empty embeddings. Pass clear=true to first wipe all nodes/edges in the active database (for 'clear then re-import' rebuild flows).",
        inputSchema: {
          batchSize: z.number().int().positive().max(200).optional().describe("Batch size (default 50, max 200)"),
          clear: z.boolean().optional().describe("If true, wipe all nodes/edges in the active database first (destructive)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ batchSize, clear }: { batchSize?: number; clear?: boolean }) => {
        if (!embed) {
          return { content: [{ type: "text", text: "Embed function not configured" }] };
        }
        try {
          if (clear === true) {
            const { clearAllNodes } = await import("../store/nodes.ts");
            const cleared = await clearAllNodes(driver);
            return {
              content: [{ type: "text", text: `Cleared ${cleared} nodes. Re-run your import, then invoke gm_reembed.` }],
              structuredContent: asStructured({ cleared, note: "database cleared; re-run import then reembed" }),
            };
          }
          const result = await withTimeout(() => reEmbedNodes(driver, embed, batchSize ?? 50, cfg.embedding?.model, undefined, batchEmbed), maintenanceTimeoutMs, "gm_reembed");
          return {
            content: [{ type: "text", text: `Re-embedded ${result.reEmbedded}/${result.totalScanned} nodes, ${result.failed} failed, ${result.durationMs}ms` }],
            structuredContent: asStructured(result),
          };
        } catch (err: unknown) {
          return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_feedback")) {
    mcpServer.registerTool(
      "gm_feedback",
      {
        title: "Submit Recall Feedback",
        description: "Submit feedback for a recall result (drives I-2 judge + I-3 persistence + L-1 M matrix update). The assistantReply text is matched against recalled node names/ids to determine used/unused.",
        inputSchema: {
          query: z.string().min(1).describe("Original query"),
          recalledNodeIds: z.array(z.string()).describe("Ids of recalled nodes"),
          assistantReply: z.string().describe("Assistant reply text (used for heuristic matching)"),
          sessionId: z.string().optional().describe("Session id"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ query, recalledNodeIds, assistantReply, sessionId }: {
        query: string; recalledNodeIds: string[]; assistantReply: string; sessionId?: string;
      }) => {
        try {
          // 获取 GmNode[] 用于 processFeedback（需要 name 做 heuristic 匹配）
          const recalledNodes = await Promise.all(
            recalledNodeIds.map(id => findById(driver, id)),
          );
          const validNodes = recalledNodes.filter((n): n is NonNullable<typeof n> => n !== null);

          // 若 recaller 可用，触发 I-2 裁判 + I-3 持久化 + L-1 M 更新
          let usedCount = 0;
          let unusedCount = 0;
          if (recaller) {
            try {
              await withTimeout(
                () => recaller.processFeedback(
                  query, validNodes, assistantReply, sessionId ?? "mcp",
                ),
                60_000,
                "gm_feedback",
              );
            } catch { /* M 矩阵更新失败不阻塞 */ }
          } else {
            // 无 recaller 时，启发式匹配并直接持久化
            const fbId = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const replyLower = assistantReply.toLowerCase();
            const usedNodeIds: string[] = [];
            const unusedNodeIds: string[] = [];
            for (const n of validNodes) {
              if (replyLower.includes(n.id.toLowerCase()) || (n.name && replyLower.includes(n.name.toLowerCase()))) {
                usedNodeIds.push(n.id);
              } else {
                unusedNodeIds.push(n.id);
              }
            }
            await upsertFeedback(driver, {
              id: fbId, query, recalledNodeIds,
              usedNodeIds, unusedNodeIds,
              timestamp: Date.now(), sessionId: sessionId ?? "mcp",
              matchedBy: "heuristic",
            });
            usedCount = usedNodeIds.length;
            unusedCount = unusedNodeIds.length;
          }
          return {
            content: [{ type: "text", text: `Feedback recorded: used=${usedCount}, unused=${unusedCount}` }],
            structuredContent: asStructured({ usedCount, unusedCount, totalValid: validNodes.length }),
          };
        } catch (err: unknown) {
          return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_benchmark")) {
    mcpServer.registerTool(
      "gm_benchmark",
      {
        title: "Run Benchmark",
        description: "Run S-10 benchmark evaluation (LoCoMo / LongMemEval). Requires recaller instance.",
        inputSchema: {
          datasets: z.array(z.string()).optional().describe("Dataset names (default all)"),
          maxCases: z.number().int().nonnegative().optional().describe("Max cases per dataset (0 = all)"),
          buildGraph: z.boolean().optional().describe("Build graph before eval (default true)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ datasets, maxCases, buildGraph }: {
        datasets?: string[]; maxCases?: number; buildGraph?: boolean;
      }) => {
        if (!recaller) {
          return { content: [{ type: "text", text: "Recaller not initialized" }] };
        }
        try {
          const { runBenchmark } = await import("../benchmark/runner.ts");
          const result = await withTimeout(
            () => runBenchmark(recaller, driver, cfg, {
              datasets: datasets,
              maxCases: maxCases ?? cfg.benchmark?.maxCases ?? 50,
              buildGraph: buildGraph ?? cfg.benchmark?.buildGraph ?? true,
            }),
            300_000,
            "gm_benchmark",
          );
          return {
            content: [{ type: "text", text: `Benchmark done: P1=${(result.aggregate.avgP1 * 100).toFixed(2)}%, MRR=${result.aggregate.avgMrr.toFixed(4)}` }],
            structuredContent: asStructured(result),
          };
        } catch (err: unknown) {
          return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_tune") && cfg.autoTuner?.enabled) {
    mcpServer.registerTool(
      "gm_tune",
      {
        title: "Run Auto-Tuner Cycle",
        description: "Trigger R-1 EvolveMem auto-tuning cycle (EVALUATE → DIAGNOSE → PROPOSE → GUARD). Requires autoTuner.enabled.",
        inputSchema: {
          rounds: z.number().int().positive().max(10).optional().describe("Tuning rounds (default 1, max 10)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ rounds }: { rounds?: number }) => {
        try {
          const { AutoTuner } = await import("../evolution/auto-tuner.ts");
          const tuner = new AutoTuner(cfg.autoTuner ?? {}, llm);
          const r = Math.min(rounds ?? 1, cfg.autoTuner?.maxRounds ?? 10);
          const results = [];
          for (let i = 0; i < r; i++) {
            const res = await withTimeout(
              () => tuner.runTuneCycle(recaller!, driver, cfg),
              maintenanceTimeoutMs,
              "gm_tune",
            );
            results.push(res);
            if (res.applied === false && res.reason?.includes("cold start")) break;
          }
          const applied = results.filter(r => r.applied).length;
          const improvements = results.filter(r => r.isImprovement).length;
          return {
            content: [{ type: "text", text: `Tuning done: ${results.length} rounds, ${applied} applied, ${improvements} improvements` }],
            structuredContent: asStructured({ rounds: results.length, applied, improvements, results }),
          };
        } catch (err: unknown) {
          return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
        }
      },
    );
  }

  // ── HTTP server + Streamable HTTP transport ─────────────────────
  const httpServer = http.createServer(async (req, res) => {
    // 健康检查端点（无需鉴权）
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "graph-memory-pro-mcp", version: VERSION }));
      return;
    }

    // MCP 端点
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    if (req.method !== "POST" || url.pathname !== path) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found", hint: `POST ${path} for MCP, GET /health for status` }));
      return;
    }

    // Bearer Token 鉴权
    if (authToken) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${authToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: invalid or missing Bearer token" }));
        return;
      }
    }

    // 读取并解析 body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString("utf-8");
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    // 创建 transport 处理本次请求（无状态模式）
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await transport.handleRequest(req as any, res, parsedBody);
    } catch (err: unknown) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    }
  });

  // 启动监听：EADDRINUSE 时自动 +1/+2/+3 重试（与 http-server.ts API server 对称）
  let listenError: Error | null = null;
  let actualPort = basePort;
  for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
    listenError = null;
    const tryPort = basePort + attempt;
    actualPort = tryPort;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        httpServer.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE" && attempt < MAX_PORT_RETRIES) {
          console.warn(`[graph-memory-pro] MCP server port ${tryPort} in use (EADDRINUSE), trying ${tryPort + 1}...`);
          resolve();
        } else {
          listenError = err;
          reject(err);
        }
      };
      const onListening = () => {
        httpServer.removeListener("error", onError);
        actualPort = tryPort;
        console.log(`[graph-memory-pro] MCP server listening on http://${host}:${tryPort}${path}`);
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

  return {
    httpServer,
    port: actualPort,
    async close() {
      // 先关 SDK 层，再优雅关 HTTP server（超时强回收）
      try { await mcpServer.close(); } catch { /* ignore */ }
      await closeHttpServer(httpServer, 2000);
      console.log("[graph-memory-pro] MCP server closed");
    },
  };
}
