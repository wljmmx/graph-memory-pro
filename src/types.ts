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
  /** Ollama keep_alive 参数（仅 Ollama 识别，OpenAI 会忽略） */
  keepAlive?: string;
  /** v2.3.2 阶段二: 最大并发请求数（默认 1 for Ollama 本地，可调高 for 云端） */
  maxConcurrency?: number;
}

export interface EmbeddingConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimensions?: number;
  options?: Record<string, number | boolean | string>;
  keepAlive?: string;
  /** v2.3.2 阶段二: LRU 缓存容量（默认 256，设为 0 禁用缓存） */
  cacheSize?: number;
  /** v2.3.2 阶段二: LRU 缓存 TTL（默认 10min） */
  cacheTtlMs?: number;
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

  // ── v2.1.2 第二批 反馈闭环 + 冷启动 ────────────

  /** I-1 历史查询缓存（默认开启，LRU + cosine 相似复用） */
  queryCache?: {
    enabled?: boolean;
    maxSize?: number;
    ttlMs?: number;
    similarityThreshold?: number;
  };

  /** I-2 LLM 裁判反馈（v2.2.0：支持 Tier 1/2/3） */
  judge?: {
    enabled?: boolean;
    asyncMode?: boolean;
    judgeWarmupFeedbacks?: number;
    heuristicMatch?: "id" | "name" | "both";
    /** 裁判层级（v2.2.0：1=启发式 / 2=LLM / 3=自定义） */
    tier?: 1 | 2 | 3;
    /** Tier 2 LLM 裁判单次最大节点数（默认 10） */
    llmJudgeMaxNodes?: number;
    /** Tier 2 LLM 裁判超时（ms，默认 8000） */
    llmJudgeTimeoutMs?: number;
    /** Tier 3 自定义策略名称（需先通过 JudgeManager.registerStrategy 注册） */
    customStrategy?: string;
  };

  /** I-3 反馈持久化（默认开启） */
  feedback?: {
    enabled?: boolean;
    /** 反馈保留天数（TTL，默认 90 天） */
    retentionDays?: number;
  };

  /** G-6 冷启动策略 */
  warmup?: {
    /** M 矩阵冷启动阈值（累计反馈数，默认 100） */
    warmupFeedbacks?: number;
    /** 裁判冷启动阈值（默认 50） */
    judgeWarmupFeedbacks?: number;
  };

  // ── v2.1.2 第三批 在线学习 + 可进化嵌入 + 重要性评分 ────────────

  /** L-1 关联矩阵 M（默认关闭，需显式启用） */
  associationMatrix?: {
    enabled?: boolean;
    /** 学习率 η（默认 0.01） */
    learningRate?: number;
    /** Momentum 系数（默认 0.9） */
    momentum?: number;
    /** Adam β1（默认 0.9） */
    adamBeta1?: number;
    /** Adam β2（默认 0.999） */
    adamBeta2?: number;
    /** M 矩阵冷启动阈值（覆盖 warmup.warmupFeedbacks） */
    warmupFeedbacks?: number;
  };

  /** R-3 边际效用奖励（默认开启，仅在 L-1 启用时生效） */
  marginalUtility?: {
    enabled?: boolean;
    /** 语义邻域大小（默认 5，从历史 query 中找最相似 N 个） */
    neighborhoodSize?: number;
    /** 邻域整体需达到的最小提升（低于则放弃 M 更新，防过拟合） */
    minImprovement?: number;
  };

  /** R-4 可进化嵌入（默认开启） */
  evolvableEmbedding?: {
    enabled?: boolean;
    /** content 变化时触发重新嵌入（默认 true） */
    reembedOnContentChange?: boolean;
    /** 旧嵌入归档保留条数（默认 3，超出则丢弃最旧） */
    archiveKeepCount?: number;
  };

  /** G-3 重要性评分（默认开启） */
  importance?: {
    enabled?: boolean;
    /** 各分量权重（默认 0.3/0.3/0.2/0.2，内部自动归一化） */
    weights?: {
      recency?: number;
      frequency?: number;
      centrality?: number;
      source?: number;
    };
    /** recency 衰减周期（天，默认 30） */
    recencyDecayDays?: number;
    /** frequency 饱和阈值（默认 10 次） */
    frequencySaturation?: number;
  };

  // ── v2.1.2 第四批 结构升级 + 冲突消解 + 嵌入版本 ────────────

  /** S-4 层次化社区（默认开启，depth=3） */
  hierarchicalCommunity?: {
    enabled?: boolean;
    /** 层次深度（1=单层, 2=社区+主题, 3=社区+主题+领域） */
    depth?: 1 | 2 | 3;
  };

  /** G-2 冲突消解（默认开启） */
  conflictResolution?: {
    enabled?: boolean;
    /** 时态优先（validFrom 更新者胜出） */
    temporalPriority?: boolean;
    /** 来源优先（knowledge > experience > imported） */
    sourcePriority?: boolean;
    /** 置信度优先（validatedCount 高者胜出） */
    confidencePriority?: boolean;
  };

  /** L-3 边权重调整（默认开启，需 I-2 反馈数据） */
  edgeWeights?: {
    enabled?: boolean;
    /** 强化系数（默认 1.1） */
    strengthenFactor?: number;
    /** 衰减系数（默认 0.95） */
    decayFactor?: number;
    /** weight 最小值（默认 0.1） */
    minWeight?: number;
    /** weight 最大值（默认 5.0） */
    maxWeight?: number;
  };

  /** L-4 反向记忆项（默认开启，需 I-2 反馈数据） */
  reverseMemory?: {
    enabled?: boolean;
    /** 召回频次阈值（默认 10 次） */
    recallThreshold?: number;
    /** stalenessScore 增量（默认 0.1） */
    stalenessPenalty?: number;
    /** importanceScore 下限（默认 0.2） */
    importanceFloor?: number;
  };

  // ── v2.1.2 第五批 Benchmark + 自主调优 ────────────

  /** S-10 Benchmark 评测（默认关闭） */
  benchmark?: {
    enabled?: boolean;
    /** 数据目录（默认 benchmarks/data） */
    dataDir?: string;
    /** 单次评测最大样本数（0 = 全部） */
    maxCases?: number;
    /** 评测前是否先用对话历史建图谱 */
    buildGraph?: boolean;
    /** 单样本超时（ms） */
    caseTimeoutMs?: number;
  };

  /** R-1 自主调优 EvolveMem（默认关闭） */
  autoTuner?: {
    enabled?: boolean;
    /** revert-on-regression 阈值（默认 0.02 = 2pp） */
    regressionThreshold?: number;
    /** explore-on-stagnation 阈值（默认 5 轮） */
    stagnationThreshold?: number;
    /** 最大调优轮次（默认 10） */
    maxRounds?: number;
    /** 单次评测最大样本数（默认 50） */
    benchmarkMaxCases?: number;
    /** 是否启用 LLM 诊断（默认 true，false 则仅用启发式） */
    llmDiagnosis?: boolean;
    /** 冷启动阈值（累计反馈 < 此值时不触发，默认 100） */
    warmupFeedbacks?: number;
  };

  /** MCP Server 配置（v2.2.0 新增，对外暴露 13 个 tools） */
  mcp?: {
    /** 是否启用 MCP server（默认 false） */
    enabled?: boolean;
    /** 监听端口（默认 7800） */
    port?: number;
    /** 监听地址（默认 127.0.0.1，对外暴露设为 0.0.0.0） */
    host?: string;
    /** HTTP 路径（默认 /mcp） */
    path?: string;
    /** Bearer Token 鉴权（为空则不鉴权） */
    authToken?: string;
    /** 启用的工具列表（省略则全部启用） */
    enabledTools?: string[];
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

  // ── R-4 可进化嵌入（v2.1.2 第三批新增）─────────
  /** content 的 MD5 hash，用于检测 content 是否实质变化 */
  embeddingHash?: string;
  /** 历史嵌入存档（content 变化时旧嵌入归档，最近的在前） */
  embeddingHistory?: Array<{
    embedding: number[];
    embeddingModel?: string;
    embeddingHash?: string;
    archivedAt: number;
  }>;

  // ── S-4 层次化社区（v2.1.2 第四批新增）─────────
  /** Level 2 主题 id（社区→主题） */
  topicId?: string;
  /** Level 3 领域 id（主题→领域） */
  domainId?: string;
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
