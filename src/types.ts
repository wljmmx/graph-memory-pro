/**
 * graph-memory-pro — 类型定义
 */

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

export interface LlmConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export interface EmbeddingConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimensions?: number;
}

export interface GmConfig {
  neo4j: Neo4jConfig;
  compactTurnCount: number;
  recallMaxNodes: number;
  recallMaxDepth: number;
  freshTailCount: number;
  dedupThreshold: number;
  pagerankDamping: number;
  pagerankIterations: number;
  llm?: LlmConfig;
  embedding?: EmbeddingConfig;
}

export type NodeType = "TASK" | "SKILL" | "EVENT";

export type EdgeType =
  | "USED_SKILL"
  | "SOLVED_BY"
  | "REQUIRES"
  | "PATCHES"
  | "CONFLICTS_WITH";

export type NodeStatus = "active" | "deprecated" | "merged";

export interface GmNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  content: string;
  status: NodeStatus;
  communityId?: string;
  pagerank: number;
  validatedCount: number;
  createdAt: number;
  updatedAt: number;
  embedding?: number[];
}

export interface GmEdge {
  id: string;
  type: EdgeType;
  fromId: string;
  toId: string;
  instruction: string;
  condition?: string;
  weight: number;
  createdAt: number;
  updatedAt: number;
}

export interface GmSessionMetadata {
  sessionKey: string;
  assistantId?: string;
  assistantName?: string;
}

export interface GmMessage {
  id: string;
  sessionKey: string;
  turnIndex: number;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface RecallResult {
  nodes: GmNode[];
  edges: GmEdge[];
  tokenEstimate: number;
}

export interface ExtractResult {
  nodes: ExtractNode[];
  edges: ExtractEdge[];
}

export interface ExtractNode {
  type: NodeType;
  name: string;
  description: string;
  content: string;
}

export interface ExtractEdge {
  type: EdgeType;
  fromName: string;
  toName: string;
  instruction: string;
  condition?: string;
}

export interface CommunitySummary {
  communityId: string;
  summary: string;
  memberCount: number;
  embedding?: number[];
}
