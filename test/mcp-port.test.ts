/**
 * 测试 src/mcp/server.ts — MCP server 端口处理（v2.5.x 回归）
 *
 * 覆盖本次修复的 3 个点：
 *   1. EADDRINUSE 自动 +1/+2/+3 重试，并返回实际监听端口
 *   2. close() 后端口可复用（优雅关闭 + 超时强回收）
 *   3. /health 探针在自动重试后仍可用（用 handle.port 而非配置端口）
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startMcpServer } from "../src/mcp/server.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";
import type { GmConfig } from "../src/types.ts";

/** 构造最小 GmConfig（mcp 默认关闭，仅测试用打开） */
function cfg(port: number): GmConfig {
  return {
    neo4j: { uri: "bolt://127.0.0.1:7687", user: "neo4j", password: "x" },
    compactTurnCount: 6,
    recallMaxNodes: 8,
    recallMaxDepth: 2,
    freshTailCount: 4,
    dedupThreshold: 0.92,
    pagerankDamping: 0.85,
    pagerankIterations: 30,
    mcp: { enabled: true, port, host: "127.0.0.1", path: "/mcp" },
  };
}

/** 探测某端口 /health 是否返回 ok */
async function healthOk(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

/** 获取一个当前空闲的端口 */
async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** 占用某端口直到返回的释放函数被调用 */
async function occupy(port: number): Promise<() => Promise<void>> {
  const srv = http.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", resolve);
  });
  return async () => {
    await new Promise<void>((r) => {
      srv.closeAllConnections?.();
      srv.close(() => r());
    });
  };
}

const opened: Array<{ close(): Promise<void> }> = [];
async function cleanup() {
  for (const h of opened.splice(0)) {
    try { await h.close(); } catch { /* ignore */ }
  }
}
afterEach(cleanup);

describe("startMcpServer 端口处理", () => {
  it("端口空闲时监听在配置端口，/health 正常", async () => {
    const base = await freePort();
    const h = await startMcpServer(mockDriver() as never, cfg(base));
    opened.push(h);
    expect(h.port).toBe(base);
    expect(await healthOk(base)).toBe(true);
  });

  it("配置端口被占用时自动 +1 重试，并返回实际端口", async () => {
    const base = await freePort();
    const release = await occupy(base);
    try {
      const h = await startMcpServer(mockDriver() as never, cfg(base));
      opened.push(h);
      expect(h.port).toBe(base + 1);
      expect(h.port).not.toBe(base);
      // 实际端口上的 /health 可用
      expect(await healthOk(h.port)).toBe(true);
    } finally {
      await release();
    }
  });

  it("close() 后端口可复用（重启链路不 EADDRINUSE）", async () => {
    const base = await freePort();
    const h1 = await startMcpServer(mockDriver() as never, cfg(base));
    expect(h1.port).toBe(base);
    await h1.close();
    // 旧端口应立即可复用
    const h2 = await startMcpServer(mockDriver() as never, cfg(base));
    opened.push(h2);
    expect(h2.port).toBe(base);
    expect(await healthOk(base)).toBe(true);
  });
});
