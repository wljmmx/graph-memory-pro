/**
 * I-2 LLM 裁判反馈（v2.2.0 重构，支持 Tier 1/2/3）
 *
 * 三层裁判策略：
 * - Tier 1 启发式规则（默认，本项目自带）：节点 id/name 出现在 assistant 回复中
 * - Tier 2 LLM 裁判（本项目内置，可选启用）：构造 prompt 让 LLM 输出 JSON
 * - Tier 3 自定义策略（外部注入点）：通过 registerStrategy() 注册
 *
 * G-6 冷启动策略：
 * - 前 judgeWarmupFeedbacks 次反馈：仅使用 Tier 1（不调用 LLM）
 * - 累计达标后根据 cfg.tier 启用对应策略
 *
 * Tier 2 安全护栏：
 * - LLM 调用失败 / 超时 / 输出无法解析 → fallback 到 Tier 1
 * - 节点数超过 llmJudgeMaxNodes → 截断 + 警告
 * - matchedBy 字段区分 "heuristic" / "llm" / "cold-start"
 *
 * 异步运行，不阻塞召回
 */

import type { GmNode } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("judge");

export type JudgeTier = 1 | 2 | 3;
export type JudgeMatchedBy = "heuristic" | "llm" | "cold-start" | "custom";

export interface JudgeConfig {
  enabled: boolean;
  asyncMode: boolean;            // 异步运行（默认 true）
  judgeWarmupFeedbacks: number;  // 冷启动阈值，默认 50
  /** 启发式匹配模式：id / name / both */
  heuristicMatch: "id" | "name" | "both";
  /** 裁判层级（v2.2.0 新增） */
  tier: JudgeTier;
  /** Tier 2 LLM 裁判单次最大节点数（v2.2.0 新增，默认 10） */
  llmJudgeMaxNodes: number;
  /** Tier 2 LLM 裁判超时（ms，默认 8000） */
  llmJudgeTimeoutMs: number;
  /** 自定义策略名称（Tier 3，需先 registerStrategy 注册） */
  customStrategy?: string;
}

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  enabled: true,
  asyncMode: true,
  judgeWarmupFeedbacks: 50,
  heuristicMatch: "both",
  tier: 1,
  llmJudgeMaxNodes: 10,
  llmJudgeTimeoutMs: 8000,
};

export interface JudgeResult {
  usedNodeIds: string[];
  unusedNodeIds: string[];
  matchedBy: JudgeMatchedBy;
  coldStart: boolean;
  /** 实际使用的策略 tier（fallback 时可能与配置不同） */
  effectiveTier?: JudgeTier;
}

export interface JudgeFeedback {
  query: string;
  recalledNodeIds: string[];
  usedNodeIds: string[];
  unusedNodeIds: string[];
  timestamp: number;
  sessionId?: string;
  matchedBy: JudgeMatchedBy;
}

// ── 策略接口（v2.2.0 新增 Tier 2/3 扩展点） ──────────────────────

/**
 * 裁判策略抽象接口
 *
 * 第三方可实现此接口注入自定义裁判逻辑（Tier 3）。
 * 通过 JudgeManager.registerStrategy(name, strategy) 注册。
 */
export interface JudgeStrategy {
  readonly tier: JudgeTier;
  judge(nodes: GmNode[], assistantReply: string): Promise<JudgeResult>;
}

// ── Tier 1: 启发式策略 ──────────────────────────────────────

export class HeuristicJudgeStrategy implements JudgeStrategy {
  readonly tier: JudgeTier = 1;
  private readonly matchMode: "id" | "name" | "both";

  constructor(matchMode: "id" | "name" | "both" = "both") {
    this.matchMode = matchMode;
  }

  async judge(nodes: GmNode[], reply: string): Promise<JudgeResult> {
    const replyLower = reply.toLowerCase();
    const usedNodeIds: string[] = [];
    const unusedNodeIds: string[] = [];

    for (const node of nodes) {
      let matched = false;
      if (this.matchMode === "id" || this.matchMode === "both") {
        if (replyLower.includes(node.id.toLowerCase())) matched = true;
      }
      if (!matched && (this.matchMode === "name" || this.matchMode === "both")) {
        // 名称匹配：要求至少 3 字符，避免误匹配
        if (node.name.length >= 3 && replyLower.includes(node.name.toLowerCase())) {
          matched = true;
        }
      }
      if (matched) usedNodeIds.push(node.id);
      else unusedNodeIds.push(node.id);
    }

    return {
      usedNodeIds,
      unusedNodeIds,
      matchedBy: "heuristic",
      coldStart: false,
      effectiveTier: 1,
    };
  }
}

