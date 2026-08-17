/**
 * L-1 关联矩阵 M 的持久化（v2.3.6）
 *
 * 背景：AssociationMatrix 的 serialize()/deserialize() 已实现但生产代码从不调用，
 * M 仅存内存，进程重启即丢失。本模块补齐持久化接线，并暴露给：
 *   - 内部：gm_maintain / 启动流程 / crud.ts 状态接口
 *   - 外部：lcm-graph-extra 等插件可通过 `import { saveAssociationMatrix, loadAssociationMatrix } from "graph-memory-pro"`
 *
 * 设计要点：
 *   - M 为 N×N Float32Array（N=1024 时 serialize 约 4MB JSON），保存较重，
 *     因此仅在 gm_maintain 维护周期、优雅关闭、以及外部显式调用时触发保存。
 *   - 提供默认状态文件路径（与 auto-tuner 对齐），同时允许调用方用 options.path 覆盖，
 *     便于 lcm-graph-extra 将 M 持久化到自己的目录。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssociationMatrix } from "./association-matrix.ts";
import type { GmConfig } from "../types.ts";

/** 持久化选项 */
export interface AssociationMatrixPersistOptions {
  /** 覆盖默认状态文件路径 */
  path?: string;
  /** 覆盖默认缓存根目录（默认插件目录下的 association-matrix 子目录） */
  baseDir?: string;
}

export interface AssociationMatrixSaveResult {
  path: string;
  bytes: number;
  dim: number;
  updateCount: number;
  rejectedCount: number;
}

/** 插件默认安装目录（OpenClaw extensions 目录，可在 env 覆盖） */
export function getDefaultPluginDir(): string {
  return (
    process.env.GRAPH_MEMORY_PRO_PLUGIN_DIR ??
    join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".openclaw", "extensions", "graph-memory-pro",
    )
  );
}

/**
 * M 默认缓存根目录：插件目录下的独立子目录。
 * 一般插件位于 ~/.openclaw/extensions/graph-memory-pro，M 保存到
 * ~/.openclaw/extensions/graph-memory-pro/association-matrix/ 下。
 */
export function getDefaultBaseDir(): string {
  return join(getDefaultPluginDir(), "association-matrix");
}

/** 解析 M 状态文件路径 */
export function getAssociationMatrixPath(opts: AssociationMatrixPersistOptions = {}): string {
  if (opts.path) return opts.path;
  return join(opts.baseDir ?? getDefaultBaseDir(), "association-matrix.json");
}

/**
 * 旧版默认路径（v2.6.x 之前）：~/.openclaw/graph-memory-pro/association-matrix.json。
 * M 默认目录改到插件目录下后，用于把历史学习成果自动迁移到新位置，避免
 * 升级后加载到全新单位矩阵导致 updateCount/historySize 归零、学习痕迹丢失。
 */
export function getLegacyAssociationMatrixPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return join(home, ".openclaw", "graph-memory-pro", "association-matrix.json");
}

/**
 * 保存关联矩阵 M 到磁盘（JSON，含 M/bias/gain/rowScale + Adam/BatchNorm 状态）
 *
 * @param am 关联矩阵实例
 * @param opts 路径覆盖等
 * @returns 保存结果（路径、字节数、统计），未启用或维度为 0 时返回 null
 */
export async function saveAssociationMatrix(
  am: AssociationMatrix,
  opts: AssociationMatrixPersistOptions = {},
): Promise<AssociationMatrixSaveResult | null> {
  if (!am || !am.isEnabled()) return null;

  const path = getAssociationMatrixPath(opts);
  const json = am.serialize();
  const bytes = Buffer.byteLength(json, "utf-8");

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json, "utf-8");

  const stats = am.getStats();
  return {
    path,
    bytes,
    dim: stats.dim ?? 0,
    updateCount: (stats as unknown as { updatesApplied?: number }).updatesApplied ?? 0,
    rejectedCount: (stats as unknown as { updatesRejected?: number }).updatesRejected ?? 0,
  };
}

/**
 * 从磁盘加载关联矩阵 M 到已创建的实例（覆盖其内部参数）
 *
 * @param am 已创建的实例（维度必须与文件一致，否则抛 dim mismatch）
 * @param opts 路径覆盖等
 * @returns 是否成功加载（文件不存在 / 未启用时返回 false）
 */
export async function loadAssociationMatrix(
  am: AssociationMatrix,
  opts: AssociationMatrixPersistOptions = {},
): Promise<boolean> {
  if (!am || !am.isEnabled()) return false;

  const path = getAssociationMatrixPath(opts);
  let json: string;
  try {
    json = await readFile(path, "utf-8");
  } catch {
    // v2.6.x: 新路径无文件时,尝试从旧版默认路径(~/.openclaw/graph-memory-pro)迁移，
    // 保留升级前的学习成果(矩阵权重 + updateCount)。仅当调用方未显式指定 path/baseDir
    // 时迁移,显式指向的文件仍按原路径处理。
    if (opts.path || opts.baseDir) return false;
    try {
      json = await readFile(getLegacyAssociationMatrixPath(), "utf-8");
    } catch {
      return false; // 全新安装，无任何状态文件
    }
    await migrateMatrixFile(getLegacyAssociationMatrixPath(), path);
  }
  if (!json || !json.trim()) return false;

  am.deserialize(json);
  return true;
}

/** 把旧路径文件复制到新路径（自动迁移，升级后保留历史 M） */
async function migrateMatrixFile(from: string, to: string): Promise<void> {
  const { copyFile } = await import("node:fs/promises");
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

/**
 * 便捷：从磁盘加载并返回是否命中（供启动流程使用）
 *
 * 与 loadAssociationMatrix 等价，但额外返回文件路径便于日志/健康检查。
 */
export async function tryLoadAssociationMatrix(
  am: AssociationMatrix,
  opts: AssociationMatrixPersistOptions = {},
): Promise<{ loaded: boolean; path: string }> {
  const loaded = await loadAssociationMatrix(am, opts);
  return { loaded, path: getAssociationMatrixPath(opts) };
}

/**
 * 构造并加载：从配置创建 AssociationMatrix，若已启用且有持久化文件则恢复。
 *
 * 供内部启动流程与外部插件统一使用，避免重复的 create+load 样板代码。
 */
export async function createAssociationMatrixPersisted(
  dim: number,
  cfg?: GmConfig,
  opts: AssociationMatrixPersistOptions = {},
): Promise<AssociationMatrix | null> {
  if (!cfg?.associationMatrix?.enabled) return null;
  const { createAssociationMatrix } = await import("./association-matrix.ts");
  const am = createAssociationMatrix(dim, cfg);
  const { path, loaded } = await tryLoadAssociationMatrix(am, opts);
  return Object.assign(am, { __persistPath: path, __persistLoaded: loaded });
}

/**
 * 便捷：从 Recaller 提取 M 并保存（供 gm_maintain / 优雅关闭复用）。
 *
 * 兼容 Recaller 的 getAssociationMatrix() 访问器；若传入的并非 Recaller 而是 M 实例，
 * 则直接透传保存。
 */
export async function saveRecallerAssociationMatrix(
  recaller: { getAssociationMatrix: () => AssociationMatrix | null } | AssociationMatrix | null | undefined,
  opts: AssociationMatrixPersistOptions = {},
): Promise<AssociationMatrixSaveResult | null> {
  if (!recaller) return null;
  const am = "getAssociationMatrix" in recaller ? recaller.getAssociationMatrix() : recaller;
  if (!am) return null;
  return saveAssociationMatrix(am, opts);
}