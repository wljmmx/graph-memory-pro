/**
 * 结构化日志（v2.2.0 P2-1）
 *
 * 统一的可观测性日志接口：
 *   - 分级：debug / info / warn / error
 *   - 结构化字段：plugin / module / level / msg / data / timestamp / traceId?
 *   - 可选 JSON 输出（GM_LOG_JSON=true）
 *   - 可选级别过滤（GM_LOG_LEVEL=debug|info|warn|error）
 *   - 可选 traceId 关联（setTraceId 在请求入口设置）
 *
 * 默认行为：
 *   - 输出到 stdout（保留向后兼容，等价于 console.log）
 *   - 仅 info 及以上输出（除非 GM_LOG_LEVEL=debug）
 *   - 不强制 JSON，开发模式仍可读
 *
 * 用法：
 *   import { createLogger } from "../logger.ts";
 *   const log = createLogger("recaller");
 *   log.info("recall completed", { nodes: 5, edges: 3 });
 *   log.warn("fallback triggered", { reason: "vec search failed" });
 *
 * 与 OpenClaw SDK logger 集成：
 *   - index.ts 顶层使用 SDK 注入的 api.logger
 *   - 深层模块通过 createLogger(namespace) 获取结构化 logger
 *   - 通过 setExternalLogger(sdkLogger) 把 SDK logger 注入到本模块
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** 子命名空间（链路追踪） */
  child(subNamespace: string): Logger;
  /** 获取当前命名空间 */
  getNamespace(): string;
}

// ── 全局配置 ──────────────────────────────────────────────

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function getConfiguredLevel(): LogLevel {
  const env = (process.env.GM_LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVEL_PRIORITY[env] !== undefined ? env : "info";
}

function isJsonOutput(): boolean {
  return process.env.GM_LOG_JSON === "true";
}

// ── 外部 logger 注入（SDK 集成） ──────────────────────────────

interface ExternalLogger {
  debug?(msg: string, ...args: any[]): void;
  info?(msg: string, ...args: any[]): void;
  warn?(msg: string, ...args: any[]): void;
  error?(msg: string, ...args: any[]): void;
}

let _externalLogger: ExternalLogger | null = null;

/**
 * 注入 OpenClaw SDK logger
 *
 * 注入后所有 createLogger 创建的 logger 都会转发到 SDK logger，
 * 同时仍保留结构化字段（作为 JSON 字符串前缀）。
 */
export function setExternalLogger(logger: ExternalLogger | null): void {
  _externalLogger = logger;
}

// ── traceId 上下文 ──────────────────────────────────────────

let _traceId: string | null = null;

/**
 * 设置当前请求的 traceId（用于跨模块关联）
 *
 * 在 HTTP 请求入口或 MCP 工具入口设置，请求结束时清空。
 */
export function setTraceId(id: string | null): void {
  _traceId = id;
}

/** 获取当前 traceId */
export function getTraceId(): string | null {
  return _traceId;
}

// ── Logger 实现 ──────────────────────────────────────────

class StructuredLogger implements Logger {
  constructor(private readonly namespace: string) {}

  getNamespace(): string {
    return this.namespace;
  }

  child(subNamespace: string): Logger {
    return new StructuredLogger(`${this.namespace}:${subNamespace}`);
  }

  debug(msg: string, fields?: LogFields): void {
    this.log("debug", msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.log("info", msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.log("warn", msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.log("error", msg, fields);
  }

  private log(level: LogLevel, msg: string, fields?: LogFields): void {
    const configLevel = getConfiguredLevel();
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[configLevel]) return;

    // 构造结构化记录
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      plugin: "graph-memory-pro",
      module: this.namespace,
      msg,
    };
    if (_traceId) record.traceId = _traceId;
    if (fields) Object.assign(record, fields);

    // 外部 logger 优先（SDK 集成）
    if (_externalLogger) {
      const formatted = `[graph-memory-pro:${this.namespace}] ${msg}`;
      const fn = _externalLogger[level];
      if (typeof fn === "function") {
        try {
          fn.call(_externalLogger, formatted, fields ?? {});
          return;
        } catch {
          // SDK logger 失败 → fallback 到 stdout
        }
      }
    }

    // 默认输出
    if (isJsonOutput()) {
      const line = JSON.stringify(record);
      const target = level === "error" ? process.stderr : process.stdout;
      target.write(line + "\n");
    } else {
      // 开发可读格式：[graph-memory-pro:namespace] LEVEL msg {fields}
      const fieldsStr = fields && Object.keys(fields).length > 0
        ? " " + JSON.stringify(fields)
        : "";
      const line = `[graph-memory-pro:${this.namespace}] ${level.toUpperCase()} ${msg}${fieldsStr}`;
      switch (level) {
        case "debug": console.debug(line); break;
        case "info": console.log(line); break;
        case "warn": console.warn(line); break;
        case "error": console.error(line); break;
      }
    }
  }
}

// ── 工厂 ──────────────────────────────────────────────────

const _loggerCache = new Map<string, Logger>();

/**
 * 创建结构化 logger
 *
 * @param namespace 模块命名空间（如 "recaller" / "maintenance:dedup"）
 * @returns Logger 实例
 */
export function createLogger(namespace: string): Logger {
  if (!_loggerCache.has(namespace)) {
    _loggerCache.set(namespace, new StructuredLogger(namespace));
  }
  return _loggerCache.get(namespace)!;
}

/**
 * 重置全局状态（测试用）
 */
export function _resetLoggerState(): void {
  _externalLogger = null;
  _traceId = null;
  _loggerCache.clear();
}
