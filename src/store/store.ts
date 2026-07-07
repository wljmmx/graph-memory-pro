/**
 * graph-memory-pro — Neo4j 数据操作层（barrel 重新导出）
 *
 * 本文件仅作为聚合入口，所有实现已按职责拆分到子模块：
 *   - schema.ts:    Schema 初始化 + 共享工具（computeEmbeddingHash / recordToNode 等）
 *   - nodes.ts:     节点 CRUD（upsertNode / findById / searchNodes / vectorSearchWithScore ...）
 *   - edges.ts:     边 CRUD 与节点合并（upsertEdge / mergeNodes / getEdgesForNodes ...）
 *   - feedback.ts:  I-3 反馈持久化（upsertFeedback / getFeedbackCount ...）
 *   - community.ts: 社区管理（updateCommunities / getCommunitySummary ...）
 *   - vector.ts:    向量索引（saveVector / getVectorHash）
 *   - messages.ts:  消息存储（saveMessage / getSessionMessages ...）
 *
 * 注意：不使用 APOC 插件，所有操作使用原生 Cypher 实现
 *
 * 向后兼容：现有 `import { ... } from "../store/store.ts"` 全部继续工作。
 */

// ─── Schema 初始化 + 共享工具 ───────────────────────────────
export { computeEmbeddingHash, ensureSchema } from "./schema.ts";

// ─── 节点 CRUD ──────────────────────────────────────────────
export {
  upsertNode,
  findById,
  searchNodes,
  vectorSearchWithScore,
  graphWalk,
  getNodeCount,
  getNodesByType,
  getTopNodes,
} from "./nodes.ts";

// ─── 边 CRUD 与节点合并 ─────────────────────────────────────
export {
  upsertEdge,
  getEdgeCount,
  getEdgesForNodes,
  mergeNodes,
} from "./edges.ts";

// ─── I-3 反馈持久化 ─────────────────────────────────────────
export {
  upsertFeedback,
  getFeedbackCount,
  getNodeFeedbackStats,
} from "./feedback.ts";
export type { GmFeedback } from "./feedback.ts";

// ─── 社区管理 ──────────────────────────────────────────────
export {
  updateCommunities,
  getCommunitySummary,
  getAllCommunitySummaries,
  upsertCommunitySummary,
  pruneCommunitySummaries,
  communityRepresentatives,
  communityVectorSearch,
  communityVectorSearchWithReps,
  nodesByCommunityIds,
} from "./community.ts";

// ─── 向量索引 ──────────────────────────────────────────────
export { saveVector, getVectorHash } from "./vector.ts";

// ─── 消息存储 ──────────────────────────────────────────────
export {
  saveMessage,
  getSessionMessages,
  getRecentDistinctMessages,
} from "./messages.ts";
