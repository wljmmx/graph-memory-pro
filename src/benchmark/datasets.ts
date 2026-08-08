/**
 * S-10 Benchmark 数据集适配层（v2.1.2 第五批）
 *
 * LoCoMo + LongMemEval 标准评测数据集适配
 *
 * 注意：实际数据集需用户下载后放置于 benchmarks/data/ 目录
 * 本文件提供加载器 + 适配器，将原始格式转为 BenchmarkCase[]
 *
 * 下载地址：
 *   - LoCoMo: https://github.com/snap-research/locomo
 *   - LongMemEval: https://github.com/xiaowu0162/LongMemEval
 */

import type { BenchmarkCase, BenchmarkDataset } from "./types.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.ts";

const log = createLogger("benchmark-datasets");

// ── LoCoMo 适配器 ──────────────────────────────────────

/**
 * LoCoMo 数据集（1,540 题）
 *
 * 类别：单跳 / 多跳 / 开放域 / 时序
 * 目标：P@1 > 50%
 *
 * 原始格式（JSON）：
 * {
 *   "conversations": [...],
 *   "qa_pairs": [
 *     { "question": "...", "answer": "...", "category": "single_hop" }
 *   ]
 * }
 */
export async function loadLoCoMo(dataDir: string = "benchmarks/data"): Promise<BenchmarkDataset> {
  const filePath = join(dataDir, "locomo.json");
  const cases: BenchmarkCase[] = [];

  if (!existsSync(filePath)) {
    // 数据集未下载，返回空数据集（带说明）
    return {
      name: "LoCoMo",
      cases: [],
      description: "LoCoMo 评测数据集（1,540 题，单跳/多跳/开放域/时序）",
      targets: { p1: 0.5 },
    };
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);

    const conversations: Array<{ role: string; content: string }> = data.conversations ?? [];
    const qaPairs: Array<any> = data.qa_pairs ?? [];

    for (let i = 0; i < qaPairs.length; i++) {
      const qa = qaPairs[i];
      const category = mapLoCoMoCategory(qa.category ?? "single_hop");
      cases.push({
        id: `locomo-${i + 1}`,
        dataset: "LoCoMo",
        category,
        query: qa.question ?? "",
        expectedAnswer: qa.answer ?? "",
        conversation: conversations.map(c => ({
          role: (c.role === "user" ? "user" : "assistant") as "user" | "assistant",
          content: c.content ?? "",
        })),
      });
    }
  } catch (err) {
    log.warn(`LoCoMo load failed: ${err}`);
  }

  return {
    name: "LoCoMo",
    cases,
    description: "LoCoMo 评测数据集（1,540 题，单跳/多跳/开放域/时序）",
    targets: { p1: 0.5 },
  };
}

function mapLoCoMoCategory(raw: string): string {
  const map: Record<string, string> = {
    "single_hop": "单跳",
    "multi_hop": "多跳",
    "open_domain": "开放域",
    "temporal": "时序",
  };
  return map[raw] ?? raw;
}

// ── LongMemEval 适配器 ──────────────────────────────────────

/**
 * LongMemEval 数据集（500 题，6 类）
 *
 * 类别：单跳 / 多跳 / 知识更新 / 多会话 / 时序 / 干扰
 * 目标：时序 F1 可用
 *
 * 原始格式（JSON Lines，每行一个样本）：
 * {"question": "...", "answer": "...", "category": "...", "session": {...}}
 */
export async function loadLongMemEval(dataDir: string = "benchmarks/data"): Promise<BenchmarkDataset> {
  const filePath = join(dataDir, "longmemeval.jsonl");
  const cases: BenchmarkCase[] = [];

  if (!existsSync(filePath)) {
    return {
      name: "LongMemEval",
      cases: [],
      description: "LongMemEval 评测数据集（500 题，6 类含知识更新/多会话）",
      targets: { f1: 0.3 },
    };
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l: string) => l && l.trim());

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const data = JSON.parse(line);
        const category = mapLongMemEvalCategory(data.category ?? "single_session");
        cases.push({
          id: `longmemeval-${i + 1}`,
          dataset: "LongMemEval",
          category,
          query: data.question ?? "",
          expectedAnswer: data.answer ?? "",
          conversation: data.session?.messages
            ? data.session.messages.map((m: any) => ({
                role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
                content: m.content ?? "",
              }))
            : undefined,
          timestamp: data.timestamp,
        });
      } catch {
        // 跳过解析失败的行
      }
    }
  } catch (err) {
    log.warn(`LongMemEval load failed: ${err}`);
  }

  return {
    name: "LongMemEval",
    cases,
    description: "LongMemEval 评测数据集（500 题，6 类含知识更新/多会话）",
    targets: { f1: 0.3 },
  };
}

