/**
 * graph-memory-pro v2.3.2 阶段三 — 配置热更新辅助函数
 *
 * 从 index.ts /api/reload handler 中提取的纯逻辑，便于单元测试。
 * handler 本身仍留在 index.ts（持有模块级状态），此处仅提供可复用的纯函数。
 */

import type { GmConfig } from "../types.ts";

/** 配置段 diff 结果 */
export interface ConfigSegmentDiff {
  neo4j: boolean;
  llm: boolean;
  embedding: boolean;
  background: boolean;
}

/**
 * v2.3.2 阶段三: 检测配置段是否变化（diff-based 部分重建）
 *
 * 仅当某段配置变化时才重建对应资源（driver/llm/embed/timer），
 * 其余配置原地合并（Object.assign）让持引用的组件自动生效。
 */
export function diffConfigSegments(oldCfg: GmConfig, newCfg: GmConfig): ConfigSegmentDiff {
  return {
    neo4j: JSON.stringify(newCfg.neo4j) !== JSON.stringify(oldCfg.neo4j),
    llm: JSON.stringify(newCfg.llm) !== JSON.stringify(oldCfg.llm),
    embedding: JSON.stringify(newCfg.embedding) !== JSON.stringify(oldCfg.embedding),
    background:
      (newCfg.background?.extractorIntervalMs ?? 60_000) !== (oldCfg.background?.extractorIntervalMs ?? 60_000) ||
      (newCfg.background?.maintenanceIntervalMs ?? 6 * 3600_000) !== (oldCfg.background?.maintenanceIntervalMs ?? 6 * 3600_000),
  };
}

/** 鉴权结果 */
export interface AuthResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * v2.3.2 阶段三: 校验 reload 请求鉴权
 *
 * - 未配置 authToken → 允许本地访问（无鉴权）
 * - 配置了 authToken 且 provided 匹配 → 放行
 * - 配置了 authToken 但 provided 不匹配 → 401
 */
export function checkReloadAuth(cfg: GmConfig | null, provided: string | undefined): AuthResult {
  const authToken = cfg?.mcp?.authToken;
  if (!authToken) return { ok: true };
  if (provided !== authToken) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}

/**
 * v2.3.2 阶段三: 规范化新配置（填充与 init 时一致的默认值）
 *
 * 从 SDK 重新获取的 api.config 可能缺少部分字段，需填充默认值后才能安全使用。
 */
export function normalizeReloadConfig(raw: any): GmConfig {
  return {
    ...raw,
    compactTurnCount: raw.compactTurnCount ?? 6,
    recallMaxNodes: raw.recallMaxNodes ?? 6,
    recallMaxDepth: raw.recallMaxDepth ?? 2,
    freshTailCount: raw.freshTailCount ?? 10,
    dedupThreshold: raw.dedupThreshold ?? 0.90,
    pagerankDamping: raw.pagerankDamping ?? 0.85,
    pagerankIterations: raw.pagerankIterations ?? 20,
  } as GmConfig;
}
