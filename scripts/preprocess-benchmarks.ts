/**
 * v2.3.6: Benchmark 真实数据集预处理管线
 *
 * 将 LoCoMo / LongMemEval 原始数据离线转换为标准化 BenchmarkDataset，
 * 输出带 prebuiltNodes / prebuiltEdges / expectedNodeIds，使评测确定、可复现。
 *
 * 设计原则（方案 B：离线预处理落盘）：
 *   - 不依赖运行时 LLM 提取（避免 LLM 不稳定导致 expectedNodeIds 永不匹配）
 *   - 利用数据集自带的结构化信息：
 *       LoCoMo: session_summary（官方生成的会话摘要）+ qa.evidence（答案来源 dia_id）
 *       → 每个会话摘要建一个节点，evidence 反推答案所在会话 → expectedNodeIds
 *   - 输出 .preprocessed.json 落盘，loader 优先读取；每次评测确定性结果
 *
 * 用法：
 *   npm run preprocess:benchmarks
 *   npm run preprocess:benchmarks -- --data-dir=./benchmarks/data
 *
 * 输出：
 *   benchmarks/data/locomo.preprocessed.json
 *   benchmarks/data/longmemeval.preprocessed.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { BenchmarkCase, BenchmarkDataset } from "../src/benchmark/types.ts";
import { buildLongMemEvalV2Dataset, loadV2QuestionsFile, loadV2TrajectoriesFile, type LongMemEvalV2Options } from "../src/benchmark/datasets.ts";
import { resolveBenchmarkDataDir } from "../src/benchmark/dataDir.ts";

// ── 类别映射（复用 datasets.ts 的映射）───────────────────────
const LOCOMO_CATEGORY: Record<string, string> = {
  single_hop: "单跳",
  multi_hop: "多跳",
  open_domain: "开放域",
  temporal: "时序",
};

const LONGMEVAL_CATEGORY: Record<string, string> = {
  single_session: "单会话",
  multi_session: "多会话",
  knowledge_update: "知识更新",
  temporal: "时序",
  multi_hop: "多跳",
  distract: "干扰",
};

// ── LoCoMo 解析 ────────────────────────────────────────────

interface LocomoTurn { speaker?: string; dia_id?: string; text?: string; content?: string }
interface LocomoSession { idx: number; dateTime?: string; turns: LocomoTurn[] }

/** 解析 LoCoMo conversation 对象（含 session_n 与 session_n_date_time 键） */
function parseLocomoConversation(conv: Record<string, unknown>): {
  sessions: LocomoSession[];
  diaIdToSession: Map<string, number>;
} {
  const sessions: LocomoSession[] = [];
  const diaIdToSession = new Map<string, number>();

  for (const key of Object.keys(conv)) {
    if (!key.startsWith("session_") || key.endsWith("_date_time")) continue;
    const idx = parseInt(key.replace("session_", ""), 10);
    if (Number.isNaN(idx)) continue;
    const raw = conv[key];
    const turns = Array.isArray(raw) ? (raw as unknown[]).map((t) => (t as LocomoTurn)) : [];
    const dateTime = typeof conv[`${key}_date_time`] === "string" ? String(conv[`${key}_date_time`]) : undefined;
    sessions.push({ idx, dateTime, turns });
    for (const t of turns) {
      if (t.dia_id) diaIdToSession.set(String(t.dia_id), idx);
    }
  }
  sessions.sort((a, b) => a.idx - b.idx);
  return { sessions, diaIdToSession };
}

function extractUrlFromDateTime(dt: string | undefined): number {
  if (!dt) return 0;
  const ts = Date.parse(dt);
  return Number.isNaN(ts) ? 0 : ts;
}

/** 把会话 turns 转为 BenchmarkCase.conversation */
function turnsToMessages(sessions: LocomoSession[]): Array<{ role: "user" | "assistant"; content: string }> {
  const msgs: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const s of sessions) {
    for (const t of s.turns) {
      const content = t.text ?? t.content ?? "";
      if (!content) continue;
      const role = String(t.speaker ?? "").toLowerCase().includes("user") ? "user" : "assistant";
      msgs.push({ role, content });
    }
  }
  return msgs;
}

