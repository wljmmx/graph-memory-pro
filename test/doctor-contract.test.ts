/**
 * 测试 doctor-contract-api.js 与 openclaw.plugin.json 的一致性
 *
 * 为什么必须守护：
 *   宿主在加载插件迁移前会逐项校验 manifest 声明与产物导出（见 openclaw 的
 *   doctor-contract-registry：`validateDeclarations`），一旦 id / doctorOnly / phase
 *   不一致，会抛 PluginDoctorStateMigrationDeclarationError **并清空本次全部
 *   inspectedPluginIds 直接返回** —— 影响面不止本插件，而是该轮所有插件的迁移。
 *   因此这条一致性不能只靠人去比，必须由测试守住。
 *
 * 同时守护两项部署前提，任一缺失都会让 doctor contract 静默失效：
 *   - 产物必须位于插件根目录或 dist/（根目录优先）；本插件刻意放根目录，
 *     以免破坏 dist 单文件自包含不变式；
 *   - 必须列入 package.json 的 files，否则 npm 发布时被丢弃。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");

async function loadArtifact(): Promise<{ stateMigrations?: unknown }> {
  return (await import("../doctor-contract-api.js")) as { stateMigrations?: unknown };
}

/** 复刻宿主 isPluginDoctorStateMigration 的形状判定 */
function isMigrationShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    c.id.trim().length > 0 &&
    typeof c.label === "string" &&
    c.label.trim().length > 0 &&
    typeof c.detectLegacyState === "function" &&
    typeof c.migrateLegacyState === "function"
  );
}

describe("doctor contract", () => {
  it("产物导出的 stateMigrations 满足宿主形状要求", async () => {
    const { stateMigrations } = await loadArtifact();
    expect(Array.isArray(stateMigrations)).toBe(true);
    const list = stateMigrations as unknown[];
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(isMigrationShape(entry)).toBe(true);
    }
  });

  it("manifest 声明与产物导出逐项一致（否则宿主会拒绝本轮全部迁移）", async () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "openclaw.plugin.json"), "utf8"));
    const declared = manifest.doctorContract?.stateMigrations;
    const { stateMigrations } = await loadArtifact();
    const migrations = stateMigrations as Array<{
      id: string;
      doctorOnly?: boolean;
      phase?: string;
    }>;

    expect(Array.isArray(declared)).toBe(true);
    // 宿主的校验：长度一致 + 逐项 id / doctorOnly / phase 一致
    expect(declared.length).toBe(migrations.length);
    declared.forEach(
      (action: { id: string; doctorOnly?: boolean; phase?: string }, index: number) => {
        const migration = migrations[index];
        expect(action.id).toBe(migration.id);
        expect(action.doctorOnly === true).toBe(migration.doctorOnly === true);
        expect(action.phase).toBe(migration.phase);
      },
    );
  });

  it("detectLegacyState 返回 null（无遗留状态 → 宿主据此结清伪义务，且不生成迁移计划）", async () => {
    const { stateMigrations } = await loadArtifact();
    for (const entry of stateMigrations as Array<{ detectLegacyState: () => Promise<unknown> }>) {
      await expect(entry.detectLegacyState()).resolves.toBeNull();
    }
  });

  it("migrateLegacyState 不产生任何变更（fail-closed，不触碰数据）", async () => {
    const { stateMigrations } = await loadArtifact();
    for (const entry of stateMigrations as Array<{
      migrateLegacyState: () => Promise<{ changes: unknown[]; warnings: unknown[] }>;
    }>) {
      const result = await entry.migrateLegacyState();
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
  });

  it("产物零 import（可被宿主独立加载，不依赖任何模块）", () => {
    const source = readFileSync(resolve(root, "doctor-contract-api.js"), "utf8");
    // 去掉注释再检查，避免注释里出现 import 字样造成误判
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it("产物位于插件根目录，且已列入 package.json files（否则部署/发布后静默失效）", () => {
    expect(existsSync(resolve(root, "doctor-contract-api.js"))).toBe(true);
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.files).toContain("doctor-contract-api.js");
  });
});