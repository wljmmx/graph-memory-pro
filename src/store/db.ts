/**
 * graph-memory-pro — Neo4j 连接管理（带自动重连）
 */

import neo4j, { Driver, Session, auth } from "neo4j-driver";
import type { Neo4jConfig } from "../types.ts";

const RETRY_DELAYS = [1000, 3000, 5000];

let _driver: Driver | null = null;
let _config: Neo4jConfig | null = null;

// v2.3.2 阶段三: 应用层 Session 计数 — 跟踪在途会话数（不等于 driver 内部活跃连接，但可反映并发压力）
let _activeSessions = 0;
let _totalSessionsCreated = 0;

export function createDriver(cfg: Neo4jConfig): Driver {
  const d = neo4j.driver(cfg.uri, auth.basic(cfg.user, cfg.password), {
    maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3h
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 10_000,
    // logging removed to avoid Neo4j ESM bundling issue
  });
  return d;
}

export function setDriver(d: Driver): void {
  _driver = d;
}

export function getDriver(): Driver | null {
  return _driver;
}

export function initDriver(cfg: Neo4jConfig): Driver {
  closeDriver();
  _config = cfg;
  _driver = createDriver(cfg);
  return _driver;
}

export function closeDriver(): void {
  if (_driver) {
    const oldDriver = _driver;
    _driver = null;
    _config = null;
    // 异步关闭旧 driver，不阻塞当前调用
    oldDriver.close().catch(() => {
      // ignore close errors
    });
  }
}

export function getConfig(): Neo4jConfig | null {
  return _config;
}

/**
 * 获取一个 Neo4j 会话
 * 调用方负责 `await session.close()`
 *
 * v2.3.2 阶段三: 包装 close() 做应用层 Session 计数（_activeSessions 递减）
 */
export function getSession(driver: Driver): Session {
  const session = driver.session({
    defaultAccessMode: neo4j.session.WRITE,
    database: "neo4j",
  });
  _activeSessions++;
  _totalSessionsCreated++;
  const origClose = session.close.bind(session);
  session.close = (async () => {
    try {
      await origClose();
    } finally {
      _activeSessions--;
    }
  }) as typeof session.close;
  return session;
}

/**
 * v2.3.2 阶段三: 获取连接池指标
 *
 * 组合应用层计数 + driver 内部反射（防御性，v6 API 可能变化）。
 * 反射失败时仅返回应用层计数，不抛错。
 */
export interface PoolMetrics {
  appActiveSessions: number;
  appTotalSessionsCreated: number;
  maxPoolSize: number;
  driverActiveConnections: number | null;
}

export function getPoolMetrics(): PoolMetrics {
  return {
    appActiveSessions: _activeSessions,
    appTotalSessionsCreated: _totalSessionsCreated,
    maxPoolSize: 50,
    // driver 内部 pool 反射读取（防御性，v6 内部 API 不稳定）
    // 失败返回 null，仅用应用层计数兜底
    driverActiveConnections: tryGetDriverActiveConnections(),
  };
}

/**
 * 尝试反射读取 driver 内部活跃连接数
 * neo4j-driver v6 内部结构: driver._connectionProvider._connectionPool
 * 此路径脆弱，driver 升级可能失效，必须 try/catch
 */
function tryGetDriverActiveConnections(): number | null {
  if (!_driver) return null;
  try {
    const provider = (_driver as any)._connectionProvider;
    const pool = provider?._connectionPool;
    if (!pool) return null;
    // pool._activeResourceCounts 是 Map<ServerAddress, number>
    const counts = pool._activeResourceCounts;
    if (counts instanceof Map) {
      let total = 0;
      for (const v of counts.values()) {
        total += typeof v === "number" ? v : 0;
      }
      return total;
    }
    // 某些版本是普通对象
    if (counts && typeof counts === "object") {
      return Object.values(counts).reduce((s: number, v: any) => s + (typeof v === "number" ? v : 0), 0);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 验证连接是否可用
 */
export async function verifyConnectivity(driver: Driver): Promise<boolean> {
  try {
    await driver.verifyConnectivity();
    return true;
  } catch {
    return false;
  }
}

/**
 * 带重试的连接验证
 */
export async function verifyWithRetry(driver: Driver): Promise<boolean> {
  const delays = [...RETRY_DELAYS];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (await verifyConnectivity(driver)) return true;
    if (attempt < delays.length) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  return false;
}