function mapLongMemEvalCategory(raw: string): string {
  const map: Record<string, string> = {
    "single_session": "单会话",
    "multi_session": "多会话",
    "knowledge_update": "知识更新",
    "temporal": "时序",
    "multi_hop": "多跳",
    "distract": "干扰",
  };
  return map[raw] ?? raw;
}

// ── 内置样本数据集（用于无外部数据时的快速验证）──────────────────

/**
 * 内置样本数据集（10 题）
 *
 * 当 LoCoMo/LongMemEval 数据未下载时，使用此内置数据集进行快速验证
 */
export function getBuiltinSampleDataset(): BenchmarkDataset {
  // 节点 name 同时作为 expectedNodeIds，建图后 upsertNode 以 name 为 id 之一
  // 这样 evaluateCase 能通过 expectedNodeIds 匹配召回结果
  // v2.3.5：同时提供 prebuiltNodes / prebuiltEdges，不走 LLM extractor
  // 直接以 expectedNodeIds 作为 name，保证 100% 可控匹配
  const cases: BenchmarkCase[] = [
    {
      id: "sample-1",
      dataset: "Sample",
      category: "单跳",
      query: "什么是 Neo4j？",
      expectedAnswer: "Neo4j 是图数据库",
      expectedNodeIds: ["Neo4j"],
      conversation: [
        { role: "user", content: "Neo4j 是什么" },
        { role: "assistant", content: "Neo4j 是一个图数据库" },
      ],
      prebuiltNodes: [
        { type: "SKILL", name: "Neo4j", description: "一个图数据库", content: "Neo4j 是一个图数据库，用于存储和查询图结构数据，支持 Cypher 查询语言和 GDS 图算法库。" },
      ],
    },
    {
      id: "sample-2",
      dataset: "Sample",
      category: "多跳",
      query: "graph-memory-pro 用了什么图算法？",
      expectedAnswer: "PageRank Label Propagation",
      expectedNodeIds: ["graph-memory-pro", "PageRank", "Label Propagation"],
      conversation: [
        { role: "user", content: "graph-memory-pro 的图算法" },
        { role: "assistant", content: "使用 PageRank 和 Label Propagation" },
      ],
      prebuiltNodes: [
        { type: "SKILL", name: "graph-memory-pro", description: "基于 Neo4j 的知识图谱记忆引擎", content: "graph-memory-pro 是 OpenClaw 的知识图谱记忆插件，提供三元组提取、PageRank、社区检测、向量召回等能力。" },
        { type: "SKILL", name: "PageRank", description: "图节点重要性排名算法", content: "PageRank 通过图上的随机游走迭代计算每个节点的中心性，用于 graph-memory-pro 的召回排序。" },
        { type: "SKILL", name: "Label Propagation", description: "社区检测/标签传播算法", content: "Label Propagation 是 GDS 提供的社区检测算法，用于在图中发现结构上的社区聚类，graph-memory-pro 用于社区向量召回。" },
      ],
      prebuiltEdges: [
        { type: "USED_SKILL", fromName: "graph-memory-pro", toName: "PageRank", instruction: "graph-memory-pro 使用 PageRank 对召回节点做重要性排序" },
        { type: "USED_SKILL", fromName: "graph-memory-pro", toName: "Label Propagation", instruction: "graph-memory-pro 使用 Label Propagation 进行社区检测和社区向量召回" },
      ],
    },
    {
      id: "sample-3",
      dataset: "Sample",
      category: "时序",
      query: "v2.1.2 新增了哪些能力？",
      expectedAnswer: "bi-temporal 状态追踪 过时检测",
      expectedNodeIds: ["v2.1.2", "bi-temporal", "状态追踪", "过时检测"],
      conversation: [
        { role: "user", content: "v2.1.2 版本" },
        { role: "assistant", content: "v2.1.2 新增 bi-temporal、状态追踪、过时检测" },
      ],
      prebuiltNodes: [
        { type: "EVENT", name: "v2.1.2", description: "graph-memory-pro v2.1.2 版本发布", content: "v2.1.2 版本：新增 bi-temporal 双时间追踪、节点状态追踪（state）、内容过时检测（staleness）、JudgeManager 冷启动裁判、QueryCache 查询缓存、AssociationMatrix 关联矩阵 M。" },
        { type: "SKILL", name: "bi-temporal", description: "双时间戳追踪", content: "bi-temporal 双时间机制：区分事件发生时间和系统记录时间，支持版本回溯与时序查询。" },
        { type: "SKILL", name: "状态追踪", description: "节点状态追踪", content: "状态追踪记录每个节点的 active/superseded/archived 状态，在召回时可过滤过时节点。" },
        { type: "SKILL", name: "过时检测", description: "内容过时检测", content: "过时检测通过启发式或 LLM 判定节点内容是否仍有效，支持 staleness.threshold 配置。" },
      ],
      prebuiltEdges: [
        { type: "RELATES_TO", fromName: "v2.1.2", toName: "bi-temporal", instruction: "v2.1.2 新增 bi-temporal 能力" },
        { type: "RELATES_TO", fromName: "v2.1.2", toName: "状态追踪", instruction: "v2.1.2 新增状态追踪能力" },
        { type: "RELATES_TO", fromName: "v2.1.2", toName: "过时检测", instruction: "v2.1.2 新增过时检测能力" },
      ],
    },
    {
      id: "sample-4",
      dataset: "Sample",
      category: "开放域",
      query: "如何配置召回参数？",
      expectedAnswer: "recallMaxNodes recallMaxDepth",
      expectedNodeIds: ["recallMaxNodes", "recallMaxDepth"],
      conversation: [
        { role: "user", content: "召回配置" },
        { role: "assistant", content: "通过 recallMaxNodes 和 recallMaxDepth 配置" },
      ],
      prebuiltNodes: [
        { type: "SKILL", name: "recallMaxNodes", description: "召回最大节点数", content: "recallMaxNodes 是 GmConfig 中的参数，控制单次 recall 返回的节点上限，默认 6。增大可提高召回覆盖率但可能引入噪声。" },
        { type: "SKILL", name: "recallMaxDepth", description: "图游走最大深度", content: "recallMaxDepth 是 GmConfig 中的参数，控制 graphWalk 的 BFS 深度，默认 2。增大可支持多跳推理但耗时上升。" },
      ],
    },
    {
      id: "sample-5",
      dataset: "Sample",
      category: "单跳",
      query: "社区检测的默认迭代次数？",
      expectedAnswer: "50",
      expectedNodeIds: ["社区检测"],
      conversation: [
        { role: "user", content: "社区检测迭代" },
        { role: "assistant", content: "默认 50 次" },
      ],
      prebuiltNodes: [
        { type: "SKILL", name: "社区检测", description: "图社区聚类算法", content: "社区检测通过 Label Propagation 或 Louvain 等算法将图划分为社区，graph-memory-pro 中社区检测的默认迭代次数为 50。" },
      ],
    },
  ];

  return {
    name: "Sample",
    cases,
    description: "内置样本数据集（5 题，用于无外部数据时的快速验证）",
    targets: { p1: 0.4, p3: 0.6 },
  };
}

/**
 * 加载所有可用的评测数据集
 */
export async function loadAllDatasets(dataDir?: string): Promise<BenchmarkDataset[]> {
  const [locomo, longmemeval] = await Promise.all([
    loadLoCoMo(dataDir),
    loadLongMemEval(dataDir),
  ]);

  const datasets = [locomo, longmemeval];

  // 如果两个数据集都为空，加入内置样本
  if (locomo.cases.length === 0 && longmemeval.cases.length === 0) {
    datasets.push(getBuiltinSampleDataset());
  }

  return datasets.filter(d => d.cases.length > 0);
}
