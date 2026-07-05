// ── G-3 重要性评分（v2.1.2 第三批新增）──────────────────────────

import type { Driver } from "neo4j-driver";
import { getSession } from "../../store/db.ts";

export interface ImportanceConfig {
  enabled?: boolean;
  /** 各分量权重（默认 0.3/0.3/0.2/0.2，需归一化） */
  weights?: {
    recency?: number;      // 时间衰减
    frequency?: number;    // 使用频率
    centrality?: number;  // 图中心性
    source?: number;       // 来源权重
  };
  /** recency 衰减周期（天，默认 30） */
  recencyDecayDays?: number;
  /** frequency 饱和阈值（默认 10 次） */
  frequencySaturation?: number;
}

const DEFAULT_IMPORTANCE_WEIGHTS = {
  recency: 0.3,
  frequency: 0.3,
  centrality: 0.2,
  source: 0.2,
};

/**
 * 计算节点重要性评分 importanceScore ∈ [0, 1]
 *
 * 公式：importanceScore = w1·recency + w2·frequency + w3·centrality + w4·source
 *   - recency:    1 - min(ageDays, decayDays) / decayDays   （30 天线性衰减）
 *   - frequency:  min(validatedCount / saturation, 1)         （10 次饱和）
 *   - centrality: pagerank / max(pagerank)                   （归一化）
 *   - source:     knowledge=1.0, experience=0.7, imported=0.5
 *
 * 与 stalenessScore 互补：
 *   - stalenessScore 衡量"是否过时"（越高越糟）
 *   - importanceScore 衡量"是否有价值"（越高越值得召回）
 *
 * 召回排序加权：score × importanceScore × (1 - stalenessScore)
 */
export async function computeImportanceScores(
  driver: Driver,
  cfg?: ImportanceConfig,
): Promise<{ scanned: number; updated: number; avgScore: number }> {
  const session = getSession(driver);
  const weights = {
    recency: cfg?.weights?.recency ?? DEFAULT_IMPORTANCE_WEIGHTS.recency,
    frequency: cfg?.weights?.frequency ?? DEFAULT_IMPORTANCE_WEIGHTS.frequency,
    centrality: cfg?.weights?.centrality ?? DEFAULT_IMPORTANCE_WEIGHTS.centrality,
    source: cfg?.weights?.source ?? DEFAULT_IMPORTANCE_WEIGHTS.source,
  };
  // 归一化权重，避免配置漂移
  const wSum = weights.recency + weights.frequency + weights.centrality + weights.source;
  const w = {
    recency: weights.recency / wSum,
    frequency: weights.frequency / wSum,
    centrality: weights.centrality / wSum,
    source: weights.source / wSum,
  };
  const decayDays = cfg?.recencyDecayDays ?? 30;
  const freqSat = cfg?.frequencySaturation ?? 10;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  try {
    // 先查询 max pagerank 用于 centrality 归一化
    const maxPrResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       RETURN max(n.pagerank) AS maxPr`,
    );
    const maxPr = maxPrResult.records[0]?.get("maxPr")?.toNumber?.() ?? 0;

    const result = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       RETURN n.id AS id,
              n.updatedAt AS updatedAt,
              n.validatedCount AS validatedCount,
              n.pagerank AS pagerank,
              n.source AS source`,
    );

    let updated = 0;
    let scoreSum = 0;
    for (const rec of result.records) {
      const id = rec.get("id");
      const updatedAt = rec.get("updatedAt")?.toNumber?.() ?? now;
      const validatedCount = rec.get("validatedCount")?.toNumber?.() ?? 0;
      const pagerank = rec.get("pagerank")?.toNumber?.() ?? 0;
      const source = rec.get("source") ?? "experience";

      const ageDays = Math.max(0, (now - updatedAt) / DAY_MS);
      const recency = Math.max(0, 1 - Math.min(ageDays, decayDays) / decayDays);
      const frequency = Math.min(validatedCount / freqSat, 1);
      const centrality = maxPr > 0 ? Math.max(0, Math.min(pagerank / maxPr, 1)) : 0;
      const sourceWeight = source === "knowledge" ? 1.0
        : source === "imported" ? 0.5
        : 0.7; // experience (默认)

      const score = w.recency * recency
        + w.frequency * frequency
        + w.centrality * centrality
        + w.source * sourceWeight;

      await session.run(
        `MATCH (n:Task|Skill|Event {id: $id})
         SET n.importanceScore = $score`,
        { id, score: Number(score.toFixed(3)) },
      );
      scoreSum += score;
      updated++;
    }

    const avgScore = updated > 0 ? scoreSum / updated : 0;
    return { scanned: updated, updated, avgScore };
  } finally {
    await session.close();
  }
}
