/**
 * v2.6.0 — 稀疏图自维护（Phase 12）
 *
 * 保守策略：仅在稀疏时补边/合并/社区重连，全部带 inferred 标记可回滚。
 *   - 补边：embedding 相似度 ∈ [inferSimMin, inferSimMax) 且无既有边的 active 节点对，
 *     weight = 融合相似度 × confidenceFactor，source='self-heal'。
 *   - 合并：孤立节点与最近非孤立节点相似度 ≥ mergeSimThreshold 时自动合并，
 *     否则仅产出候选报告（不写图）。
 *   - 社区重连：有 communityId 的孤立节点连到本社区代表（PageRank 最高成员）。
 *   - 限额：每节点 ≤ maxEdgesPerNode，每周期 ≤ maxEdgesPerCycle。
 *   - 中文优化：cjkBigramSim 字符 bigram Jaccard，与 cosine 加权融合（cjkWeight）。
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../../types.ts";
import { getSession } from "../../store/db.ts";
import { computeGraphHealthScore, type GraphHealthScore } from "./health.ts";
import { mergeNodes } from "../../store/edges.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("self-heal");

export interface SelfHealConfig {
  /** 稀疏判定评分阈值（默认 60） */
  scoreThreshold?: number;
  /** 补边相似度下限（默认 0.70） */
  inferSimMin?: number;
  /** 补边相似度上限（默认 0.90） */
  inferSimMax?: number;
  /** 每节点补边上限（默认 5） */
  maxEdgesPerNode?: number;
  /** 每周期补边上限（默认 50） */
  maxEdgesPerCycle?: number;
  /** 孤立节点自动合并阈值（默认 0.85） */
  mergeSimThreshold?: number;
  /** 边权重系数（默认 1.0） */
  confidenceFactor?: number;
  /** CJK 文本相似度权重（默认 0.3） */
  cjkWeight?: number;
}

export interface SelfHealResult {
  scored: boolean;
  score?: GraphHealthScore;
  sparse: boolean;
  edgesAdded: number;
  mergesApplied: number;
  mergeCandidates: Array<{ a: string; b: string; sim: number }>;
  reLinks: number;
  skippedNoEmbedding: number;
}

const DEFAULT_CFG: Required<SelfHealConfig> = {
  scoreThreshold: 60,
  inferSimMin: 0.7,
  inferSimMax: 0.9,
  maxEdgesPerNode: 5,
  maxEdgesPerCycle: 50,
  mergeSimThreshold: 0.85,
  confidenceFactor: 1.0,
  cjkWeight: 0.3,
};

/**
 * CJK 字符 bigram Jaccard 相似度。
 * 处理中文文本在 embedding 区分度不足时的字符级重叠信号；
 * 非中文/空输入安全回落（避免 NaN 污染权重计算）。
 */
export function cjkBigramSim(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const chars = (s ?? "").replace(/[^\u4e00-\u9fa5]/g, "");
    const set = new Set<string>();
    for (let i = 0; i + 1 < chars.length; i++) {
      set.add(chars.slice(i, i + 2));
    }
    return set;
  };
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 && gb.size === 0) {
    // 双方均无中文 bigram：退化为全等判定（等价字符串算相同）
    return (a ?? "").trim() === (b ?? "").trim() ? 1 : 0;
  }
  let intersect = 0;
  for (const g of ga) if (gb.has(g)) intersect++;
  const union = ga.size + gb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/** 从 GmConfig 提取自愈配置 */
export function sparsityConfigFrom(cfg: GmConfig): SelfHealConfig {
  const sh = cfg?.sparseHeal ?? {};
  return {
    scoreThreshold: sh.scoreThreshold,
    inferSimMin: sh.inferSimMin,
    inferSimMax: sh.inferSimMax,
    maxEdgesPerNode: sh.maxEdgesPerNode,
    maxEdgesPerCycle: sh.maxEdgesPerCycle,
    mergeSimThreshold: sh.mergeSimThreshold,
    confidenceFactor: sh.confidenceFactor,
    cjkWeight: sh.cjkWeight,
  };
}

/**
 * Phase 12 主入口：评分 → 稀疏则补边/合并/社区重连。
 */
