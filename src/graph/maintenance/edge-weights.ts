// ── L-3 边权重调整（v2.1.2 第四批新增）──────────────────────────

import type { Driver } from "neo4j-driver";
import { getSession } from "../../store/db.ts";

export interface EdgeWeightsConfig {
  enabled?: boolean;
  /** 被裁判标记为"有效"的边 weight 强化系数（默认 1.1） */
  strengthenFactor?: number;
  /** 未使用的边 weight 衰减系数（默认 0.95） */
  decayFactor?: number;
  /** weight 最小值（避免衰减到 0） */
  minWeight?: number;
  /** weight 最大值（避免强化过度） */
  maxWeight?: number;
}

/**
 * 根据裁判反馈调整边权重
 *
 * 规则：
 *   - 被裁判标记为"有效"的召回路径上的边 weight × strengthenFactor
 *   - 被裁判标记为"未使用"的召回路径上的边 weight × decayFactor
 *   - 与 GDS 投影协同：下一个维护周期重建投影时生效
 *   - 冷启动：累计反馈数 < warmupFeedbacks 时不调整
 */
export async function adjustEdgeWeights(
  driver: Driver,
  cfg?: EdgeWeightsConfig,
  warmupFeedbacks?: number,
): Promise<{ scanned: number; strengthened: number; decayed: number }> {
  // 冷启动检查
  const feedbackCount = await getFeedbackCountInternal(driver);
  if (feedbackCount < (warmupFeedbacks ?? 100)) {
    return { scanned: 0, strengthened: 0, decayed: 0 };
  }

  const session = getSession(driver);
  const strengthenFactor = cfg?.strengthenFactor ?? 1.1;
  const decayFactor = cfg?.decayFactor ?? 0.95;
  const minWeight = cfg?.minWeight ?? 0.1;
  const maxWeight = cfg?.maxWeight ?? 5.0;

  try {
    // 查询被使用节点与召回节点之间的边（强化）
    // 仅强化 used-used 节点对之间的边（修复旧实现 j2 未过滤 verdict 导致 used-unused 边也被强化的缺陷）
    const strengthenResult = await session.run(
      `MATCH (f:GmFeedback)-[j1:JUDGED {verdict: 'used'}]->(used:Task|Skill|Event)
       MATCH (f)-[j2:JUDGED {verdict: 'used'}]->(recalled:Task|Skill|Event)
       WHERE recalled.id <> used.id
       MATCH (used)-[r]-(recalled)
       WHERE NOT type(r) IN ['NEXT_SESSION', 'CONTAINS']
       WITH r, count(DISTINCT f) AS usageCount
       SET r.weight = CASE
         WHEN r.weight * $factor * (1 + usageCount * 0.05) > $max THEN $max
         ELSE r.weight * $factor * (1 + usageCount * 0.05)
       END,
       r.updatedAt = timestamp()
       RETURN count(DISTINCT r) AS strengthened`,
      { factor: strengthenFactor, max: maxWeight },
    );
    const strengthened = strengthenResult.records[0]?.get("strengthened")?.toNumber?.() ?? 0;

    // 衰减从未被使用的召回节点之间的边
    const decayResult = await session.run(
      `MATCH (f:GmFeedback)-[j:JUDGED {verdict: 'unused'}]->(unused:Task|Skill|Event)
       MATCH (unused)-[r]-()
       WHERE NOT type(r) IN ['NEXT_SESSION', 'CONTAINS']
         AND r.weight > $min
       WITH r, count(DISTINCT f) AS unusedCount
       SET r.weight = CASE
         WHEN r.weight * $factor < $min THEN $min
         ELSE r.weight * $factor
       END,
       r.updatedAt = timestamp()
       RETURN count(DISTINCT r) AS decayed`,
      { factor: decayFactor, min: minWeight },
    );
    const decayed = decayResult.records[0]?.get("decayed")?.toNumber?.() ?? 0;

    return {
      scanned: strengthened + decayed,
      strengthened,
      decayed,
    };
  } finally {
    await session.close();
  }
}

// ── 辅助函数 ──────────────────────────────────────

/** 查询反馈总数（冷启动计数） — edge-weights 与 reverse-memory 共用 */
export async function getFeedbackCountInternal(driver: Driver): Promise<number> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (f:GmFeedback) RETURN count(f) AS c",
    );
    return result.records[0]?.get("c")?.toNumber?.() ?? 0;
  } finally {
    await session.close();
  }
}
