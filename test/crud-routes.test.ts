/**
 * graph-memory-pro v2.2.0 — CRUD 路由单元测试
 *
 * 覆盖：/workspace/src/routes/crud.ts 的 9 个 HTTP handler
 *   handleStatus / handleStats / handleHealth / handleGetNode / handleSearch
 *   handleTop / handleNodesByType / handleMaintain / handleRefreshStaleness
 *
 * 策略：
 *   - 用 mockDriver() 构造 driver
 *   - 调用 initRoutes(driver, cfg) 初始化内部 _driver/_cfg
 *   - 通过 getRoutes() 获取路由数组，按 path 找到对应 handler 调用
 *   - 调用 handler(params) 断言 { status, body }
 *
 * 注意：
 *   - crud.ts 的 handler 未 export，必须通过 getRoutes() 访问
 *   - 返回节点对象的查询（findById/searchNodes/getTopNodes/getNodesByType）
 *     需要 record.get("n") 返回的对象具有 .properties/.labels 字段，
 *     而内置 mockRecord 会递归包装嵌套对象导致 .properties 不可达，
 *     故此类用例使用 setupCustomRun 直接返回构造好的 record。
 *   - 返回原始字段的查询（getNodeCount/getEdgeCount/healthCheck/computeStalenessScores）
 *     可直接使用 driver.queueResult / queueResults。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { initRoutes, getRoutes } from "../src/routes/crud.ts";
import { mockDriver, MockInteger } from "./helpers/neo4j-mock.ts";
import type { GmConfig } from "../src/types.ts";

// ── 辅助 ──────────────────────────────────────────────────────

const baseConfig: GmConfig = {
  neo4j: { uri: "", user: "", password: "" },
  compactTurnCount: 6,
  recallMaxNodes: 50,
  recallMaxDepth: 2,
  freshTailCount: 6,
  dedupThreshold: 0.92,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
};

/** 在 getRoutes() 中按 path 查找 handler */
function findHandler(path: string) {
  const route = getRoutes().find(r => r.path === path);
  if (!route) throw new Error(`Route ${path} not found`);
  return route.handler;
}

/** 构造一个 record：get(key) 返回原始对象（不递归包装），数字包装为 MockInteger */
function makeRecord(fields: Record<string, any>) {
  return {
    get(k: string) {
      const v = fields[k];
      if (v == null) return null;
      if (typeof v === "number") return new MockInteger(v);
      return v;
    },
    has(k: string) { return k in fields; },
    keys: () => Object.keys(fields),
  };
}

/** 构造一个节点对象（具有 .properties/.labels，recordToNode 可识别） */
function makeNodeObj(props: Record<string, any>, label = "Task") {
  return { properties: props, labels: [label] };
}

/**
 * 覆盖 session.run，按调用顺序返回预置 records
 * 用于返回节点对象的查询（绕过 mockRecord 的递归包装）
 */
function setupCustomRun(driver: any, resultsByCall: any[][]) {
  const session = driver.session();
  let callIndex = 0;
  session.run = async (query: string, params: Record<string, any> = {}) => {
    session.runCalls.push({ query, params });
    const records = callIndex < resultsByCall.length ? resultsByCall[callIndex++] : [];
    return { records, summary: { counters: { upserts: () => 0 } } };
  };
  return session;
}

beforeEach(() => {
  // 重置内部 _driver 为 null，确保每个测试从干净状态开始
  initRoutes(null as any, baseConfig);
});

// ═══════════════════════════════════════════════════════════════
// handleStatus
// ═══════════════════════════════════════════════════════════════

describe("handleStatus", () => {
  it("connected: verifyConnectivity 成功 → 200", async () => {
    const driver = mockDriver() as any;
    driver.verifyConnectivity = async () => {};
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/status");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(result.body.status).toBe("connected");
    expect(result.body.version).toBe("2.3.0");
  });

  it("disconnected: verifyConnectivity 抛错 → 503", async () => {
    const driver = mockDriver() as any;
    driver.verifyConnectivity = async () => {
      throw new Error("connection refused");
    };
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/status");
    const result = await handler({});

    expect(result.status).toBe(503);
    expect(result.body.status).toBe("disconnected");
    expect(result.body.error).toContain("connection refused");
  });
});

// ═══════════════════════════════════════════════════════════════
// handleStats
// ═══════════════════════════════════════════════════════════════

