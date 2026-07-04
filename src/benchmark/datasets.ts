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
    console.warn(`[benchmark] LoCoMo load failed: ${err}`);
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
    const lines = raw.split("\n").filter(l => l.trim());

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
    console.warn(`[benchmark] LongMemEval load failed: ${err}`);
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
  const cases: BenchmarkCase[] = [
    {
      id: "sample-1",
      dataset: "Sample",
      category: "单跳",
      query: "什么是 Neo4j？",
      expectedAnswer: "Neo4j 是图数据库",
      conversation: [
        { role: "user", content: "Neo4j 是什么" },
        { role: "assistant", content: "Neo4j 是一个图数据库" },
      ],
    },
    {
      id: "sample-2",
      dataset: "Sample",
      category: "多跳",
      query: "graph-memory-pro 用了什么图算法？",
      expectedAnswer: "PageRank Label Propagation",
      conversation: [
        { role: "user", content: "graph-memory-pro 的图算法" },
        { role: "assistant", content: "使用 PageRank 和 Label Propagation" },
      ],
    },
    {
      id: "sample-3",
      dataset: "Sample",
      category: "时序",
      query: "v2.1.2 新增了哪些能力？",
      expectedAnswer: "bi-temporal 状态追踪 过时检测",
      conversation: [
        { role: "user", content: "v2.1.2 版本" },
        { role: "assistant", content: "v2.1.2 新增 bi-temporal、状态追踪、过时检测" },
      ],
    },
    {
      id: "sample-4",
      dataset: "Sample",
      category: "开放域",
      query: "如何配置召回参数？",
      expectedAnswer: "recallMaxNodes recallMaxDepth",
      conversation: [
        { role: "user", content: "召回配置" },
        { role: "assistant", content: "通过 recallMaxNodes 和 recallMaxDepth 配置" },
      ],
    },
    {
      id: "sample-5",
      dataset: "Sample",
      category: "单跳",
      query: "社区检测的默认迭代次数？",
      expectedAnswer: "50",
      conversation: [
        { role: "user", content: "社区检测迭代" },
        { role: "assistant", content: "默认 50 次" },
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
