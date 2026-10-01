/**
 * v2.8.x — 配置 schema 一致性守卫
 *
 * 缺陷背景（现场）：宿主报
 *   plugins.entries.graph-memory-pro.config.graphHealth.scoring: must not have additional
 *     properties: "sparseScoreThreshold", "sparseIsolatedRatioThreshold"
 *   plugins.entries.graph-memory-pro.config.sparseHeal.<k>: schema is false   （5 个键）
 *
 * 核实结论（两部分，两者都成立）：
 *   ① 用户配置里那 7 个键**在插件中根本不存在** —— 不在 types.ts、不在
 *      openclaw.plugin.json、不在任何文档。宿主的拒绝是**正确**的。
 *   ② 同时发现一个独立缺陷：`index.ts` 的 TypeBox 与 `openclaw.plugin.json` 的
 *      configSchema **不同步**，TypeBox 缺了 recall / sparseHeal / timestampBackfill
 *      三整段，以及 graphHealth.scoring。宿主若改用 TypeBox 派生校验，这些整段配置
 *      会被整段判为「不存在」而拒绝（sparseHeal 已实际发生）。
 *
 * 本测试把「两套 schema 必须一致」固化为守卫，防止再次漂移。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 从 index.ts 的 configSchema TypeBox 中提取顶层键与一层子键。
 *
 * 用**缩进**解析而非括号计数：`Type.Optional(Type.Object({` 有 3 层括号，
 * 按 depth 判断层级极易错位（初版即因此把子键当成顶层）。
 * 该文件缩进风格稳定：顶层键 4 空格、子键 6 空格。
 */
function extractTypeBoxKeys(src: string): { top: Set<string>; sub: Map<string, Set<string>> } {
  const lines = src.slice(src.indexOf("configSchema")).split("\n");
  const top = new Set<string>();
  const sub = new Map<string, Set<string>>();
  let currentTop: string | null = null;

  for (const line of lines) {
    const topMatch = /^ {4}(\w+): Type\./.exec(line);
    if (topMatch) {
      currentTop = topMatch[1];
      top.add(currentTop);
      if (/Type\.Optional\(\s*Type\.Object\(/.test(line)) sub.set(currentTop, new Set());
      continue;
    }
    const subMatch = /^ {6}(\w+): Type\./.exec(line);
    if (subMatch && currentTop && sub.has(currentTop)) {
      sub.get(currentTop)!.add(subMatch[1]);
      continue;
    }
    // 顶层键结束（回到 4 空格的非键行）→ 清空上下文，避免把下一段的 6 空格行误算
    if (/^ {4}\S/.test(line) && !topMatch && !/^ {4}\}/.test(line)) currentTop = null;
  }
  return { top, sub };
}

const repoRoot = resolve(__dirname, "..");
const jsonSchema = JSON.parse(
  readFileSync(resolve(repoRoot, "openclaw.plugin.json"), "utf-8"),
) as { configSchema: { properties: Record<string, { properties?: Record<string, unknown> }> } };
const tsSrc = readFileSync(resolve(repoRoot, "index.ts"), "utf-8");

describe("配置 schema 一致性：index.ts TypeBox vs openclaw.plugin.json（v2.8.x）", () => {
  const jsonTop = Object.keys(jsonSchema.configSchema.properties);
  const { top: tsTop, sub } = extractTypeBoxKeys(tsSrc);

  it("顶层配置段必须完全一致（此前 TypeBox 缺 recall/sparseHeal/timestampBackfill）", () => {
    const missing = jsonTop.filter((k) => !tsTop.has(k));
    const extra = [...tsTop].filter((k) => !jsonTop.includes(k));
    expect(missing, `TypeBox 缺失这些配置段（会被宿主拒绝）: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `TypeBox 多出这些配置段（json 未声明）: ${extra.join(", ")}`).toEqual([]);
  });

  it("sparseHeal 子键一致，且此前被拒的 5 个键已成为契约的一部分", () => {
    const jsonSub = Object.keys(jsonSchema.configSchema.properties.sparseHeal.properties ?? {});
    const tsSub = [...(sub.get("sparseHeal") ?? [])];
    expect(tsSub.sort()).toEqual(jsonSub.slice().sort());

    // 现场曾被宿主拒绝（schema is false）的 5 个键 —— 现已**显式登记**并接到实现
    // （只加 schema 不接代码 = 配置说谎，故这 5 项在 self-heal.ts 中都有真实分支）
    for (const k of ["autoEdgeRepair", "nodeMerge", "communityReconnect", "maxOperationsPerRun", "rollbackOnError"]) {
      expect(jsonSub, `openclaw.plugin.json 缺少 ${k}`).toContain(k);
      expect(tsSub, `index.ts TypeBox 缺少 ${k}`).toContain(k);
    }
  });

  it("graphHealth.scoring 子键一致，且含两个稀疏阈值别名", () => {
    const jsonSub = Object.keys(
      (jsonSchema.configSchema.properties.graphHealth.properties?.scoring as { properties?: Record<string, unknown> })
        ?.properties ?? {},
    );
    const tsSub = [...(sub.get("graphHealth") ?? [])];
    // graphHealth 下有 enabled / alertOnAnomaly / scoring
    expect(tsSub).toContain("scoring");
    // 现场曾被拒的两个键 —— 现作为 sparseHeal 同名阈值的别名（本项优先）
    expect(jsonSub.sort()).toEqual([
      "enabled",
      "historyKeep",
      "sparseIsolatedRatioThreshold",
      "sparseScoreThreshold",
    ]);
  });

  it("两处阈值别名与 sparseHeal 原字段语义一致（不是只加 schema 不接代码）", () => {
    // 约束：别名与本体必须都在，且实现里确实读了 graphHealth.scoring.*（有测试覆盖优先级）
    const sh = Object.keys(jsonSchema.configSchema.properties.sparseHeal.properties ?? {});
    const sc = Object.keys(
      (jsonSchema.configSchema.properties.graphHealth.properties?.scoring as { properties?: Record<string, unknown> })
        ?.properties ?? {},
    );
    expect(sh).toContain("scoreThreshold");
    expect(sh).toContain("isolatedRatioThreshold");
    expect(sc).toContain("sparseScoreThreshold");
    expect(sc).toContain("sparseIsolatedRatioThreshold");
  });
});