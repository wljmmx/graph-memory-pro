/**
 * S-10 Benchmark CLI 入口（v2.2.0 新增）
 *
 * 用法：
 *   npm run benchmark
 *   npm run benchmark -- --config=./config.json
 *   npm run benchmark -- --datasets=locomo,longmemeval --max-cases=50 --no-build-graph
 *   tsx src/benchmark/cli.ts --data-dir=./benchmarks/data
 *
 * 环境变量（优先级低于 --config）：
 *   GM_NEO4J_URI / GM_NEO4J_USER / GM_NEO4J_PASSWORD
 *   GM_LLM_API_KEY / GM_LLM_BASE_URL / GM_LLM_MODEL
 *   GM_EMBED_API_KEY / GM_EMBED_BASE_URL / GM_EMBED_MODEL / GM_EMBED_DIMENSIONS
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { initDriver, verifyWithRetry, closeDriver } from "../store/db.ts";
import { ensureSchema } from "../store/store.ts";
import { Recaller } from "../recaller/recall.ts";
import { createCompleteFn } from "../engine/llm.ts";
import { createEmbedFn } from "../engine/embed.ts";
import { runBenchmark, formatAggregateReport } from "./runner.ts";
import { resolveBenchmarkDataDir } from "./dataDir.ts";
import type { GmConfig } from "../types.ts";

/**
 * 从 ~/.openclaw/openclaw.json 读取 graph-memory-pro 插件配置。
 * 查找路径：plugins.entries["graph-memory-pro"].config（兼容数组/对象两种 entries 结构）。
 */