// ── Tier 2: LLM 裁判策略 ──────────────────────────────────────

/**
 * LLM 裁判 prompt 模板（v2.2.0 Tier 2）
 *
 * 让 LLM 输出 JSON：
 * { "used": ["nodeId1", ...], "reasoning": "..." }
 */
function buildLlmJudgePrompt(nodes: GmNode[], reply: string): string {
  const nodesBrief = nodes.map(n => ({
    id: n.id,
    name: n.name,
    type: n.type,
    description: (n.description ?? "").slice(0, 200),
  }));
  return `你是 graph-memory-pro 的召回节点使用判定专家。

任务：判断以下召回的节点中，哪些被 assistant 回复实际"使用"了（被引用/被展开/作为回答依据）。

召回节点列表（JSON）：
${JSON.stringify(nodesBrief, null, 2)}

Assistant 回复（截断到 2000 字符）：
${reply.slice(0, 2000)}

判定规则：
- "使用" 的标准：回复中明确引用了节点的内容、名称作为论据、或展开其描述
- 仅"提及"节点名但未实质使用不算"使用"
- 不在回复中出现的节点视为未使用

输出格式（仅输出 JSON，不要其他内容）：
{
  "used": ["nodeId1", "nodeId2"],
  "reasoning": "简短说明判定依据"
}`;
}

export class LlmJudgeStrategy implements JudgeStrategy {
  readonly tier: JudgeTier = 2;
  private readonly llm: CompleteFn;
  private readonly maxNodes: number;
  private readonly timeoutMs: number;
  private readonly fallback: HeuristicJudgeStrategy;

  constructor(llm: CompleteFn, opts?: { maxNodes?: number; timeoutMs?: number; matchMode?: "id" | "name" | "both" }) {
    this.llm = llm;
    this.maxNodes = opts?.maxNodes ?? 10;
    this.timeoutMs = opts?.timeoutMs ?? 8000;
    this.fallback = new HeuristicJudgeStrategy(opts?.matchMode ?? "both");
  }

  async judge(nodes: GmNode[], reply: string): Promise<JudgeResult> {
    // 节点过多 → 截断（仅判定前 maxNodes 个）
    const targetNodes = nodes.length > this.maxNodes ? nodes.slice(0, this.maxNodes) : nodes;
    if (targetNodes.length === 0) {
      return { usedNodeIds: [], unusedNodeIds: [], matchedBy: "llm", coldStart: false, effectiveTier: 2 };
    }

    try {
      const prompt = buildLlmJudgePrompt(targetNodes, reply);
      const response = await withTimeout(this.llm(prompt, "判断召回节点是否被使用"), this.timeoutMs);
      const cleaned = response.trim()
        .replace(/```json\s*/i, "")
        .replace(/```\s*$/g, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      const usedSet = new Set<string>((parsed.used ?? []).filter((x: any) => typeof x === "string"));

      const usedNodeIds: string[] = [];
      const unusedNodeIds: string[] = [];
      for (const n of targetNodes) {
        if (usedSet.has(n.id)) usedNodeIds.push(n.id);
        else unusedNodeIds.push(n.id);
      }
      // 未参与 LLM 判定的节点（被截断的）→ 走启发式快速判断
      if (nodes.length > this.maxNodes) {
        const overflow = nodes.slice(this.maxNodes);
        const overflowResult = await this.fallback.judge(overflow, reply);
        usedNodeIds.push(...overflowResult.usedNodeIds);
        unusedNodeIds.push(...overflowResult.unusedNodeIds);
      }

      return {
        usedNodeIds,
        unusedNodeIds,
        matchedBy: "llm",
        coldStart: false,
        effectiveTier: 2,
      };
    } catch (err) {
      // LLM 失败 / 超时 / 解析失败 → fallback 到 Tier 1 启发式
      log.warn("Tier 2 LLM judge failed, fallback to Tier 1", { error: String(err) });
      const result = await this.fallback.judge(nodes, reply);
      return { ...result, effectiveTier: 1 };
    }
  }
}

// ── Tier 3: 自定义策略容器 ──────────────────────────────────────

/**
 * Tier 3 自定义策略容器
 *
 * 包装外部注入的策略，使其符合 JudgeStrategy 接口。
 * 策略注册后通过 customStrategy 名称引用。
 */
class CustomJudgeStrategy implements JudgeStrategy {
  readonly tier: JudgeTier = 3;
  private readonly name: string;
  private readonly fn: (nodes: GmNode[], reply: string) => Promise<JudgeResult>;

