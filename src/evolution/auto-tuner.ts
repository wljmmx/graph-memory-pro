/**
 * R-1 自主调优（EvolveMem）（v2.1.2 第五批）
 *
 * EvolveMem 四步循环：
 *   1. EVALUATE：在 Benchmark（S-10）上评估当前配置
 *   2. DIAGNOSE：LLM 读取失败案例，归类根因
 *   3. PROPOSE：LLM 提出配置调整
 *   4. GUARD：revert-on-regression（退步→回退）+ explore-on-stagnation（停滞→探索）
 *
 * 安全护栏：
 *   - revert-on-regression：退步 > 2pp → 自动回退上一稳定配置
 *   - explore-on-stagnation：连续 5 轮无改进 → 探索新维度
 *   - 配置版本快照：每次变更存档，可回溯
 *
 * 冷启动：累计反馈 < warmupFeedbacks 时不触发
 */

import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { Driver } from "neo4j-driver";
import type { Recaller } from "../recaller/recall.ts";
import type { BenchmarkReport, CaseResult } from "../benchmark/types.ts";
import { runBenchmark, formatAggregateReport, type BenchmarkRunResult } from "../benchmark/runner.ts";

// ── 动作空间 ──────────────────────────────────────

/**
 * EvolveMem 动作空间
 *
 * 召回参数暴露为可调动作，每个参数有 [min, max] 范围
 */
export interface EvolveActionSpace {
  recallMaxNodes: number;          // 3-15
  recallMaxDepth: number;          // 1-4
  pagerankDamping: number;         // 0.7-0.95
  pagerankIterations: number;      // 10-50
  dedupThreshold: number;          // 0.80-0.98
  freshTailCount: number;          // 5-20
  vectorSearchTopK: number;        // 5-30
  compactTurnCount: number;       // 3-12
}

export const ACTION_BOUNDS: Record<keyof EvolveActionSpace, { min: number; max: number }> = {
  recallMaxNodes: { min: 3, max: 15 },
  recallMaxDepth: { min: 1, max: 4 },
  pagerankDamping: { min: 0.7, max: 0.95 },
  pagerankIterations: { min: 10, max: 50 },
  dedupThreshold: { min: 0.8, max: 0.98 },
  freshTailCount: { min: 5, max: 20 },
  vectorSearchTopK: { min: 5, max: 30 },
  compactTurnCount: { min: 3, max: 12 },
};

/** 默认动作空间（基于 GmConfig 提取） */
export function extractActionSpace(cfg: GmConfig): EvolveActionSpace {
  return {
    recallMaxNodes: cfg.recallMaxNodes ?? 6,
    recallMaxDepth: cfg.recallMaxDepth ?? 2,
    pagerankDamping: cfg.pagerankDamping ?? 0.85,
    pagerankIterations: cfg.pagerankIterations ?? 20,
    dedupThreshold: cfg.dedupThreshold ?? 0.9,
    freshTailCount: cfg.freshTailCount ?? 10,
    vectorSearchTopK: cfg.recallMaxNodes ? cfg.recallMaxNodes * 2 : 12,
    compactTurnCount: cfg.compactTurnCount ?? 6,
  };
}

/** 将动作空间应用回 GmConfig */
export function applyActionSpace(cfg: GmConfig, action: EvolveActionSpace): GmConfig {
  return {
    ...cfg,
    recallMaxNodes: action.recallMaxNodes,
    recallMaxDepth: action.recallMaxDepth,
    pagerankDamping: action.pagerankDamping,
    pagerankIterations: action.pagerankIterations,
    dedupThreshold: action.dedupThreshold,
    freshTailCount: action.freshTailCount,
    compactTurnCount: action.compactTurnCount,
  };
}

/** 裁剪动作到合法范围 */
export function clampAction(action: Partial<EvolveActionSpace>): Partial<EvolveActionSpace> {
  const clamped: Partial<EvolveActionSpace> = {};
  for (const key of Object.keys(action) as Array<keyof EvolveActionSpace>) {
    const val = action[key]!;
    const bounds = ACTION_BOUNDS[key];
    clamped[key] = Math.max(bounds.min, Math.min(bounds.max, val));
  }
  return clamped;
}

// ── 配置快照 ──────────────────────────────────────

