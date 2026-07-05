/**
 * graph-memory-pro v2.2.0 — MCP Server
 *
 * 将图谱能力通过 Model Context Protocol 对外暴露，供 lcm-graph-extra dashboard
 * 或任意 MCP client（Claude Desktop / Cursor / 自研 client）调用。
 *
 * 设计：
 *   - Streamable HTTP transport，监听独立端口
 *   - 通过 api.registerService 在 OpenClaw 宿主进程内启动，复用已初始化的
 *     driver / cfg / llm / embed / recaller，不重复创建连接
 *   - 工具实现复用 store / maintenance / recaller 的现有函数，不重复业务逻辑
 *   - 支持 Bearer Token 鉴权与工具白名单
 *
 * 启动配置：在 GmConfig 中设置 mcp.enabled = true
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
  findById, searchNodes, getTopNodes, getNodesByType,
  getNodeCount, getEdgeCount, getEdgesForNodes,
  upsertNode,
} from "../store/store.ts";
import { runMaintenance, healthCheck } from "../graph/maintenance.ts";
import { reEmbedNodes } from "../graph/reembed.ts";

/** MCP server 句柄，便于 stop 时关闭 */
export interface McpServerHandle {
  httpServer: http.Server;
  mcpServer: McpServer;
  stop(): Promise<void>;
}

/**
 * 启动 MCP HTTP server
 *
 * @param driver   Neo4j driver（已初始化）
 * @param cfg      插件配置
 * @param llm      LLM complete 函数
 * @param embed    Embed 函数
 * @param recaller Recaller 实例（用于 feedback / benchmark / tune）
 */
