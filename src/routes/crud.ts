/**
 * graph-memory-pro — HTTP CRUD 路由
 *
 * 安全修复 (2.1.0):
 * - 不再返回密码等敏感信息
 * - 密码只接受写入，不返回
 */

import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import { getSession } from "../store/db.ts";
import {
  findById, searchNodes, getTopNodes, getNodesByType,
  getNodeCount, getEdgeCount, getEdgesForNodes,
} from "../store/store.ts";
import { runMaintenance, type MaintenanceResult } from "../graph/maintenance.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";

let _driver: Driver | null = null;
let _cfg: GmConfig | null = null;
let _llm: CompleteFn | null = null;
let _embed: EmbedFn | null = null;

export function initRoutes(
  driver: Driver,
  cfg: GmConfig,
  llm?: CompleteFn,
  embed?: EmbedFn,
): void {
  _driver = driver;
  _cfg = cfg;
  _llm = llm ?? null;
  _embed = embed ?? null;
}

interface RouteHandler {
  method: "GET" | "POST";
  path: string;
  handler: (params: any) => Promise<{ status: number; body: any }>;
}

export function getRoutes(): RouteHandler[] {
  return [
    { method: "GET", path: "/api/status", handler: handleStatus },
    { method: "GET", path: "/api/stats", handler: handleStats },
    { method: "GET", path: "/api/nodes/:id", handler: handleGetNode },
    { method: "GET", path: "/api/search", handler: handleSearch },
    { method: "GET", path: "/api/top", handler: handleTop },
    { method: "GET", path: "/api/nodes-by-type/:type", handler: handleNodesByType },
    { method: "POST", path: "/api/maintain", handler: handleMaintain },
  ];
}

async function handleStatus(): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    await _driver.verifyConnectivity();
    return { status: 200, body: { status: "connected", version: "2.1.0" } };
  } catch (err: any) {
    return { status: 503, body: { status: "disconnected", error: err.message } };
  }
}

async function handleStats(): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const [nodeCount, edgeCount] = await Promise.all([
      getNodeCount(_driver),
      getEdgeCount(_driver),
    ]);
    return { status: 200, body: { nodeCount, edgeCount } };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

async function handleGetNode(params: { id: string }): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const node = await findById(_driver, params.id);
    if (!node) return { status: 404, body: { error: "Node not found" } };
    return { status: 200, body: node };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

/** 安全解析整数参数 */
function safeParseInt(value: string | undefined, defaultValue: number, max?: number): number {
  const parsed = Number.parseInt(value ?? String(defaultValue), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return max ? Math.min(parsed, max) : parsed;
}

async function handleSearch(params: { query?: string; limit?: string }): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const q = params.query || "";
  const limit = safeParseInt(params.limit, 10, 50);
  if (!q.trim()) return { status: 400, body: { error: "query required" } };
  try {
    const nodes = await searchNodes(_driver, q, limit);
    const ids = nodes.map(n => n.id);
    const edges = await getEdgesForNodes(_driver, ids);
    return { status: 200, body: { nodes, edges } };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

async function handleTop(params: { limit?: string }): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const limit = safeParseInt(params.limit, 20, 100);
  try {
    const nodes = await getTopNodes(_driver, limit);
    return { status: 200, body: { nodes } };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

async function handleNodesByType(params: { type: string; limit?: string }): Promise<{ status: number; body: any }> {
  if (!_driver) return { status: 503, body: { error: "Neo4j not connected" } };
  const type = params.type.toUpperCase();
  if (!["TASK", "SKILL", "EVENT"].includes(type)) {
    return { status: 400, body: { error: `Invalid type: ${type}. Must be TASK, SKILL, or EVENT` } };
  }
  const limit = params.limit ? safeParseInt(params.limit, 10, 50) : undefined;
  try {
    const nodes = await getNodesByType(_driver, type, limit);
    return { status: 200, body: { type, nodes } };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}

async function handleMaintain(): Promise<{ status: number; body: any }> {
  if (!_driver || !_cfg) return { status: 503, body: { error: "Neo4j not connected" } };
  try {
    const result = await runMaintenance(_driver, _cfg, _llm ?? undefined, _embed ?? undefined);
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: 500, body: { error: err.message } };
  }
}
