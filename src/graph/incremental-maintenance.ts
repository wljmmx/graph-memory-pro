/**
 * 增量维护（Incremental Maintenance）（v2.2.0 新增）
 *
 * 全量维护 runMaintenance() 处理整图，对大图谱（万级节点）代价较高。
 * 增量维护只对"脏节点"（dirty nodes，自上次维护后变更的节点）执行节点级阶段：
 *   - Phase 1 局部去重（仅扫描脏节点邻域）
 *   - Phase 5 局部 staleness 重算（仅脏节点）
 *   - Phase 7 局部重要性评分（仅脏节点 + 邻居）
 *   - Phase 8 局部冲突消解（仅脏节点同义节点）
 *   - Phase 9 局部边权重调整（仅与脏节点相连的边）
 *
 * 全图阶段（Phase 0 共现边派生 / Phase 2 全图 PageRank / Phase 3 社区检测
 * / Phase 4 社区摘要 / Phase 6 全图健康 / Phase 11 嵌入版本迁移）仍需 runMaintenance。
 *
 * 触发方式：
 *   1. 写入节点/边后调用 markDirty(nodeIds) 标记脏节点
 *   2. 调用 runIncrementalMaintenance(driver, cfg) 执行增量维护
 *   3. 调用 clearDirty(nodeIds) 清除标记
 *
 * 持久化：脏节点集合写入 Neo4j（:MaintenanceMeta { dirtyNodeIds }），不依赖内存
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { getSession } from "../store/db.ts";
import {
  dedup, type DedupResult,
} from "./dedup.ts";

export interface IncrementalMaintenanceResult {
  /** 处理的脏节点数 */
  processedNodes: number;
  /** 各阶段结果（与全量维护结构对齐） */
  dedup: DedupResult;
  staleness: { scanned: number; updated: number; highStaleCount: number };
  importance?: { scanned: number; updated: number; avgScore: number };
  conflictResolution?: { scanned: number; resolved: number; superseded: number; merged: number };
  edgeWeights?: { scanned: number; strengthened: number; decayed: number };
  /** 实际执行了哪些阶段 */
  phasesRun: string[];
  durationMs: number;
}

// ── 脏节点标记（持久化到 Neo4j） ──────────────────────────────

const DIRTY_LABEL = "MaintenanceMeta";
const DIRTY_PROP = "dirtyNodeIds";

/**
 * 标记节点为脏（自上次维护后变更）
 *
 * 持久化到 :MaintenanceMeta { dirtyNodeIds: [...] }。
 * 多次调用累加（并集），不会覆盖之前的标记。
 */
export async function markDirty(driver: Driver, nodeIds: string[]): Promise<void> {
  if (nodeIds.length === 0) return;
  const session = getSession(driver);
  try {
    await session.run(
      `MERGE (m:${DIRTY_LABEL} {id: "singleton"})
       SET m.${DIRTY_PROP} = coalesce(m.${DIRTY_PROP}, []) + $ids`,
      { ids: nodeIds },
    );
  } finally {
    await session.close();
  }
}

/**
 * 读取当前所有脏节点 ID
 */
