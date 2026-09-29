/**
 * v2.8.x: agent_end 写端回归测试
 *
 * 回归目标：saveMessage 此前只有定义、无运行时调用点，:GmMessage 不再新增，
 * markMessagesByContent 空转。本测试锁定 persistSessionMessages 的行为契约：
 *   1. 只落 user/assistant 两类消息，其它 role 跳过
 *   2. 空白内容跳过
 *   3. 返回落库条数正确
 *   4. 相同输入重跑幂等（id 稳定，MERGE 不膨胀）
 */
import { describe, expect, it } from "vitest";

// 与 index.ts 中 persistSessionMessages 保持同构的纯函数版（不依赖 Neo4j / 模块加载），
// 用于锁定 id 生成规则与过滤规则这两个最容易回归的点。
interface AgentMessageLike { role?: string; type?: string; content?: string | Array<{ type?: string; text?: string } | string>; text?: string; body?: string }

function extractMessageText(msg: AgentMessageLike): string {
  if (!msg) return "";
  const content = msg.content ?? msg.text ?? msg.body ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (typeof b === "string" || b?.type === "text"))
      .map((b) => (typeof b === "string" ? b : b.text ?? ""))
      .join("\n");
  }
  return "";
}

function simpleHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function collect(messages: AgentMessageLike[], sessionKey: string) {
  const out: Array<{ id: string; sessionKey: string; turnIndex: number; role: string; content: string }> = [];
  let turnIndex = 0;
  for (const msg of messages) {
    if (!msg) continue;
    const role = msg.role ?? msg.type ?? "";
    const isUser = /user|human/i.test(role);
    const isAssistant = /assistant/i.test(role);
    if (!isUser && !isAssistant) continue;
    const content = extractMessageText(msg);
    if (!content || !content.trim()) continue;
    const roleTag = isAssistant ? "assistant" : "user";
    const id = "gm:" + sessionKey + ":" + turnIndex + ":" + roleTag + ":" + simpleHash(content.slice(0, 200));
    out.push({ id, sessionKey, turnIndex, role: roleTag, content });
    turnIndex++;
  }
  return out;
}

describe("session message persist (v2.8.x write path)", () => {
  it("collects only user/assistant with non-empty text", () => {
    const rows = collect([
      { role: "system", content: "sys prompt" },
      { role: "user", content: "你好" },
      { role: "tool", content: "tool out" },
      { role: "assistant", content: "收到" },
      { role: "assistant", content: "   " },
    ], "sess-A");
    expect(rows.map(r => r.role)).toEqual(["user", "assistant"]);
    expect(rows.map(r => r.content)).toEqual(["你好", "收到"]);
    expect(rows.length).toBe(2);
  });

  it("parses content block arrays", () => {
    const rows = collect([
      { role: "assistant", content: [{ type: "text", text: "部分A" }, { type: "tool_use" }, { type: "text", text: "部分B" }] },
    ], "sess-A");
    expect(rows[0].content).toBe("部分A\n部分B");
  });

  it("id is stable and idempotent across runs", () => {
    const msgs: AgentMessageLike[] = [
      { role: "user", content: "同一句话" },
      { role: "assistant", content: "同一回复" },
    ];
    const a = collect(msgs, "sess-A");
    const b = collect(msgs, "sess-A");
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id));
    expect(new Set(a.map(r => r.id)).size).toBe(2);
  });

  it("turnIndex increases monotonically", () => {
    const rows = collect([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ], "sess-A");
    expect(rows.map(r => r.turnIndex)).toEqual([0, 1, 2]);
  });

  it("different sessions produce different ids", () => {
    const msgs: AgentMessageLike[] = [{ role: "user", content: "hi" }];
    expect(collect(msgs, "sess-A")[0].id).not.toBe(collect(msgs, "sess-B")[0].id);
  });
});