/** 预处理 LoCoMo → BenchmarkDataset（规则模式，利用 session_summary + evidence） */
function preprocessLocomo(raw: unknown, sampleIdPrefix = "locomo"): BenchmarkDataset {
  const samples = Array.isArray(raw) ? raw as unknown[] : [];
  const cases: BenchmarkCase[] = [];

  for (const sample of samples) {
    const s = sample as Record<string, unknown>;
    const sampleId = String(s.sample_id ?? "sample");
    const conv = (s.conversation ?? {}) as Record<string, unknown>;
    const { sessions, diaIdToSession } = parseLocomoConversation(conv);

    if (sessions.length === 0) continue;

    // 每个会话一个节点：name 用可预测标识，content 用官方 session_summary
    const summaries = (s.session_summary ?? {}) as Record<string, unknown>;
    const prebuiltNodes: BenchmarkCase["prebuiltNodes"] = [];
    const prebuiltEdges: BenchmarkCase["prebuiltEdges"] = [];
    const sessionNodeNames = new Map<number, string>();

    for (const sess of sessions) {
      const nodeName = `${sampleIdPrefix}-${sampleId}-session-${sess.idx}`;
      sessionNodeNames.set(sess.idx, nodeName);
      const summary = typeof summaries[`session_${sess.idx}_summary`] === "string"
        ? String(summaries[`session_${sess.idx}_summary`])
        : sess.turns.map((t) => t.text ?? t.content ?? "").filter(Boolean).join(" ").slice(0, 800);
      prebuiltNodes.push({
        type: "EVENT",
        name: nodeName,
        description: `LoCoMo ${sampleId} 第 ${sess.idx} 个会话${sess.dateTime ? `（${sess.dateTime}）` : ""}`,
        content: summary,
        updatedAt: extractUrlFromDateTime(sess.dateTime) || undefined,
      });
    }

    // 会话间按时间序建 NEXT_SESSION 关系（放入每个 case）
    for (let i = 0; i < sessions.length - 1; i++) {
      const a = sessionNodeNames.get(sessions[i].idx);
      const b = sessionNodeNames.get(sessions[i + 1].idx);
      if (a && b) {
        prebuiltEdges.push({ type: "NEXT_SESSION", fromName: a, toName: b, instruction: "时序相邻会话" });
      }
    }

    // QA：用 evidence 反推答案所在会话 → expectedNodeIds
    const qa = Array.isArray(s.qa) ? s.qa as unknown[] : [];
    for (let qi = 0; qi < qa.length; qi++) {
      const q = qa[qi] as Record<string, unknown>;
      const evidence = Array.isArray(q.evidence) ? q.evidence as unknown[] : [];
      const sessionIdxs = new Set<number>();
      for (const diaId of evidence) {
        const idx = diaIdToSession.get(String(diaId));
        if (idx !== undefined) sessionIdxs.add(idx);
      }
      const expectedNodeIds = [...sessionIdxs]
        .sort((a, b) => a - b)
        .map((idx) => sessionNodeNames.get(idx))
        .filter((n): n is string => Boolean(n));

      cases.push({
        id: `${sampleIdPrefix}-${sampleId}-q-${qi + 1}`,
        dataset: "LoCoMo",
        category: LOCOMO_CATEGORY[String(q.category ?? "")] ?? String(q.category ?? "未知"),
        query: String(q.question ?? ""),
        expectedAnswer: String(q.answer ?? ""),
        expectedNodeIds,
        conversation: turnsToMessages(sessions),
        timestamp: extractUrlFromDateTime(sessions[0]?.dateTime) || undefined,
        prebuiltNodes: prebuiltNodes as BenchmarkCase["prebuiltNodes"],
        prebuiltEdges,
      });
    }
  }

  return {
    name: "LoCoMo",
    cases,
    description: "LoCoMo 评测数据集（预处理后，会话摘要建图 + evidence 标注 expectedNodeIds）",
    targets: { p1: 0.5 },
  };
}

// ── LongMemEval 解析 ───────────────────────────────────────

interface LmeMessage { role?: string; content?: string }
interface LmeLine { question?: string; answer?: string; category?: string; timestamp?: number; session?: { messages?: LmeMessage[] } }

/** 预处理 LongMemEval → BenchmarkDataset（规则模式，按消息块建节点） */
function preprocessLongMemEval(raw: string): BenchmarkDataset {
  const lines = raw.split("\n").filter((l) => l && l.trim());
  const cases: BenchmarkCase[] = [];

  for (let i = 0; i < lines.length; i++) {
    let data: LmeLine;
    try {
      data = JSON.parse(lines[i]) as LmeLine;
    } catch {
      continue;
    }
    const msgs = data.session?.messages ?? [];
    if (msgs.length === 0) continue;

    // 按 10 轮一个块聚合为节点（LongMemEval 无官方 summary，作为确定性退化方案）
    const CHUNK = 10;
    const nodeName = `longmemeval-case-${i + 1}-chunk-{n}`;
    const prebuiltNodes: BenchmarkCase["prebuiltNodes"] = [];
    let chunkIdx = 0;
    for (let m = 0; m < msgs.length; m += CHUNK) {
      const chunk = msgs.slice(m, m + CHUNK);
      chunkIdx++;
      const content = chunk.map((c) => `${c.role ?? "?"}: ${c.content ?? ""}`).join("\n");
      prebuiltNodes.push({
        type: "EVENT",
        name: nodeName.replace("{n}", String(chunkIdx)),
        description: `LongMemEval case ${i + 1} 第 ${chunkIdx} 块消息`,
        content,
      });
    }

    // LongMemEval 无 evidence 标注，expectedNodeIds 留空（仅用 F1 评测）
    cases.push({
      id: `longmemeval-${i + 1}`,
      dataset: "LongMemEval",
      category: LONGMEVAL_CATEGORY[String(data.category ?? "")] ?? String(data.category ?? "未知"),
      query: String(data.question ?? ""),
      expectedAnswer: String(data.answer ?? ""),
      conversation: msgs.map((m) => ({
        role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: m.content ?? "",
      })),
      timestamp: data.timestamp,
      prebuiltNodes,
    });
  }

  return {
    name: "LongMemEval",
    cases,
    description: "LongMemEval 评测数据集（预处理后，消息块建图，F1 评测）",
    targets: { f1: 0.3 },
  };
}

