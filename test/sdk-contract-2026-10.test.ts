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
 * | matcher **仅** before_tool_call / after_tool_call 生效，其余会告警 | `registry-registrars-tools-hooks.ts` |
 * | matcher 校验：非空数组、禁 `"*"`、禁非规范名、按小写归一 | `src/plugins/tool-hook-matcher.ts` |
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

/**
 * 复刻宿主的 matcher 校验器（src/plugins/tool-hook-matcher.ts）。
 * 未从 SDK 导入是因为宿主未公开导出该函数；此处按源码规则复现。
 */
const NON_CANONICAL_TOOL_MATCHER_NAMES = new Set([
  "bash", "exec_command", "apply-patch", "Write", "Edit", "agent",
]);

function validateToolMatcher(matcher: unknown): string {
  if (!Array.isArray(matcher)) throw new TypeError("must be an array");
  if (matcher.length === 0) throw new TypeError("must contain at least one tool name");
  const out = new Set<string>();
  for (const name of matcher) {
    if (typeof name !== "string" || !name.trim()) throw new TypeError("entries must be non-empty strings");
    const canonical = name.trim().toLowerCase();
    if (canonical === "*") throw new TypeError("wildcard entries are not supported");
    if (NON_CANONICAL_TOOL_MATCHER_NAMES.has(canonical) || NON_CANONICAL_TOOL_MATCHER_NAMES.has(name.trim())) {
      throw new TypeError("entries must use canonical OpenClaw tool ids");
    }
    out.add(canonical);
  }
  return [...out].toSorted().join(",");
}

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

describe("after_tool_call matcher（宿主在派发前过滤，避免每次工具调用都唤起插件）", () => {
  it("after_tool_call 传入了 matcher", () => {
    expect(src).toMatch(/api\.on\("after_tool_call"[\s\S]*?\}\s*,\s*\{\s*matcher:\s*MEMORY_TOOL_MATCHER\s*\}\s*\)/);
  });

  it("matcher 列表通过宿主校验规则（非空、无通配、无非法名、全小写）", () => {
    // 从源码提取 MEMORY_TOOL_NAMES 的字面量
    const block = /const MEMORY_TOOL_NAMES = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(block, "未找到 MEMORY_TOOL_NAMES").toBeTruthy();
    const names = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);

    // 不得使用宿主明确拒绝的名字（否则注册会被拒）
    expect(() => validateToolMatcher(names)).not.toThrow();

    // 全小写 —— matcher 按小写比对，大小写不符会静默丢事件
    for (const n of names) expect(n).toBe(n.toLowerCase());
  });

  it("matcher 与 handler 内部过滤是同一集合（等价前置过滤，不丢事件）", () => {
    expect(src).toMatch(/MEMORY_TOOL_MATCHER[^=]*=\s*\[\.\.\.MEMORY_TOOL_NAMES\]/);
    // handler 内仍保留同一集合的过滤（双保险）
    expect(src).toContain("MEMORY_TOOL_NAMES.has(toolName)");
  });

  it("matcher 只用在 tool hook 上（宿主对其它 hook 会告警 ignores tool matcher）", () => {
    // 全文件应只有**一处** `{ matcher:`，且必须紧邻 after_tool_call 的注册。
    // 不能用「跨 api.on 懒匹配」的正则：`[\s\S]*?` 会越过多个注册造成假阳性（初版即栽在这）。
    const occurrences = [...src.matchAll(/,\s*\{\s*matcher:/g)];
    expect(occurrences, "matcher 应恰好出现一次").toHaveLength(1);

    const at = occurrences[0].index!;
    const aStart = src.indexOf('api.on("after_tool_call"');
    expect(aStart, "未找到 after_tool_call 注册").toBeGreaterThan(-1);
    // 下一次注册的起点（= after_tool_call 注册块的结束边界）
    const aEnd = src.indexOf('api.on("', aStart + 10);
    expect(aEnd, "未找到 after_tool_call 之后的下一个注册").toBeGreaterThan(aStart);
    expect(at, "matcher 不在 after_tool_call 注册块内").toBeGreaterThan(aStart);
    expect(at, "matcher 落到了别的注册块").toBeLessThan(aEnd);
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
