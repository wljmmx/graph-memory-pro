/**
 * graph-memory-pro — LLM Usage 统计（v2.3.0）
 *
 * 内存累计 LLM token 用量，供 /api/usage 和 /api/metrics 查询。
 * 设计原则：
 *   - 进程级单例，不持久化（重启清零，与 QueryCache/JudgeManager 同生命周期）
 *   - 区分 provider（ollama/openai/runtime）+ purpose（extract/recall/judge/maintain/probe）
 *   - 支持 reset（测试用）
 *
 * 不做：写入 Neo4j（避免高频写入开销）；区分用户（单租户场景）
 */

export interface UsageRecord {
  provider: string;
  purpose: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

export interface UsageStats {
  total: UsageRecord;
  byProvider: Record<string, UsageRecord>;
  byPurpose: Record<string, UsageRecord>;
  startedAt: string;
}

const _stats: UsageRecord = {
  provider: "all",
  purpose: "all",
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  calls: 0,
};
const _byProvider: Record<string, UsageRecord> = {};
const _byPurpose: Record<string, UsageRecord> = {};
const _startedAt = new Date().toISOString();

/**
 * 记录一次 LLM 调用的 token 用量
 *
 * @param provider 模型 provider（ollama/openai/runtime 等）
 * @param purpose 调用目的（extract/recall/judge/maintain/probe/unknown）
 * @param promptTokens 输入 token 数
 * @param completionTokens 输出 token 数
 */
export function recordUsage(
  provider: string,
  purpose: string,
  promptTokens: number,
  completionTokens: number,
): void {
  const total = (promptTokens || 0) + (completionTokens || 0);

  // 累计到总统计
  _stats.promptTokens += promptTokens || 0;
  _stats.completionTokens += completionTokens || 0;
  _stats.totalTokens += total;
  _stats.calls += 1;

  // 按 provider 累计
  if (!_byProvider[provider]) {
    _byProvider[provider] = { provider, purpose: "all", promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  }
  _byProvider[provider].promptTokens += promptTokens || 0;
  _byProvider[provider].completionTokens += completionTokens || 0;
  _byProvider[provider].totalTokens += total;
  _byProvider[provider].calls += 1;

  // 按 purpose 累计
  if (!_byPurpose[purpose]) {
    _byPurpose[purpose] = { provider: "all", purpose, promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  }
  _byPurpose[purpose].promptTokens += promptTokens || 0;
  _byPurpose[purpose].completionTokens += completionTokens || 0;
  _byPurpose[purpose].totalTokens += total;
  _byPurpose[purpose].calls += 1;
}

/**
 * 获取完整 usage 统计
 */
export function getUsageStats(): UsageStats {
  return {
    total: { ..._stats },
    byProvider: { ..._byProvider },
    byPurpose: { ..._byPurpose },
    startedAt: _startedAt,
  };
}

/**
 * 重置统计（仅测试用）
 */
export function _resetUsageStats(): void {
  _stats.promptTokens = 0;
  _stats.completionTokens = 0;
  _stats.totalTokens = 0;
  _stats.calls = 0;
  for (const k of Object.keys(_byProvider)) delete _byProvider[k];
  for (const k of Object.keys(_byPurpose)) delete _byPurpose[k];
}
