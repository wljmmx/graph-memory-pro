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
import { initDriver, verifyWithRetry, closeDriver, withDatabase, ensureDatabase, getNeo4jEdition, setCachedEdition } from "../store/db.ts";
import { resolveBenchmarkDatabase } from "./database.ts";
import { ensureSchema } from "../store/store.ts";
import { Recaller } from "../recaller/recall.ts";
import { createCompleteFn } from "../engine/llm.ts";
import { createEmbedFn, createBatchEmbedFn } from "../engine/embed.ts";
import { runBenchmark, formatAggregateReport } from "./runner.ts";
import { resolveBenchmarkDataDir } from "./dataDir.ts";
import type { GmConfig } from "../types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("benchmark-cli");

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
      log.warn("[benchmark] openclaw.json 中未找到 graph-memory-pro 的 neo4j 配置，忽略 openclaw.json");
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
    log.warn("[benchmark] 读取 openclaw.json 失败", { error: (err as Error)?.message ?? String(err) });
    return null;
  }
}

function loadConfig(configPath?: string): GmConfig {
  // 1. 显式 --config 指定的文件（最高优先级）
  if (configPath) {
    const raw = readFileSync(configPath, "utf-8");
    log.info(`[benchmark] 使用 --config 配置: ${configPath}`);
    return JSON.parse(raw) as GmConfig;
  }

  // 2. 优先读取 openclaw.json 插件配置（plugins.entries.graph-memory-pro.config）
  const fromOpenclaw = readConfigFromOpenclaw();
  if (fromOpenclaw) {
    log.info(`[benchmark] 使用 openclaw.json 的 graph-memory-pro 插件配置`);
    return fromOpenclaw;
  }

  // 3. 兜底：环境变量构建最小配置
  log.info("[benchmark] 未找到 openclaw.json 配置，使用环境变量 + 默认值");
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

  log.info("=== Graph Memory Pro Benchmark ===");
  log.info(`Neo4j: ${cfg.neo4j.uri}`);
  log.info(`LLM: ${cfg.llm?.model ?? "(none)"}`);
  log.info(`Embedding: ${cfg.embedding?.model ?? "(none)"}`);
  log.info(`Datasets: ${datasets === "all" ? "all" : (datasets as string[]).join(", ")}`);
  log.info(`Max cases: ${maxCases || "all"}`);
  log.info(`Build graph: ${buildGraph}`);
  log.info(`Data dir: ${dataDir}`);
  log.info("");

  // 1. 连接 Neo4j
  const driver = initDriver(cfg.neo4j);
  const ok = await verifyWithRetry(driver);
  if (!ok) {
    log.error("Neo4j connection failed");
    closeDriver();
    process.exit(1);
  }

  // v2.9.0 断链修复（①）：CLI 是独立 tsx 进程，不会经过插件主进程 index.ts 的
  // getNeo4jEdition/setCachedEdition 链路——不检测 edition，withDatabase 闸门恒关，
  // 物理切库静默退化为"直接执行"（benchmark 数据落生产库）。此处补齐。
  try {
    const edition = await getNeo4jEdition(driver);
    setCachedEdition(edition);
    log.info(`Neo4j edition: ${edition ?? "(unknown)"} (multi-database isolation: ${edition === "Enterprise" ? "enabled" : "not available — falling back to logical isolation"})`);
  } catch (err) {
    log.warn("Neo4j edition detection failed (multi-db isolation disabled, logical isolation fallback)", { error: String(err) });
  }

  // 2. 初始化 schema
  const embedDim = cfg.embedding?.dimensions ?? 1024;

  // v2.4.0: benchmark 专用数据库（默认 benchmarks 库；需 Neo4j Enterprise 多库）。
  // ensureSchema + runBenchmark 全部在该库上下文中执行。
  // v2.9.0 断链修复（②）：空串/缺失配置统一回落到 benchmarks 默认库名（原先 "??" 不兜空串）。
  // v2.9.0 断链修复（③）：Enterprise 下目标库不存在时自动 CREATE DATABASE（原先静默失败）。
  const benchDatabase = resolveBenchmarkDatabase(cfg);
  if (benchDatabase !== (cfg.neo4j.database || "neo4j")) {
    log.info(`benchmark database: ${benchDatabase}`);
  }
  try {
    await ensureDatabase(driver, benchDatabase);
    await withDatabase(benchDatabase, () => ensureSchema(driver, embedDim));
  } catch (err) {
    log.warn("Schema init failed", { error: String(err) });
  }

  // 3. 初始化 LLM / Embed
  const llm = createCompleteFn(cfg.llm);
  const embed = cfg.embedding ? createEmbedFn(cfg.embedding) : null;
  // v2.4.0: 批量嵌入（建图时一次请求携带多个文本，减少请求数，缓解 Ollama 503）
  const batchEmbed = cfg.embedding ? createBatchEmbedFn(cfg.embedding) : null;

  // 4. 初始化 Recaller
  const recaller = new Recaller(driver, cfg);
  if (embed) recaller.setEmbedFn(embed);

  // 5. 运行 Benchmark（在该单元中切换到 benchmark 专用数据库，结束后自动恢复）
  try {
    const result = await withDatabase(benchDatabase, () => runBenchmark(recaller, driver, cfg, {
      datasets: datasets,
      dataDir,
      maxCases,
      buildGraph,
      caseTimeoutMs,
      llm: llm ?? undefined,
      embedFn: embed ?? undefined,
      batchEmbedFn: batchEmbed ?? undefined,
    }));

    log.info("");
    log.info(formatAggregateReport(result));
    log.info("");
    log.info(`Total duration: ${result.totalDurationMs}ms`);

    process.exit(0);
  } catch (err) {
    log.error(`Benchmark failed: ${err}`);
    process.exit(1);
  } finally {
    closeDriver();
  }
}

main().catch((err) => {
  log.error(String(err));
  process.exit(1);
});