function readConfigFromOpenclaw(): GmConfig | null {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const configPath = join(home, ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as { plugins?: { entries?: unknown } };
    const entries = config?.plugins?.entries;

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

    if (!pluginConfig) return null;
    const neo4j = pluginConfig.neo4j;
    const hasNeo4j = neo4j && typeof neo4j === "object" && typeof (neo4j as { uri?: unknown }).uri === "string";
    if (!hasNeo4j) {
      console.warn("[benchmark] openclaw.json 中未找到 graph-memory-pro 的 neo4j 配置，忽略 openclaw.json");
      return null;
    }
    const cfg = pluginConfig as unknown as GmConfig;
    return {
      ...cfg,
      compactTurnCount: cfg.compactTurnCount ?? 6,
      recallMaxNodes: cfg.recallMaxNodes ?? 6,
      recallMaxDepth: cfg.recallMaxDepth ?? 2,
      freshTailCount: cfg.freshTailCount ?? 10,
      dedupThreshold: cfg.dedupThreshold ?? 0.9,
      pagerankDamping: cfg.pagerankDamping ?? 0.85,
      pagerankIterations: cfg.pagerankIterations ?? 20,
    };
  } catch (err) {
    console.warn(`[benchmark] 读取 openclaw.json 失败: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

function loadConfig(configPath?: string): GmConfig {
  // 1. 显式 --config 指定的文件（最高优先级）
  if (configPath) {
    const raw = readFileSync(configPath, "utf-8");
    console.log(`[benchmark] 使用 --config 配置: ${configPath}`);
    return JSON.parse(raw) as GmConfig;
  }

  // 2. 优先读取 openclaw.json 插件配置（plugins.entries.graph-memory-pro.config）
  const fromOpenclaw = readConfigFromOpenclaw();
  if (fromOpenclaw) {
    console.log(`[benchmark] 使用 openclaw.json 的 graph-memory-pro 插件配置`);
    return fromOpenclaw;
  }

  // 3. 兜底：环境变量构建最小配置
  console.log("[benchmark] 未找到 openclaw.json 配置，使用环境变量 + 默认值");
  const neo4jUri = process.env.GM_NEO4J_URI ?? "bolt://localhost:7687";
  const neo4jUser = process.env.GM_NEO4J_USER ?? "neo4j";
  const neo4jPassword = process.env.GM_NEO4J_PASSWORD ?? "";
  const llmApiKey = process.env.GM_LLM_API_KEY ?? "";
  const llmBaseURL = process.env.GM_LLM_BASE_URL ?? "";
  const llmModel = process.env.GM_LLM_MODEL ?? "gpt-4o-mini";
  const embedApiKey = process.env.GM_EMBED_API_KEY ?? "";
  const embedBaseURL = process.env.GM_EMBED_BASE_URL ?? "";
  const embedModel = process.env.GM_EMBED_MODEL ?? "nomic-embed-text";
  const embedDims = Number(process.env.GM_EMBED_DIMENSIONS ?? 768);

  return {
    neo4j: { uri: neo4jUri, user: neo4jUser, password: neo4jPassword },
    llm: { apiKey: llmApiKey, baseURL: llmBaseURL, model: llmModel },
    embedding: { apiKey: embedApiKey, baseURL: embedBaseURL, model: embedModel, dimensions: embedDims },
    recallMaxNodes: 6,
    recallMaxDepth: 2,
    dedupThreshold: 0.9,
    freshTailCount: 10,
    pagerankDamping: 0.85,
    pagerankIterations: 20,
    compactTurnCount: 6,
  } as GmConfig;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      "data-dir": { type: "string" },
      datasets: { type: "string", default: "all" },
      "max-cases": { type: "string" },
      "build-graph": { type: "boolean" },
      "no-build-graph": { type: "boolean" },
      "case-timeout-ms": { type: "string" },
    },
  });

  const cfg = loadConfig(values.config);

  // benchmark 参数优先级：CLI 显式指定 > cfg.benchmark（来自 openclaw.json）> 默认值
  const maxCases = values["max-cases"] !== undefined
    ? Number(values["max-cases"])
    : (cfg.benchmark?.maxCases ?? 0);
  const caseTimeoutMs = values["case-timeout-ms"] !== undefined
    ? Number(values["case-timeout-ms"])
    : (cfg.benchmark?.caseTimeoutMs ?? 30000);
  const buildGraph = values["no-build-graph"] ? false
    : (values["build-graph"] ? true : (cfg.benchmark?.buildGraph ?? true));
  // 数据目录：CLI --data-dir > openclaw.json benchmark.dataDir > 默认 benchmarks/data
  // 与 download/preprocess 保持同一解析逻辑，避免「预处理写 A 目录、评测读 B 目录」。
  const dataDir = resolveBenchmarkDataDir(values["data-dir"]);

  const datasets: string[] | "all" = values.datasets === "all" ? "all" : values.datasets.split(",");

  console.log("=== Graph Memory Pro Benchmark ===");
  console.log(`Neo4j: ${cfg.neo4j.uri}`);
  console.log(`LLM: ${cfg.llm?.model ?? "(none)"}`);
  console.log(`Embedding: ${cfg.embedding?.model ?? "(none)"}`);
  console.log(`Datasets: ${datasets === "all" ? "all" : (datasets as string[]).join(", ")}`);
  console.log(`Max cases: ${maxCases || "all"}`);
  console.log(`Build graph: ${buildGraph}`);
  console.log(`Data dir: ${dataDir}`);
  console.log("");

  // 1. 连接 Neo4j
  const driver = initDriver(cfg.neo4j);
  const ok = await verifyWithRetry(driver);
  if (!ok) {
    console.error("Neo4j connection failed");
    closeDriver();
    process.exit(1);
  }

  // 2. 初始化 schema
  const embedDim = cfg.embedding?.dimensions ?? 1024;
  try {
    await ensureSchema(driver, embedDim);
  } catch (err) {
    console.warn(`Schema init failed: ${err}`);
  }

  // 3. 初始化 LLM / Embed
  const llm = createCompleteFn(cfg.llm);
  const embed = cfg.embedding ? createEmbedFn(cfg.embedding) : null;

  // 4. 初始化 Recaller
  const recaller = new Recaller(driver, cfg);
  if (embed) recaller.setEmbedFn(embed);

  // 5. 运行 Benchmark
  try {
    const result = await runBenchmark(recaller, driver, cfg, {
      datasets: datasets,
      dataDir,
      maxCases,
      buildGraph,
      caseTimeoutMs,
      llm: llm ?? undefined,
      embedFn: embed ?? undefined,
    });

    console.log("");
    console.log(formatAggregateReport(result));
    console.log("");
    console.log(`Total duration: ${result.totalDurationMs}ms`);

    process.exit(0);
  } catch (err) {
    console.error(`Benchmark failed: ${err}`);
    process.exit(1);
  } finally {
    closeDriver();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