export interface ConfigSnapshot {
  /** 配置版本号 */
  version: number;
  /** 时间戳 */
  timestamp: number;
  /** 动作空间（配置参数） */
  action: EvolveActionSpace;
  /** 评测时的指标 */
  metrics: {
    p1: number;
    p3: number;
    mrr: number;
    f1: number;
    p99: number;
  };
  /** 是否为稳定配置（通过 GUARD 验证） */
  stable: boolean;
  /** 调优轮次 */
  tuneRound: number;
}

// ── 诊断结果 ──────────────────────────────────────

export interface DiagnosisResult {
  /** 失败案例的根因分类 */
  rootCauses: Array<{
    cause: string;
    count: number;
    examples: string[];
  }>;
  /** LLM 建议的调整 */
  proposedAdjustments: Partial<EvolveActionSpace>;
  /** 诊断理由（LLM 输出） */
  reasoning: string;
}

// ── 调优配置 ──────────────────────────────────────

export interface AutoTunerConfig {
  enabled: boolean;
  /** revert-on-regression 阈值（退步 > 2pp → 回退） */
  regressionThreshold: number; // 0.02 = 2pp
  /** explore-on-stagnation 阈值（连续 5 轮无改进 → 探索） */
  stagnationThreshold: number;
  /** 最大调优轮次 */
  maxRounds: number;
  /** 单次评测最大样本数（0 = 全部） */
  benchmarkMaxCases: number;
  /** 是否启用 LLM 诊断（false 则仅用启发式） */
  llmDiagnosis: boolean;
  /** 冷启动阈值（累计反馈 < 此值时不触发） */
  warmupFeedbacks: number;
}

export const DEFAULT_AUTOTUNER_CONFIG: AutoTunerConfig = {
  enabled: false,
  regressionThreshold: 0.02,
  stagnationThreshold: 5,
  maxRounds: 10,
  benchmarkMaxCases: 50,
  llmDiagnosis: true,
  warmupFeedbacks: 100,
};

// ── AutoTuner 主类 ──────────────────────────────────────

export class AutoTuner {
  private cfg: AutoTunerConfig;
  private llm: CompleteFn | null;
  private currentAction: EvolveActionSpace;
  private snapshots: ConfigSnapshot[] = [];
  private tuneRound = 0;
  private stagnationCount = 0;
  private bestMetrics: { p1: number; p3: number; mrr: number; f1: number; p99: number } | null = null;

  constructor(cfg: Partial<AutoTunerConfig> = {}, llm?: CompleteFn) {
    this.cfg = { ...DEFAULT_AUTOTUNER_CONFIG, ...cfg };
    this.llm = llm ?? null;
    this.currentAction = {
      recallMaxNodes: 6,
      recallMaxDepth: 2,
      pagerankDamping: 0.85,
      pagerankIterations: 20,
      dedupThreshold: 0.9,
      freshTailCount: 10,
      vectorSearchTopK: 12,
      compactTurnCount: 6,
    };
  }

  /** 是否启用 */
  isEnabled(): boolean {
    return this.cfg.enabled;
  }

  /** 获取当前动作空间 */
  getCurrentAction(): EvolveActionSpace {
    return { ...this.currentAction };
  }

  /** 获取配置快照历史 */
  getSnapshots(): ConfigSnapshot[] {
    return [...this.snapshots];
  }

  /** 获取调优轮次 */
  getTuneRound(): number {
    return this.tuneRound;
  }

  /**
   * 设置初始动作空间（从 GmConfig 提取）
   */
  setInitialAction(cfg: GmConfig): void {
    this.currentAction = extractActionSpace(cfg);
  }