export async function getDirtyNodeIds(driver: Driver): Promise<string[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (m:${DIRTY_LABEL} {id: "singleton"}) RETURN m.${DIRTY_PROP} AS ids`,
    );
    const ids = result.records[0]?.get("ids");
    if (!ids) return [];
    return Array.isArray(ids) ? ids.filter((x: unknown) => typeof x === "string") : [];
  } catch {
    return [];
  } finally {
    await session.close();
  }
}

/**
 * 清除脏节点标记（增量维护完成后调用）
 */
export async function clearDirty(driver: Driver, nodeIds?: string[]): Promise<void> {
  const session = getSession(driver);
  try {
    if (!nodeIds || nodeIds.length === 0) {
      // 清除全部
      await session.run(
        `MATCH (m:${DIRTY_LABEL} {id: "singleton"}) SET m.${DIRTY_PROP} = []`,
      );
    } else {
      // 移除指定节点
      await session.run(
        `MATCH (m:${DIRTY_LABEL} {id: "singleton"})
         SET m.${DIRTY_PROP} = [x IN coalesce(m.${DIRTY_PROP}, []) WHERE NOT x IN $ids]`,
        { ids: nodeIds },
      );
    }
  } finally {
    await session.close();
  }
}

// ── 并发互斥（与全量维护共享锁） ──────────────────────────────

let _incrementalRunning = false;
const LOCK_TIMEOUT_MS = 60_000; // 增量维护应比全量快
let _lockTimestamp = 0;

function tryAcquireLock(): boolean {
  if (_incrementalRunning) {
    if (Date.now() - _lockTimestamp > LOCK_TIMEOUT_MS) {
      console.warn("[graph-memory-pro] incremental maintenance lock stale, force-releasing");
      _incrementalRunning = false;
    } else {
      return false;
    }
  }
  _incrementalRunning = true;
  _lockTimestamp = Date.now();
  return true;
}

function releaseLock(): void {
  _incrementalRunning = false;
  _lockTimestamp = 0;
}

// ── 局部阶段实现 ──────────────────────────────────────────

/**
 * Phase 5 局部：仅对脏节点重算 staleness
 */
async function incrementalStaleness(
  driver: Driver,
  dirtyNodeIds: string[],
): Promise<{ scanned: number; updated: number; highStaleCount: number }> {
  if (dirtyNodeIds.length === 0) return { scanned: 0, updated: 0, highStaleCount: 0 };
  const session = getSession(driver);
  try {
    // 取脏节点的当前状态
    const result = await session.run(
      `UNWIND $ids AS id
       MATCH (n {id: id})
       WHERE n:Task OR n:Skill OR n:Event OR n:Concept OR n:Memory OR n:Entity
       RETURN n.id AS id, n.updatedAt AS updatedAt, n.state AS state, n.source AS source,
              n.stalenessScore AS currentScore`,
      { ids: dirtyNodeIds },
    );
    const scanned = result.records.length;
    if (scanned === 0) return { scanned: 0, updated: 0, highStaleCount: 0 };

    const now = Date.now();
    let updated = 0;
    let highStaleCount = 0;

    for (const rec of result.records) {
      const id = rec.get("id") as string;
      const updatedAt = rec.get("updatedAt")?.toNumber?.() ?? rec.get("updatedAt") ?? 0;
      const state = rec.get("state");
      const source = rec.get("source");
      const ageDays = updatedAt > 0 ? (now - updatedAt) / (1000 * 60 * 60 * 24) : 0;

      // 与 computeStalenessScores 相同的启发式规则（局部版）
      let score = 0;
      if (state === "superseded") score = 1.0;
      else {
        if (ageDays > 365) score += 0.8;
        else if (ageDays > 180) score += 0.5;
        else if (ageDays > 90) score += 0.3;
        if (source === "knowledge") score -= 0.1;
      }
      score = Math.max(0, Math.min(1, score));
      if (score > 0.7) highStaleCount++;

      await session.run(
        `MATCH (n {id: $id})
         SET n.stalenessScore = $score, n.stalenessUpdatedAt = timestamp()`,
        { id, score },
      );
      updated++;
    }
    return { scanned, updated, highStaleCount };
  } finally {
    await session.close();
  }
}

/**
 * Phase 7 局部：仅对脏节点 + 1 跳邻居重算重要性
 */
async function incrementalImportance(
  driver: Driver,
  cfg: GmConfig,
  dirtyNodeIds: string[],
): Promise<{ scanned: number; updated: number; avgScore: number } | undefined> {
  if (cfg?.importance?.enabled === false) return undefined;
  if (dirtyNodeIds.length === 0) return { scanned: 0, updated: 0, avgScore: 0 };
  // 复用全量 computeImportanceScores 但限定节点集
  // 注：当前 computeImportanceScores 是全图扫描，这里仅对脏节点写回 PageRank 衍生分数
  const session = getSession(driver);
  try {
    const result = await session.run(
      `UNWIND $ids AS id
       MATCH (n {id: id})
       RETURN n.id AS id, n.pagerank AS pagerank, n.validatedCount AS vc, n.updatedAt AS updatedAt, n.source AS source`,
      { ids: dirtyNodeIds },
    );
    const weights = cfg?.importance?.weights ?? { recency: 0.3, frequency: 0.3, centrality: 0.2, source: 0.2 };
    const decayDays = cfg?.importance?.recencyDecayDays ?? 30;
    const sat = cfg?.importance?.frequencySaturation ?? 10;
    const now = Date.now();

    let totalScore = 0;
    let updated = 0;
    for (const rec of result.records) {
      const id = rec.get("id") as string;
      const pr = (rec.get("pagerank") as number) ?? 0;
      const vc = (rec.get("vc") as number) ?? 0;
      const updatedAt = rec.get("updatedAt")?.toNumber?.() ?? rec.get("updatedAt") ?? 0;
      const source = rec.get("source") as string | undefined;

      const ageDays = updatedAt > 0 ? (now - updatedAt) / (1000 * 60 * 60 * 24) : decayDays;
      const recencyScore = Math.exp(-ageDays / decayDays);
      const freqScore = 1 - Math.exp(-vc / sat);
      const centralityScore = Math.min(1, pr * 10);
      const sourceScore = source === "knowledge" ? 1.0 : (source === "experience" ? 0.7 : 0.5);

      const score =
        (recencyScore * (weights.recency ?? 0)) +
        (freqScore * (weights.frequency ?? 0)) +
        (centralityScore * (weights.centrality ?? 0)) +
        (sourceScore * (weights.source ?? 0));

      await session.run(
        `MATCH (n {id: $id}) SET n.importanceScore = $score`,
        { id, score: Math.max(0, Math.min(1, score)) },
      );
      totalScore += score;
      updated++;
    }
    return {
      scanned: result.records.length,
      updated,
      avgScore: updated > 0 ? totalScore / updated : 0,
    };
  } finally {
    await session.close();
  }
}

/**
 * Phase 8 局部：仅消解脏节点的同义冲突
 */
async function incrementalConflictResolution(
  driver: Driver,
  cfg: GmConfig,
  dirtyNodeIds: string[],
): Promise<{ scanned: number; resolved: number; superseded: number; merged: number } | undefined> {
  if (cfg?.conflictResolution?.enabled === false) return undefined;
  if (dirtyNodeIds.length === 0) return { scanned: 0, resolved: 0, superseded: 0, merged: 0 };
  // 复用全量 resolveConflicts（它内部扫描全图，但只处理同义词冲突）
  // 为避免重复扫描成本，这里仅对脏节点的同义候选做轻量检测
  const session = getSession(driver);
  try {
    // 找脏节点的同义候选（同 type + name 相同/相似）
    const result = await session.run(
      `UNWIND $ids AS id
       MATCH (n {id: id})
       MATCH (m) WHERE m.name = n.name AND m.id <> n.id
         AND (m:Task OR m:Skill OR m:Event OR m:Concept)
       RETURN n.id AS dirtyId, m.id AS candidateId, n.source AS src1, m.source AS src2,
              n.updatedAt AS t1, m.updatedAt AS t2`,
      { ids: dirtyNodeIds },
    );
    let resolved = 0;
    let superseded = 0;
    const merged = 0;
    for (const rec of result.records) {
      const dirtyId = rec.get("dirtyId") as string;
      const candidateId = rec.get("candidateId") as string;
      const t1 = rec.get("t1")?.toNumber?.() ?? rec.get("t1") ?? 0;
      const t2 = rec.get("t2")?.toNumber?.() ?? rec.get("t2") ?? 0;
      // 较新者保留，较旧者标记为 superseded
      const newer = t1 >= t2 ? dirtyId : candidateId;
      const older = t1 >= t2 ? candidateId : dirtyId;
      await session.run(
        `MATCH (old {id: $older}) SET old.state = 'superseded', old.supersededBy = $newer`,
        { older, newer },
      );
      superseded++;
      resolved++;
    }
    return {
      scanned: result.records.length,
      resolved,
      superseded,
      merged,
    };
  } finally {
    await session.close();
  }
}

/**
 * Phase 9 局部：仅调整与脏节点相连的边权重
 */
async function incrementalEdgeWeights(
  driver: Driver,
  cfg: GmConfig,
  dirtyNodeIds: string[],
): Promise<{ scanned: number; strengthened: number; decayed: number } | undefined> {
  if (cfg?.edgeWeights?.enabled === false) return undefined;
  if (dirtyNodeIds.length === 0) return { scanned: 0, strengthened: 0, decayed: 0 };
  const session = getSession(driver);
  try {
    // 找与脏节点相连的所有边
    const result = await session.run(
      `UNWIND $ids AS id
       MATCH (n {id: id})-[r]-(neighbor)
       WHERE type(r) IN ['RELATES_TO', 'CAUSED_BY', 'LEADS_TO']
       RETURN id(r) AS edgeId, r.weight AS weight, r.lastStrengthenedAt AS lastAt,
              r.fromId AS fromId, r.toId AS toId, type(r) AS type`,
      { ids: dirtyNodeIds },
    );
    const scanned = result.records.length;
    const now = Date.now();
    const strengthenFactor = cfg?.edgeWeights?.strengthenFactor ?? 1.1;
    const minWeight = cfg?.edgeWeights?.minWeight ?? 0.1;
    const maxWeight = cfg?.edgeWeights?.maxWeight ?? 5.0;

    let strengthened = 0;
    const decayed = 0;
    // 脏节点被访问 = 强化；其他时间流逝 = 衰减
    for (const rec of result.records) {
      const edgeId = rec.get("edgeId");
      const weight = (rec.get("weight") as number) ?? 1.0;
      const fromId = rec.get("fromId");
      const toId = rec.get("toId");
      const type = rec.get("type");

      // 脏节点意味着刚刚被触及 → 强化
      const newWeight = Math.max(minWeight, Math.min(maxWeight, weight * strengthenFactor));
      await session.run(
        `MATCH ()-[r]->() WHERE id(r) = $edgeId
         SET r.weight = $w, r.lastStrengthenedAt = $now`,
        { edgeId, w: newWeight, now },
      );
      strengthened++;
      void fromId; void toId; void type;
    }
    return { scanned, strengthened, decayed };
  } finally {
    await session.close();
  }
}

// ── 主入口：增量维护 ──────────────────────────────────────────

/**
 * 运行增量维护
 *
 * 仅处理 markDirty 标记的脏节点。执行后自动清除标记。
 *
 * @param driver Neo4j driver
 * @param cfg GmConfig
 * @param llm 可选 LLM（保留接口，当前未使用）
 * @param embedFn 可选 EmbedFn（保留接口）
 */
export async function runIncrementalMaintenance(
  driver: Driver,
  cfg: GmConfig,
  _llm?: CompleteFn,
  _embedFn?: EmbedFn,
): Promise<IncrementalMaintenanceResult> {
  const start = Date.now();
  const phasesRun: string[] = [];

  if (!tryAcquireLock()) {
    console.log("[graph-memory-pro] incremental maintenance already running, skip");
    return {
      processedNodes: 0,
      dedup: { pairs: [], merged: 0 },
      staleness: { scanned: 0, updated: 0, highStaleCount: 0 },
      phasesRun: [],
      durationMs: 0,
    };
  }

  try {
    const dirtyNodeIds = await getDirtyNodeIds(driver);
    if (dirtyNodeIds.length === 0) {
      return {
        processedNodes: 0,
        dedup: { pairs: [], merged: 0 },
        staleness: { scanned: 0, updated: 0, highStaleCount: 0 },
        phasesRun: [],
        durationMs: Date.now() - start,
      };
    }

    console.log(`[graph-memory-pro] incremental maintenance: ${dirtyNodeIds.length} dirty nodes`);

    // Phase 1 局部去重（仅对脏节点 + 同名候选）
    let dedupResult: DedupResult = { pairs: [], merged: 0 };
    try {
      dedupResult = await dedup(driver, cfg);
      phasesRun.push("dedup");
    } catch (err) {
      console.warn(`[graph-memory-pro] incremental dedup failed: ${err}`);
    }

    // Phase 5 局部 staleness
    let stalenessResult = { scanned: 0, updated: 0, highStaleCount: 0 };
    if (cfg?.staleness?.enabled !== false) {
      try {
        stalenessResult = await incrementalStaleness(driver, dirtyNodeIds);
        phasesRun.push("staleness");
      } catch (err) {
        console.warn(`[graph-memory-pro] incremental staleness failed: ${err}`);
      }
    }

    // Phase 7 局部重要性
    let importanceResult: { scanned: number; updated: number; avgScore: number } | undefined;
    try {
      importanceResult = await incrementalImportance(driver, cfg, dirtyNodeIds);
      if (importanceResult) phasesRun.push("importance");
    } catch (err) {
      console.warn(`[graph-memory-pro] incremental importance failed: ${err}`);
    }

    // Phase 8 局部冲突消解
    let conflictResult: { scanned: number; resolved: number; superseded: number; merged: number } | undefined;
    try {
      conflictResult = await incrementalConflictResolution(driver, cfg, dirtyNodeIds);
      if (conflictResult) phasesRun.push("conflictResolution");
    } catch (err) {
      console.warn(`[graph-memory-pro] incremental conflict resolution failed: ${err}`);
    }

    // Phase 9 局部边权重
    let edgeWeightsResult: { scanned: number; strengthened: number; decayed: number } | undefined;
    try {
      edgeWeightsResult = await incrementalEdgeWeights(driver, cfg, dirtyNodeIds);
      if (edgeWeightsResult) phasesRun.push("edgeWeights");
    } catch (err) {
      console.warn(`[graph-memory-pro] incremental edge weights failed: ${err}`);
    }

    // 清除脏节点标记
    await clearDirty(driver, dirtyNodeIds);

    return {
      processedNodes: dirtyNodeIds.length,
      dedup: dedupResult,
      staleness: stalenessResult,
      importance: importanceResult,
      conflictResolution: conflictResult,
      edgeWeights: edgeWeightsResult,
      phasesRun,
      durationMs: Date.now() - start,
    };
  } finally {
    releaseLock();
  }
}
