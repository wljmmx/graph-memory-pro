/**
 * graph-memory-pro — 三元组提取器
 *
 * 从对话中提取 (节点, 关系, 节点) 三元组
 * 使用 LLM prompt 提取
 */

import type { CompleteFn } from "../engine/llm.ts";
import type { ExtractResult, NodeType, EdgeType } from "../types.ts";
import type { Driver } from "neo4j-driver";

const EXTRACT_SYSTEM_PROMPT = `你是知识图谱三元组提取专家。
从用户提供的对话内容中提取知识节点和关系。

## 节点类型
- TASK: 用户提出的具体任务需求。
- SKILL: 完成任务使用的方法、工具、代码片段或最佳实践。
- EVENT: 发生的具体事件、错误、异常或问题。

## 关系类型
- USED_SKILL: TASK → SKILL。任务使用了某个技能。注意：对TASK使用工具/方法。
- SOLVED_BY: EVENT → SKILL。事件被某个技能解决。注意：EVENT被SKILL解决。
- REQUIRES: TASK → TASK。任务依赖另一个任务。注意：先决条件关系。
- PATCHES: SKILL → SKILL。新的技能修正了旧的技能。注意：新优于旧。
- CONFLICTS_WITH: SKILL → SKILL。两种技能互相冲突或互斥。
- RELATES_TO: TASK ↔ EVENT 或 SKILL ↔ EVENT 或 TASK ↔ TOPIC。跨领域关联关系，用于连接不同知识领域的节点。注意：不同标签类型之间的重要联系。
- CAUSED_BY: EVENT → EVENT。一个事件直接导致另一个事件发生。注意：因果链关系（如"A 错误导致 B 服务崩溃"）。
- LEADS_TO: TASK → EVENT。任务执行后产生了某个事件。注意：任务→事件因果。

## 提取原则
- 用户的每一个有实际信息的请求都应该尝试提取
- 只提取明确提及的信息，不要猜测或编造
- 如果当前内容没有可提取的信息，返回空数组
- 节点name统一使用英文
- 每个节点/边都提供description
- edge.instruction: 描述这条关系具体是什么意思
- 因果关系（CAUSED_BY/LEADS_TO）单轮即可识别："因为 X 所以 Y"的因果链

## 输出格式 (JSON)
{
  "nodes": [
    { "type": "TASK|SKILL|EVENT", "name": "英文名", "description": "描述", "content": "具体内容" }
  ],
  "edges": [
    { "type": "USED_SKILL|SOLVED_BY|REQUIRES|PATCHES|CONFLICTS_WITH|RELATES_TO|CAUSED_BY|LEADS_TO", "fromName": "节点名", "toName": "节点名", "instruction": "关系说明", "condition": "条件（可选）" }
  ]
}`;

const FALLBACK: ExtractResult = { nodes: [], edges: [] };

export async function extractTriplets(
  llm: CompleteFn,
  userContent: string,
  assistantContent: string,
): Promise<ExtractResult> {
  if (!userContent?.trim() && !assistantContent?.trim()) {
    return FALLBACK;
  }

  const userPrompt = `对话内容：
用户消息: ${userContent.slice(0, 2000)}
助手回复: ${assistantContent.slice(0, 3000)}

请提取知识三元组。`;

  try {
    const raw = await llm(EXTRACT_SYSTEM_PROMPT, userPrompt, undefined, "extract");
    return parseExtractResult(raw);
  } catch {
    return FALLBACK;
  }
}

function parseExtractResult(raw: string): ExtractResult {
  const cleaned = ((raw ?? "") as string)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // 1) 直接 JSON.parse（输出即纯 JSON 的常规情况）
  const direct = tryParseWholeObject(cleaned);
  if (direct) return toExtractResult(direct);

  // 2) 思考模式/reasoning 适配：剥离思考文本，
  //    用括号配对扫描顶层对象，取第一个含 "nodes" 键的 JSON 对象
  const found = extractObjectWithNodes(cleaned);
  if (found) return toExtractResult(found);

  return FALLBACK;
}

/** 尝试把整段文本当作单个 JSON 对象解析 */
function tryParseWholeObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 在思考模式输出（reasoning 文本 + 末尾 JSON）中提取含 "nodes" 键的顶层 JSON 对象。
 * 用括号配对定位每个顶层对象，避免被思考文本里的 `{}` 干扰，并优先返回含 "nodes" 的。
 */
function extractObjectWithNodes(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let objStart = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const candidate = tryParseWholeObject(text.slice(objStart, i + 1));
        if (candidate && "nodes" in candidate) return candidate;
        objStart = -1;
      }
    }
  }
  return null;
}

function toExtractResult(parsed: Record<string, unknown>): ExtractResult {
  return {
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes.filter(isValidNode).slice(0, 5) : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges.filter(isValidEdge).slice(0, 8) : [],
  };
}

// ─── 验证函数 ──────────────────────────────────

