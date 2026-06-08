/**
 * graph-memory-pro — Neo4j 连接管理（带自动重连）
 */

import neo4j, { Driver, Session, auth } from "neo4j-driver";
import type { Neo4jConfig } from "../types.ts";

const RETRY_DELAYS = [1000, 3000, 5000];

let _driver: Driver | null = null;
let _config: Neo4jConfig | null = null;

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
    try {
      _driver.close();
    } catch {
      // ignore close errors
    }
    _driver = null;
  }
}

export function getConfig(): Neo4jConfig | null {
  return _config;
}

/**
 * 获取一个 Neo4j 会话
 * 调用方负责 `await session.close()`
 */
export function getSession(driver: Driver): Session {
  return driver.session({
    defaultAccessMode: neo4j.session.WRITE,
    database: "neo4j",
  });
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