export async function runSelfHeal(driver: Driver, cfg?: SelfHealConfig): Promise<SelfHealResult> {
  const c = { ...DEFAULT_CFG, ...cfg };
  const score = await computeGraphHealthScore(driver, c.scoreThreshold);

  if (!score.sparse) {
    log.info("self-heal: graph healthy, skip", { score: score.score });
    return { scored: true, score, sparse: false, edgesAdded: 0, mergesApplied: 0, mergeCandidates: [], reLinks: 0, skippedNoEmbedding: 0 };
  }

  log.info("self-heal: graph sparse, running recovery", { score: score.score, isolatedRatio: score.metrics.isolatedRatio });
  const session = getSession(driver);
  const edgesAdded = 0;
  const mergesApplied = 0;
  const mergeCandidates: Array<{ a: string; b: string; sim: number }> = [];
  let reLinks = 0;
  try {
    // ── 1. 补边候选（embedding 余弦 + 无既有语义边；与 dedup 同款原生 reduce，不依赖 GDS）──
    const candidates = await session.run(
      `MATCH (a:Task|Skill|Event {status: 'active'})
       WHERE a.embedding IS NOT NULL
       WITH a
       MATCH (b:Task|Skill|Event {status: 'active'})
       WHERE b.embedding IS NOT NULL
         AND a.id < b.id
         AND NOT (a)-[:RELATES_TO]-(b)
         AND NOT (a)-[:USED_SKILL|SOLVED_BY|REQUIRES|PATCHES|CONFLICTS_WITH|CAUSED_BY|LEADS_TO]-(b)
       WITH a, b, a.embedding AS va, b.embedding AS vb
       WITH a, b, va, vb,
         reduce(dot = 0.0, i IN range(0, size(va) - 1) | dot + va[i] * vb[i]) AS dot,
         sqrt(reduce(sq = 0.0, i IN range(0, size(va) - 1) | sq + va[i] * va[i])) AS na,
         sqrt(reduce(sq = 0.0, i IN range(0, size(vb) - 1) | sq + vb[i] * vb[i])) AS nb
       WHERE size(va) = size(vb) AND na > 0 AND nb > 0
       WITH a, b, dot / (na * nb) AS cosSim
       WHERE cosSim >= $simMin AND cosSim < $simMax
       RETURN a.id AS idA, a.name AS nameA, a.type AS typeA,
              b.id AS idB, b.name AS nameB, b.type AS typeB, cosSim AS sim
       ORDER BY cosSim DESC
       LIMIT toInteger($maxEdgesPerCycle)`,
      { simMin: c.inferSimMin, simMax: c.inferSimMax, maxEdgesPerCycle: c.maxEdgesPerCycle },
    );

    // ── 补边写入：带 inferred 标记 ──
    const now = Date.now();
    let created = 0;
    const degreeBudget = new Map<string, number>();
    for (const rec of candidates.records) {
      if (created >= c.maxEdgesPerCycle) break;
      const idA = String(rec.get("idA"));
      const idB = String(rec.get("idB"));
      const nameA = String(rec.get("nameA") ?? "");
      const nameB = String(rec.get("nameB") ?? "");
      const simRaw = rec.get("sim");
      const sim = typeof simRaw === "number" ? simRaw : (simRaw?.toNumber?.() ?? 0);
      // CJK 文本相似度融合
      const cjkSim = cjkBigramSim(nameA, nameB);
      const fusedSim = (1 - c.cjkWeight) * sim + c.cjkWeight * cjkSim;
      if (fusedSim < c.inferSimMin) continue;

      const budgetA = degreeBudget.get(idA) ?? 0;
      const budgetB = degreeBudget.get(idB) ?? 0;
      if (budgetA >= c.maxEdgesPerNode || budgetB >= c.maxEdgesPerNode) continue;

      await session.run(
        `MATCH (from:Task|Skill|Event {id: $fromId, status: 'active'})
         MATCH (to:Task|Skill|Event {id: $toId, status: 'active'})
         MERGE (from)-[r:RELATES_TO]->(to)
         SET r.id = $id, r.fromId = $fromId, r.toId = $toId,
             r.weight = $weight, r.instruction = $instruction,
             r.inferred = true, r.source = 'self-heal',
             r.createdAt = $now, r.updatedAt = $now`,
        {
          fromId: idA, toId: idB,
          id: `selfheal-${now}-${Math.random().toString(36).slice(2, 8)}`,
          weight: fusedSim * c.confidenceFactor,
          instruction: `自愈补边：相似度 ${fusedSim.toFixed(3)}`,
          now,
        },
      );
      degreeBudget.set(idA, budgetA + 1);
      degreeBudget.set(idB, budgetB + 1);
      created++;
    }

    // ── 2. 孤立节点：合并候选 + 社区重连 ──
    const isolated = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE NOT (n)--(:Task|Skill|Event)
       RETURN n.id AS id, n.name AS name, n.type AS type, n.communityId AS communityId,
              n.embedding AS embedding`,
    );
    let skippedNoEmbedding = 0;
    for (const rec of isolated.records) {
      const id = String(rec.get("id"));
      const name = String(rec.get("name") ?? "");
      const communityId = rec.get("communityId");
      const embedding = rec.get("embedding");

      // 2a. 社区重连：有社区 → 连到社区代表（PageRank 最高成员）
      if (communityId) {
        const rep = await session.run(
          `MATCH (n:Task|Skill|Event {communityId: $cid, status: 'active'})
           WHERE n.id <> $id
           RETURN n.id AS rid
           ORDER BY n.pagerank DESC, n.validatedCount DESC
           LIMIT 1`,
          { cid: String(communityId), id },
        );
        const rid = rep.records[0]?.get("rid");
        if (rid) {
          await session.run(
            `MATCH (from:Task|Skill|Event {id: $fromId}),
                   (to:Task|Skill|Event {id: $toId})
             MERGE (from)-[r:RELATES_TO]->(to)
             SET r.fromId = $fromId, r.toId = $toId,
                 r.weight = 0.5, r.instruction = '自愈社区重连',
                 r.inferred = true, r.source = 'self-heal',
                 r.updatedAt = $now`,
            { fromId: id, toId: String(rid), now: Date.now() },
          );
          reLinks++;
          continue;
        }
      }

      // 2b. 合并候选：与最近非孤立节点比较（无 embedding 则跳过）
      if (!embedding) {
        skippedNoEmbedding++;
        continue;
      }
      const nearest = await session.run(
        `MATCH (n:Task|Skill|Event {status: 'active'})
         WHERE n.id <> $id AND n.embedding IS NOT NULL
           AND (n)--(:Task|Skill|Event)
         WITH n, n.embedding AS vb, $embedding AS va
         WITH n, va, vb,
           reduce(dot = 0.0, i IN range(0, size(va) - 1) | dot + va[i] * vb[i]) AS dot,
           sqrt(reduce(sq = 0.0, i IN range(0, size(va) - 1) | sq + va[i] * va[i])) AS na,
           sqrt(reduce(sq = 0.0, i IN range(0, size(vb) - 1) | sq + vb[i] * vb[i])) AS nb
         WHERE size(va) = size(vb) AND na > 0 AND nb > 0
         WITH n, dot / (na * nb) AS cosSim
         RETURN n.id AS nid, n.name AS nname, cosSim AS sim
         ORDER BY cosSim DESC
         LIMIT 1`,
        { id, embedding },
      );
      const best = nearest.records[0];
      if (!best) continue;
      const nid = String(best.get("nid"));
      const sim = best.get("sim");
      const simVal = typeof sim === "number" ? sim : (sim?.toNumber?.() ?? 0);
      const fused = (1 - c.cjkWeight) * simVal + c.cjkWeight * cjkBigramSim(name, String(best.get("nname") ?? ""));
      if (fused >= c.mergeSimThreshold) {
        await mergeNodes(driver, nid, id); // 保留非孤立节点 nid，合并孤立节点 id
        mergesApplied++;
      } else {
        mergeCandidates.push({ a: id, b: nid, sim: Math.round(fused * 100) / 100 });
      }
    }

    const total = edgesAdded + created;
    log.info("self-heal: recovery done", { edgesAdded: created, mergesApplied, reLinks, candidates: mergeCandidates.length });
    return {
      scored: true, score, sparse: true,
      edgesAdded: created, mergesApplied, mergeCandidates, reLinks, skippedNoEmbedding,
    };
  } finally {
    await session.close();
  }
}

/** 回滚全部 self-heal 边（GUARD / 手动运维用） */
export async function revertSelfHeal(driver: Driver): Promise<{ removed: number }> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (:Task|Skill|Event)-[r {source: 'self-heal'}]->(:Task|Skill|Event)
       WITH collect(r) AS rs
       UNWIND rs AS r
       DELETE r
       RETURN size(rs) AS removed`,
    );
    const removed = result.records[0]?.get("removed")?.toNumber?.() ?? 0;
    log.info("self-heal: reverted edges", { removed });
    return { removed };
  } finally {
    await session.close();
  }
}