  /**
   * 运行一次完整的 EvolveMem 调优循环
   *
   * @param recaller Recaller 实例
   * @param driver Neo4j driver
   * @param currentCfg 当前 GmConfig
   * @returns 调优结果（含新配置 + 评测指标）
   */
  async runTuneCycle(
    recaller: Recaller,
    driver: Driver | null,
    currentCfg: GmConfig,
  ): Promise<TuneCycleResult> {
    if (!this.cfg.enabled) {
      return {
        applied: false,
        reason: "auto-tuner disabled",
        tuneRound: this.tuneRound,
      };
    }

    // 冷启动检查
    const feedbackCount = recaller.getJudgeManager()?.getFeedbackCount() ?? 0;
    if (feedbackCount < this.cfg.warmupFeedbacks) {
      return {
        applied: false,
        reason: `cold start (feedback=${feedbackCount} < ${this.cfg.warmupFeedbacks})`,
        tuneRound: this.tuneRound,
      };
    }

    this.tuneRound++;
    const roundStart = Date.now();

    // 1. EVALUATE：在 Benchmark 上评估当前配置
    console.log(`[auto-tuner] round ${this.tuneRound}: EVALUATE`);
    const evalResult = await runBenchmark(recaller, driver, currentCfg, {
      maxCases: this.cfg.benchmarkMaxCases,
      buildGraph: false,
      llm: this.llm ?? undefined,
    });

    const currentMetrics = extractMetrics(evalResult);
    const failedCases = collectFailedCases(evalResult.reports);

    // 2. DIAGNOSE：LLM 诊断失败案例
    console.log(`[auto-tuner] round ${this.tuneRound}: DIAGNOSE (${failedCases.length} failures)`);
    const diagnosis = await this.diagnose(failedCases, currentMetrics);

    // 3. PROPOSE：应用建议的调整
    console.log(`[auto-tuner] round ${this.tuneRound}: PROPOSE`);
    const proposedAction = { ...this.currentAction, ...diagnosis.proposedAdjustments };
    const clampedAction = clampAction(proposedAction) as EvolveActionSpace;
    const fullClamped = this.fillAction(clampedAction);

    // 4. GUARD：revert-on-regression + explore-on-stagnation
    console.log(`[auto-tuner] round ${this.tuneRound}: GUARD`);
    const guardResult = this.guard(currentMetrics, fullClamped);

    if (guardResult.revert) {
      // 回退到上一稳定配置
      const lastStable = this.snapshots.filter(s => s.stable).pop();
      if (lastStable) {
        this.currentAction = lastStable.action;
        console.log(`[auto-tuner] reverted to snapshot v${lastStable.version}`);
      }
      return {
        applied: false,
        reason: guardResult.reason,
        tuneRound: this.tuneRound,
        metrics: currentMetrics,
        proposedAction: fullClamped,
        diagnosis,
        durationMs: Date.now() - roundStart,
      };
    }

    // 应用新配置
    this.currentAction = fullClamped;
    const isImprovement = this.bestMetrics === null || currentMetrics.p1 > this.bestMetrics.p1;

    const snapshot: ConfigSnapshot = {
      version: this.snapshots.length + 1,
      timestamp: Date.now(),
      action: { ...this.currentAction },
      metrics: currentMetrics,
      stable: isImprovement,
      tuneRound: this.tuneRound,
    };
    this.snapshots.push(snapshot);

    if (isImprovement) {
      this.bestMetrics = currentMetrics;
      this.stagnationCount = 0;
    } else {
      this.stagnationCount++;
    }

    // explore-on-stagnation：连续 N 轮无改进 → 探索新维度
    if (this.stagnationCount >= this.cfg.stagnationThreshold) {
      console.log(`[auto-tuner] stagnation: exploring new dimensions`);
      const explored = this.exploreNewDimension();
      this.currentAction = { ...this.currentAction, ...explored };
      this.stagnationCount = 0;
    }

    return {
      applied: true,
      reason: guardResult.reason,
      tuneRound: this.tuneRound,
      metrics: currentMetrics,
      proposedAction: this.currentAction,
      diagnosis,
      isImprovement,
      durationMs: Date.now() - roundStart,
      benchmarkSummary: formatAggregateReport(evalResult),
    };
  }

