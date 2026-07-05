// ── S-14 过时检测（v2.1.2 新增）─────────────────────────────────

import type { Driver } from "neo4j-driver";
import { getSession } from "../../store/db.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("maintenance:staleness");

/**
 * 计算 stalenessScore（0=新鲜，1=完全过时）
 *
 * 启发式规则（heuristic 模式）：
 * - 90 天未更新 +0.3
 * - 6 个月未更新 +0.5
 * - 1 年未更新 +0.8
 * - state=superseded 直接 1.0
 * - 无入边（孤立）+0.2
 * - 来源为 knowledge 减 0.1（外部权威知识更稳定）
 *
 * @param halfLifeDays 衰减半周期，默认 90 天
 */
export async function computeStalenessScores(
  driver: Driver,
  opts?: { halfLifeDays?: number; threshold?: number },
): Promise<{ scanned: number; updated: number; highStaleCount: number }> {
  const session = getSession(driver);
  const halfLifeDays = opts?.halfLifeDays ?? 90;
  const threshold = opts?.threshold ?? 0.7;
  const now = Date.now();

  try {
    // 启发式：基于 updatedAt、入度、state、source 计算
    const result = await session.run(
      `MATCH (n:Task|Skill|Event)
       WHERE n.status = 'active'
       OPTIONAL MATCH (n)<-[r]-()
       WITH n, count(r) AS inDegree
       RETURN n.id AS id,
              n.updatedAt AS updatedAt,
              n.state AS state,
              n.source AS source,
              inDegree`,
    );

    let updated = 0;
    let highStaleCount = 0;
    for (const rec of result.records) {
      const id = rec.get("id");
      const updatedAt = rec.get("updatedAt")?.toNumber?.() ?? now;
      const state = rec.get("state");
      const source = rec.get("source");
      const inDegree = rec.get("inDegree")?.toNumber?.() ?? 0;

      let score = 0;
      if (state === "superseded") {
        score = 1.0;
      } else {
        const ageMs = now - updatedAt;
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        if (ageDays > 365) score += 0.8;
        else if (ageDays > 180) score += 0.5;
        else if (ageDays > 90) score += 0.3;
        else if (ageDays > halfLifeDays / 2) {
          // 半衰期线性插值
          score += 0.1 + 0.2 * (ageDays - halfLifeDays / 2) / (halfLifeDays / 2);
        }
        if (inDegree === 0) score += 0.2;
        if (source === "knowledge") score -= 0.1;
        score = Math.max(0, Math.min(1, score));
      }

      await session.run(
        `MATCH (n:Task|Skill|Event {id: $id})
         SET n.stalenessScore = $score`,
        { id, score: Number(score.toFixed(3)) },
      );
      if (score > threshold) highStaleCount++;
      updated++;
    }

    log.info(
      "staleness: scanned",
      { scanned: updated, threshold, highStaleCount },
    );
    return { scanned: updated, updated, highStaleCount };
  } finally {
    await session.close();
  }
}
