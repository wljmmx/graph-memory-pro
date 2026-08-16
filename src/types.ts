/**
 * graph-memory-pro — 类型定义
 */

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
  /** v2.3.5: 最大连接池大小（默认 50，与 neo4j-driver 默认一致） */
  maxConnectionPoolSize?: number;
  /** v2.3.5: 连接获取超时（毫秒，默认 10000） */
  connectionAcquisitionTimeout?: number;
  /** v2.4.0: 目标数据库名（默认 neo4j）。生产数据写入该库；需 Neo4j Enterprise 多库支持 */
  database?: string;
}

export interface LlmConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  /** Ollama keep_alive 参数（仅 Ollama 识别，OpenAI 会忽略）。-1 表示永久驻留 */
  keepAlive?: string | number;
  /** v2.3.2 阶段二: 最大并发请求数（默认 1 for Ollama 本地，可调高 for 云端） */
  maxConcurrency?: number;
  /**
   * v2.4.1: 思考模式开关。true=开启思考（reasoning），false=关闭（快速）。
   * 仅对支持该参数的服务生效：Ollama 原生 /api/chat 传 options.think；
   * OpenAI 兼容端点透传 think 字段（不支持的服务会忽略）。默认不传（保持服务默认行为）。
   */
  thinking?: boolean;
}

export interface EmbeddingConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimensions?: number;
  options?: Record<string, number | boolean | string>;
  keepAlive?: string | number;
  /** v2.3.2 阶段二: LRU 缓存容量（默认 256，设为 0 禁用缓存） */
  cacheSize?: number;
  /** v2.3.2 阶段二: LRU 缓存 TTL（默认 10min） */
  cacheTtlMs?: number;
  /** v2.4.0: 最大并发请求数（默认 3 for 本地 Ollama，过高会触发 503 server busy） */
  maxConcurrency?: number;
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
    /** v2.5.4: maintenance 首次启动延迟 ms（默认 30min，避免启动初期 lossless-claw compaction 与 community summary 抢 LLM） */
    maintenanceInitialDelayMs?: number;
    /** v2.5.4: 中间轮 assistant 文本提取的轮数节流阈值（默认 15 轮），满 N 轮才批量入队一次 */
    interimTurnsThreshold?: number;
  };
  /** v2.5.4: 社区摘要节流配置（避免 maintenance 与主会话 / compaction 抢 LLM 导致 503） */
  communitySummary?: {
    /** 单次 maintenance 最多摘要多少个社区（默认 5，超过留到下次 maintenance） */
    maxPerBatch?: number;
    /** 两个社区摘要之间的间隔 ms（默认 3_000，避免连打 LLM） */
    interCallSleepMs?: number;
  };
  /** v2.5.x 心跳自愈配置（探测 API/MCP/driver，崩溃后自动重建） */
  heartbeat?: {
    enabled?: boolean;
    intervalMs?: number;
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

  /** v2.4.0: 时序字段回填（Maintenance Phase 4b，默认开启） */
  timestampBackfill?: {
    enabled?: boolean;
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
    /** M 矩阵冷启动阈值（累计反馈数，默认 40，v2.3.5 B1 从 100 降低） */
    warmupFeedbacks?: number;
    /** v2.3.5: judgeWarmupFeedbacks 已迁移到 judge 段，不再在此处定义 */
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
    /** v2.4.0: benchmark 专用数据库（默认与生产一致，即 neo4j.database）。
     *  设置不同库名时 benchmark 全部读写切到该库，与生产物理隔离（需 Neo4j Enterprise 多库）。 */
    database?: string;
    /** v2.4.1: benchmark 专属关联矩阵 M 文件名（默认 association-matrix-benchmark.json）。
     *  与生产 M（association-matrix.json）独立持久化，实现两个流程 M 隔离。 */
    matrixFile?: string;
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

  /**
   * v2.3.5 方案 A: 自动反馈采集配置
   *
   * 通过 agent_end 钩子自动采集反馈，破除手动 gm_feedback 的冷启动死循环。
   * 默认启用（enabled=true）。关闭后回到纯手动模式。
   */
  autoFeedback?: {
    /** 是否启用自动反馈采集（默认 true） */
    enabled?: boolean;
    /** 是否记录 get() 展开作为强使用信号（默认 true） */
    trackGetExpansion?: boolean;
    /** 单 session 最大召回缓存条数（默认 5） */
    maxRecallRecordsPerSession?: number;
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
  /** 独立 HTTP API 服务器配置（默认启用，端口 7850） */
  apiServer?: {
    enabled?: boolean;
    port?: number;
    host?: string;
    authToken?: string;
  };

  // ── v2.4.0 检索质量与输出增强 ────────────────────────────

  /**
   * 检索与输出配置（v2.4.0 新增）
   *
   * 覆盖：记忆切片长度、长文本分段嵌入、多阶段检索、时序权重、标准格式化输出。
   */
  recall?: {
    /**
     * 点2：嵌入文本的记忆切片长度（字符数，默认 800）。
     * 旧版硬编码 500，长描述/内容的尾部关键上下文会被切断。
     * 仅作用于「嵌入文本」构造（embed 的输入），不改变节点 content 存储。
     */
    memorySliceChars?: number;

    /**
     * 点6：长文本分段嵌入。
     * enabled=true 时，嵌入文本超过 chunkSize 会按 chunkSize 切分（含 chunkOverlap 重叠），
     * 每段分别 embed 并保存到 chunkEmbeddings，提升长文本局部匹配能力。
     */
    chunking?: {
      enabled?: boolean;
      /** 单段字符数（默认 400） */
      chunkSize?: number;
      /** 段间重叠字符数（默认 40） */
      chunkOverlap?: number;
    };

    /**
     * 点5：多阶段检索。
     * enabled=true 时，先通过图关系（FTS 种子 → graphWalk 邻域）筛选候选节点，
     * 再在候选中做向量相似度排序，减少全局向量搜索带来的无关节点干扰。
     */
    multiStage?: boolean;

    /**
     * 点4：时序权重（0~1，默认 0.3）。
     * 重排召回结果时，结合节点 validTo/updatedAt 的新鲜度做时序衰减，
     * 与关联矩阵 M 的关联分共同加权，避免过期/冲突节点被错误排前。
     */
    temporalWeight?: number;

    /**
     * 点3：标准格式化输出。
     * 为系统提示注入「简洁、贴近原文、减少自由篡改」的输出约束。
     */
    outputFormat?: {
      enabled?: boolean;
      /** 是否要求简洁（默认 true） */
      concise?: boolean;
      /** 是否要求贴近原文表述（默认 true） */
      faithful?: boolean;
    };
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
  | "LEADS_TO"    // TASK → EVENT：任务执行产生了某事件
  // 会话/全文/提及关系（v2.3.5 补充）
  | "MENTIONS"
  | "NEXT_SESSION"
  | "CONTAINS";

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

  // ── v2.4.0 长文本分段嵌入（点 6）──────────────
  /** 分块文本（与 chunkEmbeddings 一一对应） */
  chunkTexts?: string[];
  /** 分块向量（每段一个，供多阶段检索做局部相似度细化） */
  chunkEmbeddings?: number[][];

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
