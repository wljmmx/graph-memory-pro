/**
 * S-10 Benchmark 运行器（v2.1.2 第五批）
 *
 * 执行评测流程：
 *   1. 加载评测数据集
 *   2. 对每个样本调用 Recaller.recall()
 *   3. 计算 P@1/P@3/MRR/F1/P99/Tokens
 *   4. 生成报告
 *
 * 可选：评测前先用对话历史提取三元组建图谱
 *
 * 用法：
 *   import { runBenchmark } from "./src/benchmark/runner.ts";
 *   const reports = await runBenchmark(recaller, { datasets: ["all"] });
 */

import type { Recaller } from "../recaller/recall.ts";
import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import type { BenchmarkCase, BenchmarkDataset, BenchmarkReport, CaseResult } from "./types.ts";
import { evaluateCase, buildReport, formatReport } from "./types.ts";
import { loadAllDatasets, getBuiltinSampleDataset } from "./datasets.ts";
import { Extractor } from "../extractor/extract.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { upsertNode, upsertEdge, saveVector, computeEmbeddingHash } from "../store/store.ts";
import { withTimeout } from "../utils.ts";

export interface BenchmarkOptions {
  /** 指定运行的数据集（"all" 或具体名称数组） */
  datasets?: string[] | "all";
  /** 数据目录（默认 benchmarks/data） */
  dataDir?: string;
  /** 最大样本数（0 = 全部，用于快速测试） */
  maxCases?: number;
  /** 评测前是否先用对话历史建图谱（默认 true） */
  buildGraph?: boolean;
  /** 单样本超时（ms，默认 30000） */
  caseTimeoutMs?: number;
  /** 嵌入函数（建图时为节点生成 embedding，避免 benchmark 偏向 FTS） */
  embedFn?: EmbedFn;
  /** LLM 完成函数（建图谱时需要） */
  llm?: CompleteFn;
}

export interface BenchmarkRunResult {
  reports: BenchmarkReport[];
  totalDurationMs: number;
  /** 汇总指标 */
  aggregate: {
    totalCases: number;
    avgP1: number;
    avgP3: number;
    avgMrr: number;
    avgF1: number;
    avgP99: number;
  };
}

/**
 * 运行 Benchmark 评测
 *
 * @param recaller Recaller 实例
 * @param driver Neo4j driver（建图谱时需要）
 * @param cfg GmConfig（建图谱时需要）
 * @param opts 评测选项
 */
export async function runBenchmark(
  recaller: Recaller,
  driver: Driver | null,
  cfg: GmConfig,
  opts: BenchmarkOptions = {},
): Promise<BenchmarkRunResult> {
  const start = Date.now();
  const {
    datasets: datasetFilter = "all",
    dataDir,
    maxCases = 0,
    buildGraph = true,
    caseTimeoutMs = 30_000,
    llm,
    embedFn,
  } = opts;

  // 1. 加载数据集
  let datasets: BenchmarkDataset[];
  if (dataDir) {
    datasets = await loadAllDatasets(dataDir);
  } else {
    // 无 dataDir 时尝试加载，失败则用内置样本
    try {
      datasets = await loadAllDatasets();
    } catch {
      datasets = [getBuiltinSampleDataset()];
    }
  }

  // 过滤数据集
  const targetDatasets = datasetFilter === "all"
    ? datasets
    : datasets.filter(d => datasetFilter.includes(d.name));

  if (targetDatasets.length === 0) {
    return {
      reports: [],
      totalDurationMs: Date.now() - start,
      aggregate: {
        totalCases: 0,
        avgP1: 0,
        avgP3: 0,
        avgMrr: 0,
        avgF1: 0,
        avgP99: 0,
      },
    };
  }

  // 2. 可选：建图谱
  if (buildGraph && driver && llm) {
    const extractor = new Extractor(driver);
    for (const dataset of targetDatasets) {
      for (const testCase of dataset.cases) {
        if (!testCase.conversation) continue;
        await buildGraphFromConversation(extractor, driver, llm, testCase, embedFn);
      }
    }
  }

  // 3. 逐样本评测
  const reports: BenchmarkReport[] = [];
  for (const dataset of targetDatasets) {
    const cases = maxCases > 0 ? dataset.cases.slice(0, maxCases) : dataset.cases;
    const caseResults: CaseResult[] = [];

    console.log(`[benchmark] running ${dataset.name}: ${cases.length} cases`);

    for (const testCase of cases) {
      try {
        const caseStart = Date.now();
        // 带超时的召回
        const recallResult = await withTimeout(
          recaller.recall(testCase.query),
          caseTimeoutMs,
        );
        const latencyMs = Date.now() - caseStart;

        const caseResult = evaluateCase(testCase, recallResult, latencyMs);
        caseResults.push(caseResult);
      } catch {
        // 超时或失败的样本记为未命中
        caseResults.push({
          caseId: testCase.id,
          dataset: testCase.dataset,
          category: testCase.category,
          hitAt1: false,
          hitAt3: false,
          reciprocalRank: 0,
          f1: 0,
          latencyMs: caseTimeoutMs,
          tokenEstimate: 0,
          recalledNodes: 0,
        });
      }
    }

    const datasetStart = Date.now();
    const report = buildReport(dataset, caseResults, Date.now() - datasetStart);
    reports.push(report);
    console.log(formatReport(report));
    console.log("");
  }

  // 4. 汇总
  const totalCases = reports.reduce((acc, r) => acc + r.totalCases, 0);
  const avgP1 = reports.length > 0 ? reports.reduce((acc, r) => acc + r.metrics.p1, 0) / reports.length : 0;
  const avgP3 = reports.length > 0 ? reports.reduce((acc, r) => acc + r.metrics.p3, 0) / reports.length : 0;
  const avgMrr = reports.length > 0 ? reports.reduce((acc, r) => acc + r.metrics.mrr, 0) / reports.length : 0;
  const avgF1 = reports.length > 0 ? reports.reduce((acc, r) => acc + r.metrics.f1, 0) / reports.length : 0;
  const avgP99 = reports.length > 0 ? reports.reduce((acc, r) => acc + r.metrics.latencyP99, 0) / reports.length : 0;

  return {
    reports,
    totalDurationMs: Date.now() - start,
    aggregate: {
      totalCases,
      avgP1,
      avgP3,
      avgMrr,
      avgF1,
      avgP99,
    },
  };
}

