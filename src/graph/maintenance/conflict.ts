// ── G-2 冲突消解（v2.1.2 第四批新增）──────────────────────────

import type { Driver } from "neo4j-driver";
import { getSession } from "../../store/db.ts";

export interface ConflictResolutionConfig {
  enabled?: boolean;
  /** 来源优先级权重：knowledge > experience > imported */
  sourcePriority?: boolean;
  /** 时态优先（validFrom 更新者胜出） */
  temporalPriority?: boolean;
  /** 置信度优先（validatedCount 高者胜出） */
  confidencePriority?: boolean;
}

/**
 * 冲突消解策略（A-TMA 三层故障模型的 Cognition + Action 层）
 *
 * 检测：S-13（state=transitional）+ S-14（stalenessScore 高）
 * 消解策略（按优先级，纯规则无 LLM 成本）：
 *   1. 时态优先：validFrom 更新的胜出，旧节点 state → superseded
 *   2. 来源优先：source=knowledge > experience > imported
 *   3. 置信度优先：validatedCount 高的胜出
 *   4. 合并：两节点可合并时（同 type + 名称相似），保留主节点合并描述
 *
 * 消解决策写入 GmDecision 节点（可追溯）
 */
export async function resolveConflicts(
  driver: Driver,
  cfg?: ConflictResolutionConfig,
): Promise<{ scanned: number; resolved: number; superseded: number; merged: number }> {
  const session = getSession(driver);
  try {
    // 扫描 transitional 状态的节点对（潜在冲突）
    // 启发式：找到 name 相同但 state=transitional 的节点对
    const conflicts = await session.run(
      `MATCH (a:Task|Skill|Event), (b:Task|Skill|Event)
       WHERE a.name = b.name
         AND a.id < b.id
         AND (a.state = 'transitional' OR b.state = 'transitional'
              OR a.stalenessScore > 0.7 OR b.stalenessScore > 0.7)
         AND a.status = 'active' AND b.status = 'active'
       RETURN a.id AS aId, a.validFrom AS aValidFrom, a.source AS aSource,
              a.validatedCount AS aValidatedCount, a.stalenessScore AS aStaleness,
              a.content AS aContent, a.type AS aType,
              b.id AS bId, b.validFrom AS bValidFrom, b.source AS bSource,
              b.validatedCount AS bValidatedCount, b.stalenessScore AS bStaleness,
              b.content AS bContent, b.type AS bType
       LIMIT 100`,
    );

    let resolved = 0;
    let superseded = 0;
    let merged = 0;

    for (const rec of conflicts.records) {
      const aId = rec.get("aId");
      const bId = rec.get("bId");
      const aValidFrom = rec.get("aValidFrom")?.toNumber?.() ?? 0;
      const bValidFrom = rec.get("bValidFrom")?.toNumber?.() ?? 0;
      const aSource = rec.get("aSource") ?? "experience";
      const bSource = rec.get("bSource") ?? "experience";
      const aValidated = rec.get("aValidatedCount")?.toNumber?.() ?? 0;
      const bValidated = rec.get("bValidatedCount")?.toNumber?.() ?? 0;
      const aStaleness = rec.get("aStaleness")?.toNumber?.() ?? 0;
      const bStaleness = rec.get("bStaleness")?.toNumber?.() ?? 0;
      const aType = rec.get("aType");
      const bType = rec.get("bType");

      // 类型不同，不视为冲突
      if (aType !== bType) continue;

      // 决定胜者（winner）与败者（loser）
      let winnerId = aId;
      let loserId = bId;
      let decision = "temporal"; // 默认时态优先

      // 策略 1: 时态优先（validFrom 更新者胜出）
      if (cfg?.temporalPriority !== false) {
        if (bValidFrom > aValidFrom) {
          winnerId = bId;
          loserId = aId;
          decision = "temporal";
        } else if (aValidFrom > bValidFrom) {
          winnerId = aId;
          loserId = bId;
          decision = "temporal";
        } else {
          // validFrom 相同，进入策略 2
          // 策略 2: 来源优先
          const sourceRank = (s: string): number =>
            s === "knowledge" ? 3 : s === "experience" ? 2 : 1;
          if (cfg?.sourcePriority !== false && sourceRank(bSource) > sourceRank(aSource)) {
            winnerId = bId;
            loserId = aId;
            decision = "source";
          } else if (cfg?.sourcePriority !== false && sourceRank(aSource) > sourceRank(bSource)) {
            winnerId = aId;
            loserId = bId;
            decision = "source";
          } else {
            // 策略 3: 置信度优先
            if (cfg?.confidencePriority !== false && bValidated > aValidated * 1.5) {
              winnerId = bId;
              loserId = aId;
              decision = "confidence";
            } else if (cfg?.confidencePriority !== false && aValidated > bValidated * 1.5) {
              winnerId = aId;
              loserId = bId;
              decision = "confidence";
            } else {
              // 策略 4: 合并（同 type + 名相同 → 按 validatedCount/stalenessScore 综合选择 winner，合并 content）
              // 修复旧实现 a 总是 winner 的偏向：比较 validatedCount/stalenessScore 综合选择
              const aScore = aValidated * (1 - aStaleness);
              const bScore = bValidated * (1 - bStaleness);
              const mergeWinnerId = bScore > aScore ? bId : aId;
              const mergeLoserId = bScore > aScore ? aId : bId;
              const mergedContent = [rec.get("aContent"), rec.get("bContent")]
                .filter(Boolean)
                .join("\n---\n");
              await session.run(
                `MATCH (winner:Task|Skill|Event {id: $winnerId}),
                       (loser:Task|Skill|Event {id: $loserId})
                 SET winner.content = $mergedContent,
                     winner.validatedCount = $totalValidated,
                     winner.state = 'current',
                     winner.stalenessScore = 0.0,
                     loser.state = 'superseded',
                     loser.validTo = timestamp(),
                     loser.supersededBy = $winnerId
                 WITH winner, loser
                 MATCH (loser)-[r]->(related)
                 WHERE NOT type(r) IN ['NEXT_SESSION', 'CONTAINS']
                 MERGE (winner)-[r2:type(r)]->(related)
                   SET r2.id = coalesce(r2.id, 'edge-' + toString(timestamp()) + '-' + toString(rand())),
                       r2.weight = coalesce(r2.weight, 1.0) * 0.5,
                       r2.createdAt = coalesce(r2.createdAt, timestamp()),
                       r2.updatedAt = timestamp()
                 DETACH DELETE loser`,
                {
                  winnerId: mergeWinnerId,
                  loserId: mergeLoserId,
                  mergedContent,
                  totalValidated: aValidated + bValidated,
                },
              );
              merged++;
              resolved++;
              continue;
            }
          }
        }
      }

      // 时态/来源/置信度消解：败者标记为 superseded
      const finalWinner = winnerId;
      const finalLoser = loserId;

      // 失败者的边降权，但不物理删除（保留可追溯）
      await session.run(
        `MATCH (loser:Task|Skill|Event {id: $loserId}),
               (winner:Task|Skill|Event {id: $winnerId})
         SET loser.state = 'superseded',
             loser.validTo = timestamp(),
             loser.supersededBy = $winnerId,
             loser.stalenessScore = 1.0
         WITH loser
         MATCH (loser)-[r]->()
         WHERE NOT type(r) IN ['NEXT_SESSION', 'CONTAINS']
         SET r.weight = r.weight * 0.1`,
        { loserId: finalLoser, winnerId: finalWinner },
      );

      // 写入 GmDecision 节点（可追溯）
      await session.run(
        `CREATE (d:GmDecision {
           id: 'decision-' + toString(timestamp()) + '-' + toString(rand()),
           type: 'conflict-resolution',
           decision: $decision,
           winnerId: $winnerId,
           loserId: $loserId,
           timestamp: timestamp(),
           reason: $reason
         })`,
        {
          decision,
          winnerId: finalWinner,
          loserId: finalLoser,
          reason: `staleness: a=${aStaleness.toFixed(2)}, b=${bStaleness.toFixed(2)}; validated: a=${aValidated}, b=${bValidated}; source: a=${aSource}, b=${bSource}`,
        },
      );

      superseded++;
      resolved++;
    }

    return { scanned: conflicts.records.length, resolved, superseded, merged };
  } finally {
    await session.close();
  }
}