function isValidNode(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (typeof n.name !== "string" || !n.name.trim()) return false;
  if (typeof n.description !== "string") return false;
  if (typeof n.content !== "string") return false;
  if (typeof n.type !== "string" || !["TASK", "SKILL", "EVENT"].includes(n.type.toUpperCase())) return false;
  return true;
}

function isValidEdge(edge: unknown): boolean {
  if (!edge || typeof edge !== "object") return false;
  const e = edge as Record<string, unknown>;
  if (typeof e.type !== "string" || !e.type.trim()) return false;
  if (typeof e.fromName !== "string" || !e.fromName.trim()) return false;
  if (typeof e.toName !== "string" || !e.toName.trim()) return false;
  return true;
}

// ─── Extractor 类包装 ──────────────────────────

export class Extractor {
  constructor(private _driver: Driver) {}

  /** v2.5.x: 心跳驱动恢复后热替换 driver（Extractor 不缓存 driver 派生状态） */
  setDriver(driver: Driver): void { this._driver = driver; }

  async extract(
    llm: CompleteFn,
    userContent: string,
    assistantContent: string,
  ): Promise<ExtractResult> {
    return extractTriplets(llm, userContent, assistantContent);
  }
}

// ─────────────────────────────────────────────────────────────
// v2.4.1 非 LLM 快速提取（启发式规则）
//
// 不调用 LLM，用规则从对话文本快速提取 TASK/SKILL/EVENT 节点与边。
// 速度快、零成本、确定性，但泛化能力有限 —— 适合大批量初筛/快速重建。
// 由 rebuild 的 `mode: "heuristic"` 开关启用。
// ─────────────────────────────────────────────────────────────

/** 转小写 ASCII 短横线 slug（中文则保留原样，用于节点 name） */
function slugify(text: string): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (/[\u4e00-\u9fa5]/.test(t)) return t.slice(0, 24);
  return t.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** 取前 n 个词/字作为短语 */
function firstPhrase(text: string, maxWords: number): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const words = t.split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

/** 错误/问题关键词（命中则视为 EVENT 节点） */
const ERROR_KEYWORDS = /(?:错误|失败|异常|崩溃|报错|超时|无法|拒绝|error|failed|crash|exception|timeout|denied)/i;

/**
 * 基于规则的快速提取。不依赖 LLM。
 */
export function heuristicExtract(userContent: string, assistantContent: string): ExtractResult {
  const nodes: RoomNodeLike[] = [];
  const edges: RoomEdgeLike[] = [];
  const seen = new Set<string>();

  const user = (userContent ?? "").trim();
  const assistant = (assistantContent ?? "").trim();

  // TASK：来自用户消息
  if (user) {
    const name = slugify(firstPhrase(user, 10));
    if (name && !seen.has(name)) {
      seen.add(name);
      nodes.push({ type: "TASK", name, description: user.slice(0, 160), content: user });
    }
  }

  // EVENT：命中错误关键词
  const joined = `${user} ${assistant}`;
  const errMatch = joined.match(new RegExp(`(?:${ERROR_KEYWORDS.source})[：:\\s]*([^。\\n]{2,60})`));
  if (errMatch) {
    const raw = errMatch[0];
    const name = `event-${slugify(firstPhrase(raw, 8))}`;
    if (!seen.has(name)) {
      seen.add(name);
      nodes.push({ type: "EVENT", name, description: raw.slice(0, 160), content: raw });
    }
  }

  // SKILL：来自助手消息，按句切分取前几段
  if (assistant) {
    const chunks = assistant.split(/[。；;！!？?]/).map((s) => s.trim()).filter(Boolean);
    for (const ch of chunks.slice(0, 3)) {
      const name = slugify(firstPhrase(ch, 10));
      if (name && name.length >= 2 && !seen.has(name)) {
        seen.add(name);
        nodes.push({ type: "SKILL", name, description: ch.slice(0, 160), content: ch });
      }
    }
  }

  const taskNode = nodes.find((n) => n.type === "TASK");
  const eventNode = nodes.find((n) => n.type === "EVENT");
  const skillNodes = nodes.filter((n) => n.type === "SKILL");

  if (taskNode) {
    for (const s of skillNodes) {
      edges.push({ type: "USED_SKILL", fromName: taskNode.name, toName: s.name, instruction: "task uses skill" });
    }
  }
  if (eventNode) {
    for (const s of skillNodes) {
      edges.push({ type: "SOLVED_BY", fromName: eventNode.name, toName: s.name, instruction: "event solved by skill" });
    }
  }

  return { nodes: nodes.slice(0, 5), edges: edges.slice(0, 8) };
}

// 与 ExtractResult 兼容的局部类型，避免重复引用
interface RoomNodeLike {
  type: NodeType;
  name: string;
  description: string;
  content: string;
}
interface RoomEdgeLike {
  type: EdgeType;
  fromName: string;
  toName: string;
  instruction: string;
  condition?: string;
}
