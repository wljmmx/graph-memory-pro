/**
 * L-1 关联矩阵 M 持久化 单元测试（graph-memory-pro v2.3.6）
 *
 * 覆盖 /workspace/src/recaller/association-matrix-persist.ts：
 *   - getAssociationMatrixPath / getDefaultBaseDir（路径解析）
 *   - saveAssociationMatrix（落盘 + 返回结果）
 *   - loadAssociationMatrix / tryLoadAssociationMatrix（恢复 + 首次无文件返回 false）
 *   - createAssociationMatrixPersisted（构造 + 加载一体化）
 *   - saveRecallerAssociationMatrix（从 Recaller 提取 M 保存）
 *
 * 使用临时目录覆盖 baseDir，避免污染真实 ~/.openclaw 目录。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { AssociationMatrix } from "../src/recaller/association-matrix.ts";
import {
  getAssociationMatrixPath,
  getLegacyAssociationMatrixPath,
  saveAssociationMatrix,
  loadAssociationMatrix,
  tryLoadAssociationMatrix,
  createAssociationMatrixPersisted,
  saveRecallerAssociationMatrix,
} from "../src/recaller/association-matrix-persist.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gm-am-persist-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 构造一个已启用、维度为 4 的关联矩阵 */
function makeEnabledMatrix(dim = 4): AssociationMatrix {
  return new AssociationMatrix(dim, { enabled: true, warmupFeedbacks: 2 });
}

describe("getAssociationMatrixPath / getDefaultBaseDir", () => {
  it("v2.8.x: 默认路径位于 ~/.openclaw/data/association-matrix/association-matrix.json（已从插件目录迁移）", () => {
    const p = getAssociationMatrixPath();
    expect(p.endsWith("association-matrix.json")).toBe(true);
    expect(p).toContain(".openclaw");
    expect(p).toContain("association-matrix");
    // 旧目录 ~/.openclaw/graph-memory-pro/ 仅作为迁移源，不再是默认路径
    expect(getLegacyAssociationMatrixPath()).toContain("graph-memory-pro");
    expect(p).not.toContain("graph-memory-pro");
  });

  it("支持 baseDir 与 path 覆盖", () => {
    expect(getAssociationMatrixPath({ baseDir: tmp })).toBe(join(tmp, "association-matrix.json"));
    expect(getAssociationMatrixPath({ path: "/custom/m.json" })).toBe("/custom/m.json");
    // path 优先于 baseDir
    expect(getAssociationMatrixPath({ baseDir: tmp, path: "/x/y.json" })).toBe("/x/y.json");
  });
});

describe("saveAssociationMatrix", () => {
  it("未启用时返回 null 且不写文件", async () => {
    const am = new AssociationMatrix(4); // enabled=false
    const r = await saveAssociationMatrix(am, { baseDir: tmp });
    expect(r).toBeNull();
  });

  it("启用时落盘并返回路径/字节数/统计", async () => {
    const am = makeEnabledMatrix();
    const r = await saveAssociationMatrix(am, { baseDir: tmp });
    expect(r).not.toBeNull();
    expect(r!.path).toBe(join(tmp, "association-matrix.json"));
    expect(r!.bytes).toBeGreaterThan(0);
    expect(r!.dim).toBe(4);
    expect(r!.updateCount).toBe(0);
  });

  it("写入的文件可被重新读取（JSON 有效）", async () => {
    const am = makeEnabledMatrix();
    await saveAssociationMatrix(am, { baseDir: tmp });
    const { readFile } = await import("node:fs/promises");
    const json = await readFile(join(tmp, "association-matrix.json"), "utf-8");
    const data = JSON.parse(json);
    expect(data.dim).toBe(4);
    expect(Array.isArray(data.M)).toBe(true);
  });
});

describe("loadAssociationMatrix / tryLoadAssociationMatrix", () => {
  it("首次运行时无文件返回 false", async () => {
    const am = makeEnabledMatrix();
    expect(await loadAssociationMatrix(am, { baseDir: tmp })).toBe(false);
    const t = await tryLoadAssociationMatrix(am, { baseDir: tmp });
    expect(t.loaded).toBe(false);
    expect(t.path).toBe(join(tmp, "association-matrix.json"));
  });

  it("保存后能恢复 M 状态（round-trip）", async () => {
    const src = makeEnabledMatrix();
    // 触发一次更新使 updateCount>0
    const v = new Float32Array([1, 0, 0.5, -0.5]);
    const r = src.updateWithMarginalUtility(v, 1);
    expect(r.applied).toBe(true);
    await saveAssociationMatrix(src, { baseDir: tmp });

    const dst = makeEnabledMatrix();
    expect(await loadAssociationMatrix(dst, { baseDir: tmp })).toBe(true);
    expect(dst.getStats().updatesApplied).toBe(src.getStats().updatesApplied);
  });

  it("未启用时即使有文件也返回 false", async () => {
    const src = makeEnabledMatrix();
    await saveAssociationMatrix(src, { baseDir: tmp });
    // 手动写入一个文件，但目标矩阵未启用
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, "association-matrix.json"), "{}", "utf-8");
    const disabled = new AssociationMatrix(4); // enabled=false
    expect(await loadAssociationMatrix(disabled, { baseDir: tmp })).toBe(false);
  });
});

