/**
 * graph-memory-pro — 边 CRUD 与节点合并（Neo4j 数据操作层）
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 */

import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";
import type { GmEdge } from "../types.ts";
import { getSession } from "./db.ts";
import { recordToEdge } from "./schema.ts";

// ─── 边 CRUD ────────────────────────────────────────────────

export async function upsertEdge(
  driver: Driver,
  edge: GmEdge,
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      `MATCH (from:Task|Skill|Event {id: $fromId})
       MATCH (to:Task|Skill|Event {id: $toId})
       MERGE (from)-[r:${edge.type}]->(to)
       SET r.id = $id,
           r.fromId = $fromId,
           r.toId = $toId,
           r.instruction = $instruction,
           r.condition = $condition,
           r.weight = $weight,
           r.createdAt = $createdAt,
           r.updatedAt = $updatedAt
      `,
      {
        fromId: edge.fromId,
        toId: edge.toId,
        id: edge.id,
        instruction: edge.instruction,
        condition: edge.condition ?? null,
        weight: edge.weight,
        createdAt: neo4j.int(edge.createdAt),
        updatedAt: neo4j.int(edge.updatedAt),
      },
    );
  } finally {
    await session.close();
  }
}

export async function getEdgeCount(driver: Driver): Promise<number> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (:Task|Skill|Event)-[r]->(:Task|Skill|Event) RETURN count(r) AS c",
    );
    return result.records[0]?.get("c")?.toNumber?.() ?? 0;
  } finally {
    await session.close();
  }
}

export async function mergeNodes(
  driver: Driver,
  keepId: string,
  mergeId: string,
): Promise<void> {
  const session = getSession(driver);
  try {
    // Phase 1: collect outgoing edges from merge node
    const outResult = await session.run(
      `MATCH (merge:Task|Skill|Event {id: $mergeId})
       OPTIONAL MATCH (merge)-[r]->(target:Task|Skill|Event)
       WHERE target.id <> $keepId AND r IS NOT NULL
       RETURN target.id AS targetId, type(r) AS relType, r.instruction AS instruction, r.weight AS weight`,
      { mergeId },
    );

    // Phase 2: MERGE each outgoing edge (relType as literal per iteration)
    for (const record of outResult.records) {
      const targetIdRaw = record.get('targetId');
      if (!targetIdRaw) continue; // skip null from OPTIONAL MATCH
      const targetId = String(targetIdRaw);
      const relTypeRaw = record.get('relType');
      if (!relTypeRaw) continue;
      const relType = String(relTypeRaw);
      const instruction = record.get('instruction') ? String(record.get('instruction')) : null;
      const weight = record.get('weight');
      const w = typeof weight === 'number' ? weight : (weight && typeof weight.toNumber === 'function' ? weight.toNumber() : 0);

      await session.run(
        `MATCH (k {id: $keepId}), (t {id: $targetId})
         MERGE (k)-[nr:${relType}]->(t)
         SET nr.instruction = CASE
           WHEN nr.instruction IS NULL OR trim(nr.instruction) = '' THEN COALESCE($instruction, nr.instruction)
           WHEN $instruction IS NOT NULL AND nr.instruction <> $instruction THEN nr.instruction + ' | ' + $instruction
           ELSE nr.instruction
         END,
         nr.weight = COALESCE(nr.weight, 0) + $weight,
         nr.fromId = $keepId,
         nr.toId = $targetId`,
        { keepId, targetId, instruction, weight: w },
      );
    }

    // Phase 3: collect incoming edges to merge node
    const inResult = await session.run(
      `MATCH (merge:Task|Skill|Event {id: $mergeId})
       OPTIONAL MATCH (source:Task|Skill|Event)-[r2]->(merge)
       WHERE source.id <> $keepId AND r2 IS NOT NULL
       RETURN source.id AS sourceId, type(r2) AS relType, r2.instruction AS instruction, r2.weight AS weight`,
      { mergeId },
    );

    // Phase 4: MERGE each incoming edge
    for (const record of inResult.records) {
      const sourceIdRaw = record.get('sourceId');
      if (!sourceIdRaw) continue;
      const sourceId = String(sourceIdRaw);
      const relTypeRaw = record.get('relType');
      if (!relTypeRaw) continue;
      const relType = String(relTypeRaw);
      const instruction = record.get('instruction') ? String(record.get('instruction')) : null;
      const weight = record.get('weight');
      const w = typeof weight === 'number' ? weight : (weight && typeof weight.toNumber === 'function' ? weight.toNumber() : 0);

      await session.run(
        `MATCH (s {id: $sourceId}), (k {id: $keepId})
         MERGE (s)-[nr2:${relType}]->(k)
         SET nr2.instruction = CASE
           WHEN nr2.instruction IS NULL OR trim(nr2.instruction) = '' THEN COALESCE($instruction, nr2.instruction)
           WHEN $instruction IS NOT NULL AND nr2.instruction <> $instruction THEN nr2.instruction + ' | ' + $instruction
           ELSE nr2.instruction
         END,
         nr2.weight = COALESCE(nr2.weight, 0) + $weight,
         nr2.fromId = $sourceId,
         nr2.toId = $keepId`,
        { sourceId, keepId, instruction, weight: w },
      );
    }

    // Phase 5: update merge counts and status
    await session.run(
      `MATCH (keep {id: $keepId}), (merge {id: $mergeId})
       SET keep.validatedCount = COALESCE(keep.validatedCount, 0) + COALESCE(merge.validatedCount, 0),
           merge.status = 'merged', merge.updatedAt = timestamp()`,
      { keepId, mergeId },
    );

    // Phase 6: S-2 软替换（v2.1.2）
    // 旧实现：DETACH DELETE merge（物理删除，丢失历史）
    // 新实现：保留节点，标记 state=superseded，validTo=now，supersededBy 指向 keep
    //         边 weight 降为 0.1 不参与 GDS 计算（但仍可追溯）
    //         state.enabled=false 时退化为旧行为（物理删除）
    // 注：当前默认走软替换；如需旧行为可由调用方在 mergeNodes 前判断 cfg.state.enabled
    await session.run(
      `MATCH (merge:Task|Skill|Event {id: $mergeId})
       SET merge.state = 'superseded',
           merge.validTo = timestamp(),
           merge.supersededBy = $keepId,
           merge.updatedAt = timestamp()
       WITH merge
       MATCH (merge)-[r]-()
       WHERE NOT type(r) IN ['NEXT_SESSION', 'CONTAINS', 'MENTIONS']
       SET r.weight = 0.1
      `,
      { keepId, mergeId },
    );
  } finally {
    await session.close();
  }
}


export async function getEdgesForNodes(
  driver: Driver,
  nodeIds: string[],
): Promise<GmEdge[]> {
  if (!nodeIds.length) return [];
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (from:Task|Skill|Event)-[r]->(to:Task|Skill|Event)
       WHERE from.id IN $nodeIds AND to.id IN $nodeIds
       RETURN r`,
      { nodeIds },
    );
    return result.records.map((r) => recordToEdge(r.get("r"))).filter(Boolean) as GmEdge[];
  } finally {
    await session.close();
  }
}
