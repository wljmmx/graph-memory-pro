/**
 * I-2 LLM 裁判反馈（v2.1.2 第二批）
 *
 * 判断召回节点是否真正被使用：
 * - Tier 1 启发式规则（本项目范围）：节点 id/name 出现在 assistant 回复中
 * - Tier 2/3 LLM 裁判：在 lcm-graph-extra 编排层（本项目不实现）
 *
 * G-6 冷启动策略：
 * - 前 judgeWarmupFeedbacks 次反馈：仅使用纯规则（不调用 LLM）
 * - 累计达标后启用 LLM（本项目仅保留接口）
 *
 * 异步运行，不阻塞召回
 */

import type { GmNode } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";

export interface JudgeConfig {
  enabled: boolean;
  asyncMode: boolean;            // 异步运行（默认 true）
  judgeWarmupFeedbacks: number;  // 冷启动阈值，默认 50
  /** 启发式匹配模式：id / name / both */
  heuristicMatch: "id" | "name" | "both";
}

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  enabled: true,
  asyncMode: true,
  judgeWarmupFeedbacks: 50,
  heuristicMatch: "both",
};

export interface JudgeResult {
  usedNodeIds: string[];
  unusedNodeIds: string[];
  matchedBy: "heuristic" | "llm" | "cold-start";
  coldStart: boolean;
}

export interface JudgeFeedback {
  query: string;
  recalledNodeIds: string[];
  usedNodeIds: string[];
  unusedNodeIds: string[];
  timestamp: number;
  sessionId?: string;
  matchedBy: "heuristic" | "llm" | "cold-start";
}

/**
 * 裁判管理器
 *
 * 维护一个累计反馈计数器，决定是否进入冷启动期
 */
export class JudgeManager {
  private feedbackCount = 0;
  private readonly cfg: JudgeConfig;
  private readonly llm?: CompleteFn;

  constructor(cfg?: Partial<JudgeConfig>, llm?: CompleteFn) {
    this.cfg = { ...DEFAULT_JUDGE_CONFIG, ...cfg };
    this.llm = llm;
  }

  /**
   * 判断召回的节点是否被使用
   *
   * @param recalledNodes 召回的节点列表
   * @param assistantReply assistant 的回复内容
   * @returns 判断结果
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
      };
    }

    // 冷启动期：仅启发式规则
    if (this.feedbackCount < this.cfg.judgeWarmupFeedbacks) {
      return this.heuristicJudge(recalledNodes, assistantReply, true);
    }

    // 已过冷启动期：本版本仍使用启发式（LLM 接口预留）
    // 注：T1-3 路线图明确 Tier 2/3 在 lcm-graph-extra，本项目仅 Tier 1
    return this.heuristicJudge(recalledNodes, assistantReply, false);
  }

  /**
   * 启发式裁判（Tier 1）
   *
   * 规则：节点 id/name 在 assistant 回复中出现 → used，否则 unused
   */
  private heuristicJudge(
    nodes: GmNode[],
    reply: string,
    coldStart: boolean,
  ): JudgeResult {
    const replyLower = reply.toLowerCase();
    const usedNodeIds: string[] = [];
    const unusedNodeIds: string[] = [];

    for (const node of nodes) {
      let matched = false;
      if (this.cfg.heuristicMatch === "id" || this.cfg.heuristicMatch === "both") {
        if (replyLower.includes(node.id.toLowerCase())) {
          matched = true;
        }
      }
      if (!matched && (this.cfg.heuristicMatch === "name" || this.cfg.heuristicMatch === "both")) {
        // 名称匹配：要求至少 3 字符，避免误匹配
        if (node.name.length >= 3 && replyLower.includes(node.name.toLowerCase())) {
          matched = true;
        }
      }
      if (matched) {
        usedNodeIds.push(node.id);
      } else {
        unusedNodeIds.push(node.id);
      }
    }

    return {
      usedNodeIds,
      unusedNodeIds,
      matchedBy: coldStart ? "cold-start" : "heuristic",
      coldStart,
    };
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

  /**
   * 处理一轮对话的反馈
   *
   * 调用方可选传入 onFeedback 回调，用于在反馈判定完成后执行持久化等操作。
   * - 同步模式：await judge → 调用 onFeedback → 返回 JudgeFeedback
   * - 异步模式：fire-and-forget 启动后台任务（任务内部仍会调用 onFeedback），立即返回 null
   *
   * 这样无论同步/异步模式，onFeedback（持久化 + 计数 + M 更新）都会被执行，
   * 修复了旧实现中 asyncMode=true 时整条反馈链路断裂的致命缺陷。
   *
   * @param query 用户查询
   * @param recalledNodes 召回的节点
   * @param assistantReply assistant 回复
   * @param sessionId 会话 ID（可选）
   * @param onFeedback 反馈完成回调（用于 I-3 持久化 + 计数 + L-1 M 更新）
   * @returns 同步模式返回 JudgeFeedback；异步模式返回 null（但 onFeedback 仍会被调用）
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
        .catch(err => console.warn(`[graph-memory-pro] judge async failed: ${err}`));
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
        console.warn(`[graph-memory-pro] feedback handler failed: ${err}`);
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
