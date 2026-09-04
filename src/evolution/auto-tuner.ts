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
import type { GraphHealthScore } from "../graph/maintenance/health.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import type { Driver } from "neo4j-driver";
import type { Recaller } from "../recaller/recall.ts";
import type { BenchmarkReport, CaseResult, BenchmarkDataset } from "../benchmark/types.ts";
import { runBenchmark, formatAggregateReport, type BenchmarkRunResult } from "../benchmark/runner.ts";
import { getNodeCount } from "../store/store.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("auto-tuner");

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
  // v2.5.4: 后台资源节流参数（autoTurn 调优纳入）
  interimTurnsThreshold: number;   // 5-30 轮：中间轮 assistant 文本提取的轮数节流阈值
  extractorIntervalMs: number;     // 900_000-3_600_000 ms (15min~60min)：后台提取定时器间隔
  // v2.6.0: 稀疏图自愈参数（与 sparseHeal 静态配置联动，调优器启用时覆盖）
  edgeInferThreshold: number;        // 0.60-0.95 补边相似度下限
  selfHealMaxEdgesPerCycle: number;  // 10-200 每周期补边上限
  isolatedMergeThreshold: number;    // 0.75-0.98 孤立节点合并阈值
  graphScoreAlertThreshold: number;  // 40-80 图谱评分告警阈值
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
  // v2.5.4: 后台提取相关参数范围
  interimTurnsThreshold: { min: 5, max: 30 },
  extractorIntervalMs: { min: 15 * 60 * 1000, max: 60 * 60 * 1000 }, // 15min ~ 60min
  // v2.6.0: 稀疏自愈参数范围
  edgeInferThreshold: { min: 0.6, max: 0.95 },
  selfHealMaxEdgesPerCycle: { min: 10, max: 200 },
  isolatedMergeThreshold: { min: 0.75, max: 0.98 },
  graphScoreAlertThreshold: { min: 40, max: 80 },
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
    // v2.5.4: 后台提取相关参数，默认值与运行时常量一致
    interimTurnsThreshold: cfg.background?.interimTurnsThreshold ?? 15,
    extractorIntervalMs: cfg.background?.extractorIntervalMs ?? 20 * 60 * 1000,
    // v2.6.0: 稀疏自愈参数，默认与 sparseHeal 静态配置一致
    edgeInferThreshold: cfg.sparseHeal?.inferSimMin ?? 0.7,
    selfHealMaxEdgesPerCycle: cfg.sparseHeal?.maxEdgesPerCycle ?? 50,
    isolatedMergeThreshold: cfg.sparseHeal?.mergeSimThreshold ?? 0.85,
    graphScoreAlertThreshold: cfg.sparseHeal?.scoreThreshold ?? 60,
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
    // v2.5.4: 后台提取相关参数写入 background 子对象
    background: {
      ...(cfg.background ?? {}),
      interimTurnsThreshold: Math.round(action.interimTurnsThreshold),
      extractorIntervalMs: Math.round(action.extractorIntervalMs),
    },
    // v2.6.0: 稀疏自愈参数写入 sparseHeal
    sparseHeal: {
      ...(cfg.sparseHeal ?? {}),
      inferSimMin: action.edgeInferThreshold,
      maxEdgesPerCycle: Math.round(action.selfHealMaxEdgesPerCycle),
      mergeSimThreshold: action.isolatedMergeThreshold,
      scoreThreshold: Math.round(action.graphScoreAlertThreshold),
    },
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
  warmupFeedbacks: 40,
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
  /** v2.6.0: 最近一次图谱健康评分（供稀疏诊断） */
  private lastGraphScore: GraphHealthScore | null = null;

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
      // v2.5.4: 后台提取相关参数默认值
      interimTurnsThreshold: 15,
      extractorIntervalMs: 20 * 60 * 1000, // 20min
      // v2.6.0: 稀疏自愈参数初始值
      edgeInferThreshold: 0.7,
      selfHealMaxEdgesPerCycle: 50,
      isolatedMergeThreshold: 0.85,
      graphScoreAlertThreshold: 60,
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

  /** v2.6.0: 注入最近一次图谱健康评分（自愈阶段在调优前调用） */
  setGraphHealthScore(score: GraphHealthScore | null): void {
    this.lastGraphScore = score;
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
    // v2.3.6 fix: 透传 embedFn，使 buildGraph 写入的 prebuilt 节点带 embedding，
    // 否则向量召回（vectorSearchWithScore）命不中仅靠 FTS，调优信号偏弱。
    embedFn?: EmbedFn,
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
    //
    // v2.3.5 fix: buildGraph 策略（彻底修复 P@1=0%）：
    //   先探测会实际加载哪些数据集。如果包含 Sample 数据集或任何带有 prebuiltNodes/prebuiltEdges
    //   的数据集，**强制 buildGraph=true**，无视当前 graph 节点数量。
    //
    //   理由：Sample 等内置/小数据集的 expectedNodeIds 是人为预置的（如 "Neo4j",
    //   "graph-memory-pro"），只有先通过 prebuiltNodes 写入 graph 后才能被召回。
    //   而 gm_bootstrap 等写入的 100+ 真实节点名字完全不同，不建图则 expectedNodeIds 永不匹配，
    //   指标恒为 0%，调优器也永远在错误的信号下瞎调。
    //
    //   仅当数据集**完全是** LoCoMo/LongMemEval 等真实生产对话数据集（无 prebuiltNodes，
    //   靠 conversation 提取）且 nodeCount 充足时，才 buildGraph=false 评估真实召回。
    log.info(`round ${this.tuneRound}: EVALUATE`);
    let nodeCount = 0;
    try {
      nodeCount = driver ? await getNodeCount(driver) : 0;
    } catch { /* ignore */ }
    log.info(`current graph node count: ${nodeCount}`);

    // 探测实际数据集（无副作用，仅读文件/构造内置样本，耗时可忽略）
    const { loadAllDatasets } = await import("../benchmark/datasets.ts");
    let probedDatasets: BenchmarkDataset[];
    try {
      probedDatasets = await loadAllDatasets();
    } catch {
      probedDatasets = [];
    }

    // 判断是否有需要 buildGraph 的数据集：
    //   - 名称为 "Sample"（即 getBuiltinSampleDataset）
    //   - 或任何 case 里带 prebuiltNodes/prebuiltEdges
    const hasSampleDataset = probedDatasets.some((d: BenchmarkDataset) =>
      d.name === "Sample" ||
      d.cases.some((c) => (c.prebuiltNodes && c.prebuiltNodes.length > 0) || (c.prebuiltEdges && c.prebuiltEdges.length > 0)),
    );
    const SAMPLE_BUILDGRAPH_THRESHOLD = 50;
    let forceBuildGraph: boolean;
    let forceReason: string;
    if (hasSampleDataset) {
      forceBuildGraph = true;
      forceReason = "probed dataset contains Sample or cases with prebuiltNodes/Edges, MUST buildGraph to inject expected nodes (regardless of current graph size)";
    } else if (nodeCount < SAMPLE_BUILDGRAPH_THRESHOLD) {
      forceBuildGraph = true;
      forceReason = `node count (${nodeCount}) < ${SAMPLE_BUILDGRAPH_THRESHOLD}, build graph from conversations before evaluating`;
    } else {
      forceBuildGraph = false;
      forceReason = `real-world dataset + node count (${nodeCount}) >= ${SAMPLE_BUILDGRAPH_THRESHOLD}, evaluating real graph recall (no graph rebuild)`;
    }
    log.info(`buildGraph decision: ${forceBuildGraph} — ${forceReason}`);
    if (!forceBuildGraph && probedDatasets.length === 0) {
      log.warn("no dataset available, benchmark will be empty");
    }

    const evalResult = await runBenchmark(recaller, driver, currentCfg, {
      maxCases: this.cfg.benchmarkMaxCases,
      buildGraph: forceBuildGraph,
      llm: this.llm ?? undefined,
      embedFn,
    });

    const currentMetrics = extractMetrics(evalResult);
    const failedCases = collectFailedCases(evalResult.reports);

    // 2. DIAGNOSE：LLM 诊断失败案例
    log.info(`round ${this.tuneRound}: DIAGNOSE (${failedCases.length} failures)`);
    const diagnosis = await this.diagnose(failedCases, currentMetrics);

    // 3. PROPOSE：应用建议的调整
    log.info(`round ${this.tuneRound}: PROPOSE`);
    const proposedAction = { ...this.currentAction, ...diagnosis.proposedAdjustments };
    const clampedAction = clampAction(proposedAction) as EvolveActionSpace;
    const fullClamped = this.fillAction(clampedAction);

    // 4. GUARD：revert-on-regression + explore-on-stagnation
    log.info(`round ${this.tuneRound}: GUARD`);
    const guardResult = this.guard(currentMetrics, fullClamped);

    if (guardResult.revert) {
      // 回退到上一稳定配置
      const lastStable = this.snapshots.filter(s => s.stable).pop();
      if (lastStable) {
        this.currentAction = lastStable.action;
        log.info(`reverted to snapshot v${lastStable.version}`);
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

    // 热应用到 Recaller：将调优后的参数直接写入运行时配置，无需重启
    const appliedCfg = applyActionSpace(currentCfg, this.currentAction);
    recaller.updateConfig(appliedCfg);

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
      log.info(`stagnation detected (${this.stagnationCount} rounds), exploring new dimensions`);
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
      const response = await this.llm(sysPrompt, "诊断召回失败", undefined, "diagnose");
      const cleaned = ((response ?? "") as string)
        .trim()
        .replace(/```json\s*/i, "")
        .replace(/```\s*$/, "");
      const parsed = JSON.parse(cleaned);
      return {
        rootCauses: parsed.rootCauses ?? [],
        proposedAdjustments: clampAction(parsed.proposedAdjustments ?? {}),
        reasoning: parsed.reasoning ?? "",
      };
    } catch (err) {
      log.warn(`LLM diagnosis failed: ${err}, fallback to heuristic`);
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

    // 启发式 5（v2.6.0）：图谱稀疏 → 收紧补边阈值、提高补边上限、放宽合并阈值
    // 依赖注入：runTuneCycle 传入 graphScore 时生效（无评分时跳过）
    if (this.lastGraphScore !== null && this.lastGraphScore.score < this.currentAction.graphScoreAlertThreshold) {
      causes.push({
        cause: "graph sparse (health score below threshold)",
        count: 1,
        examples: [`score=${this.lastGraphScore.score}`],
      });
      proposed.edgeInferThreshold = Math.max(0.6, this.currentAction.edgeInferThreshold - 0.05);
      proposed.selfHealMaxEdgesPerCycle = Math.min(200, this.currentAction.selfHealMaxEdgesPerCycle + 25);
      proposed.isolatedMergeThreshold = Math.max(0.75, this.currentAction.isolatedMergeThreshold - 0.02);
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
      // v2.5.4: 后台提取相关参数填充
      interimTurnsThreshold: partial.interimTurnsThreshold ?? this.currentAction.interimTurnsThreshold,
      extractorIntervalMs: partial.extractorIntervalMs ?? this.currentAction.extractorIntervalMs,
      // v2.6.0: 稀疏自愈参数填充
      edgeInferThreshold: partial.edgeInferThreshold ?? this.currentAction.edgeInferThreshold,
      selfHealMaxEdgesPerCycle: partial.selfHealMaxEdgesPerCycle ?? this.currentAction.selfHealMaxEdgesPerCycle,
      isolatedMergeThreshold: partial.isolatedMergeThreshold ?? this.currentAction.isolatedMergeThreshold,
      graphScoreAlertThreshold: partial.graphScoreAlertThreshold ?? this.currentAction.graphScoreAlertThreshold,
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