// ── L-4 反向记忆项（v2.1.2 第四批新增）──────────────────────────

import type { Driver } from "neo4j-driver";
import { getSession } from "../../store/db.ts";
import { getFeedbackCountInternal } from "./edge-weights.ts";

export interface ReverseMemoryConfig {
  enabled?: boolean;
  /** 召回频次阈值（被召回 N 次但从未被标记为有效 → 进入观察列表） */
  recallThreshold?: number;
  /** 观察列表中节点的 stalenessScore 增量 */
  stalenessPenalty?: number;
  /** importanceScore 下限（低于此值 + 召回频次高 → 进入观察列表） */
  importanceFloor?: number;
}

/**
 * 反向记忆项：弱化"频繁召回但从未被裁判标记为有效"的节点
 *
 * 算法：
 *   - 查询每个节点的"召回频次 vs 有效频次"比值
 *   - 比值 > recallThreshold（召回 10 次以上但从未有效）→ stalenessScore += 0.1
 *   - 与 S-14 过时检测协同：stalenessScore 高的节点在召回时降权
 *   - 冷启动：累计反馈数 < warmupFeedbacks 时不调整
 */
export async function applyReverseMemory(
  driver: Driver,
  cfg?: ReverseMemoryConfig,
  warmupFeedbacks?: number,
): Promise<{ watchlistAdded: number; watchlistRemoved: number; decayed: number }> {
  // 冷启动检查
  const feedbackCount = await getFeedbackCountInternal(driver);
  if (feedbackCount < (warmupFeedbacks ?? 100)) {
    return { watchlistAdded: 0, watchlistRemoved: 0, decayed: 0 };
  }

  const session = getSession(driver);
  const recallThreshold = cfg?.recallThreshold ?? 10;
  const stalenessPenalty = cfg?.stalenessPenalty ?? 0.1;
  const importanceFloor = cfg?.importanceFloor ?? 0.2;

  try {
    // 查询频繁召回但从未有效的节点
    // 简化：JUDGED 关系中 recalledNodeIds 包含该节点，但 verdict=used 从未命中
    const candidates = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       OPTIONAL MATCH (f:GmFeedback)-[j:JUDGED {verdict: 'unused'}]->(n)
       WITH n, count(DISTINCT f) AS unusedCount
       WHERE unusedCount >= $threshold
         AND coalesce(n.importanceScore, 0) < $floor
       RETURN n.id AS id, n.stalenessScore AS staleness, n.importanceScore AS importance, unusedCount
       LIMIT 200`,
      { threshold: recallThreshold, floor: importanceFloor },
    );

    let decayed = 0;
    for (const rec of candidates.records) {
      const id = rec.get("id");
      const currentStaleness = rec.get("staleness")?.toNumber?.() ?? 0;
      const newStaleness = Math.min(1.0, currentStaleness + stalenessPenalty);

      await session.run(
        `MATCH (n:Task|Skill|Event {id: $id})
         SET n.stalenessScore = $newStaleness,
             n.state = CASE WHEN $newStaleness > 0.9 THEN 'transitional' ELSE n.state END`,
        { id, newStaleness },
      );
      decayed++;
    }

    // 移除观察列表：曾经被标记为有效 → 重置 stalenessScore
    const recovered = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active', state: 'transitional'})
       MATCH (f:GmFeedback)-[j:JUDGED {verdict: 'used'}]->(n)
       WHERE f.timestamp > n.updatedAt
       WITH DISTINCT n
       SET n.stalenessScore = 0.0,
           n.state = 'current'
       RETURN count(n) AS recovered`,
    );
    const watchlistRemoved = recovered.records[0]?.get("recovered")?.toNumber?.() ?? 0;

    return {
      watchlistAdded: decayed,
      watchlistRemoved,
      decayed,
    };
  } finally {
    await session.close();
  }
}
