/**
 * v2.8.x — openclaw 2026.10.4 SDK 适配的回归守卫
 *
 * 本文件的规则**逐条来自已核对的 openclaw 源码**（cloned v2026.10.4），非推测：
 *
 * | 事实 | 源码位置 |
 * |---|---|
 * | `api.runtime` 在 cli-metadata / setup-only 下是「访问即抛错」Proxy | `src/plugins/api-builder.ts` createUnavailableRuntime |
 * | 该 Proxy 由两条路径注入 | `registry-api.ts`（cli-metadata）/ `captured-registration.ts`（cli-metadata \|\| setup-only） |
 * | 兜底超时：agent_end 30s、gateway_stop 5s | `src/plugins/hooks.ts` DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK |
 * | 超时**不取消** handler（race + trackAsyncWork 保留其工作） | `src/plugins/hook-timeout.ts` |
 * | 超时优先级：hooks.timeouts.<hook> > hooks.timeoutMs > 插件自声明 | `src/plugins/registry-state.ts` resolveTypedHookTimeoutMs |
 * | `api.on` 第三参在 2026.7.x 只有 `{ priority, timeoutMs }`；`matcher` 是 2026.8.1 新增 | 各版本 `package/dist/types-<hash>.d.ts` 中的 `on:` 签名 |
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..");
const src = readFileSync(resolve(repoRoot, "index.ts"), "utf-8");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as {
  openclaw: {
    compat: { pluginApi: string; minGatewayVersion: string };
    build: { openclawVersion: string; pluginSdkVersion: string };
    extensions: string[];
  };
};

describe("after_tool_call 注册（兼容 2026.7.x 的 api.on 选项类型）", () => {
  it("不向 api.on 传 matcher（2026.7.x 无此选项，会 DTS 报 TS2353）", () => {
    expect(src).not.toMatch(/,\s*\{\s*matcher:/);
  });

  it("handler 内保留工具白名单过滤（无宿主侧前置过滤，必须自行兜底）", () => {
    expect(src).toContain("MEMORY_TOOL_NAMES.has(toolName)");
  });
});

describe("注册模式守卫（cli-metadata / setup-only 不得做重初始化）", () => {
  it("两个无运行时模式都被显式挡住", () => {
    expect(src).toMatch(/NON_RUNTIME_REGISTRATION_MODES\s*=\s*new Set\(\[[^\]]*"cli-metadata"[^\]]*"setup-only"/s);
  });

  it("doGatewayInitInner 在重活之前就 return（不连 Neo4j、不建 schema）", () => {
    const fnStart = src.indexOf("async function doGatewayInitInner(");
    expect(fnStart).toBeGreaterThan(-1);
    const head = src.slice(fnStart, fnStart + 700);
    // 守卫必须出现在读取 pluginConfig / 建 driver 之前
    expect(head).toContain("nonRuntimeRegistrationMode(api)");
    expect(head.indexOf("nonRuntimeRegistrationMode(api)")).toBeLessThan(head.indexOf("api.pluginConfig"));
  });

  it("api.runtime 访问被 try/catch 包住（?. 拦不住抛错的 getter）", () => {
    // 注意：上面守卫的**注释里也出现了 `api.runtime?.llm` 字样**，故不能用 indexOf（会命中注释）。
    // 这里定位真正的赋值语句。
    const needle = "runtimeLlm = api.runtime?.llm";
    expect(src).toContain(needle);
    const idx = src.indexOf(needle);
    const before = src.slice(Math.max(0, idx - 120), idx);
    const after = src.slice(idx, idx + 300);
    expect(before, "缺少 try 保护").toContain("try {");
    expect(after, "缺少 catch 保护").toContain("catch");
  });
});

describe("hook 超时预算（宿主默认 agent_end=30s / gateway_stop=5s，且超时不取消 handler）", () => {
  it("agent_end 声明了 timeoutMs", () => {
    expect(src).toMatch(/api\.on\("agent_end"[\s\S]*?\}\s*,\s*\{\s*timeoutMs:\s*AGENT_END_TIMEOUT_MS\s*\}\s*\)/);
  });

  it("gateway_stop 声明了 timeoutMs", () => {
    expect(src).toMatch(/api\.on\("gateway_stop"[\s\S]*?\}\s*,\s*\{\s*timeoutMs:\s*GATEWAY_STOP_TIMEOUT_MS\s*\}\s*\)/);
  });

  it("声明的预算不小于宿主默认（否则等于收紧而非放宽）", () => {
    const m = (name: string) => {
      const r = new RegExp(`const ${name}\\s*=\\s*([\\d_]+)`).exec(src);
      expect(r, `未找到常量 ${name}`).toBeTruthy();
      return Number(r![1].replace(/_/g, ""));
    };
    expect(m("AGENT_END_TIMEOUT_MS")).toBeGreaterThanOrEqual(30_000);
    expect(m("GATEWAY_STOP_TIMEOUT_MS")).toBeGreaterThanOrEqual(5_000);
  });
});

describe("包清单版本对齐（build 目标 = 2026.10.4）", () => {
  it("build.openclawVersion / pluginSdkVersion 已对齐到 2026.10.4", () => {
    expect(pkg.openclaw.build.openclawVersion).toBe("2026.10.4");
    expect(pkg.openclaw.build.pluginSdkVersion).toBe("2026.10.4");
  });

  it("compat 保留开放下界（官方示例同样如此；加上界会在新版本上阻断安装）", () => {
    // 宿主在安装时按 satisfiesPluginApiRange 强校验；范围过窄会直接装不上
    expect(pkg.openclaw.compat.pluginApi).toMatch(/^>=/);
    expect(pkg.openclaw.compat.minGatewayVersion).toBeTruthy();
  });

  it("extensions 无 runtimeExtensions 时长度校验安全（宿主仅在两者都声明时校验长度相等）", () => {
    expect(Array.isArray(pkg.openclaw.extensions)).toBe(true);
  });
});