  constructor(name: string, fn: (nodes: GmNode[], reply: string) => Promise<JudgeResult>) {
    this.name = name;
    this.fn = fn;
  }

  async judge(nodes: GmNode[], reply: string): Promise<JudgeResult> {
    try {
      const result = await this.fn(nodes, reply);
      return { ...result, matchedBy: "custom", effectiveTier: 3, coldStart: false };
    } catch (err) {
      // 自定义策略失败 → 不 fallback（调用方应自行处理），仅抛出
      throw new Error(`Tier 3 custom strategy "${this.name}" failed: ${err}`);
    }
  }
}

// ── 工具：带超时的 Promise ──────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Tier 2 LLM judge timeout after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

// ── 裁判管理器（v2.2.0 重构，支持 Tier 1/2/3 分发） ──────────────

/**
 * 裁判管理器
 *
 * 维护一个累计反馈计数器，决定是否进入冷启动期。
 * v2.2.0：根据 cfg.tier 分发到对应策略
 */
export class JudgeManager {
  private feedbackCount = 0;
  private readonly cfg: JudgeConfig;
  private readonly llm?: CompleteFn;
  private readonly strategies = new Map<string, JudgeStrategy>();
  private readonly heuristicStrategy: HeuristicJudgeStrategy;
  private llmStrategy: LlmJudgeStrategy | null = null;

  constructor(cfg?: Partial<JudgeConfig>, llm?: CompleteFn) {
    this.cfg = { ...DEFAULT_JUDGE_CONFIG, ...cfg };
    this.llm = llm;
    this.heuristicStrategy = new HeuristicJudgeStrategy(this.cfg.heuristicMatch);
    // 内置 Tier 1
    this.strategies.set("heuristic", this.heuristicStrategy);
    // 若有 LLM 且 tier >= 2，预构建 Tier 2 策略
    if (llm && this.cfg.tier >= 2) {
      this.llmStrategy = new LlmJudgeStrategy(llm, {
        maxNodes: this.cfg.llmJudgeMaxNodes,
        timeoutMs: this.cfg.llmJudgeTimeoutMs,
        matchMode: this.cfg.heuristicMatch,
      });
      this.strategies.set("llm", this.llmStrategy);
    }
  }

  /**
   * 注册自定义策略（Tier 3 扩展点）
   *
   * @param name 策略名称（用于 cfg.customStrategy 引用）
   * @param fn 裁判函数
   */
  registerStrategy(name: string, fn: (nodes: GmNode[], reply: string) => Promise<JudgeResult>): void {
    const strategy = new CustomJudgeStrategy(name, fn);
    this.strategies.set(name, strategy);
    log.info("registered custom judge strategy", { name });
  }

  /**
   * 判断召回的节点是否被使用
   *
   * 分发逻辑：
   * 1. 未启用 → 返回空
   * 2. 冷启动期 → 始终用 Tier 1 启发式（不调用 LLM）
   * 3. 热启动期：
   *    - tier=1 → 启发式
   *    - tier=2 → LLM 裁判（失败 fallback 到 Tier 1）
   *    - tier=3 → 自定义策略
   */
  async judge(
    recalledNodes: GmNode[],
    assistantReply: string,
  ): Promise<JudgeResult> {
    if (!this.cfg.enabled) {
      return {
        usedNodeIds: [],
        unusedNodeIds: [],
        matchedBy: "heuristic",
        coldStart: true,
        effectiveTier: 1,
      };
    }

    // 冷启动期：仅启发式规则
    if (this.feedbackCount < this.cfg.judgeWarmupFeedbacks) {
      const result = await this.heuristicStrategy.judge(recalledNodes, assistantReply);
      return { ...result, matchedBy: "cold-start", coldStart: true };
    }

    // 热启动期：按 tier 分发
    if (this.cfg.tier === 1) {
      return this.heuristicStrategy.judge(recalledNodes, assistantReply);
    }

    if (this.cfg.tier === 2) {
      if (!this.llmStrategy) {
        // 配置了 tier=2 但未注入 LLM → 降级到 Tier 1 + 警告
        log.warn("tier=2 but no LLM available, fallback to tier 1");
        const result = await this.heuristicStrategy.judge(recalledNodes, assistantReply);
        return { ...result, effectiveTier: 1 };
      }
      return this.llmStrategy.judge(recalledNodes, assistantReply);
    }

    if (this.cfg.tier === 3) {
      const strategyName = this.cfg.customStrategy;
      if (!strategyName) {
        throw new Error("tier=3 but customStrategy not configured");
      }
      const strategy = this.strategies.get(strategyName);
      if (!strategy) {
        throw new Error(`custom strategy "${strategyName}" not registered`);
      }
      return strategy.judge(recalledNodes, assistantReply);
    }

    // 不应到达
    return this.heuristicStrategy.judge(recalledNodes, assistantReply);
  }

