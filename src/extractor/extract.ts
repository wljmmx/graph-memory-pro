/**
 * graph-memory-pro — 三元组提取器
 *
 * 从对话中提取 (节点, 关系, 节点) 三元组
 * 使用 LLM prompt 提取
 */

import type { CompleteFn } from "../engine/llm.ts";
import type { ExtractNode, ExtractResult, ExtractEdge } from "../types.ts";
import { VALID_EDGE_TYPES } from "../types.ts";
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
    const raw = await llm(EXTRACT_SYSTEM_PROMPT, userPrompt);
    return parseExtractResult(raw);
  } catch {
    return FALLBACK;
  }
}

function parseExtractResult(raw: string): ExtractResult {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object") return FALLBACK;
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes.filter(isValidNode).slice(0, 5) : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges.filter(isValidEdge).slice(0, 8) : [],
    };
  } catch {
    // 非贪婪匹配，避免匹配过多内容
    const match = cleaned.match(/\{[\s\S]*?"nodes"[\s\S]*?\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return {
          nodes: Array.isArray(parsed.nodes) ? parsed.nodes.filter(isValidNode).slice(0, 5) : [],
          edges: Array.isArray(parsed.edges) ? parsed.edges.filter(isValidEdge).slice(0, 8) : [],
        };
      } catch {
        return FALLBACK;
      }
    }
    return FALLBACK;
  }
}

// ─── 验证函数 ──────────────────────────────────

function isValidNode(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (typeof node.name !== "string" || !node.name.trim()) return false;
  if (typeof node.description !== "string") return false;
  if (typeof node.content !== "string") return false;
  if (typeof node.type !== "string" || !["TASK", "SKILL", "EVENT"].includes(node.type.toUpperCase())) return false;
  return true;
}

function isValidEdge(edge: any): boolean {
  if (!edge || typeof edge !== "object") return false;
  if (typeof edge.type !== "string" || !edge.type.trim()) return false;
  // v2.2.0: 防御 LLM 产生非预期边类型
  if (!VALID_EDGE_TYPES.has(edge.type)) return false;
  if (typeof edge.fromName !== "string" || !edge.fromName.trim()) return false;
  if (typeof edge.toName !== "string" || !edge.toName.trim()) return false;
  return true;
}

// ─── Extractor 类包装 ──────────────────────────

export class Extractor {
  constructor(private _driver: Driver) {}

  async extract(
    llm: CompleteFn,
    userContent: string,
    assistantContent: string,
  ): Promise<ExtractResult> {
    return extractTriplets(llm, userContent, assistantContent);
  }
}
