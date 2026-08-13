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
import type { GmConfig, EdgeType } from "../types.ts";
import type { BenchmarkCase, BenchmarkDataset, BenchmarkReport, CaseResult } from "./types.ts";
import { evaluateCase, buildReport, formatReport } from "./types.ts";
import { loadAllDatasets, getBuiltinSampleDataset } from "./datasets.ts";
import { Extractor } from "../extractor/extract.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn, BatchEmbedFn } from "../engine/embed.ts";
import { upsertNode, upsertEdge } from "../store/store.ts";
import { embedNode, embedNodeBatch, type BatchEmbedNodeItem } from "../store/embed-helper.ts";
import { getSession } from "../store/db.ts";
import { withTimeout } from "../utils.ts";
import { createLogger } from "../logger.ts";
import { getCircuitBreaker } from "../engine/circuit-breaker.ts";

const log = createLogger("benchmark");

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
  /** 批量嵌入函数（v2.4.0）：建图时对节点批量 embed，显著减少 HTTP 请求数，缓解 Ollama 503 */
  batchEmbedFn?: BatchEmbedFn;
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
    batchEmbedFn,
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
  // v2.3.5: prebuiltNodes 不需要 LLM（完全确定数据），所以 buildGraph=true 时
  //   - 有 prebuiltNodes：只要 driver 存在就写
  //   - 需要 LLM extractor（fallback 到 conversation）：才需要 llm
  if (buildGraph && driver) {
    // v2.3.6: 建图前清理上一轮 bench-* 节点，避免污染生产图谱和指标
    await cleanupBenchNodes(driver);

    const extractor = llm ? new Extractor(driver) : null;
    for (const dataset of targetDatasets) {
      for (const testCase of dataset.cases) {
        const hasPrebuilt = testCase.prebuiltNodes && testCase.prebuiltNodes.length > 0;
        const hasConversation = testCase.conversation && testCase.conversation.length > 0;
        if (hasPrebuilt || (extractor && hasConversation)) {
          await buildGraphFromConversation(
            extractor,
            driver,
            llm ?? null,
            testCase,
            embedFn,
            batchEmbedFn,
          );
        } else if (!hasPrebuilt && !extractor) {
          log.warn(`buildGraph: case ${testCase.id} has no prebuiltNodes and LLM unavailable — skip graph build`);
        } else if (!hasPrebuilt && !hasConversation) {
          log.warn(`buildGraph: case ${testCase.id} has no prebuiltNodes and no conversation — skip graph build`);
        }
      }
    }
  } else if (!buildGraph) {
    // v2.3.5: 不建图时检查数据集是否有 prebuiltNodes，这种情况 expectedNodeIds 几乎必然不匹配
    for (const dataset of targetDatasets) {
      const casesWithPrebuilt = dataset.cases.filter(c =>
        (c.prebuiltNodes && c.prebuiltNodes.length > 0) || (c.prebuiltEdges && c.prebuiltEdges.length > 0),
      ).length;
      if (casesWithPrebuilt > 0) {
        log.warn(
          `buildGraph=false but dataset "${dataset.name}" has ${casesWithPrebuilt} cases with prebuiltNodes/Edges! ` +
          `expectedNodeIds will NOT match any real graph nodes → P@1/P@3/MRR will be 0%. ` +
          `Set buildGraph=true to inject prebuilt nodes before evaluation.`,
        );
      }
    }
  }

  // 3. 逐样本评测
  const reports: BenchmarkReport[] = [];

  // v2.4.0: 全链路——真实训练一份隔离的关联矩阵 M（benchmarks 专用，不加载生产持久化）
  //
  // 此前 benchmark 仅做「注入 prebuilt 节点 + 静态召回」，从不训练 M、也不跑反馈，
  // 无法衡量真实系统的「在线学习」部分。这里：
  //   - 若 cfg.associationMatrix.enabled 为 true（与生产一致的开头），创建一份全新的 M
  //     （不恢复持久化，隔离于生产），并注入 JudgeManager，走真实反馈链路。
  //   - 评测期间每次 recall 后调用 recaller.processFeedback(...)（真实 judge → 反馈落库 →
  //     incrementFeedback → updateAssociationMatrix），使后续 recall 受益于已学到的 M。
  //   - 这样 benchmark 衡量的是「真实全链路（建图 + 召回 + 反馈 + M 在线学习）」而非静态召回。
  let trainM = false;
  if (cfg.associationMatrix?.enabled === true && cfg.embedding?.dimensions) {
    try {
      const { createAssociationMatrix } = await import("../recaller/association-matrix.ts");
      recaller.setAssociationMatrix(createAssociationMatrix(cfg.embedding.dimensions, cfg));
      trainM = true;
    } catch (err) {
      log.warn(`benchmark: association-matrix init failed (${(err as Error)?.message ?? err}), run without M`);
    }
  }
  if (cfg.judge?.enabled !== false && !recaller.getJudgeManager()) {
    try {
      const { JudgeManager } = await import("../recaller/judge.ts");
      recaller.setJudgeManager(new JudgeManager(cfg.judge, llm ?? undefined));
    } catch {
      /* judge 不可用则跳过反馈训练 */
    }
  }

  for (const dataset of targetDatasets) {
    const cases = maxCases > 0 ? dataset.cases.slice(0, maxCases) : dataset.cases;
    const caseResults: CaseResult[] = [];

    log.info(`running ${dataset.name}: ${cases.length} cases`);

    // v2.3.7: 在评测循环开始前记录数据集耗时起点，计算真实评测耗时（修复旧版耗时≈0 的 bug）
    const datasetStart = Date.now();

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

        // v2.4.0: 真实反馈训练 M（不阻塞评测；仅当 M 已启用且召回到节点时）
        if (trainM && recallResult.nodes.length > 0) {
          try {
            await recaller.processFeedback(
              testCase.query,
              recallResult.nodes,
              testCase.expectedAnswer ?? "",
              testCase.id,
              { sync: true },
            );
          } catch {
            /* 反馈失败不影响评测 */
          }
        }
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

    const report = buildReport(dataset, caseResults, Date.now() - datasetStart);
    reports.push(report);
    log.info(formatReport(report));
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
 * v2.3.6: 清理上一轮 benchmark 写入的 bench-* 节点
 *
 * benchmark 节点 id 以 "bench-" 前缀标识，每次运行前先清理，
 * 避免旧 bench 节点干扰生产图谱的 searchNodes / getNodeCount / PPR 排序。
 */
async function cleanupBenchNodes(driver: Driver): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      `MATCH (n) WHERE n.id STARTS WITH 'bench-' DETACH DELETE n`,
    );
  } catch (err) {
    log.warn(`cleanupBenchNodes: failed (non-fatal): ${(err as Error).message}`);
  } finally {
    await session.close();
  }
}

