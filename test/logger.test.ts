/**
 * P2-1 结构化日志单元测试（v2.2.0）
 *
 * 被测模块：src/logger.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createLogger, setExternalLogger, setTraceId, getTraceId,
  _resetLoggerState,
} from "../src/logger.ts";

describe("StructuredLogger", () => {
  beforeEach(() => {
    _resetLoggerState();
  });

  afterEach(() => {
    _resetLoggerState();
  });

  it("createLogger 返回同 namespace 的缓存实例", () => {
    const log1 = createLogger("test");
    const log2 = createLogger("test");
    expect(log1).toBe(log2);
    expect(log1.getNamespace()).toBe("test");
  });

  it("child() 返回带子命名空间的 logger", () => {
    const parent = createLogger("maintenance");
    const child = parent.child("dedup");
    expect(child.getNamespace()).toBe("maintenance:dedup");
    // child 是独立实例（缓存键不同）
    expect(child).not.toBe(parent);
  });

  it("info 级别默认输出到 console.log（不抛错）", () => {
    const log = createLogger("test1");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info("hello", { count: 5 });
    expect(spy).toHaveBeenCalled();
    const arg = spy.mock.calls[0][0];
    expect(arg).toContain("test1");
    expect(arg).toContain("INFO");
    expect(arg).toContain("hello");
    spy.mockRestore();
  });

  it("warn 映射到 console.warn", () => {
    const log = createLogger("test2");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.warn("warning", { code: 42 });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toContain("WARN");
    expect(spy.mock.calls[0][0]).toContain("warning");
    spy.mockRestore();
  });

  it("error 映射到 console.error", () => {
    const log = createLogger("test3");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("boom", { err: "x" });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toContain("ERROR");
    spy.mockRestore();
  });

  it("debug 默认不输出（GM_LOG_LEVEL=info）", () => {
    const origLevel = process.env.GM_LOG_LEVEL;
    delete process.env.GM_LOG_LEVEL;
    const log = createLogger("test4");
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    log.debug("should not appear");
    expect(spy).not.toHaveBeenCalled();
    process.env.GM_LOG_LEVEL = origLevel;
  });

  it("GM_LOG_LEVEL=debug 时 debug 输出", () => {
    const origLevel = process.env.GM_LOG_LEVEL;
    process.env.GM_LOG_LEVEL = "debug";
    const log = createLogger("test5");
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    log.debug("now visible");
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toContain("DEBUG");
    process.env.GM_LOG_LEVEL = origLevel;
  });

  it("GM_LOG_JSON=true 时输出 JSON 行到 stdout", () => {
    const origJson = process.env.GM_LOG_JSON;
    process.env.GM_LOG_JSON = "true";
    const log = createLogger("test6");
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    log.info("structured", { count: 7 });
    expect(writeSpy).toHaveBeenCalled();
    const line = writeSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.level).toBe("info");
    expect(parsed.plugin).toBe("graph-memory-pro");
    expect(parsed.module).toBe("test6");
    expect(parsed.msg).toBe("structured");
    expect(parsed.count).toBe(7);
    expect(typeof parsed.timestamp).toBe("string");
    process.env.GM_LOG_JSON = origJson;
    writeSpy.mockRestore();
  });

  it("setTraceId / getTraceId 设置当前请求 traceId", () => {
    setTraceId("req-abc-123");
    expect(getTraceId()).toBe("req-abc-123");

    const log = createLogger("test7");
    process.env.GM_LOG_JSON = "true";
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    log.info("with trace");
    const line = writeSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.traceId).toBe("req-abc-123");

    setTraceId(null);
    expect(getTraceId()).toBeNull();
    process.env.GM_LOG_JSON = undefined as any;
    writeSpy.mockRestore();
  });

  it("setExternalLogger 注入后转发到外部 logger", () => {
    const externalLog = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    setExternalLogger(externalLog);
    const log = createLogger("test8");
    log.info("forwarded", { x: 1 });
    log.warn("warning");
    log.error("error");
    expect(externalLog.info).toHaveBeenCalledTimes(1);
    expect(externalLog.warn).toHaveBeenCalledTimes(1);
    expect(externalLog.error).toHaveBeenCalledTimes(1);
    // 验证转发时带前缀
    const call = externalLog.info.mock.calls[0];
    expect(call[0]).toContain("test8");
    expect(call[0]).toContain("forwarded");
  });

  it("外部 logger 抛错时 fallback 到 stdout", () => {
    const failingExternal = {
      info: () => { throw new Error("external logger broken"); },
    };
    setExternalLogger(failingExternal);
    const log = createLogger("test9");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    // 不应抛错
    log.info("fallback");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("无效 GM_LOG_LEVEL 回退到 info", () => {
    const origLevel = process.env.GM_LOG_LEVEL;
    process.env.GM_LOG_LEVEL = "invalid_level";
    const log = createLogger("test10");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info("still works");
    expect(spy).toHaveBeenCalled();
    process.env.GM_LOG_LEVEL = origLevel;
    spy.mockRestore();
  });
});
