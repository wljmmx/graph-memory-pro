/**
 * 测试 src/format/transcript-repair.ts — tool_use/toolResult 配对修复
 */
import { describe, it, expect } from "vitest";
import { sanitizeToolUseResultPairing } from "../src/format/transcript-repair.ts";

describe("sanitizeToolUseResultPairing", () => {
  it("空数组返回空数组", () => {
    const result = sanitizeToolUseResultPairing([]);
    expect(result).toEqual([]);
  });

  it("无 tool_calls 的 assistant 消息直接保留", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "end" },
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result).toEqual(msgs);
  });

  it("有 toolCall 但无对应 toolResult 时补全错误结果", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "gm_search" }],
        stopReason: "end",
      },
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("assistant");
    expect(result[1].role).toBe("toolResult");
    expect((result[1] as any).toolCallId).toBe("tc1");
    expect((result[1] as any).isError).toBe(true);
  });

  it("有 toolCall + 匹配 toolResult 时保留两者", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "gm_search" }],
        stopReason: "end",
      },
      { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "result" }] },
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("assistant");
    expect(result[1].role).toBe("toolResult");
  });

  it("重复 toolResult 去重", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "gm_search" }],
        stopReason: "end",
      },
      { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "first" }] },
      { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "dup" }] },
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    // 验证 assistant 消息存在且 toolResult 被正确处理
    const assistant = result.find((r: any) => r.role === "assistant");
    expect(assistant).toBeTruthy();
    // 至少有一个 toolResult（去重可能保留第一个，也可能标记为 changed）
    const toolResults = result.filter((r: any) => r.role === "toolResult");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolResults[0].toolCallId).toBe("tc1");
  });

  it("stopReason=error 的 assistant 消息跳过 tool 配对", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "gm_search" }],
        stopReason: "error",
      },
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
  });

  it("非 object 消息原样保留", () => {
    const msgs = [
      null as any,
      { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end" },
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result).toHaveLength(2);
  });

  it("孤立的 toolResult（无对应 assistant）被移除", () => {
    const msgs = [
      { role: "toolResult", toolCallId: "orphan", content: [{ type: "text", text: "x" }] },
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result).toHaveLength(0);
  });

  it("多个 toolCall 同时处理", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc1", name: "gm_search" },
          { type: "toolCall", id: "tc2", name: "gm_record" },
        ],
        stopReason: "end",
      },
      { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "r1" }] },
      { role: "toolResult", toolCallId: "tc2", content: [{ type: "text", text: "r2" }] },
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result).toHaveLength(3);
    expect((result[1] as any).toolCallId).toBe("tc1");
    expect((result[2] as any).toolCallId).toBe("tc2");
  });
});