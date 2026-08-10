/**
 * Benchmark 数据目录统一解析（download / preprocess / benchmark 三处共用）
 *
 * 数据目录优先级（保证三处结果一致，避免「预处理写 A 目录、评测读 B 目录」）：
 *   1. CLI 显式 --data-dir（或环境变量方式，见各命令行）
 *   2. ~/.openclaw/openclaw.json 中 graph-memory-pro 插件的 benchmark.dataDir
 *   3. 默认 benchmarks/data（相对当前工作目录）
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export const DEFAULT_BENCHMARK_DATA_DIR = "benchmarks/data";

/** 读取 ~/.openclaw/openclaw.json 中 graph-memory-pro 插件的 benchmark.dataDir */
export function readBenchmarkDataDirFromOpenclaw(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const configPath = join(home, ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      plugins?: { entries?: unknown };
    };
    const entries = raw?.plugins?.entries;

    let pluginConfig: Record<string, unknown> | null = null;
    if (Array.isArray(entries)) {
      const entry = (entries as Array<{ id?: string; name?: string; config?: unknown }>).find(
        (e) => e?.id === "graph-memory-pro" || e?.name === "graph-memory-pro",
      );
      const cfg = entry?.config ?? entry;
      if (cfg && typeof cfg === "object") pluginConfig = cfg as Record<string, unknown>;
    } else if (entries && typeof entries === "object") {
      const rec = entries as Record<string, { config?: unknown }>;
      const scoped = rec["graph-memory-pro"] ?? rec["graph_memory_pro"];
      if (scoped && typeof scoped === "object") {
        const cfg = (scoped as { config?: unknown }).config ?? scoped;
        if (cfg && typeof cfg === "object") pluginConfig = cfg as Record<string, unknown>;
      }
    }

    const benchmark = pluginConfig?.benchmark;
    const dataDir = benchmark && typeof benchmark === "object"
      ? (benchmark as { dataDir?: unknown }).dataDir
      : undefined;
    return typeof dataDir === "string" && dataDir.trim() ? dataDir.trim() : null;
  } catch {
    return null;
  }
}

/** 解析评测数据目录：cliDataDir > openclaw.json benchmark.dataDir > 默认 */
export function resolveBenchmarkDataDir(cliDataDir?: string): string {
  if (cliDataDir && cliDataDir.trim()) return cliDataDir.trim();
  const fromOpenclaw = readBenchmarkDataDirFromOpenclaw();
  if (fromOpenclaw) return fromOpenclaw;
  return DEFAULT_BENCHMARK_DATA_DIR;
}