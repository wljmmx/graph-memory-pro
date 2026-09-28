/**
 * v2.8.x — openclaw.json 插件配置持久化（供 gm_embed_bench 自动落盘）
 *
 * 背景：gm_embed_bench 可把实测结论热应用到运行时（内存），但重启即失效。
 * 本模块提供「自动写回配置文件」能力，免去手工编辑 openclaw.json。
 *
 * 设计原则（写用户的全局配置，必须保守）：
 *   1. 只在**能确认目标就位**时才写：文件必须是严格 JSON（能被 JSON.parse），
 *      且必须能定位到 plugins.entries["graph-memory-pro"].config.embedding。
 *      定位不到 → 拒绝写入并说明原因，绝不新建结构（很可能写错文件）。
 *   2. 写前备份原始文件（<path>.bak-<时间戳>），失败可回滚。
 *   3. 原子替换：先写同目录临时文件再 rename，避免中途崩溃留下半截 JSON。
 *   4. 保留原文件的缩进风格与结尾换行；只改目标叶子字段，其余原样保留。
 *      （JSON.parse 能成功即说明无注释，因此 round-trip 不丢信息。）
 *   5. 不触碰除 embedding.maxBatchChars / embedding.batchSize 之外的任何字段。
 */

import { readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

/** 落盘结果 */
export interface PersistConfigResult {
  ok: boolean;
  /** 目标配置文件绝对路径 */
  path: string;
  /** 备份文件路径（仅在真正写入时产生） */
  backupPath?: string;
  /** 是否确实发生了字段变更（false = 值已相同，无需写） */
  changed?: boolean;
  /** 失败原因（ok=false 时给出，面向用户可读） */
  error?: string;
  /** 实际写入后的 embedding 片段快照 */
  embedding?: Record<string, unknown>;
}

/** 解析 openclaw.json 路径：~/.openclaw/openclaw.json（与 index.ts readFullConfigFromFile 一致） */
export function resolveOpenclawConfigPath(home?: string): string {
  const base = home || process.env.HOME || process.env.USERPROFILE || homedir();
  return join(base, ".openclaw", "openclaw.json");
}

/**
 * 定位插件配置对象在文件中的位置。
 * 兼容两种形态：entries 为对象（键为插件 id）或为数组（元素含 id/name）。
 * 返回用于**回写**的 setter，避免调用方各自处理两种形态。
 */
function locatePluginConfig(
  root: unknown,
): { get: () => Record<string, unknown> | null; describe: string } {
  const entries = (root as { plugins?: { entries?: unknown } })?.plugins?.entries;
  if (Array.isArray(entries)) {
    const idx = entries.findIndex(
      (e) => e && typeof e === "object"
        && ((e as { id?: string }).id === "graph-memory-pro" || (e as { name?: string }).name === "graph-memory-pro"),
    );
    if (idx < 0) return { get: () => null, describe: "plugins.entries[] 中未找到 graph-memory-pro" };
    return {
      get: () => {
        const entry = entries[idx] as { config?: Record<string, unknown> };
        return (entry?.config ?? entry) as Record<string, unknown>;
      },
      describe: "plugins.entries[graph-memory-pro].config（数组形态）",
    };
  }
  if (entries && typeof entries === "object") {
    const entry = (entries as Record<string, { config?: unknown }>)["graph-memory-pro"];
    if (!entry) return { get: () => null, describe: 'plugins.entries["graph-memory-pro"] 不存在' };
    return {
      get: () => ((entry.config ?? entry) as Record<string, unknown>),
      describe: 'plugins.entries["graph-memory-pro"].config（对象形态）',
    };
  }
  return { get: () => null, describe: "openclaw.json 中不存在 plugins.entries" };
}

/** 探测原文件缩进（首个缩进行的前导空白），默认两空格 */
function detectIndent(raw: string): string {
  const m = raw.match(/\n([ \t]+)\S/);
  return m ? m[1] : "  ";
}

/** 时间戳（YYYYMMDD-HHmmss），用于备份文件名 */
function stamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把 embedding 参数写入 openclaw.json（自动落盘）。
 *
 * @param params 要写入的字段（至少一项）；值必须先经调用方校验
 * @param configPath 可选：覆盖配置文件路径（默认 ~/.openclaw/openclaw.json）
 * @param now 可选：注入时间源（便于测试备份文件名）
 */
export async function persistEmbeddingParams(
  params: { maxBatchChars?: number; batchSize?: number },
  configPath?: string,
  now?: Date,
): Promise<PersistConfigResult> {
  const path = configPath ?? resolveOpenclawConfigPath();

  // 1) 读原文（保留缩进/换行风格需要原文，不能只留解析结果）
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    return { ok: false, path, error: `读取失败：${(err as Error).message}` };
  }

  // 2) 必须是严格 JSON —— 若含注释/尾逗号则解析失败，此时**拒绝改写**
  //    （改写会把注释与特殊格式抹掉，属于破坏性操作）
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      path,
      error: `文件不是严格 JSON（可能含注释/尾逗号），拒绝改写以免破坏格式：${(err as Error).message}`,
    };
  }

  // 3) 定位目标：定位不到就拒绝，不新建结构（避免写到一份并非生效来源的文件）
  const loc = locatePluginConfig(root);
  const pluginCfg = loc.get();
  if (!pluginCfg) {
    return { ok: false, path, error: `未定位到插件配置（${loc.describe}），拒绝写入。` };
  }
  const embedding = pluginCfg.embedding as Record<string, unknown> | undefined;
  if (!embedding || typeof embedding !== "object") {
    return { ok: false, path, error: `插件配置中不存在 embedding 段（${loc.describe}），拒绝写入。` };
  }

  // 4) 计算变更（值相同则直接返回，不产生备份/写入）
  const before: Record<string, unknown> = {};
  const next: Array<[string, number]> = [];
  if (params.maxBatchChars !== undefined) next.push(["maxBatchChars", params.maxBatchChars]);
  if (params.batchSize !== undefined) next.push(["batchSize", params.batchSize]);
  if (next.length === 0) {
    return { ok: false, path, error: "未指定要写入的字段（maxBatchChars / batchSize 均为空）。" };
  }
  let changed = false;
  for (const [k, v] of next) {
    before[k] = embedding[k];
    if (embedding[k] !== v) changed = true;
    embedding[k] = v;
  }
  if (!changed) {
    return { ok: true, path, changed: false, embedding: { ...embedding } };
  }

  // 5) 备份 + 原子替换（临时文件与目标同目录，保证 rename 不跨设备）
  const backupPath = `${path}.bak-${stamp(now)}`;
  const tmpPath = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  try {
    await copyFile(path, backupPath);
    const indent = detectIndent(raw);
    const out = JSON.stringify(root, null, indent) + (raw.endsWith("\n") ? "\n" : "");
    await writeFile(tmpPath, out, "utf-8");
    await rename(tmpPath, path);
  } catch (err) {
    return { ok: false, path, backupPath, error: `写入失败：${(err as Error).message}` };
  }

  return { ok: true, path, backupPath, changed: true, embedding: { ...embedding } };
}