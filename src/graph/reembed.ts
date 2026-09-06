import type { Driver } from "neo4j-driver";
import type { EmbedFn, BatchEmbedFn } from "../engine/embed.ts";
import type { GmConfig } from "../types.ts";
import { embedNode, embedNodeBatch, type BatchEmbedNodeItem } from "../store/embed-helper.ts";

export interface ReEmbedResult {
  totalScanned: number;
  reEmbedded: number;
  failed: number;
  skipped: number;
  durationMs: number;
  /**
   * v2.8.x: 是否因 AbortSignal 中止而提前结束（如 gm_reembed 外层超时）。
   * 为 true 时表示还有节点未处理，下次调用会从已嵌入节点之后继续。
   */
  aborted?: boolean;
  /**
   * v2.8.x: 最后一次失败的异常信息（诊断用）。
   * 此前 catch 静默吞错，出现 failed>0 时无法定位根因（如 Neo4j 查询报错、
   * embedding 字段坏类型、Ollama 连接失败等）。
   */
  lastError?: string;
}

export async function reEmbedNodes(
  driver: Driver,
  embedFn?: EmbedFn,
  batchSize = 50,
  embeddingModel?: string,
  cfg?: GmConfig,
  batchEmbedFn?: BatchEmbedFn,
  signal?: AbortSignal,
): Promise<ReEmbedResult> {
  if (!embedFn && !batchEmbedFn) {
    return { totalScanned: 0, reEmbedded: 0, failed: 0, skipped: 1, durationMs: 0 };
  }

  const start = Date.now();
  let totalScanned = 0;
  let reEmbedded = 0;
  let failed = 0;
  let skipped = 0;
  let consecutiveFailures = 0;
  let lastError: string | undefined;
  let lastBatchLen = 0;
  let advanced = false;
  const MAX_CONSECUTIVE_FAILURES = 5;

  while (true) {
    // v2.8.x: 外层 AbortSignal（如 gm_reembed 超时）触发时停止发起新批次，
    // 避免超时后孤儿循环继续处理剩余节点、与下一次调用并发写同一批。
    if (signal?.aborted) {
      return {
        totalScanned,
        reEmbedded,
        failed,
        skipped,
        durationMs: Date.now() - start,
        aborted: true,
        lastError,
      };
    }
    try {
      const session = driver.session();
      try {
        const result = await session.run(
          "MATCH (n:Task|Skill|Event)" +
          " WHERE n.status = 'active' AND (n.embedding IS NULL OR n.embedding = [])" +
          " RETURN n.id AS id, labels(n)[0] AS label, n.name, n.description, n.content" +
          " ORDER BY n.id SKIP toInteger($skip) LIMIT toInteger($limit)",
          { skip: totalScanned, limit: batchSize },
        );

        const nodes = result.records;
        if (nodes.length === 0) break;

        // Reset failure counter on successful query
        consecutiveFailures = 0;
        lastBatchLen = nodes.length;
        advanced = false;

        // v2.4.0: 批量嵌入——一次请求携带多个节点文本，显著减少 HTTP 请求数，
        // 降低本地 Ollama 请求队列压力（503 maximum pending 触发概率）。
        // 优先走 batchEmbedFn；未注入时回退到单文本 embedNode（向后兼容）。
        if (batchEmbedFn) {
          const items: BatchEmbedNodeItem[] = [];
          for (const rec of nodes) {
            const nodeId = rec.get("id") as string;
            const name = rec.get("name") || "";
            const desc = rec.get("description") || "";
            const content = rec.get("content") || "";
            if (!name.trim() && !desc.trim() && !content.trim()) {
              continue;
            }
            items.push({
              nodeId,
              params: {
                name,
                description: desc,
                content,
                embeddingModel: embeddingModel ?? undefined,
              },
            });
          }
          totalScanned += nodes.length;
          advanced = true;
          const embedded = await embedNodeBatch(driver, batchEmbedFn, items, cfg);
          reEmbedded += embedded;
          skipped += nodes.length - embedded;
          // v2.8.x: 整批 0 成功且确实发起了嵌入 → 记录提示（子批次错误被 batchEmbedFn 吞掉，
          // 需要日志/诊断才能定位，如 Ollama 模型 404、baseURL 不可达）
          if (embedded === 0 && items.length > 0 && !lastError) {
            lastError = `batch embed returned 0/${items.length} vectors (check embedding model "${embeddingModel ?? ""}" is pulled in Ollama, baseURL and Ollama logs)`;
            console.warn(`[graph-memory-pro] reEmbed: ${lastError}`);
          }
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }

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

            // v2.4.0 点2/点6: 通过 embedNode 统一处理记忆切片长度与长文本分段嵌入
            const vectors = await embedNode(driver, embedFn!, nodeId, {
              name,
              description: desc,
              content,
              embeddingModel: embeddingModel ?? undefined,
            }, cfg);
            if (vectors > 0) {
              reEmbedded++;
            } else {
              skipped++;
            }
          } catch (err) {
            // v2.8.x: 记录第一条失败详情（此前静默 failed++，37319 全失败时无法定位根因）
            failed++;
            if (!lastError) {
              lastError = (err as Error)?.message ?? String(err);
              console.warn(`[graph-memory-pro] reEmbed: first single-node failure: ${lastError}`);
            }
          }
        }

        totalScanned += nodes.length;
        advanced = true;
      } finally {
        await session.close();
      }
    } catch (err) {
      // v2.8.x: 记录错误 + 精确回滚，替代原「查询失败时 totalScanned += batchSize」的假扫描。
      // 原逻辑下查询失败仍假装扫描 50 节点，abort 时 totalScanned 虚高（如 4 次失败=200），
      // 且 SKIP 跳过未处理的批次造成静默数据丢失。
      failed++;
      lastError = (err as Error)?.message ?? String(err);
      consecutiveFailures++;
      // 仅当本批 totalScanned 已递增（embedNodeBatch 抛异常）时回滚到批头，
      // 保证重试同一批（已写入 embedding 的节点会被查询条件过滤，重试幂等安全）。
      // 查询本身失败时 advanced=false，totalScanned 未变，无需回滚。
      if (advanced && lastBatchLen > 0) {
        totalScanned -= lastBatchLen;
      }
      advanced = false;
      lastBatchLen = 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[graph-memory-pro] reEmbed: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, aborting: ${lastError}`);
        break;
      }
      // 瞬态失败（连接抖动 / Ollama 503）退避后重试同一批次
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    totalScanned,
    reEmbedded,
    failed,
    skipped,
    durationMs: Date.now() - start,
    lastError,
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
  /** v2.8.x: 有 embeddingModel 但缺 embedding 的节点数（建图写入缺步遗留，
   *  如 extract/gm_record 只写 embeddingModel 未算向量的 Task/Skill 节点） */
  missingEmbedding: number;
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
  batchEmbedFn?: BatchEmbedFn,
): Promise<MigrationResult & { reEmbed?: ReEmbedResult }> {
  if (!configuredModel) {
    return {
      configuredModel: "",
      modelDistribution: new Map(),
      needsMigration: 0,
      cleared: 0,
      migrationTriggered: false,
      missingEmbedding: 0,
    };
  }

  const session = driver.session();
  const modelDistribution = new Map<string, number>();
  let needsMigration = 0;
  let cleared = 0;
  let migrationTriggered = false;
  // v2.8.x: 有 embeddingModel 但缺向量 的节点数（建图写入缺步遗留，此前未被检测到）
  let missingEmbedding = 0;

  try {
    // 查询节点上 embeddingModel 的分布
    const distResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE n.embedding IS NOT NULL AND n.embedding <> []
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

    // v2.8.x 根因修复检测: 只统计「有 embeddingModel 但无向量」的节点。
    // 此前的分布查询只看有向量的节点，Task/Skill 这类从未被写入向量的节点
    // 对迁移逻辑完全不可见，导致 gm_maintain 每轮都跳过它们（缺失率恒 100%）。
    const missingResult = await session.run(
      `MATCH (n:Task|Skill|Event {status: 'active'})
       WHERE n.embeddingModel IS NOT NULL
         AND (n.embedding IS NULL OR n.embedding = [])
       RETURN count(n) AS cnt`,
    );
    missingEmbedding = missingResult.records[0]?.get("cnt")?.toNumber?.() ?? 0;
  } finally {
    await session.close();
  }

  // 触发迁移/补录：
  //   1) 模型不一致 → 清空不匹配节点的 embedding 后全量重嵌入（原逻辑）
  //   2) 存在「有 embeddingModel 但无向量」节点 → 直接补录（reEmbedNodes 只处理缺向量节点）
  if (needsMigration > 0 || missingEmbedding > 0) {
    migrationTriggered = true;
    const clearSession = driver.session();
    try {
      const clearResult = await clearSession.run(
        `MATCH (n:Task|Skill|Event {status: 'active'})
         WHERE n.embedding IS NOT NULL AND n.embedding <> []
           AND coalesce(n.embeddingModel, 'unknown') <> $configuredModel
         SET n.embedding = null, n.embeddingHash = null
         RETURN count(n) AS cleared`,
        { configuredModel },
      );
      cleared = clearResult.records[0]?.get("cleared")?.toNumber?.() ?? 0;

      console.log(
        `[graph-memory-pro] G-4 migration: model ${configuredModel}, cleared ${cleared} nodes (was: ${Array.from(modelDistribution.entries()).map(([m, c]) => `${m}=${c}`).join(", ")})` +
          (missingEmbedding > 0 ? `, backfilling ${missingEmbedding} nodes with embeddingModel but no embedding` : ""),
      );
    } finally {
      await clearSession.close();
    }

    // 触发全量重嵌入（清空的节点 + 缺向量的遗留节点都会被 reEmbedNodes 重新嵌入）
    if (embedFn || batchEmbedFn) {
      const reEmbed = await reEmbedNodes(driver, embedFn, 50, configuredModel, undefined, batchEmbedFn);
      return {
        configuredModel,
        modelDistribution,
        needsMigration,
        cleared,
        migrationTriggered,
        missingEmbedding,
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
    missingEmbedding,
  };
}
