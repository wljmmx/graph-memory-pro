/**
 * engines 自洽性守卫（Node 26 构建报错的根因）
 *
 * ## 现场症状
 *
 * Node 26 上 `npm run build` 报：
 * ```
 * index.ts(21,88): error TS2307: Cannot find module 'openclaw/plugin-sdk/plugin-entry'
 * index.ts(2307,32): error TS7006: Parameter 'event' implicitly has an 'any' type.
 * Error: error occurred in dts build
 * ```
 * 看起来像 TS/tsup 问题，实际是**依赖没装上**：tsup 的 DTS 构建需要 `openclaw` 的类型，
 * 而 openclaw 缺失时该模块无法解析，并连带把三个 hook handler 的参数退化成隐式 any。
 *
 * ## 真正根因：`engines.node` 与宿主冲突
 *
 * `openclaw` 自身声明 `engines.node = ">=24.22.1 <25 || >=26.12.1"`（10.9；9.6 / 10.4 曾为
 * `>=24.16.0 <25 || >=26.1.0`）。本项目的范围必须始终跟随宿主的当前声明。
 *
 * 而本项目此前声明的是 `>=22.22.3 <23 || >=24.15 <25 || >=25.9 <26 || >=26` ——
 * **三个下界全部不被宿主支持**，且 `>=26` 误把 26.0.0 也算作受支持：
 *
 * | Node | 宿主 openclaw 是否支持 | 旧 engines.node 是否允许 | 后果 |
 * |---|---|---|---|
 * | 22.22.3 | ❌ | ✅ 允许 | 声明了不存在的支持 |
 * | 24.15.0 | ❌（需 24.16） | ✅ 允许 | 同上 |
 * | 25.9.0  | ❌ | ✅ 允许 | 同上 |
 * | **26.0.0** | ❌（需 26.1） | ✅ 允许 | **装不上 → 构建报 TS2307** |
 * | 26.1.0+ | ✅ | ✅ | 正常 |
 *
 * 本测试把两条不变量固化：
 *   ① 我们支持的 Node 版本必须 ⊆ 宿主支持的 Node 版本；
 *   ② `engines.npm` 必须能被「每个受支持 Node 自带的最小 npm」满足。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as {
  engines?: { node?: string; npm?: string };
};
const pluginManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "openclaw.plugin.json"), "utf-8"),
) as { engines?: { node?: string } };

/** 宿主（openclaw）自身的 engines.node —— 2026.10.9 实测 */
const HOST_ENGINES_NODE = ">=24.22.1 <25 || >=26.12.1";

/** 受支持 Node 版本及其自带 npm（来源 nodejs.org/dist/index.json 的 npm 字段） */
const SUPPORTED_NODES: Array<{ node: string; bundledNpm: string }> = [
  { node: "24.22.1", bundledNpm: "11.19.1" },
  { node: "26.12.1", bundledNpm: "11.20.0" },
];

/** 明确不被宿主支持的版本（本项目也不得声明支持；含 10.4 时代的下界） */
const UNSUPPORTED_NODES = ["22.22.3", "24.15.0", "24.16.0", "24.22.0", "25.9.0", "26.0.0", "26.1.0", "26.12.0"];

const ver = (v: string) => v.split(".").map(Number);

/** 支持 `A || B`，每段为 `>=x <y` 这类空格分隔的比较式；版本可只写大版本（如 `<25`） */
function satisfies(version: string, range: string): boolean {
  const v = ver(version);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  return range.split("||").some((clause) =>
    clause
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((part) => {
        // 允许 `>=24.16.0` / `<25` / `26` —— 缺省的部分按 0 补齐
        const m = /^(>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part);
        if (!m) throw new Error(`测试不支持的范围片段: "${part}"`);
        const op = m[1] ?? "=";
        const c = cmp(v, [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)]);
        switch (op) {
          case ">=": return c >= 0;
          case "<=": return c <= 0;
          case ">": return c > 0;
          case "<": return c < 0;
          default: return c === 0;
        }
      }),
  );
}

describe("engines.node 必须 ⊆ 宿主 openclaw 的支持范围", () => {
  it("本项目的范围与宿主声明一致（宿主升级时这里会失败，提醒同步）", () => {
    expect(pkg.engines?.node).toBe(HOST_ENGINES_NODE);
  });

  it("宿主支持的版本，本项目都支持", () => {
    for (const { node } of SUPPORTED_NODES) {
      expect(satisfies(node, pkg.engines!.node!), `本项目不支持宿主支持的 Node ${node}`).toBe(true);
      expect(satisfies(node, HOST_ENGINES_NODE), `宿主不支持 Node ${node}（测试数据需更新）`).toBe(true);
    }
  });

  it("宿主不支持的版本，本项目不得声明支持（否则装不上 → 构建报 TS2307）", () => {
    for (const node of UNSUPPORTED_NODES) {
      expect(satisfies(node, HOST_ENGINES_NODE), `宿主竟支持 ${node}？测试数据需更新`).toBe(false);
      expect(
        satisfies(node, pkg.engines!.node!),
        `本项目声明支持 Node ${node}，但宿主 openclaw 不支持它 —— 用户会在该版本上安装失败，` +
          `随后 npm run build 只会报 'Cannot find module openclaw/plugin-sdk/plugin-entry'（掩盖真因）`,
      ).toBe(false);
    }
  });

  it("两个版本线的下界都被明确排除（26.0.0 是现场报错版本；26.12.0 差一个补丁版）", () => {
    expect(satisfies("26.0.0", pkg.engines!.node!)).toBe(false);
    expect(satisfies("26.12.0", pkg.engines!.node!)).toBe(false);
    expect(satisfies("26.12.1", pkg.engines!.node!)).toBe(true);
    expect(satisfies("24.22.0", pkg.engines!.node!)).toBe(false);
    expect(satisfies("24.22.1", pkg.engines!.node!)).toBe(true);
  });

  it("openclaw.plugin.json 若声明 engines 则必须与 package.json 一致", () => {
    if (pluginManifest.engines?.node) {
      expect(pluginManifest.engines.node).toBe(pkg.engines!.node);
    }
  });
});

describe("engines.npm 必须能被受支持 Node 自带的 npm 满足", () => {
  it("是简单的 >= 下界（便于核对）", () => {
    expect(pkg.engines?.npm, "缺少 engines.npm").toBeTruthy();
    expect(/^>=\s*\d+\.\d+\.\d+$/.test(pkg.engines!.npm!.trim())).toBe(true);
  });

  it("每个受支持 Node 自带的 npm 都满足（旧值 >=11.16 曾让所有下界失效）", () => {
    const failures = SUPPORTED_NODES.filter(({ bundledNpm }) => !satisfies(bundledNpm, pkg.engines!.npm!)).map(
      ({ node, bundledNpm }) => `Node ${node} 自带 npm ${bundledNpm} < 要求 ${pkg.engines!.npm}`,
    );
    expect(failures, `engines.npm 与 engines.node 自相矛盾:\n  ${failures.join("\n  ")}`).toEqual([]);
  });
});
