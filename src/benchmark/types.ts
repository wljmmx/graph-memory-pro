/**
 * S-10 Benchmark 评测体系（v2.1.2 第五批）
 *
 * 量化验证 R-1/R-3/R-4/L-3/L-4/G-2/G-3 的效果
 *
 * 评测指标：P@1、P@3、MRR、F1、Latency P99、Token 消耗
 * 评测数据集：LoCoMo（1,540 题）、LongMemEval（500 题）
 *
 * 适配层：将对话转为 graph-memory 提取格式
 */

import type { RecallResult } from "../types.ts";

// ── 评测数据结构 ──────────────────────────────────────

/** 单条评测样本 */
export interface BenchmarkCase {
  /** 样本 id */
  id: string;
  /** 数据集名（locomo / longmemeval） */
  dataset: string;
  /** 类别（单跳/多跳/开放域/时序 等） */
  category: string;
  /** 用户查询 */
  query: string;
  /** 期望的答案文本（用于 F1 计算） */
  expectedAnswer: string;
  /** 期望命中的节点 id 列表（用于 P@1/P@3/MRR，可选） */
  expectedNodeIds?: string[];
  /** 对话历史（用于提取三元组建图谱） */
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 时间戳（时序类样本） */
  timestamp?: number;
}

/** 评测数据集接口 */
export interface BenchmarkDataset {
  name: string;
  cases: BenchmarkCase[];
  /** 数据集描述 */
  description: string;
  /** 目标指标（如 P@1 > 50%） */
  targets: {
    p1?: number;
    p3?: number;
    mrr?: number;
    f1?: number;
  };
}

// ── 评测结果 ──────────────────────────────────────

export interface CaseResult {
  caseId: string;
  dataset: string;
  category: string;
  /** 是否命中（P@1） */
  hitAt1: boolean;
  /** 是否在 top3 命中（P@3） */
  hitAt3: boolean;
  /** 命中排名（0 = 未命中，1 = top1） */
  reciprocalRank: number; // 1/rank, 0 if not found
  /** F1 分数（文本匹配） */
  f1: number;
  /** 召回耗时（ms） */
  latencyMs: number;
  /** Token 消耗（估算） */
  tokenEstimate: number;
  /** 召回的节点数 */
  recalledNodes: number;
}

export interface BenchmarkReport {
  dataset: string;
  /** 总样本数 */
  totalCases: number;
  /** 评估指标 */
  metrics: {
    p1: number;
    p3: number;
    mrr: number;
    f1: number;
    latencyP99: number;
    avgTokenEstimate: number;
  };
  /** 按类别的指标 */
  byCategory: Map<string, {
    count: number;
    p1: number;
    p3: number;
    mrr: number;
    f1: number;
    avgLatency: number;
  }>;
  /** 是否达到目标 */
  targetsMet: {
    p1?: boolean;
    p3?: boolean;
    mrr?: boolean;
    f1?: boolean;
  };
  /** 单条样本结果 */
  caseResults: CaseResult[];
  /** 评测时间戳 */
  timestamp: number;
  /** 评测耗时（ms） */
  durationMs: number;
}

// ── 评测指标计算 ──────────────────────────────────────

/**
 * 计算 P@1（top1 命中率）
 */
export function computeP1(results: CaseResult[]): number {
  if (results.length === 0) return 0;
  return results.filter(r => r.hitAt1).length / results.length;
}

/**
 * 计算 P@3（top3 命中率）
 */
export function computeP3(results: CaseResult[]): number {
  if (results.length === 0) return 0;
  return results.filter(r => r.hitAt3).length / results.length;
}

/**
 * 计算 MRR（平均倒数排名）
 */
export function computeMRR(results: CaseResult[]): number {
  if (results.length === 0) return 0;
  const sum = results.reduce((acc, r) => acc + r.reciprocalRank, 0);
  return sum / results.length;
}

/**
 * 计算 F1（基于文本匹配）
 *
 * 简化方案：token 级别的 F1
 */
export function computeF1(expected: string, actual: string): number {
  if (!expected || !actual) return 0;
  const expectedTokens = tokenize(expected);
  const actualTokens = tokenize(actual);
  if (expectedTokens.length === 0 || actualTokens.length === 0) return 0;

  const expectedSet = new Set(expectedTokens);
  const actualSet = new Set(actualTokens);
  let common = 0;
  for (const t of expectedSet) {
    if (actualSet.has(t)) common++;
  }
  if (common === 0) return 0;
  const precision = common / actualSet.size;
  const recall = common / expectedSet.size;
  return (2 * precision * recall) / (precision + recall);
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 0);
}

/**
 * 计算 P99 延迟
 *
 * 使用 nearest-rank 方法：N=100 时返回 index 98（即第 99 个最小值）
 * 修复旧实现 Math.floor(N*0.99) 在 N=100 时返回 index 99（P100）的 off-by-one 问题
 */
export function computeP99Latency(results: CaseResult[]): number {
  if (results.length === 0) return 0;
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const n = latencies.length;
  // 标准 nearest-rank：ceil(N * 99/100) - 1，clamp 到 [0, N-1]
  const idx = Math.min(Math.max(0, Math.ceil(n * 0.99) - 1), n - 1);
  return latencies[idx];
}

/**
 * 计算平均 Token 消耗
 */
export function computeAvgTokenEstimate(results: CaseResult[]): number {
  if (results.length === 0) return 0;
  const sum = results.reduce((acc, r) => acc + r.tokenEstimate, 0);
  return sum / results.length;
}