export async function startMcpServer(
  driver: Driver,
  cfg: GmConfig,
  llm?: CompleteFn,
  embed?: EmbedFn,
  recaller?: Recaller,
): Promise<McpServerHandle> {
  const mcpCfg = cfg.mcp ?? {};
  const port = mcpCfg.port ?? 7800;
  const host = mcpCfg.host ?? "127.0.0.1";
  const path = mcpCfg.path ?? "/mcp";
  const authToken = mcpCfg.authToken;
  const enabledTools = mcpCfg.enabledTools; // undefined = 全部启用

  // ── 创建 McpServer ─────────────────────────────
  const mcpServer = new McpServer({
    name: "graph-memory-pro-mcp",
    version: "2.2.0",
  });

  const toolEnabled = (name: string): boolean =>
    !enabledTools || enabledTools.includes(name);

  // ── 工具注册 ──────────────────────────────────
  // 查询类（read-only）

  if (toolEnabled("gm_status")) {
    mcpServer.registerTool(
      "gm_status",
      {
        title: "Graph Memory Status",
        description: "Check if Graph Memory Pro is connected to Neo4j and return version info.",
        inputSchema: {},
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        try {
          const cnt = await getNodeCount(driver);
          return {
            content: [{ type: "text", text: JSON.stringify({ connected: true, version: "2.2.0", nodeCount: cnt }) }],
            structuredContent: { connected: true, version: "2.2.0", nodeCount: cnt },
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_stats")) {
    mcpServer.registerTool(
      "gm_stats",
      {
        title: "Graph Memory Stats",
        description: "Return total node count and edge count in the graph.",
        inputSchema: {},
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        try {
          const [nodeCount, edgeCount] = await Promise.all([getNodeCount(driver), getEdgeCount(driver)]);
          return {
            content: [{ type: "text", text: JSON.stringify({ nodeCount, edgeCount }) }],
            structuredContent: { nodeCount, edgeCount },
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_health")) {
    mcpServer.registerTool(
      "gm_health",
      {
        title: "Graph Memory Health Report",
        description: "Run G-5 health check and return anomalies (isolated/stale nodes, community stats, avg PageRank).",
        inputSchema: {},
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        try {
          const report = await healthCheck(driver);
          return {
            content: [{ type: "text", text: JSON.stringify(report) }],
            structuredContent: report as any,
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_get_node")) {
    mcpServer.registerTool(
      "gm_get_node",
      {
        title: "Get Node by ID",
        description: "Fetch a single node by its ID. Returns null if not found.",
        inputSchema: { id: z.string().describe("Node ID") },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ id }: { id: string }) => {
        try {
          const node = await findById(driver, id);
          return {
            content: [{ type: "text", text: JSON.stringify(node) }],
            structuredContent: node as any,
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_search")) {
    mcpServer.registerTool(
      "gm_search",
      {
        title: "Search Nodes",
        description: "Full-text search nodes by name/description/content. Returns matched nodes and their edges.",
        inputSchema: {
          query: z.string().min(1).describe("Search query"),
          limit: z.number().int().min(1).max(200).optional().describe("Max results (default 10)"),
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ query, limit }: { query: string; limit?: number }) => {
        try {
          const lim = limit ?? 10;
          const nodes = await searchNodes(driver, query, lim);
          const edges = await getEdgesForNodes(driver, nodes.map(n => n.id));
          return {
            content: [{ type: "text", text: JSON.stringify({ nodes, edges }) }],
            structuredContent: { nodes, edges },
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_top")) {
    mcpServer.registerTool(
      "gm_top",
      {
        title: "Top Nodes by PageRank",
        description: "Return top-N nodes ordered by PageRank score.",
        inputSchema: {
          limit: z.number().int().min(1).max(100).optional().describe("Top N (default 20, max 100)"),
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ limit }: { limit?: number }) => {
        try {
          const lim = limit ?? 20;
          const nodes = await getTopNodes(driver, lim);
          return {
            content: [{ type: "text", text: JSON.stringify(nodes) }],
            structuredContent: { nodes },
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
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
          limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ type, limit }: { type: "TASK" | "SKILL" | "EVENT"; limit?: number }) => {
        try {
          const nodes = await getNodesByType(driver, type, limit);
          return {
            content: [{ type: "text", text: JSON.stringify({ type, nodes }) }],
            structuredContent: { type, nodes },
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  // 写入类（mutating）

  if (toolEnabled("gm_record")) {
    mcpServer.registerTool(
      "gm_record",
      {
        title: "Record Knowledge Node",
        description: "Manually record a knowledge node (TASK / SKILL / EVENT) into the graph. Source: experience(default) / knowledge(external authoritative) / imported(manual).",
        inputSchema: {
          type: z.enum(["TASK", "SKILL", "EVENT"]).describe("Node type"),
          name: z.string().min(1).describe("Node name"),
          description: z.string().describe("Short description"),
          content: z.string().describe("Detailed content"),
          source: z.enum(["experience", "knowledge", "imported"]).optional().describe("S-3 source: experience(default) / knowledge(external) / imported(manual)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ type, name, description, content, source }: { type: "TASK" | "SKILL" | "EVENT"; name: string; description: string; content: string; source?: "experience" | "knowledge" | "imported" }) => {
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
            structuredContent: { id, source: source ?? "experience" },
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
        title: "Run Graph Maintenance",
        description: "Trigger full maintenance pipeline (dedup + PageRank + community + staleness + health).",
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        try {
          const result = await runMaintenance(driver, cfg, llm, embed);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result as any,
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
        title: "Re-Embed Nodes",
        description: "Batch re-embed active nodes that are missing embedding vectors.",
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async () => {
        try {
          if (!embed) return { content: [{ type: "text", text: "Embedding engine not configured" }] };
          const result = await reEmbedNodes(driver, embed, 50, cfg.embedding?.model);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result as any,
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_feedback") && recaller) {
    mcpServer.registerTool(
      "gm_feedback",
      {
        title: "Submit Recall Feedback",
        description: "Submit which recalled nodes were actually used. Drives I-2 judge + I-3 persistence + L-1 association matrix update.",
        inputSchema: {
          query: z.string().describe("Original user query"),
          recalledNodeIds: z.array(z.string()).describe("Node IDs returned by recall"),
          assistantReply: z.string().describe("Assistant's reply content"),
          sessionId: z.string().optional().describe("Session ID"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ query, recalledNodeIds, assistantReply, sessionId }: { query: string; recalledNodeIds: string[]; assistantReply: string; sessionId?: string }) => {
        try {
          const jm = recaller.getJudgeManager();
          if (!jm) {
            return { content: [{ type: "text", text: "Judge disabled. Set judge.enabled=true to enable feedback." }] };
          }
          const recalledNodes = (await Promise.all(
            recalledNodeIds.map(id => findById(driver, id)),
          )).filter(Boolean) as any[];
          await recaller.processFeedback(query, recalledNodes, assistantReply, sessionId);
          return {
            content: [{ type: "text", text: `Feedback submitted (recalled=${recalledNodes.length}, total=${jm.getFeedbackCount()})` }],
            structuredContent: { submitted: true, recalled: recalledNodes.length, totalFeedbacks: jm.getFeedbackCount() },
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_benchmark") && recaller) {
    mcpServer.registerTool(
      "gm_benchmark",
      {
        title: "Run Benchmark Evaluation",
        description: "Run S-10 benchmark (LoCoMo + LongMemEval) on current graph. Outputs P@1 / P@3 / MRR / F1 / P99 latency.",
        inputSchema: {
          datasets: z.union([z.literal("all"), z.array(z.string())]).optional().describe("Datasets to evaluate (default 'all')"),
          maxCases: z.number().int().min(0).optional().describe("Max cases per dataset (0 = all)"),
          buildGraph: z.boolean().optional().describe("Build graph from history before eval (default true)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ datasets, maxCases, buildGraph }: { datasets?: string | string[]; maxCases?: number; buildGraph?: boolean }) => {
        try {
          const { runBenchmark, formatAggregateReport } = await import("../benchmark/runner.ts");
          const result = await runBenchmark(recaller, driver, cfg, {
            datasets: (datasets ?? "all") as "all" | string[],
            maxCases: maxCases ?? cfg.benchmark?.maxCases ?? 0,
            buildGraph: buildGraph ?? cfg.benchmark?.buildGraph ?? true,
            caseTimeoutMs: cfg.benchmark?.caseTimeoutMs ?? 30_000,
            dataDir: cfg.benchmark?.dataDir,
            llm,
            embedFn: embed,
          });
          const text = formatAggregateReport(result);
          return {
            content: [{ type: "text", text }],
            structuredContent: result.aggregate,
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  if (toolEnabled("gm_tune") && recaller && cfg.autoTuner?.enabled === true) {
    mcpServer.registerTool(
      "gm_tune",
      {
        title: "Auto-Tune Cycle",
        description: "Run one EvolveMem auto-tuning cycle (EVALUATE → DIAGNOSE → PROPOSE → GUARD). Requires autoTuner.enabled=true.",
        inputSchema: {
          rounds: z.number().int().min(1).max(10).optional().describe("Number of tune cycles (default 1)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ rounds }: { rounds?: number }) => {
        try {
          const { AutoTuner } = await import("../evolution/auto-tuner.ts");
          const tuner = new AutoTuner(cfg.autoTuner!, llm);
          const r = await tuner.runTuneCycle(recaller, driver, cfg);
          return {
            content: [{ type: "text", text: JSON.stringify(r) }],
            structuredContent: r as any,
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  }

  // ── 启动 HTTP server，处理 Streamable HTTP transport ──
  const httpServer = http.createServer(async (req, res) => {
    // 只处理配置的 path
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      // 简单健康检查端点，供 dashboard 探活
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "graph-memory-pro-mcp", version: "2.2.0" }));
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Path not found. MCP endpoint at ${path}` }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", "Allow": "POST" });
      res.end(JSON.stringify({ error: "Method not allowed. Use POST for MCP requests." }));
      return;
    }

    // Bearer Token 鉴权
    if (authToken) {
      const auth = req.headers["authorization"] ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token !== authToken) {
        res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
        res.end(JSON.stringify({ error: "Unauthorized: invalid or missing Bearer token" }));
        return;
      }
    }

    // 读取请求体
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // 每个 POST 请求创建独立 transport（stateless，避免 sessionId 冲突）
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, payload);
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `MCP error: ${err.message}` }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, host, () => {
      resolve({
        httpServer,
        mcpServer,
        async stop() {
          await mcpServer.close();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}