describe("loadAssociationMatrix 旧路径自动迁移（v2.6.x）", () => {
  it("默认路径无文件、旧路径有文件时，迁移并恢复 updateCount", async () => {
    const { getLegacyAssociationMatrixPath } = await import("../src/recaller/association-matrix-persist.ts");
    // 临时把 HOME 指向 tmp，使旧路径(getLegacyAssociationMatrixPath)落在 tmp 下、
    // 而新默认路径(基于 fakeHome 的 ~/.openclaw/data/association-matrix)无文件 → 模拟"旧文件存在、新路径无文件"。
    const origHome = process.env.HOME;
    const fakeHome = join(tmp, "fakehome");
    process.env.HOME = fakeHome;
    try {
      // 在旧路径写一个有学习成果的矩阵
      const src = makeEnabledMatrix();
      src.updateWithMarginalUtility(new Float32Array([1, 0, 0.5, -0.5]), 1);
      const legacyPath = getLegacyAssociationMatrixPath();
      const { dirname } = await import("node:path");
      await mkdir(dirname(legacyPath), { recursive: true });
      await writeFile(legacyPath, src.serialize(), "utf-8");

      // 新默认路径(此时仍是当前 HOME，即 fakeHome 下的 data 目录,无文件)
      const am = makeEnabledMatrix();
      const loaded = await loadAssociationMatrix(am); // 不传 opts → 走默认 + 迁移
      expect(loaded).toBe(true);
      expect(am.getStats().updatesApplied).toBe(1); // 学习成果已恢复

      // 迁移后新路径应存在文件
      const { getAssociationMatrixPath } = await import("../src/recaller/association-matrix-persist.ts");
      const { access } = await import("node:fs/promises");
      await expect(access(getAssociationMatrixPath())).resolves.toBeUndefined();
    } finally {
      process.env.HOME = origHome;
    }
  });
});

describe("createAssociationMatrixPersisted", () => {
  const cfg = {
    associationMatrix: { enabled: true, warmupFeedbacks: 2 },
  } as Parameters<typeof createAssociationMatrixPersisted>[1];

  it("配置未启用时返回 null", async () => {
    const r = await createAssociationMatrixPersisted(4, {} as Parameters<typeof createAssociationMatrixPersisted>[1], { baseDir: tmp });
    expect(r).toBeNull();
  });

  it("启用且无文件时返回新建矩阵（未恢复）", async () => {
    const am = await createAssociationMatrixPersisted(4, cfg, { baseDir: tmp });
    expect(am).not.toBeNull();
    expect(am!.isEnabled()).toBe(true);
    expect((am as any).__persistLoaded).toBe(false);
  });

  it("启用且有文件时返回已恢复矩阵", async () => {
    const src = makeEnabledMatrix();
    await saveAssociationMatrix(src, { baseDir: tmp });
    const am = await createAssociationMatrixPersisted(4, cfg, { baseDir: tmp });
    expect(am).not.toBeNull();
    expect((am as any).__persistLoaded).toBe(true);
  });
});

describe("saveRecallerAssociationMatrix", () => {
  it("传入 Recaller（含 getAssociationMatrix）时保存其 M", async () => {
    const am = makeEnabledMatrix();
    const recaller = { getAssociationMatrix: () => am };
    const r = await saveRecallerAssociationMatrix(recaller, { baseDir: tmp });
    expect(r).not.toBeNull();
    expect(r!.path).toBe(join(tmp, "association-matrix.json"));
  });

  it("传入 null / undefined 时返回 null", async () => {
    expect(await saveRecallerAssociationMatrix(null, { baseDir: tmp })).toBeNull();
    expect(await saveRecallerAssociationMatrix(undefined, { baseDir: tmp })).toBeNull();
  });

  it("Recaller 的 getAssociationMatrix 返回 null 时返回 null", async () => {
    const r = await saveRecallerAssociationMatrix({ getAssociationMatrix: () => null }, { baseDir: tmp });
    expect(r).toBeNull();
  });
});