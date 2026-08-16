/**
 * v2.3.5: 会话级召回缓存 + 展开信号记录
 *
 * 用于自动反馈采集（方案 A）：
 *   - registerMemoryCorpusSupplement.search() 命中时记录召回的节点 ID
 *   - registerMemoryCorpusSupplement.get() 命中时记录"展开查看"强使用信号
 *   - agent_end 钩子触发时 consume() 取出该 session 的召回记录，
 *     自动调用 JudgeManager.processTurn 完成反馈判定（Tier 1 启发式，零 LLM 成本）
 *
 * 设计要点：
 *   - LRU 限制：最多 MAX_SESSIONS 个 session，每 session 最多 MAX_RECORDS 条召回
 *   - consume() 后清除该 session 记录，避免重复采集
 *   - TTL 兜底：超过 SESSION_TTL_MS 未访问的记录自动淘汰，防止内存泄漏
 *   - 线程模型：单进程内存，无需持久化（反馈本身已持久化到 Neo4j）
 */

import { createLogger } from "../logger.ts";

const log = createLogger("recall-cache");

const MAX_SESSIONS = 256;
const MAX_RECORDS_PER_SESSION = 5;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟

export interface RecallRecord {
  /** 触发召回的用户查询 */
  query: string;
  /** 召回的节点 ID 列表 */
  nodeIds: string[];
  /** 召回发生时间戳 */
  timestamp: number;
}

export interface ConsumedRecall {
  /** 最近一次召回的 query（用于 JudgeManager 判定） */
  query: string;
  /** 该 session 累计召回的去重节点 ID */
  nodeIds: string[];
  /** 该 session 通过 get() 展开过的节点 ID（强使用信号） */
  getNodeIds: string[];
  /** 该 session 召回次数 */
  recallCount: number;
}

interface SessionEntry {
  records: RecallRecord[];
  getNodeIds: Set<string>;
  lastAccess: number;
}

/**
 * 会话级召回缓存
 *
 * 并发安全说明：Node.js 单线程事件循环，Map 操作原子；但 consume() 涉及
 * 多步读写，agent_end 串行触发，无需加锁。
 */
export class SessionRecallCache {
  private readonly sessions = new Map<string, SessionEntry>();

  /**
   * 记录一次召回
   *
   * @param sessionKey 会话标识（agentSessionKey / sessionId）
   * @param query 触发召回的用户查询
   * @param nodeIds 召回的节点 ID 列表
   */
  recordRecall(sessionKey: string, query: string, nodeIds: string[]): void {
    if (!sessionKey || nodeIds.length === 0) return;

    let entry = this.sessions.get(sessionKey);
    if (!entry) {
      entry = { records: [], getNodeIds: new Set(), lastAccess: Date.now() };
      this.sessions.set(sessionKey, entry);
      this.evictIfNeeded();
    }

    entry.records.push({ query, nodeIds: [...nodeIds], timestamp: Date.now() });
    entry.lastAccess = Date.now();

    // 限制每 session 记录数（保留最近 N 次）
    if (entry.records.length > MAX_RECORDS_PER_SESSION) {
      entry.records = entry.records.slice(-MAX_RECORDS_PER_SESSION);
    }
  }

  /**
   * 记录一次 get() 展开（强使用信号）
   *
   * @param sessionKey 会话标识
   * @param nodeId 被展开查看的节点 ID
   */
  recordGet(sessionKey: string, nodeId: string): void {
    if (!sessionKey || !nodeId) return;

    let entry = this.sessions.get(sessionKey);
    if (!entry) {
      entry = { records: [], getNodeIds: new Set(), lastAccess: Date.now() };
      this.sessions.set(sessionKey, entry);
      this.evictIfNeeded();
    }
    entry.getNodeIds.add(nodeId);
    entry.lastAccess = Date.now();
  }

  /**
   * 消费并清除该 session 的召回记录
   *
   * agent_end 钩子调用：取出累计召回去重节点 + get 命中节点，然后清除该 session。
   * 消费后不再保留，避免同一 turn 重复采集。
   *
   * @param sessionKey 会话标识
   * @returns 召回汇总；若无记录返回 null
   */
  consume(sessionKey: string): ConsumedRecall | null {
    if (!sessionKey) return null;
    const entry = this.sessions.get(sessionKey);
    if (!entry || entry.records.length === 0) {
      // 即使没有召回记录，也清理可能的 get 记录
      if (entry) this.sessions.delete(sessionKey);
      return null;
    }

    // 合并所有召回记录的节点 ID（去重）
    const nodeIdSet = new Set<string>();
    let lastQuery = "";
    for (const r of entry.records) {
      for (const id of r.nodeIds) nodeIdSet.add(id);
      lastQuery = r.query; // 保留最后一次的 query
    }

    const result: ConsumedRecall = {
      query: lastQuery,
      nodeIds: Array.from(nodeIdSet),
      getNodeIds: Array.from(entry.getNodeIds),
      recallCount: entry.records.length,
    };

    this.sessions.delete(sessionKey);
    return result;
  }

