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
import type { EmbedFn } from "../engine/embed.ts";
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

export interface McpServerHandle {
  httpServer: http.Server;
  close(): Promise<void>;
}

/** 将强类型对象转为 MCP SDK 要求的 Record<string, unknown> 结构 */
function asStructured<T>(obj: T): Record<string, unknown> {
  return obj as unknown as Record<string, unknown>;
}

/**
 * 启动 MCP server
 *
 * @param driver Neo4j driver
 * @param cfg 插件配置
 * @param llm LLM complete 函数（可选）
 * @param embed Embedding 函数（可选）
 * @param recaller Recaller 实例（可选，gm_feedback 需要）
 */
export async function startMcpServer(
  driver: Driver,
  cfg: GmConfig,
  llm?: CompleteFn,
  embed?: EmbedFn,
  recaller?: Recaller,
): Promise<McpServerHandle> {
  const port = cfg.mcp?.port ?? 7800;
  const host = cfg.mcp?.host ?? "127.0.0.1";
  const path = cfg.mcp?.path ?? "/mcp";
  const authToken = cfg.mcp?.authToken;
  const enabledTools = cfg.mcp?.enabledTools; // 省略 = 全部启用

  /** 检查工具是否启用 */
  function toolEnabled(name: string): boolean {
    if (!enabledTools || enabledTools.length === 0) return true;
    return enabledTools.includes(name);
  }

  // ── 创建 MCP server ──────────────────────────────────────────────
  const mcpServer = new McpServer({
    name: "graph-memory-pro",
    version: "2.3.0",
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
            content: [{ type: "text", text: `connected, version=2.3.0` }],
            structuredContent: asStructured({ status: "connected", version: "2.3.0" }),
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `disconnected: ${err.message}` }],
            structuredContent: { status: "disconnected", error: err.message },
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
          });
          return {
            content: [{ type: "text", text: `Recorded: ${id} (source=${source ?? "experience"})` }],
            structuredContent: asStructured({ id, source: source ?? "experience" }),
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
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
          const result = await runMaintenance(driver, cfg, llm, embed);
          return {
            content: [{ type: "text", text: `Maintenance done: ${result.dedup.merged} merged, ${result.community.count} communities, ${result.durationMs}ms` }],
            structuredContent: asStructured(result),
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_reembed")) {
    mcpServer.registerTool(
      "gm_reembed",
      {
        title: "Re-embed Nodes",
        description: "Batch re-embed nodes with missing/empty embeddings.",
        inputSchema: {
          batchSize: z.number().int().positive().max(200).optional().describe("Batch size (default 50, max 200)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ batchSize }: { batchSize?: number }) => {
        if (!embed) {
          return { content: [{ type: "text", text: "Embed function not configured" }] };
        }
        try {
          const result = await reEmbedNodes(driver, embed, batchSize ?? 50, cfg.embedding?.model);
          return {
            content: [{ type: "text", text: `Re-embedded ${result.reEmbedded}/${result.totalScanned} nodes, ${result.failed} failed, ${result.durationMs}ms` }],
            structuredContent: asStructured(result),
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
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
              await recaller.processFeedback(
                query, validNodes, assistantReply, sessionId ?? "mcp",
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
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
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
          const result = await runBenchmark(recaller, driver, cfg, {
            datasets: datasets as any,
            maxCases: maxCases ?? cfg.benchmark?.maxCases ?? 50,
            buildGraph: buildGraph ?? cfg.benchmark?.buildGraph ?? true,
          });
          return {
            content: [{ type: "text", text: `Benchmark done: P1=${(result.aggregate.avgP1 * 100).toFixed(2)}%, MRR=${result.aggregate.avgMrr.toFixed(4)}` }],
            structuredContent: asStructured(result),
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
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
            const res = await tuner.runTuneCycle(recaller!, driver, cfg);
            results.push(res);
            if (res.applied === false && res.reason?.includes("cold start")) break;
          }
          const applied = results.filter(r => r.applied).length;
          const improvements = results.filter(r => r.isImprovement).length;
          return {
            content: [{ type: "text", text: `Tuning done: ${results.length} rounds, ${applied} applied, ${improvements} improvements` }],
            structuredContent: asStructured({ rounds: results.length, applied, improvements, results }),
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  // ── HTTP server + Streamable HTTP transport ─────────────────────
  const httpServer = http.createServer(async (req, res) => {
    // 健康检查端点（无需鉴权）
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "graph-memory-pro-mcp", version: "2.2.1" }));
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
      await transport.handleRequest(req as any, res, parsedBody);
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  // 启动监听
  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, host, () => {
      console.log(`[graph-memory-pro] MCP server listening on http://${host}:${port}${path}`);
      resolve();
    });
  });

  return {
    httpServer,
    async close() {
      await mcpServer.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => err ? reject(err) : resolve());
      });
      console.log("[graph-memory-pro] MCP server closed");
    },
  };
}
