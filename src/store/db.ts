/**
 * graph-memory-pro — Neo4j 连接管理（带自动重连）
 */

import neo4j, { Driver, Session, auth } from "neo4j-driver";
import type { Neo4jConfig } from "../types.ts";

const RETRY_DELAYS = [1000, 3000, 5000];

// v2.3.5: 默认值常量（与 neo4j-driver 默认一致）
const DEFAULT_MAX_CONNECTION_POOL_SIZE = 50;
const DEFAULT_CONNECTION_ACQUISITION_TIMEOUT = 10_000;

let _driver: Driver | null = null;
let _config: Neo4jConfig | null = null;
// v2.3.5: 记录实际生效的 maxPoolSize，供 getPoolMetrics 返回真实值（而非硬编码 50）
let _effectiveMaxPoolSize = DEFAULT_MAX_CONNECTION_POOL_SIZE;
// v2.4.0: 当前会话目标数据库。默认取配置 cfg.database（缺省 neo4j），
//      benchmark 通过 withDatabase() 临时切换到隔离的 benchmarks 数据库，避免污染生产。
let _activeDatabase = "neo4j";

// v2.4.1: 流程作用域开关（数据查询隔离）。
//   - "production": 正式流程，所有查询排除 :Benchmark 标签节点（生产数据纯净）
//   - "benchmark":  基准流程，查询不过滤 :Benchmark（评测只需命中 benchmark 节点）
//   benchmark 通过 withFlowScope("benchmark") 临时切换，结束后恢复 production。
export type FlowScope = "production" | "benchmark";
let _flowScope: FlowScope = "production";

/** 获取当前流程作用域（默认 production） */
export function getFlowScope(): FlowScope {
  return _flowScope;
}

/** 设置流程作用域（基准/生产），调用方负责在 finally 中恢复 */
export function setFlowScope(scope: FlowScope): void {
  _flowScope = scope;
}

/**
 * v2.4.1: 在指定流程作用域上下文中执行 fn，结束后恢复原作用域。
 *
 * 与 withDatabase 配合实现"两个流程数据处理互相隔离"：
 *   - 生产流程：scope=production → 查询排除 :Benchmark 节点，写生产 M
 *   - benchmark 流程：scope=benchmark → 查询命中 :Benchmark 节点，写 benchmark M
 */
export async function withFlowScope<T>(scope: FlowScope, fn: () => Promise<T>): Promise<T> {
  const prev = _flowScope;
  _flowScope = scope;
  try {
    return await fn();
  } finally {
    _flowScope = prev;
  }
}

// v2.3.2 阶段三: 应用层 Session 计数 — 跟踪在途会话数（不等于 driver 内部活跃连接，但可反映并发压力）
let _activeSessions = 0;
let _totalSessionsCreated = 0;

export function createDriver(cfg: Neo4jConfig): Driver {
  const maxPoolSize = cfg.maxConnectionPoolSize ?? DEFAULT_MAX_CONNECTION_POOL_SIZE;
  const acquisitionTimeout = cfg.connectionAcquisitionTimeout ?? DEFAULT_CONNECTION_ACQUISITION_TIMEOUT;
  _effectiveMaxPoolSize = maxPoolSize;
  const d = neo4j.driver(cfg.uri, auth.basic(cfg.user, cfg.password), {
    maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3h
    maxConnectionPoolSize: maxPoolSize,
    connectionAcquisitionTimeout: acquisitionTimeout,
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
  _activeDatabase = cfg.database ?? "neo4j";
  _driver = createDriver(cfg);
  return _driver;
}

export function closeDriver(): void {
  if (_driver) {
    const oldDriver = _driver;
    _driver = null;
    _config = null;
    _effectiveMaxPoolSize = DEFAULT_MAX_CONNECTION_POOL_SIZE;
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
 * v2.3.5: 核实实际连接的 Neo4j 版本（CALL dbms.components()）
 *
 * 用途：诊断 power() 等 5.x 专有函数报 "Unknown function" 的根因。
 *   - 若返回版本 < 5.0，说明连的是 4.x，power()/向量索引等都会失败
 *   - 若返回 5.x+（如 2026.06.0），说明连接正确，问题在其他环节
 *
 * 返回规范化后的版本字符串（如 "2026.06.0"），失败返回 null。
 */
export async function getNeo4jVersion(driver: Driver): Promise<string | null> {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(
      "CALL dbms.components() YIELD name, versions WHERE name = 'Neo4j Kernel' RETURN versions",
    );
    const versions = result.records[0]?.get("versions");
    const arr = versions?.toArray ? versions.toArray() : (Array.isArray(versions) ? versions : []);
    const v = arr[0] ?? null;
    return v ? String(v) : null;
  } catch {
    // dbms.components() 可能因权限或 server 版本不可用，静默失败
    return null;
  } finally {
    await session.close();
  }
}

/**
 * v2.3.5: 判断给定版本号是否为 Neo4j 5.x+（支持 power() 等 5.x 函数）
 * 返回 true 表示 >= 5.0 或无法解析（不误报）。
 */
export function isNeo4j5Plus(version: string | null): boolean {
  if (!version) return true; // 未知版本不误报
  const m = /^(\d+)/.exec(version.trim());
  if (!m) return true;
  return parseInt(m[1], 10) >= 5;
}

/**
 * 获取一个 Neo4j 会话
 * 调用方负责 `await session.close()`
 *
 * v2.3.2 阶段三: 包装 close() 做应用层 Session 计数（_activeSessions 递减）
 * v2.4.0: 支持显式传入 database；缺省使用当前激活数据库（_activeDatabase，可被 withDatabase 切换）
 */
export function getSession(driver: Driver, database?: string): Session {
  const db = database ?? _activeDatabase;
  const session = driver.session({
    defaultAccessMode: neo4j.session.WRITE,
    database: db,
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
 * v2.4.0: 获取当前激活数据库名（默认 neo4j）。
 */
export function getActiveDatabase(): string {
  return _activeDatabase;
}

/**
 * v2.4.0: 在指定数据库上下文中执行 fn，执行结束后恢复原数据库。
 *
 * 用途：benchmark 运行时临时切换到隔离的 benchmarks 数据库，避免污染生产数据。
 * 注意：所有经 getSession(driver) 创建的写会话都会继承该数据库名。
 * 需 Neo4j Enterprise 多库支持；Community 单库时请保持与生产一致（依赖 bench- 前缀 + 清理做逻辑隔离）。
 */
export async function withDatabase<T>(database: string, fn: () => Promise<T>): Promise<T> {
  const prev = _activeDatabase;
  _activeDatabase = database;
  try {
    return await fn();
  } finally {
    _activeDatabase = prev;
  }
}

/**
 * v2.3.2 阶段三: 获取连接池指标
 *
 * 组合应用层计数 + driver 内部反射（防御性，v6 API 可能变化）。
 * 反射失败时仅返回应用层计数，不抛错。
 *
 * v2.3.5: maxPoolSize 改为返回 createDriver 实际生效的配置值，
 *         不再硬编码 50（用户可在 neo4j.maxConnectionPoolSize 中配置）。
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
    maxPoolSize: _effectiveMaxPoolSize,
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
    // neo4j-driver v6 内部私有结构反射，类型跨版本不稳定，按 SDK 边界处理
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      return Object.values(counts).reduce((s: number, v) => s + (typeof v === "number" ? v : 0), 0);
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