/**
 * 从对话历史建图谱
 */
async function buildGraphFromConversation(
  extractor: Extractor,
  driver: Driver,
  llm: CompleteFn,
  testCase: BenchmarkCase,
  embedFn?: EmbedFn,
): Promise<void> {
  if (!testCase.conversation || testCase.conversation.length === 0) return;

  // 取最后一条 user + assistant 对
  const lastUser = [...testCase.conversation].reverse().find(m => m.role === "user");
  const lastAssistant = [...testCase.conversation].reverse().find(m => m.role === "assistant");
  if (!lastUser || !lastAssistant) return;

  try {
    const result = await extractor.extract(llm, lastUser.content, lastAssistant.content);
    if (result.nodes.length === 0) return;

    const nodeIdMap = new Map<string, string>();
    const now = Date.now();
    for (const enode of result.nodes) {
      const id = `bench-${now}-${Math.random().toString(36).slice(2, 8)}`;
      nodeIdMap.set(enode.name, id);
      await upsertNode(driver, {
        id,
        type: enode.type,
        name: enode.name,
        description: enode.description,
        content: enode.content,
        status: "active",
        communityId: undefined,
        pagerank: 0,
        validatedCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      // 为节点生成 embedding，避免 benchmark 仅靠 FTS 召回（修复建图无 embedding 缺陷）
      if (embedFn) {
        try {
          const text = `${enode.name}: ${enode.description}\n${enode.content.slice(0, 500)}`;
          const vec = await embedFn(text);
          if (vec && vec.length > 0) {
            const hash = computeEmbeddingHash(enode.name, enode.description, enode.content);
            await saveVector(driver, id, vec, hash/* embeddingModel=unknown in benchmark */);
          }
        } catch {
          // embedding 失败不阻塞建图
        }
      }
    }
    for (const eedge of result.edges) {
      const fromId = nodeIdMap.get(eedge.fromName);
      const toId = nodeIdMap.get(eedge.toName);
      if (!fromId || !toId) continue;
      await upsertEdge(driver, {
        id: `bench-edge-${now}-${Math.random().toString(36).slice(2, 8)}`,
        type: eedge.type,
        fromId,
        toId,
        instruction: eedge.instruction,
        condition: eedge.condition,
        weight: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch {
    // 静默失败
  }
}

/**
 * 汇总报告文本
 */
export function formatAggregateReport(result: BenchmarkRunResult): string {
  const lines: string[] = [
    "📊 Benchmark 汇总报告",
    `总耗时: ${result.totalDurationMs}ms`,
    `总样本: ${result.aggregate.totalCases}`,
    "",
    "🎯 汇总指标",
    `平均 P@1:  ${(result.aggregate.avgP1 * 100).toFixed(2)}%`,
    `平均 P@3:  ${(result.aggregate.avgP3 * 100).toFixed(2)}%`,
    `平均 MRR:  ${result.aggregate.avgMrr.toFixed(4)}`,
    `平均 F1:   ${(result.aggregate.avgF1 * 100).toFixed(2)}%`,
    `平均 P99:  ${result.aggregate.avgP99.toFixed(0)}ms`,
    "",
    ...result.reports.map(r =>
      `  ${r.dataset}: P@1=${(r.metrics.p1 * 100).toFixed(1)}%, F1=${(r.metrics.f1 * 100).toFixed(1)}%, cases=${r.totalCases}`,
    ),
  ];
  return lines.join("\n");
}
