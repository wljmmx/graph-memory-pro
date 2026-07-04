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
  options?: Record<string, number | boolean | string>;
  keepAlive?: string;
}

/** Timing / latency distribution options */
export interface GmTimingOptions {
  /** Enable per-phase timing collection */
  enabled: boolean;
  /** Number of samples to keep per phase before rolling (default 1000) */
  maxSamples?: number;
  /** Print distribution report every N calls (0 = disabled, default 50) */
  reportEveryN?: number;
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
  /** Latency distribution tracking (optional) */
  timing?: GmTimingOptions;
  /** 后台服务间隔配置（A 方案：三元组提取 + 图谱维护） */
  background?: {
    extractorIntervalMs?: number;
    maintenanceIntervalMs?: number;
  };

  // ── v2.1.2 第一批 Schema 升级 + 监控基础 ────────────

  /** S-1 Bi-Temporal 时态字段（默认开启，仅添加字段不影响现有逻辑） */
  temporal?: {
    enabled?: boolean;
    /** 默认 source 类型（提取出的节点） */
    defaultSource?: NodeSource;
  };

  /** S-13 状态追踪（默认关闭，mergeNodes 时启用 state 标记） */
  state?: {
    enabled?: boolean;
    /** 是否在召回时过滤 superseded 节点 */
    filterSupersededInRecall?: boolean;
  };

  /** S-14 过时检测（默认关闭，maintenance 周期计算 stalenessScore） */
  staleness?: {
    enabled?: boolean;
    /** 降权阈值（>0.7 在召回时降权） */
    threshold?: number;
    /** heuristic 规则模式 / llm 模式 */
    mode?: "heuristic" | "llm";
  };

  /** S-5 因果边提取（默认开启，单轮即可识别因果链） */
  causalEdges?: {
    enabled?: boolean;
    /** 提取时是否同时建边 */
    extract?: boolean;
  };

  /** G-5 图谱健康指标（默认开启，运维刚需） */
  graphHealth?: {
    enabled?: boolean;
    /** 异常告警（孤立节点突增等） */
    alertOnAnomaly?: boolean;
  };
}

export type NodeType = "TASK" | "SKILL" | "EVENT";

export type EdgeType =
  | "USED_SKILL"
  | "SOLVED_BY"
  | "REQUIRES"
  | "PATCHES"
  | "CONFLICTS_WITH"
  | "RELATES_TO"
  // S-5 因果关系（v2.1.2 新增）
  | "CAUSED_BY"   // EVENT → EVENT：A 事件直接导致 B 事件
  | "LEADS_TO";   // TASK → EVENT：任务执行产生了某事件

export type NodeStatus = "active" | "deprecated" | "merged";

/**
 * S-13 状态追踪：节点生命周期状态
 * - current: 当前有效（默认）
 * - superseded: 已被新版本替代
 * - transitional: 矛盾待消解（G-2 冲突消解阶段处理）
 */
export type NodeState = "current" | "superseded" | "transitional";

/**
 * S-3 来源标记：节点的知识来源
 * - experience: 从对话中提取的个人经验（默认）
 * - knowledge: 外部权威知识（文档/规范/官方文档）
 * - imported: 用户手动导入
 */
export type NodeSource = "experience" | "knowledge" | "imported";

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

  // ── S-1 Bi-Temporal（v2.1.2 新增）─────────────────
  /** 事件实际发生时间（validFrom），若未指定则 = createdAt */
  validFrom?: number;
  /** 失效时间（null 或 undefined = 仍有效）；S-2 软替换时设置 */
  validTo?: number;
  /** 写入图的时间（= createdAt，显式字段便于查询） */
  recordedAt?: number;

  // ── S-3 来源标记（v2.1.2 新增）───────────────────
  /** 知识来源，默认 "experience" */
  source?: NodeSource;
  /** 被哪个新版本替代（state=superseded 时指向新节点 id） */
  supersededBy?: string;

  // ── S-13 状态追踪（v2.1.2 新增）─────────────────
  /** 生命周期状态，默认 "current" */
  state?: NodeState;

  // ── S-14 过时检测（v2.1.2 新增）─────────────────
  /** 过时分数 0~1（0=新鲜，1=完全过时），>0.7 在召回时降权 */
  stalenessScore?: number;

  // ── G-3 重要性评分（v2.1.2 新增，将在第三批启用）──
  /** 重要性评分 0~1，由 recency/frequency/centrality/source 加权得出 */
  importanceScore?: number;

  // ── G-4 嵌入模型版本（v2.1.2 新增）─────────────
  /** 嵌入时使用的模型名，用于检测模型迁移 */
  embeddingModel?: string;
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


/**
 * Predefined Embedding Model Presets
 */
export interface EmbeddingModelPreset {
  model: string;
  dimensions: number;
  baseURL?: string;
  description: string;
}

export const EMBEDDING_PRESETS: Record<string, EmbeddingModelPreset> = {
  "text-embedding-3-small": {
    model: "text-embedding-3-small",
    dimensions: 1024,
    description: "OpenAI text-embedding-3-small",
  },
  "nomic-embed-text": {
    model: "nomic-embed-text",
    dimensions: 768,
    description: "Nomic Embed Text (Ollama)",
  },
  "qwen3.5-embedding-0.6b": {
    model: "Qwen3.5-Embedding-0.6B-GGUF",
    dimensions: 1024,
    baseURL: "http://localhost:11434/v1",
    description: "Qwen3.5 Embedding 0.6B GGUF (Ollama, local)",
  },
};