  /**
   * v2.5.4: 只消费该 session 的 get() 展开信号（用于长任务期间 M 实时更新），
   * 但保留召回记录（records）供后续 agent_end 做完整 judge。
   *
   * 长任务中 agent 每轮工具调用后（after_tool_call），get() 信号是确定性正反馈，
   * 可立即更新 M 而不必等 agent_end。为避免与 agent_end 的 judge 冲突：
   *   - 取出并清空 getNodeIds（已用于 M 更新，避免重复）
   *   - 保留 records（agent_end 仍需 nodeIds 加载召回节点做 used/unused 判定）
   *
   * @param sessionKey 会话标识
   * @returns { query, getNodeIds }；无 get 信号返回 null
   */
  consumeGetSignals(sessionKey: string): { query: string; getNodeIds: string[] } | null {
    if (!sessionKey) return null;
    const entry = this.sessions.get(sessionKey);
    if (!entry || entry.getNodeIds.size === 0) return null;

    // 取最近一次召回的 query 作为该批 get 信号的关联查询
    let lastQuery = "";
    for (const r of entry.records) lastQuery = r.query;
    const result = { query: lastQuery, getNodeIds: Array.from(entry.getNodeIds) };
    entry.getNodeIds.clear();
    entry.lastAccess = Date.now();
    return result;
  }

  /**
   * v2.5.3: 消费并清除超过 maxAgeMs 未被 agent_end 消费的"陈旧"会话。
   *
   * 长任务场景：agent 执行 100+ 工具调用期间 agent_end 尚未触发，
   * SessionRecallCache 中的召回/get 信号一直堆积却无法进入反馈链路。
   * 此方法供后台定时器周期调用，将陈旧 session 按 get() 信号直接处理为反馈，
   * 让 M 矩阵在长任务期间也能增量更新，而非等到 agent_end 才一次性处理。
   *
   * @param maxAgeMs 最大静默时间（自上次访问起）
   * @returns 被消费的 session 列表（sessionKey + ConsumedRecall）
   */
  consumeStale(maxAgeMs: number): Array<{ sessionKey: string; consumed: ConsumedRecall }> {
    const now = Date.now();
    const result: Array<{ sessionKey: string; consumed: ConsumedRecall }> = [];
    for (const [key, entry] of this.sessions) {
      if (now - entry.lastAccess < maxAgeMs) continue;
      if (entry.records.length === 0 && entry.getNodeIds.size === 0) {
        this.sessions.delete(key);
        continue;
      }
      const consumed = this.consume(key);
      if (consumed) result.push({ sessionKey: key, consumed });
    }
    return result;
  }

  /**
   * v2.5.4: 消费所有有积压 get() 信号但尚未被 agent_end 处理的活跃 session。
   *
   * 与 consumeStale 不同，此方法不依赖"静默时间"——长任务中 agent 持续调用
   * memory_search / get() 会不断更新 lastAccess，导致 consumeStale(90s) 永远
   * 不触发。但 get() 信号（确定性正反馈）已经堆积了，M 矩阵应该及时更新。
   *
   * 此方法对每个有积压 getNodeIds 的 session 调用 consumeGetSignals（只取 get
   * 信号、保留 records），返回的信号由调用方更新 M 矩阵。agent_end 触发时
   * 仍可从保留的 records 中做完整 judge。
   *
   * @returns 有积压 get 信号的 session 列表
   */
  consumeActiveGetSignals(): Array<{ sessionKey: string; query: string; getNodeIds: string[]; nodeIds: string[] }> {
    const result: Array<{ sessionKey: string; query: string; getNodeIds: string[]; nodeIds: string[] }> = [];
    for (const [key, entry] of this.sessions) {
      if (entry.getNodeIds.size === 0) continue;
      // 取最近一次召回的 query
      let lastQuery = "";
      const nodeIdSet = new Set<string>();
      for (const r of entry.records) {
        lastQuery = r.query;
        for (const id of r.nodeIds) nodeIdSet.add(id);
      }
      const getNodeIds = Array.from(entry.getNodeIds);
      entry.getNodeIds.clear(); // 清空 get 信号（已消费），保留 records 供 agent_end
      entry.lastAccess = Date.now();
      result.push({ sessionKey: key, query: lastQuery, getNodeIds, nodeIds: Array.from(nodeIdSet) });
    }
    return result;
  }

  /** 当前缓存的 session 数（健康检查/诊断用） */
  size(): number {
    return this.sessions.size;
  }

  /** 清空所有缓存（测试/gateway_stop 用） */
  clear(): void {
    this.sessions.clear();
  }

  /** 淘汰过期 session（基于 lastAccess） */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.sessions) {
      if (now - entry.lastAccess > SESSION_TTL_MS) {
        this.sessions.delete(key);
      }
    }
  }

  /** LRU 淘汰：超过 MAX_SESSIONS 时删除最旧的 */
  private evictIfNeeded(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    this.evictExpired();
    if (this.sessions.size <= MAX_SESSIONS) return;

    // 找出 lastAccess 最小的删除
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.sessions) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.sessions.delete(oldestKey);
      log.debug("evicted oldest session", { sessionKey: oldestKey });
    }
  }
}

/** 全局单例（index.ts 和 crud.ts 共享） */
let _globalCache: SessionRecallCache | null = null;

export function getSessionRecallCache(): SessionRecallCache {
  if (!_globalCache) _globalCache = new SessionRecallCache();
  return _globalCache;
}

export function resetSessionRecallCache(): void {
  if (_globalCache) _globalCache.clear();
}