describe("handleStats", () => {
  it("正常返回 nodeCount/edgeCount", async () => {
    const driver = mockDriver() as any;
    // getNodeCount → [{c:5}], getEdgeCount → [{c:3}]
    driver.queueResults([
      [{ c: 5 }],
      [{ c: 3 }],
    ]);
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/stats");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(result.body.nodeCount).toBe(5);
    expect(result.body.edgeCount).toBe(3);
  });

  it("无 driver 时返回 503", async () => {
    // beforeEach 已将 _driver 置 null
    const handler = findHandler("/api/stats");
    const result = await handler({});

    expect(result.status).toBe(503);
    expect(result.body.error).toContain("not connected");
  });
});

// ═══════════════════════════════════════════════════════════════
// handleHealth
// ═══════════════════════════════════════════════════════════════

describe("handleHealth", () => {
  it("正常返回 health report", async () => {
    const driver = mockDriver() as any;
    // 6 次查询依次返回：nodeStats / edgeStats / isolated / stale / community / pr
    driver.queueResults([
      [{ total: 5, active: 5, superseded: 0, transitional: 0 }],
      [{ type: "RELATES_TO", cnt: 10 }],
      [{ cnt: 1 }],
      [{ cnt: 0 }],
      [{ cnt: 2 }],
      [{ id: "n1", name: "node1", pr: 0.5 }],
    ]);
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/health");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(result.body.nodes).toBeDefined();
    expect(result.body.nodes.total).toBe(5);
    expect(result.body.nodes.active).toBe(5);
    expect(result.body.nodes.superseded).toBe(0);
    expect(result.body.edges).toBeDefined();
    expect(result.body.edges.total).toBe(10);
    expect(result.body.edges.byType["RELATES_TO"]).toBe(10);
    expect(result.body.isolatedNodes).toBe(1);
    expect(result.body.communities).toBe(2);
    expect(Array.isArray(result.body.anomalies)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// handleGetNode
// ═══════════════════════════════════════════════════════════════

describe("handleGetNode", () => {
  it("找到节点 → 200", async () => {
    const driver = mockDriver() as any;
    setupCustomRun(driver, [
      [makeRecord({
        n: makeNodeObj({
          id: "n1",
          name: "test-node",
          description: "desc",
          content: "content",
          type: "TASK",
          status: "active",
          pagerank: 0.5,
          validatedCount: 3,
          createdAt: 1000,
          updatedAt: 2000,
        }),
      })],
    ]);
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/nodes/:id");
    const result = await handler({ id: "n1" });

    expect(result.status).toBe(200);
    expect(result.body.id).toBe("n1");
    expect(result.body.name).toBe("test-node");
    expect(result.body.type).toBe("TASK");
  });

  it("未找到节点 → 404", async () => {
    const driver = mockDriver() as any;
    setupCustomRun(driver, [[]]); // 空结果
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/nodes/:id");
    const result = await handler({ id: "missing" });

    expect(result.status).toBe(404);
    expect(result.body.error).toContain("not found");
  });
});

// ═══════════════════════════════════════════════════════════════
// handleSearch
// ═══════════════════════════════════════════════════════════════

describe("handleSearch", () => {
  it("正常搜索 → 200，返回 nodes 和 edges", async () => {
    const driver = mockDriver() as any;
    // v2.3.1 P1-1: searchNodes 改为 4 个 fulltext 索引并行查询
    // 4 次 session.run（task/skill/event/conversation 索引各一次）+ 1 次 getEdgesForNodes
    const nodeRecord = makeRecord({
      n: makeNodeObj({
        id: "n1",
        name: "alpha",
        type: "TASK",
        status: "active",
        validatedCount: 5,
        updatedAt: 1000,
      }),
      score: 0.9,
    });
    const edgeRecord = makeRecord({
      r: {
        properties: { id: "e1", fromId: "n1", toId: "n2", instruction: "rel", weight: 1 },
        type: "RELATES_TO",
      },
    });
    setupCustomRun(driver, [
      [nodeRecord],  // task_search 索引返回 1 个节点
      [],            // skill_search 索引返回空
      [],            // event_search 索引返回空
      [],            // conversation_search 索引返回空
      [edgeRecord],  // getEdgesForNodes 返回 1 条边
    ]);
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/search");
    const result = await handler({ query: "alpha" });

    expect(result.status).toBe(200);
    expect(Array.isArray(result.body.nodes)).toBe(true);
    expect(result.body.nodes.length).toBe(1);
    expect(result.body.nodes[0].id).toBe("n1");
    expect(Array.isArray(result.body.edges)).toBe(true);
    expect(result.body.edges.length).toBe(1);
  });

  it("空 query → 400", async () => {
    const driver = mockDriver() as any;
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/search");
    const result = await handler({ query: "   " });

    expect(result.status).toBe(400);
    expect(result.body.error).toContain("query required");
  });

  it("带 limit 参数 → 200，limit 透传到 searchNodes Cypher", async () => {
    const driver = mockDriver() as any;
    setupCustomRun(driver, [
      [], // searchNodes 返回空 → 无需 getEdgesForNodes 调用
    ]);
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/search");
    const result = await handler({ query: "test", limit: "5" });

    expect(result.status).toBe(200);
    expect(result.body.nodes).toEqual([]);
    expect(result.body.edges).toEqual([]);
    // 验证 limit 已透传到 Cypher 参数
    const calls = driver.getAllRunCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].params.limit).toBe(5);
    expect(calls[0].params.query).toBe("test");
  });
});

// ═══════════════════════════════════════════════════════════════
// handleTop
// ═══════════════════════════════════════════════════════════════

describe("handleTop", () => {
  it("正常返回 top nodes", async () => {
    const driver = mockDriver() as any;
    setupCustomRun(driver, [
      [
        makeRecord({
          n: makeNodeObj({
            id: "n1", name: "top1", type: "TASK", status: "active",
            pagerank: 0.9, validatedCount: 10,
          }),
        }),
        makeRecord({
          n: makeNodeObj({
            id: "n2", name: "top2", type: "SKILL", status: "active",
            pagerank: 0.5, validatedCount: 5,
          }, "Skill"),
        }),
      ],
    ]);
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/top");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(Array.isArray(result.body.nodes)).toBe(true);
    expect(result.body.nodes.length).toBe(2);
    expect(result.body.nodes[0].id).toBe("n1");
    expect(result.body.nodes[1].id).toBe("n2");
  });
});

// ═══════════════════════════════════════════════════════════════
// handleNodesByType
// ═══════════════════════════════════════════════════════════════

describe("handleNodesByType", () => {
  it("正常返回指定类型的节点（小写 type 自动转大写）", async () => {
    const driver = mockDriver() as any;
    setupCustomRun(driver, [
      [makeRecord({
        n: makeNodeObj({
          id: "s1", name: "skill-1", type: "SKILL", status: "active",
          validatedCount: 2,
        }, "Skill"),
      })],
    ]);
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/nodes-by-type/:type");
    const result = await handler({ type: "skill" });

    expect(result.status).toBe(200);
    expect(result.body.type).toBe("SKILL");
    expect(result.body.nodes.length).toBe(1);
    expect(result.body.nodes[0].id).toBe("s1");
  });

  it("无效 type → 400", async () => {
    const driver = mockDriver() as any;
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/nodes-by-type/:type");
    const result = await handler({ type: "INVALID" });

    expect(result.status).toBe(400);
    expect(result.body.error).toContain("Invalid type");
    expect(result.body.error).toContain("INVALID");
  });
});

// ═══════════════════════════════════════════════════════════════
// handleMaintain
// ═══════════════════════════════════════════════════════════════

describe("handleMaintain", () => {
  it("正常触发维护，返回 MaintenanceResult 结构", async () => {
    const driver = mockDriver() as any;
    // 不预置数据 → 各 phase try-catch 内部失败，但 runMaintenance 仍返回结构化结果
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/maintain");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(result.body).toBeDefined();
    expect(result.body.dedup).toBeDefined();
    expect(result.body.pagerank).toBeDefined();
    expect(result.body.community).toBeDefined();
    expect(result.body.communitySummaries).toBe(0);
    expect(typeof result.body.durationMs).toBe("number");
  });

  it("无 driver 时返回 503", async () => {
    // beforeEach 已将 _driver 置 null
    const handler = findHandler("/api/maintain");
    const result = await handler({});

    expect(result.status).toBe(503);
    expect(result.body.error).toContain("not connected");
  });
});

// ═══════════════════════════════════════════════════════════════
// handleRefreshStaleness
// ═══════════════════════════════════════════════════════════════

describe("handleRefreshStaleness", () => {
  it("正常刷新 staleness，返回 scanned/updated/highStaleCount", async () => {
    const driver = mockDriver() as any;
    // 1 次 scan 查询返回 2 个新鲜节点（age≈0, inDegree>0 → score=0, highStaleCount=0）
    driver.queueResult([
      { id: "n1", inDegree: 5 },
      { id: "n2", inDegree: 3 },
    ]);
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/staleness/refresh");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(result.body.scanned).toBe(2);
    expect(result.body.updated).toBe(2);
    expect(result.body.highStaleCount).toBe(0);
    // 1 次 scan + 2 次 SET = 3 次调用
    expect(driver.getAllRunCalls().length).toBe(3);
  });

  it("无 driver 时返回 503", async () => {
    const handler = findHandler("/api/staleness/refresh");
    const result = await handler({});

    expect(result.status).toBe(503);
    expect(result.body.error).toContain("not connected");
  });
});

// ═══════════════════════════════════════════════════════════════
// handleMetrics (v2.2.0 P2-2)
// ═══════════════════════════════════════════════════════════════

describe("handleMetrics", () => {
  it("无 driver → 503 + graph_memory_up 0", async () => {
    const handler = findHandler("/api/metrics");
    const result = await handler({});

    expect(result.status).toBe(503);
    expect(result.body).toContain("graph_memory_up 0");
  });

  it("正常返回 Prometheus text exposition format", async () => {
    const driver = mockDriver() as any;
    // getNodeCount → [{c:5}], getEdgeCount → [{c:3}], getFeedbackCount → [{c:7}]
    driver.queueResults([
      [{ c: 5 }],
      [{ c: 3 }],
      [{ c: 7 }],
    ]);
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/metrics");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(typeof result.body).toBe("string");
    expect(result.body).toContain("# HELP graph_memory_up");
    expect(result.body).toContain("# TYPE graph_memory_up gauge");
    expect(result.body).toContain("graph_memory_up{");
    expect(result.body).toContain("graph_memory_nodes_total{");
    expect(result.body).toContain("graph_memory_edges_total{");
    expect(result.body).toContain("graph_memory_feedback_total{");
    // 验证数值
    expect(result.body).toMatch(/graph_memory_nodes_total\{[^}]*\} 5/);
    expect(result.body).toMatch(/graph_memory_edges_total\{[^}]*\} 3/);
    expect(result.body).toMatch(/graph_memory_feedback_total\{[^}]*\} 7/);
  });

  it("查询失败时仍返回 200 + up=1（基础计数降级为 0）", async () => {
    const driver = mockDriver() as any;
    // 让所有查询抛错
    const session = driver.session();
    session.run = async () => { throw new Error("db down"); };
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/metrics");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(result.body).toContain("graph_memory_up{");
    expect(result.body).toMatch(/graph_memory_nodes_total\{[^}]*\} 0/);
  });
});