/**
 * 从对话历史建图谱
 *
 * v2.3.5：若 testCase 提供了 prebuiltNodes / prebuiltEdges，直接写入（不走 LLM extractor）。
 *         这保证 expectedNodeIds 与实际节点 name 100% 可控对应。
 *         否则回退到 LLM extractor 提取三元组。
 *
 * 参数说明：
 *   - extractor / llm：仅 fallback 到 LLM 提取时需要，有 prebuiltNodes 时可传 null。
 */
async function buildGraphFromConversation(
  extractor: Extractor | null,
  driver: Driver,
  llm: CompleteFn | null,
  testCase: BenchmarkCase,
  embedFn?: EmbedFn,
  batchEmbedFn?: BatchEmbedFn,
): Promise<void> {
  try {
    const now = Date.now();
    const nodeIdMap = new Map<string, string>();

    // v2.3.5: 优先写 prebuiltNodes（不经过 LLM，结果确定）
    if (testCase.prebuiltNodes && testCase.prebuiltNodes.length > 0) {
      // v2.4.0: 先将节点全部写入，再统一批量 embed（减少请求数，缓解 Ollama 503）
      const embedCandidates: BatchEmbedNodeItem[] = [];
      for (const pn of testCase.prebuiltNodes) {
        // v2.3.5 fix: 使用确定性 id（case id + node name 哈希），避免多次 benchmark 运行
        // 造成同名节点重复堆积，也保证 MERGE 时真正"更新"而非"插入新的"
        const nameHash = [...pn.name].reduce((a, c) => a + c.charCodeAt(0), 0).toString(36);
        const id = `bench-${testCase.id}-${nameHash}`;
        nodeIdMap.set(pn.name, id);
        await upsertNode(driver, {
          id,
          type: pn.type,
          name: pn.name,
          description: pn.description,
          content: pn.content,
          status: pn.status ?? "active",
          communityId: pn.communityId ?? undefined,
          pagerank: pn.pagerank ?? 0,
          validatedCount: pn.validatedCount ?? 0,
          createdAt: pn.createdAt ?? now,
          updatedAt: pn.updatedAt ?? now,
        });
        if (batchEmbedFn || embedFn) {
          embedCandidates.push({
            nodeId: id,
            params: { name: pn.name, description: pn.description, content: pn.content },
          });
        }
      }

      if (embedCandidates.length > 0) {
        // v2.3.7: 建图嵌入前检查熔断器，OPEN 时跳过，避免持续请求打垮下游（Ollama server busy）
        const breaker = getCircuitBreaker("embed");
        if (breaker.allow()) {
          try {
            if (batchEmbedFn) {
              await embedNodeBatch(driver, batchEmbedFn, embedCandidates);
            } else if (embedFn) {
              for (const item of embedCandidates) {
                await embedNode(driver, embedFn, item.nodeId, item.params);
              }
            }
            breaker.recordSuccess();
          } catch {
            breaker.recordFailure();
            /* embedding 失败不阻塞建图 */
          }
        } else {
          log.warn(`buildGraph: embed circuit OPEN, skip embedding for ${embedCandidates.length} nodes (case ${testCase.id})`);
        }
      }

      // 写 prebuiltEdges（若提供）
      if (testCase.prebuiltEdges && testCase.prebuiltEdges.length > 0) {
        for (let i = 0; i < testCase.prebuiltEdges.length; i++) {
          const pe = testCase.prebuiltEdges[i];
          const fromId = nodeIdMap.get(pe.fromName);
          const toId = nodeIdMap.get(pe.toName);
          if (!fromId || !toId) {
            log.warn(`buildGraph: edge references unknown name from=${pe.fromName} to=${pe.toName} (case ${testCase.id})`);
            continue;
          }
          await upsertEdge(driver, {
            id: `bench-edge-${testCase.id}-${i}`,
            type: pe.type as EdgeType,
            fromId,
            toId,
            instruction: pe.instruction ?? "",
            condition: pe.condition ?? "",
            weight: 1,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      log.info(`buildGraph: wrote ${testCase.prebuiltNodes.length} prebuilt nodes for case ${testCase.id}`);
      return;
    }

    // fallback：通过 LLM extractor 提取（结果不稳定，仅用于无 prebuiltNodes 的外部数据集）
    if (!extractor || !llm) {
      log.warn(`buildGraph: no prebuiltNodes and extractor/llm missing for case ${testCase.id} — skip`);
      return;
    }
    if (!testCase.conversation || testCase.conversation.length === 0) {
      log.warn(`buildGraph: no conversation and no prebuiltNodes for case ${testCase.id}`);
      return;
    }
    const lastUser = [...testCase.conversation].reverse().find(m => m.role === "user");
    const lastAssistant = [...testCase.conversation].reverse().find(m => m.role === "assistant");
    if (!lastUser || !lastAssistant) {
      log.warn(`buildGraph: missing user/assistant pair for case ${testCase.id}`);
      return;
    }

    const result = await extractor.extract(llm, lastUser.content, lastAssistant.content);
    if (result.nodes.length === 0) {
      log.warn(`buildGraph: extractor returned 0 nodes for case ${testCase.id} — P@1/P@3/MRR will be 0`);
      return;
    }

    // v2.4.0: 先写节点，再统一批量 embed（减少请求数，缓解 Ollama 503）
    const embedCandidates: BatchEmbedNodeItem[] = [];
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
      if (batchEmbedFn || embedFn) {
        embedCandidates.push({
          nodeId: id,
          params: { name: enode.name, description: enode.description, content: enode.content },
        });
      }
    }
    if (embedCandidates.length > 0) {
      // v2.3.7: 同 prebuilt 分支，嵌入前检查熔断器
      const breaker = getCircuitBreaker("embed");
      if (breaker.allow()) {
        try {
          if (batchEmbedFn) {
            await embedNodeBatch(driver, batchEmbedFn, embedCandidates);
          } else if (embedFn) {
            for (const item of embedCandidates) {
              await embedNode(driver, embedFn, item.nodeId, item.params);
            }
          }
          breaker.recordSuccess();
        } catch {
          breaker.recordFailure();
          /* embedding 失败不阻塞建图 */
        }
      } else {
        log.warn(`buildGraph: embed circuit OPEN, skip embedding for ${embedCandidates.length} nodes (case ${testCase.id})`);
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
    log.info(`buildGraph: extractor wrote ${result.nodes.length} nodes for case ${testCase.id}`);
  } catch (err: unknown) {
    // v2.3.5: 不再静默失败 — 显式打印建图错误，便于诊断 0% 指标
    log.error(`buildGraph: FAILED for case ${testCase.id}: ${(err as Error)?.message ?? String(err)}`);
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