// ── 单样本评测 ──────────────────────────────────────

/**
 * 评估单条样本
 *
 * @param testCase 测试样本
 * @param recallResult 召回结果
 * @param latencyMs 召回耗时
 */
export function evaluateCase(
  testCase: BenchmarkCase,
  recallResult: RecallResult,
  latencyMs: number,
): CaseResult {
  const expectedNodeIds = testCase.expectedNodeIds ?? [];
  const recalledNodeIds = recallResult.nodes.map(n => n.id);

  // 计算 P@1 / P@3 / MRR
  let hitAt1 = false;
  let hitAt3 = false;
  let reciprocalRank = 0;

  if (expectedNodeIds.length > 0) {
    for (let i = 0; i < recalledNodeIds.length; i++) {
      if (expectedNodeIds.includes(recalledNodeIds[i])) {
        if (i === 0) hitAt1 = true;
        if (i < 3) hitAt3 = true;
        reciprocalRank = 1 / (i + 1);
        break;
      }
    }
  }

  // F1（文本匹配）
  const actualText = recallResult.nodes
    .map(n => `${n.name}: ${n.description ?? ""}`)
    .join(" ");
  const f1 = computeF1(testCase.expectedAnswer, actualText);

  return {
    caseId: testCase.id,
    dataset: testCase.dataset,
    category: testCase.category,
    hitAt1,
    hitAt3,
    reciprocalRank,
    f1,
    latencyMs,
    tokenEstimate: recallResult.tokenEstimate,
    recalledNodes: recallResult.nodes.length,
  };
}

/**
 * 汇总评测报告
 */
export function buildReport(
  dataset: BenchmarkDataset,
  caseResults: CaseResult[],
  durationMs: number,
): BenchmarkReport {
  const byCategory = new Map<string, {
    count: number;
    p1: number;
    p3: number;
    mrr: number;
    f1: number;
    avgLatency: number;
  }>();

  // 按类别聚合
  const categoryMap = new Map<string, CaseResult[]>();
  for (const cr of caseResults) {
    if (!categoryMap.has(cr.category)) categoryMap.set(cr.category, []);
    categoryMap.get(cr.category)!.push(cr);
  }
  for (const [cat, results] of categoryMap) {
    byCategory.set(cat, {
      count: results.length,
      p1: computeP1(results),
      p3: computeP3(results),
      mrr: computeMRR(results),
      f1: results.reduce((acc, r) => acc + r.f1, 0) / results.length,
      avgLatency: results.reduce((acc, r) => acc + r.latencyMs, 0) / results.length,
    });
  }

  const p1 = computeP1(caseResults);
  const p3 = computeP3(caseResults);
  const mrr = computeMRR(caseResults);
  const f1 = caseResults.reduce((acc, r) => acc + r.f1, 0) / caseResults.length;

  return {
    dataset: dataset.name,
    totalCases: caseResults.length,
    metrics: {
      p1,
      p3,
      mrr,
      f1,
      latencyP99: computeP99Latency(caseResults),
      avgTokenEstimate: computeAvgTokenEstimate(caseResults),
    },
    byCategory,
    targetsMet: {
      p1: dataset.targets.p1 !== undefined ? p1 >= dataset.targets.p1 : undefined,
      p3: dataset.targets.p3 !== undefined ? p3 >= dataset.targets.p3 : undefined,
      mrr: dataset.targets.mrr !== undefined ? mrr >= dataset.targets.mrr : undefined,
      f1: dataset.targets.f1 !== undefined ? f1 >= dataset.targets.f1 : undefined,
    },
    caseResults,
    timestamp: Date.now(),
    durationMs,
  };
}

/**
 * 格式化报告为可读文本
 */
export function formatReport(report: BenchmarkReport): string {
  const lines: string[] = [
    `📊 Benchmark Report: ${report.dataset}`,
    `总样本: ${report.totalCases}`,
    `耗时: ${report.durationMs}ms`,
    "",
    "🎯 核心指标",
    `P@1:   ${(report.metrics.p1 * 100).toFixed(2)}%  ${report.targetsMet.p1 === false ? "⚠️ 未达标" : report.targetsMet.p1 === true ? "✅ 达标" : ""}`,
    `P@3:   ${(report.metrics.p3 * 100).toFixed(2)}%  ${report.targetsMet.p3 === false ? "⚠️ 未达标" : report.targetsMet.p3 === true ? "✅ 达标" : ""}`,
    `MRR:   ${report.metrics.mrr.toFixed(4)}  ${report.targetsMet.mrr === false ? "⚠️ 未达标" : report.targetsMet.mrr === true ? "✅ 达标" : ""}`,
    `F1:    ${(report.metrics.f1 * 100).toFixed(2)}%  ${report.targetsMet.f1 === false ? "⚠️ 未达标" : report.targetsMet.f1 === true ? "✅ 达标" : ""}`,
    `P99:   ${report.metrics.latencyP99.toFixed(0)}ms`,
    `Tokens: ${report.metrics.avgTokenEstimate.toFixed(0)}`,
    "",
    "📂 按类别",
  ];

  for (const [cat, m] of report.byCategory) {
    lines.push(
      `  ${cat} (${m.count}): P@1=${(m.p1 * 100).toFixed(1)}%, P@3=${(m.p3 * 100).toFixed(1)}%, MRR=${m.mrr.toFixed(3)}, F1=${(m.f1 * 100).toFixed(1)}%, avg=${m.avgLatency.toFixed(0)}ms`,
    );
  }

  return lines.join("\n");
}