// ═══════════════════════════════════════════════════════════════
// handleAutoTunerState (v2.2.0 P2-3)
// ═══════════════════════════════════════════════════════════════

describe("handleAutoTunerState", () => {
  it("无持久化状态文件时返回 available=false", async () => {
    // 用空 HOME 避免 readFile 命中真实文件
    const origHome = process.env.HOME;
    process.env.HOME = "/nonexistent-path-xyz";
    const driver = mockDriver() as any;
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/auto-tuner/state");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(result.body.available).toBe(false);
    expect(result.body.reason).toContain("no persisted state");

    process.env.HOME = origHome;
  });

  it("配置中 autoTuner.enabled 未设置时 enabled=false", async () => {
    const origHome = process.env.HOME;
    process.env.HOME = "/nonexistent-path-xyz";
    const driver = mockDriver() as any;
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/auto-tuner/state");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(result.body.enabled).toBe(false);

    process.env.HOME = origHome;
  });
});

// ═══════════════════════════════════════════════════════════════
// handleAssociationMatrixState (v2.2.0 P2-4)
// ═══════════════════════════════════════════════════════════════

describe("handleAssociationMatrixState", () => {
  it("无 recaller → available=false", async () => {
    const driver = mockDriver() as any;
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/association-matrix/state");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(result.body.available).toBe(false);
    expect(result.body.reason).toContain("association matrix not initialized");
  });

  it("配置中 associationMatrix.enabled 未设置时 enabled=false", async () => {
    const driver = mockDriver() as any;
    initRoutes(driver, baseConfig);

    const handler = findHandler("/api/association-matrix/state");
    const result = await handler({});

    expect(result.status).toBe(200);
    expect(result.body.enabled).toBe(false);
  });
});
