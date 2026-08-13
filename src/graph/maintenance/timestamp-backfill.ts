/**
 * graph-memory-pro — 时序字段回填（Maintenance 集成 Phase）
 *
 * 背景：历史/批量导入的节点可能缺少 updatedAt / createdAt / recordedAt，
 *      导致时序新鲜度、过时衰减、重要性计算失真（缺失被当作"最新"）。
 * 修复：对缺失时序字段的节点做幂等回填：
 *   - 优先使用节点已有 timestamp 属性（部分导入器会写入消息时间戳）
 *   - 其次使用 createdAt / updatedAt 相互推导
 *   - 最后回退到当前时间（后续写入会覆盖为真实值）
 *
 * 该能力集成在 runMaintenance 中，不单独暴露为独立工具（遵循"在现有维护工具中集成"）。
 */

import type { Driver } from "neo4j-driver";
import { getSession } from "../../store/db.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("maintenance:timestamp");

/** 参与时序回填的节点类型（与图谱业务节点一致） */
const TIMESTAMP_LABELS = [":Task", ":Skill", ":Event", ":Experience", ":MemoryFile", ":DAG_Summary"];

export interface TimestampBackfillResult {
  scanned: number;
  backfilled: number;
}

/**
 * 幂等回填缺失的时序字段。
 * 重复执行不会把已有正确值覆盖（用 COALESCE 只补空）。
 */
export async function backfillTimestamps(driver: Driver): Promise<TimestampBackfillResult> {
  const session = getSession(driver);
  try {
    // 先统计需要回填的节点数
    const scan = await session.run(
      `MATCH (n) WHERE (${TIMESTAMP_LABELS.map((l) => `n${l}`).join(" OR ")}) 
       AND (n.updatedAt IS NULL OR n.createdAt IS NULL OR n.recordedAt IS NULL)
       RETURN count(n) AS c`,
    );
    const scanned = scan.records[0]?.get("c")?.toNumber?.() ?? 0;
    if (scanned === 0) {
      return { scanned: 0, backfilled: 0 };
    }

    const result = await session.run(
      `MATCH (n) WHERE (${TIMESTAMP_LABELS.map((l) => `n${l}`).join(" OR ")}) 
       AND (n.updatedAt IS NULL OR n.createdAt IS NULL OR n.recordedAt IS NULL)
       WITH n, COALESCE(n.timestamp, n.createdAt, n.updatedAt) AS srcTs
       SET n.recordedAt = COALESCE(n.recordedAt, srcTs, timestamp()),
           n.updatedAt = COALESCE(n.updatedAt, n.createdAt, srcTs, timestamp()),
           n.createdAt = COALESCE(n.createdAt, srcTs, timestamp())
       RETURN count(n) AS c`,
    );
    const backfilled = result.records[0]?.get("c")?.toNumber?.() ?? 0;
    log.info("timestamp backfill", { scanned, backfilled });
    return { scanned, backfilled };
  } finally {
    await session.close();
  }
}