  /**
   * DIAGNOSE：LLM 诊断失败案例
   */
  private async diagnose(
    failedCases: CaseResult[],
    currentMetrics: { p1: number; p3: number; mrr: number; f1: number; p99: number },
  ): Promise<DiagnosisResult> {
    // 启发式诊断（无 LLM 时的 fallback）
    if (!this.llm || !this.cfg.llmDiagnosis) {
      return this.heuristicDiagnose(failedCases, currentMetrics);
    }

    // LLM 诊断
    const sysPrompt = `你是 graph-memory-pro 的召回参数诊断专家。
根据评测失败案例，分析根因并建议参数调整。

当前配置：
${JSON.stringify(this.currentAction, null, 2)}

当前指标：
- P@1: ${(currentMetrics.p1 * 100).toFixed(2)}%
- P@3: ${(currentMetrics.p3 * 100).toFixed(2)}%
- MRR: ${currentMetrics.mrr.toFixed(4)}
- F1: ${(currentMetrics.f1 * 100).toFixed(2)}%

失败案例（前 10 条）：
${failedCases.slice(0, 10).map(c => `- ${c.dataset}/${c.category}: recalled=${c.recalledNodes}, f1=${c.f1.toFixed(2)}, latency=${c.latencyMs}ms`).join("\n")}

参数范围：
${JSON.stringify(ACTION_BOUNDS, null, 2)}

请输出 JSON 格式：
{
  "rootCauses": [{"cause": "...", "count": N, "examples": ["..."]}],
  "proposedAdjustments": {"recallMaxNodes": N, ...},
  "reasoning": "..."
}

只输出 JSON，不要其他内容。`;

    try {
      const response = await this.llm(sysPrompt, "诊断召回失败");
      const cleaned = response.trim()
        .replace(/```json\s*/i, "")
        .replace(/```\s*$/, "");
      const parsed = JSON.parse(cleaned);
      return {
        rootCauses: parsed.rootCauses ?? [],
        proposedAdjustments: clampAction(parsed.proposedAdjustments ?? {}),
        reasoning: parsed.reasoning ?? "",
      };
    } catch (err) {
      console.warn(`[auto-tuner] LLM diagnosis failed: ${err}, fallback to heuristic`);
      return this.heuristicDiagnose(failedCases, currentMetrics);
    }
  }

  /**
   * 启发式诊断（无 LLM 时的 fallback）
   */
  private heuristicDiagnose(
    failedCases: CaseResult[],
    currentMetrics: { p1: number; p3: number; mrr: number; f1: number; p99: number },
  ): DiagnosisResult {
    const causes: Array<{ cause: string; count: number; examples: string[] }> = [];
    const proposed: Partial<EvolveActionSpace> = {};

    // 启发式 1：召回节点少但 F1 低 → 增加 recallMaxNodes
    const lowF1Cases = failedCases.filter(c => c.f1 < 0.3 && c.recalledNodes < 5);
    if (lowF1Cases.length > 0) {
      causes.push({
        cause: "recall too few nodes (F1 low + recalled < 5)",
        count: lowF1Cases.length,
        examples: lowF1Cases.slice(0, 3).map(c => c.caseId),
      });
      proposed.recallMaxNodes = Math.min(15, this.currentAction.recallMaxNodes + 2);
    }

    // 启发式 2：延迟高 → 减少 pagerankIterations
    const slowCases = failedCases.filter(c => c.latencyMs > 1000);
    if (slowCases.length > failedCases.length / 2) {
      causes.push({
        cause: "high latency (>1000ms)",
        count: slowCases.length,
        examples: slowCases.slice(0, 3).map(c => c.caseId),
      });
      proposed.pagerankIterations = Math.max(10, this.currentAction.pagerankIterations - 5);
    }

    // 启发式 3：P@1 低但 P@3 高 → 排序问题，增加 pagerankDamping
    if (currentMetrics.p1 < 0.3 && currentMetrics.p3 > currentMetrics.p1 * 2) {
      causes.push({
        cause: "ranking issue (P@3 >> P@1)",
        count: 1,
        examples: [],
      });
      proposed.pagerankDamping = Math.min(0.95, this.currentAction.pagerankDamping + 0.05);
    }

    // 启发式 4：F1 整体低 → 增加 recallMaxDepth
    if (currentMetrics.f1 < 0.2) {
      causes.push({
        cause: "low overall F1",
        count: failedCases.length,
        examples: [],
      });
      proposed.recallMaxDepth = Math.min(4, this.currentAction.recallMaxDepth + 1);
    }

    return {
      rootCauses: causes,
      proposedAdjustments: proposed,
      reasoning: `heuristic diagnosis: ${causes.map(c => c.cause).join("; ") || "no clear cause"}`,
    };
  }

