import type { Driver } from "neo4j-driver";
import type { EmbedFn } from "../engine/embed.ts";
import { createHash } from "node:crypto";

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
              await session.run(
                "MATCH (n:Task|Skill|Event {id: $nodeId})" +
                " SET n.embedding = $vec, n.embeddingHash = $hash",
                { nodeId, vec, hash: createHash("md5").update(text).digest("hex") },
              );
              reEmbedded++;
            } else {
              skipped++;
            }
          } catch (err) {
            failed++;
          }
        }

        totalScanned += nodes.length;
      } finally {
        await session.close();
      }
    } catch (err) {
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
