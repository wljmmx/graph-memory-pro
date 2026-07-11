/**
 * 测试 src/format/assemble.ts — 上下文组装
 */
import { describe, it, expect } from "vitest";
import { buildSystemPromptAddition } from "../src/format/assemble.ts";

describe("buildSystemPromptAddition", () => {
  it("空节点列表返回空字符串", () => {
    const result = buildSystemPromptAddition({ selectedNodes: [], edgeCount: 0 });
    expect(result).toBe("");
  });

  it("仅 active 节点时不包含 recalled 提示", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [
        { type: "SKILL", src: "active" },
        { type: "TASK", src: "active" },
      ],
      edgeCount: 0,
    });
    expect(result).toContain("Graph Memory Pro");
    expect(result).not.toContain("recalled from other conversations");
    expect(result).toContain("1 skills");
    expect(result).toContain("1 tasks");
  });

  it("包含 recalled 节点时提示 'proven solutions'", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [
        { type: "SKILL", src: "active" },
        { type: "EVENT", src: "recalled" },
      ],
      edgeCount: 0,
    });
    expect(result).toContain("recalled from other conversations");
    expect(result).toContain("proven solutions");
  });

  it("节点 >= 4 或边 >= 3 时显示边含义", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [
        { type: "SKILL", src: "active" },
        { type: "TASK", src: "active" },
        { type: "EVENT", src: "active" },
        { type: "SKILL", src: "recalled" },
      ],
      edgeCount: 2,
    });
    expect(result).toContain("Edge meanings");
    expect(result).toContain("SOLVED_BY");
    expect(result).toContain("USED_SKILL");
  });

  it("仅边数 >= 3 时也显示边含义", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [{ type: "SKILL", src: "active" }],
      edgeCount: 3,
    });
    expect(result).toContain("Edge meanings");
  });

  it("节点 < 4 且边 < 3 时不显示边含义", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [{ type: "SKILL", src: "active" }],
      edgeCount: 1,
    });
    expect(result).not.toContain("Edge meanings");
  });

  it("always includes recall priority instructions", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [{ type: "SKILL", src: "active" }],
      edgeCount: 0,
    });
    expect(result).toContain("Recall priority");
    expect(result).toContain("gm_search");
    expect(result).toContain("gm_record");
  });
});