// ── LongMemEval-V2 预处理 ───────────────────────────────────────
//
// 结构：questions.jsonl + trajectories.jsonl + haystacks/lme_v2_{tier}.json
// 复用 datasets.ts 的 buildLongMemEvalV2Dataset 纯函数，落盘标准化数据集。

async function preprocessLongMemEvalV2(dataDir: string): Promise<BenchmarkDataset[]> {
  const out: BenchmarkDataset[] = [];
  const baseDir = join(dataDir, "longmemeval-v2");
  const questionsPath = join(baseDir, "questions.jsonl");
  const trajectoriesPath = join(baseDir, "trajectories.jsonl");

  if (!existsSync(questionsPath) || !existsSync(trajectoriesPath)) {
    console.log(`ℹ 跳过 LongMemEval-V2（未找到 ${baseDir}，请先运行 npm run download:benchmarks longmemeval-v2）`);
    return out;
  }

  // trajectories.jsonl 体积巨大，必须流式逐行读取，避免 ERR_STRING_TOO_LONG
  const [questions, trajMap] = await Promise.all([
    loadV2QuestionsFile(questionsPath),
    loadV2TrajectoriesFile(trajectoriesPath),
  ]);

  for (const tier of ["small", "medium"] as const) {
    const haystackPath = join(baseDir, "haystacks", `lme_v2_${tier}.json`);
    if (!existsSync(haystackPath)) {
      console.log(`ℹ LongMemEval-V2: 跳过 tier=${tier}（未找到 ${haystackPath}）`);
      continue;
    }
    const haystack = JSON.parse(readFileSync(haystackPath, "utf-8")) as Record<string, string[]>;
    const opts: LongMemEvalV2Options = { tier, maxTrajectoriesPerQuestion: 20 };
    const dataset = buildLongMemEvalV2Dataset(questions, trajMap, haystack, opts);
    const outPath = join(dataDir, `longmemeval-v2-${tier}.preprocessed.json`);
    writeFileSync(outPath, JSON.stringify(dataset, null, 2), "utf-8");
    console.log(`✔ LongMemEval-V2 (${tier}): ${dataset.cases.length} cases → ${outPath}`);
    out.push(dataset);
  }
  return out;
}

// ── 主流程 ────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
    },
  });
  // 与 benchmark / download 保持同一数据目录解析：CLI --data-dir > openclaw.json > 默认
  const dataDir = resolveBenchmarkDataDir(values["data-dir"]);
  console.log(`[preprocess] 数据目录: ${dataDir}`);
  mkdirSync(dataDir, { recursive: true });

  // LoCoMo
  const locomoPath = join(dataDir, "locomo.json");
  const locomoOut = join(dataDir, "locomo.preprocessed.json");
  if (existsSync(locomoPath)) {
    const raw = JSON.parse(readFileSync(locomoPath, "utf-8"));
    const dataset = preprocessLocomo(raw);
    writeFileSync(locomoOut, JSON.stringify(dataset, null, 2), "utf-8");
    console.log(`✔ LoCoMo: ${dataset.cases.length} cases → ${locomoOut}`);
  } else {
    console.log(`ℹ 跳过 LoCoMo（未找到 ${locomoPath}，请先运行 npm run download:benchmarks）`);
  }

  // LongMemEval
  const lmePath = join(dataDir, "longmemeval.jsonl");
  const lmeOut = join(dataDir, "longmemeval.preprocessed.json");
  if (existsSync(lmePath)) {
    const dataset = preprocessLongMemEval(readFileSync(lmePath, "utf-8"));
    writeFileSync(lmeOut, JSON.stringify(dataset, null, 2), "utf-8");
    console.log(`✔ LongMemEval: ${dataset.cases.length} cases → ${lmeOut}`);
  } else {
    console.log(`ℹ 跳过 LongMemEval（未找到 ${lmePath}）`);
  }

  // LongMemEval-V2
  await preprocessLongMemEvalV2(dataDir);

  console.log("\n预处理完成。运行评测: npm run benchmark");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});