  /** 累计反馈数（由 I-3 持久化成功后调用） */
  incrementFeedback(): void {
    this.feedbackCount++;
  }

  /** 获取当前反馈计数 */
  getFeedbackCount(): number {
    return this.feedbackCount;
  }

  /** 是否在冷启动期 */
  isColdStart(): boolean {
    return this.feedbackCount < this.cfg.judgeWarmupFeedbacks;
  }

  /** 获取当前配置 */
  getConfig(): JudgeConfig {
    return { ...this.cfg };
  }

  /** 获取已注册策略列表（用于健康检查/调试） */
  listStrategies(): string[] {
    return Array.from(this.strategies.keys());
  }

  /**
   * 处理一轮对话的反馈
   *
   * 调用方可选传入 onFeedback 回调，用于在反馈判定完成后执行持久化等操作。
   * - 同步模式：await judge → 调用 onFeedback → 返回 JudgeFeedback
   * - 异步模式：fire-and-forget 启动后台任务（任务内部仍会调用 onFeedback），立即返回 null
   *
   * 这样无论同步/异步模式，onFeedback（持久化 + 计数 + M 更新）都会被执行，
   * 修复了旧实现中 asyncMode=true 时整条反馈链路断裂的致命缺陷。
   */
  async processTurn(
    query: string,
    recalledNodes: GmNode[],
    assistantReply: string,
    sessionId?: string,
    onFeedback?: (feedback: JudgeFeedback) => Promise<void>,
  ): Promise<JudgeFeedback | null> {
    if (!this.cfg.enabled) return null;

    // 异步模式：fire-and-forget，但内部仍会执行 onFeedback
    if (this.cfg.asyncMode) {
      this.processTurnAsync(query, recalledNodes, assistantReply, sessionId, onFeedback)
        .catch(err => log.warn("judge async failed", { error: String(err) }));
      return null;
    }

    return this.processTurnAsync(query, recalledNodes, assistantReply, sessionId, onFeedback);
  }

  private async processTurnAsync(
    query: string,
    recalledNodes: GmNode[],
    assistantReply: string,
    sessionId?: string,
    onFeedback?: (feedback: JudgeFeedback) => Promise<void>,
  ): Promise<JudgeFeedback> {
    const result = await this.judge(recalledNodes, assistantReply);
    const feedback: JudgeFeedback = {
      query,
      recalledNodeIds: recalledNodes.map(n => n.id),
      usedNodeIds: result.usedNodeIds,
      unusedNodeIds: result.unusedNodeIds,
      timestamp: Date.now(),
      sessionId,
      matchedBy: result.matchedBy,
    };
    // 无论同步/异步，都执行 onFeedback（持久化 + 计数 + M 更新）
    if (onFeedback) {
      try {
        await onFeedback(feedback);
      } catch (err) {
        log.warn("feedback handler failed", { error: String(err) });
      }
    }
    return feedback;
  }
}

/**
 * G-6 冷启动策略工具函数
 */

export interface WarmupConfig {
  /** M 矩阵冷启动阈值（累计反馈数） */
  warmupFeedbacks: number;
  /** 裁判冷启动阈值 */
  judgeWarmupFeedbacks: number;
}

export const DEFAULT_WARMUP_CONFIG: WarmupConfig = {
  warmupFeedbacks: 100,
  judgeWarmupFeedbacks: 50,
};

/**
 * 判断是否处于 M 矩阵冷启动期
 *
 * 冷启动期：
 * - M = 单位矩阵（无变换）
 * - 召回使用 BM25 + 向量搜索混合（BM25 0.4 / 向量 0.6）
 * - 累计 warmupFeedbacks 次反馈后开始训练 M
 */
export function isMatrixColdStart(feedbackCount: number, cfg?: WarmupConfig): boolean {
  const threshold = cfg?.warmupFeedbacks ?? DEFAULT_WARMUP_CONFIG.warmupFeedbacks;
  return feedbackCount < threshold;
}

/**
 * 获取冷启动期 BM25 / 向量搜索权重
 *
 * 冷启动：BM25 0.4 + 向量 0.6
 * 热启动：完全由 M 矩阵变换（不使用此函数）
 */
export function getColdStartSearchWeights(): { bm25: number; vector: number } {
  return { bm25: 0.4, vector: 0.6 };
}
