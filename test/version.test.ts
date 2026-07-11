/**
 * 测试 src/version.ts — 统一版本号
 */
import { describe, it, expect } from "vitest";
import { VERSION } from "../src/version.ts";

describe("VERSION", () => {
  it("是符合 semver 的字符串", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("导出版本号为 2.3.3", () => {
    expect(VERSION).toBe("2.3.3");
  });
});