  /**
   * GUARD：revert-on-regression + explore-on-stagnation
   */
  private guard(
    currentMetrics: { p1: number; p3: number; mrr: number; f1: number; p99: number },
    proposedAction: EvolveActionSpace,
  ): { revert: boolean; reason: string } {
    // 如果有最佳指标，检查是否退步
    if (this.bestMetrics) {
      const regression = this.bestMetrics.p1 - currentMetrics.p1;
      if (regression > this.cfg.regressionThreshold) {
        return {
          revert: true,
          reason: `regression detected: P@1 dropped ${(regression * 100).toFixed(2)}pp (threshold=${(this.cfg.regressionThreshold * 100).toFixed(2)}pp)`,
        };
      }
    }

    // 检查配置是否与当前相同（无变化）
    const sameConfig = JSON.stringify(proposedAction) === JSON.stringify(this.currentAction);
    if (sameConfig) {
      return {
        revert: false,
        reason: "no change proposed",
      };
    }

    return {
      revert: false,
      reason: "accepted",
    };
  }

  /**
   * explore-on-stagnation：随机探索一个新维度
   */
  private exploreNewDimension(): Partial<EvolveActionSpace> {
    const keys = Object.keys(ACTION_BOUNDS) as Array<keyof EvolveActionSpace>;
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    const bounds = ACTION_BOUNDS[randomKey];
    const current = this.currentAction[randomKey] as number;
    const range = bounds.max - bounds.min;
    // 随机扰动 ±20%
    const delta = (Math.random() - 0.5) * 2 * range * 0.2;
    const newVal = Math.max(bounds.min, Math.min(bounds.max, current + delta));
    // 整数参数取整
    const isInteger = Number.isInteger(bounds.min) && Number.isInteger(bounds.max);
    return { [randomKey]: isInteger ? Math.round(newVal) : Math.round(newVal * 100) / 100 } as Partial<EvolveActionSpace>;
  }

  /** 填充缺失字段为当前值 */
  private fillAction(partial: Partial<EvolveActionSpace>): EvolveActionSpace {
    return {
      recallMaxNodes: partial.recallMaxNodes ?? this.currentAction.recallMaxNodes,
      recallMaxDepth: partial.recallMaxDepth ?? this.currentAction.recallMaxDepth,
      pagerankDamping: partial.pagerankDamping ?? this.currentAction.pagerankDamping,
      pagerankIterations: partial.pagerankIterations ?? this.currentAction.pagerankIterations,
      dedupThreshold: partial.dedupThreshold ?? this.currentAction.dedupThreshold,
      freshTailCount: partial.freshTailCount ?? this.currentAction.freshTailCount,
      vectorSearchTopK: partial.vectorSearchTopK ?? this.currentAction.vectorSearchTopK,
      compactTurnCount: partial.compactTurnCount ?? this.currentAction.compactTurnCount,
    };
  }

  /**
   * 序列化状态（用于持久化）
   */
  serialize(): string {
    return JSON.stringify({
      currentAction: this.currentAction,
      snapshots: this.snapshots,
      tuneRound: this.tuneRound,
      stagnationCount: this.stagnationCount,
      bestMetrics: this.bestMetrics,
    });
  }

  /** 反序列化 */
  deserialize(json: string): void {
    const data = JSON.parse(json);
    this.currentAction = data.currentAction;
    this.snapshots = data.snapshots ?? [];
    this.tuneRound = data.tuneRound ?? 0;
    this.stagnationCount = data.stagnationCount ?? 0;
    this.bestMetrics = data.bestMetrics ?? null;
  }
}

// ── 调优结果 ──────────────────────────────────────

export interface TuneCycleResult {
  applied: boolean;
  reason: string;
  tuneRound: number;
  metrics?: { p1: number; p3: number; mrr: number; f1: number; p99: number };
  proposedAction?: EvolveActionSpace;
  diagnosis?: DiagnosisResult;
  isImprovement?: boolean;
  durationMs?: number;
  benchmarkSummary?: string;
}

// ── 辅助函数 ──────────────────────────────────────

function extractMetrics(runResult: BenchmarkRunResult): { p1: number; p3: number; mrr: number; f1: number; p99: number } {
  return {
    p1: runResult.aggregate.avgP1,
    p3: runResult.aggregate.avgP3,
    mrr: runResult.aggregate.avgMrr,
    f1: runResult.aggregate.avgF1,
    p99: runResult.aggregate.avgP99,
  };
}

function collectFailedCases(reports: BenchmarkReport[]): CaseResult[] {
  const failed: CaseResult[] = [];
  for (const report of reports) {
    for (const cr of report.caseResults) {
      if (!cr.hitAt1) {
        failed.push(cr);
      }
    }
  }
  return failed;
}