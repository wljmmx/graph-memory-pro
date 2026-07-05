import type { Driver } from "neo4j-driver";
import type { EmbedFn } from "../engine/embed.ts";
import { computeEmbeddingHash } from "../store/store.ts";

export interface ReEmbedResult {
  totalScanned: number;
  reEmbedded: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export async function reEmbedNodes(
  driver: Driver,
  embedFn?: EmbedFn,
  batchSize = 50,
  embeddingModel?: string,
): Promise<ReEmbedResult> {
  if (!embedFn) {
    return { totalScanned: 0, reEmbedded: 0, failed: 0, skipped: 1, durationMs: 0 };
  }

  const start = Date.now();
  let totalScanned = 0;
  let reEmbedded = 0;
  let failed = 0;
  let skipped = 0;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;

  while (true) {
    try {
      const session = driver.session();
      try {
        const result = await session.run(
          "MATCH (n:Task|Skill|Event)" +
          " WHERE n.status = 'active' AND (n.embedding IS NULL OR size(n.embedding) = 0)" +
          " RETURN n.id AS id, labels(n)[0] AS label, n.name, n.description, n.content" +
          " ORDER BY n.id SKIP $skip LIMIT $limit",
          { skip: totalScanned, limit: batchSize },
        );

        const nodes = result.records;
        if (nodes.length === 0) break;

        // Reset failure counter on successful query
        consecutiveFailures = 0;

        for (const rec of nodes) {
          try {
            const nodeId = rec.get("id") as string;
            const name = rec.get("name") || "";
            const desc = rec.get("description") || "";
            const content = rec.get("content") || "";

            // 检查各字段是否都为空
            if (!name.trim() && !desc.trim() && !content.trim()) {
              skipped++;
              continue;
            }

            const text = name + ": " + desc + "\n" + content.slice(0, 500);

            const vec = await embedFn(text);
            if (vec && vec.length > 0) {
              // v2.2.0 fix: embeddingHash 统一使用 computeEmbeddingHash (md5(name|desc|content))
              await session.run(
                "MATCH (n:Task|Skill|Event {id: $nodeId})" +
                " SET n.embedding = $vec, n.embeddingHash = $hash, n.embeddingModel = $model",
                {
                  nodeId,
                  vec,
                  hash: computeEmbeddingHash(name, desc, content),
                  model: embeddingModel ?? null,
                },
              );
              reEmbedded++;
            } else {
              skipped++;
            }
          } catch {
            failed++;
          }
        }

        totalScanned += nodes.length;
      } finally {
        await session.close();
      }
    } catch {
      failed++;
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[graph-memory-pro] reEmbed: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, aborting`);
        break;
      }
      // 递增 totalScanned 避免死循环
      totalScanned += batchSize;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    totalScanned,
    reEmbedded,
    failed,
    skipped,
    durationMs: Date.now() - start,
  };
}

// ── G-4 嵌入模型版本化（v2.1.2 第四批新增）──────────────────────────

export interface MigrationResult {
  /** 配置的当前模型名 */
  configuredModel: string;
  /** 节点上记录的模型名分布 */
  modelDistribution: Map<string, number>;
  /** 需要迁移的节点数 */
  needsMigration: number;
  /** 已迁移的节点数（清空 embedding，等待 reembed 周期） */
  cleared: number;
  /** 迁移是否触发 */
  migrationTriggered: boolean;
}

/**
 * 检测嵌入模型迁移并触发重嵌入
 *
 * 简化方案（剔除双轨运行/版本化历史）：
 *   1. 对比配置的 model 与节点存储的 embeddingModel
 *   2. 不一致时，清空所有节点的 embedding（让 reembed 周期重算）
 *   3. 调用 reEmbedNodes 全量重嵌入
 *
 * @param driver Neo4j driver
 * @param embedFn 嵌入函数
 * @param configuredModel 当前配置的模型名（来自 cfg.embedding.model）
 * @returns 迁移结果
 */
export async function detectAndMigrateEmbeddings(
  driver: Driver,
  embedFn: EmbedFn | undefined,
  configuredModel?: string,
): Promise<MigrationResult & { reEmbed?: ReEmbedResult }> {
  if (!configuredModel) {
    return {
      configuredModel: "",
      modelDistribution: new Map(),
      needsMigration: 0,
      cleared: 0,
      migrationTriggered: false,
    };
  }

  const session = driver.session();
  const modelDistribution = new Map<string, number>();
  let needsMigration = 0;
  let cleared = 0;
  let migrationTriggered = false;

  try {
    // 查询节点上 embeddingModel 的分布
    const distResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE n.embedding IS NOT NULL AND size(n.embedding) > 0
       RETURN coalesce(n.embeddingModel, 'unknown') AS model, count(n) AS cnt
       ORDER BY cnt DESC`,
    );

    for (const rec of distResult.records) {
      const model = rec.get("model");
      const cnt = rec.get("cnt")?.toNumber?.() ?? 0;
      modelDistribution.set(model, cnt);

      // 模型名不一致 → 需要迁移
      if (model !== configuredModel) {
        needsMigration += cnt;
      }
    }
  } finally {
    await session.close();
  }

  // 触发迁移：清空 embeddingModel 不匹配的节点的 embedding
  if (needsMigration > 0) {
    migrationTriggered = true;
    const clearSession = driver.session();
    try {
      const clearResult = await clearSession.run(
        `MATCH (n:Task|Skill|Event {status: 'active'})
         WHERE n.embedding IS NOT NULL AND size(n.embedding) > 0
           AND coalesce(n.embeddingModel, 'unknown') <> $configuredModel
         SET n.embedding = null, n.embeddingHash = null
         RETURN count(n) AS cleared`,
        { configuredModel },
      );
      cleared = clearResult.records[0]?.get("cleared")?.toNumber?.() ?? 0;

      console.log(
        `[graph-memory-pro] G-4 migration: model ${configuredModel}, cleared ${cleared} nodes (was: ${Array.from(modelDistribution.entries()).map(([m, c]) => `${m}=${c}`).join(", ")})`,
      );
    } finally {
      await clearSession.close();
    }

    // 触发全量重嵌入（清空的节点会被 reEmbedNodes 重新嵌入）
    if (embedFn) {
      const reEmbed = await reEmbedNodes(driver, embedFn, 50, configuredModel);
      return {
        configuredModel,
        modelDistribution,
        needsMigration,
        cleared,
        migrationTriggered,
        reEmbed,
      };
    }
  }

  return {
    configuredModel,
    modelDistribution,
    needsMigration,
    cleared,
    migrationTriggered,
  };
}
