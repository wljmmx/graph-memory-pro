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
import { readFileSync } from "node:fs";
import { initDriver, verifyWithRetry, closeDriver } from "../store/db.ts";
import { ensureSchema } from "../store/store.ts";
import { Recaller } from "../recaller/recall.ts";
import { createCompleteFn } from "../engine/llm.ts";
import { createEmbedFn } from "../engine/embed.ts";
import { runBenchmark, formatAggregateReport } from "./runner.ts";
import type { GmConfig } from "../types.ts";

function loadConfig(configPath?: string): GmConfig {
  // 1. 显式 --config 指定的文件
  if (configPath) {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as GmConfig;
  }

  // 2. 环境变量构建最小配置
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
      "max-cases": { type: "string", default: "0" },
      "build-graph": { type: "boolean", default: true },
      "no-build-graph": { type: "boolean", default: false },
      "case-timeout-ms": { type: "string", default: "30000" },
    },
  });

  const cfg = loadConfig(values.config);
  const buildGraph = values["no-build-graph"] ? false : values["build-graph"];
  const datasets = values.datasets === "all" ? "all" : values.datasets.split(",");
  const maxCases = Number(values["max-cases"] ?? 0);
  const caseTimeoutMs = Number(values["case-timeout-ms"] ?? 30000);

  console.log("=== Graph Memory Pro Benchmark ===");
  console.log(`Neo4j: ${cfg.neo4j.uri}`);
  console.log(`LLM: ${cfg.llm?.model ?? "(none)"}`);
  console.log(`Embedding: ${cfg.embedding?.model ?? "(none)"}`);
  console.log(`Datasets: ${datasets === "all" ? "all" : (datasets as string[]).join(", ")}`);
  console.log(`Max cases: ${maxCases || "all"}`);
  console.log(`Build graph: ${buildGraph}`);
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
      datasets: datasets as any,
      dataDir: values["data-dir"],
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
