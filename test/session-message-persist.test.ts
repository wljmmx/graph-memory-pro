/**
 * v2.8.x: agent_end 写端回归测试
 *
 * 历史：saveMessage 仅有定义、无运行时调用点，:GmMessage 不再新增，
 * markMessagesByContent 空转。本测试锁定写端的四条不变式。
 *
 * v2.8.x 重要变更：**不再镜像复制实现**。
 * 旧版把 `extractMessageText` / `simpleHash` / `collect` 复制了一份在测试里断言，
 * 属于镜像测试 —— 真实实现改了它也照样通过，永远抓不到回归。
 * 现改为直接 import 真实纯函数（`planMessagePersist` 等），实现与断言同源。
 *
 * 覆盖不变式：
 *   S1 只落 user/assistant 且文本非空
 *   S2 同输入重放键稳定（MERGE 幂等）
 *   S3 键不含位置分量 → 历史被压缩/位移后同一消息仍是同一键（不产生重复行）
 *   S4 同内容重复消息用 seq 区分，不互相覆盖
 *   S5 库中已有份数 → alreadyPresent，键方案切换时不重插历史
 *   S6 台账与键方案无关（旧位置键写入的历史同样能被识别为"已在库"）
 */
import { describe, expect, it } from "vitest";
import {
  messageContentHash,
  buildMessageId,
  messageGroupKey,
  extractMessageText,
  planMessagePersist,
  type AgentMessageLike,
} from "../src/store/messages.ts";

/** 便于构造已有台账：给定 [{role, content}] 生成 (role, 指纹) → 份数 */
function baselineOf(rows: Array<{ role: "user" | "assistant"; content: string }>, truncated = false) {
  const byGroup = new Map<string, number>();
  for (const r of rows) {
    const k = messageGroupKey(r.role, messageContentHash(r.content));
    byGroup.set(k, (byGroup.get(k) ?? 0) + 1);
  }
  return { byGroup, truncated };
}

describe("session message persist (v2.8.x write path)", () => {
  describe("过滤（S1）", () => {
    it("只落 user/assistant 且文本非空，系统/工具/空白消息跳过", () => {
      const plan = planMessagePersist(
        [
          { role: "system", content: "sys prompt" },
          { role: "user", content: "你好" },
          { role: "tool", content: "tool out" },
          { role: "assistant", content: "收到" },
          { role: "assistant", content: "   " },
        ],
        "sess-A",
      );
      expect(plan.map((p) => p.role)).toEqual(["user", "assistant"]);
      expect(plan.map((p) => p.content)).toEqual(["你好", "收到"]);
      expect(plan.map((p) => p.turnIndex)).toEqual([0, 1]);
    });

    it("解析多模态 content 块数组（仅取 text 块，用换行连接）", () => {
      const plan = planMessagePersist(
        [{ role: "assistant", content: [{ type: "text", text: "部分A" }, { type: "tool_use" }, { type: "text", text: "部分B" }] }],
        "sess-A",
      );
      expect(plan[0].content).toBe("部分A\n部分B");
    });

    it("text / body 兜底字段也能取到文本", () => {
      expect(extractMessageText({ role: "user", text: "来自 text" })).toBe("来自 text");
      expect(extractMessageText({ role: "user", body: "来自 body" })).toBe("来自 body");
    });
  });

  describe("稳定键（S2 / S3）", () => {
    it("同输入重放键稳定（MERGE 幂等，行数不膨胀）", () => {
      const msgs: AgentMessageLike[] = [
        { role: "user", content: "同一句话" },
        { role: "assistant", content: "同一回复" },
      ];
      const a = planMessagePersist(msgs, "sess-A");
      const b = planMessagePersist(msgs, "sess-A");
      expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
      expect(new Set(a.map((p) => p.id)).size).toBe(2);
    });

    it("键不含位置分量：历史头部被压缩掉后，尾部消息的键保持不变", () => {
      const user1: AgentMessageLike = { role: "user", content: "第一轮问题" };
      const asst1: AgentMessageLike = { role: "assistant", content: "第一轮回答" };
      const user2: AgentMessageLike = { role: "user", content: "第二轮问题" };
      const asst2: AgentMessageLike = { role: "assistant", content: "第二轮回答" };

      const full = planMessagePersist([user1, asst1, user2, asst2], "sess-A");
      // 模拟宿主 compaction：前两条被摘要替换 → 数组位移
      const compacted = planMessagePersist([{ role: "user", content: "（前文摘要）" }, user2, asst2], "sess-A");

      const tailOfFull = full.filter((p) => p.content.includes("第二轮")).map((p) => p.id);
      const tailOfCompacted = compacted.filter((p) => p.content.includes("第二轮")).map((p) => p.id);
      expect(tailOfCompacted).toEqual(tailOfFull);
      // 旧位置键会因位移而改变：这里显式断言新键不含 turnIndex 语义
      expect(tailOfCompacted[0]).not.toContain(":1:");
    });

    it("不同会话 / 不同角色 / 不同内容 → 不同键", () => {
      const one: AgentMessageLike[] = [{ role: "user", content: "hi" }];
      expect(planMessagePersist(one, "sess-A")[0].id).not.toBe(planMessagePersist(one, "sess-B")[0].id);
      expect(planMessagePersist([{ role: "user", content: "x" }], "s")[0].id)
        .not.toBe(planMessagePersist([{ role: "assistant", content: "x" }], "s")[0].id);
      expect(planMessagePersist([{ role: "user", content: "x" }], "s")[0].id)
        .not.toBe(planMessagePersist([{ role: "user", content: "y" }], "s")[0].id);
    });
  });

  describe("同内容重复消息（S4）", () => {
    it("连发两次相同内容 → seq 区分，两行互不覆盖", () => {
      const plan = planMessagePersist(
        [
          { role: "user", content: "继续" },
          { role: "assistant", content: "好的" },
          { role: "user", content: "继续" },
        ],
        "sess-A",
      );
      const continues = plan.filter((p) => p.content === "继续");
      expect(continues).toHaveLength(2);
      expect(continues[0].occurrence).toBe(0);
      expect(continues[1].occurrence).toBe(1);
      expect(continues[0].id).not.toBe(continues[1].id);
    });
  });

  describe("与库中对账（S5 / S6）", () => {
    it("库中已有 N 份 → 前 N 次 occurrence 标记 alreadyPresent，仅新增份数需写入", () => {
      // 库中已有 1 条 user"继续"（无论是旧位置键还是新稳定键写入的）
      const baseline = baselineOf([{ role: "user", content: "继续" }]);
      const plan = planMessagePersist(
        [
          { role: "user", content: "继续" }, // occurrence 0 < 已有 1 → 跳过
          { role: "user", content: "新增一条" }, // 新内容 → 写
          { role: "user", content: "继续" }, // occurrence 1 >= 已有 1 → 写（第二份）
        ],
        "sess-A",
        baseline.byGroup,
      );
      expect(plan.map((p) => p.alreadyPresent)).toEqual([true, false, false]);
    });

    it("键方案切换：旧位置键写入的历史被识别为已在库，不重插", () => {
      // 模拟历史：旧写端用位置键写入过这两条
      const legacyRows = [
        { role: "user" as const, content: "旧问题" },
        { role: "assistant" as const, content: "旧回答" },
      ];
      const baseline = baselineOf(legacyRows);
      const plan = planMessagePersist(
        [
          { role: "user", content: "旧问题" },
          { role: "assistant", content: "旧回答" },
          { role: "user", content: "本轮新问题" },
        ],
        "sess-A",
        baseline.byGroup,
      );
      // 前两条（历史）跳过 → 只写 1 条 → 不会把历史重插一遍
      expect(plan.filter((p) => !p.alreadyPresent)).toHaveLength(1);
      expect(plan.filter((p) => !p.alreadyPresent)[0].content).toBe("本轮新问题");
    });

    it("台账被截断（truncated）→ 不跳过，退化为只保证幂等", () => {
      const baseline = baselineOf([{ role: "user", content: "继续" }], true);
      const plan = planMessagePersist([{ role: "user", content: "继续" }], "sess-A", baseline.byGroup, baseline.truncated);
      expect(plan[0].alreadyPresent).toBe(false);
    });
  });

  describe("指纹质量", () => {
    it("前 200 字相同、尾部不同的两条消息 → 指纹不同（旧实现会碰撞导致覆盖）", () => {
      const head = "x".repeat(200);
      expect(messageContentHash(head + "尾部甲")).not.toBe(messageContentHash(head + "尾部乙"));
    });

    it("指纹为 64-bit（16 位十六进制），且相同内容稳定", () => {
      const h = messageContentHash("稳定内容");
      expect(h).toMatch(/^[0-9a-f]{16}$/);
      expect(messageContentHash("稳定内容")).toBe(h);
    });

    it("buildMessageId 形状：gm:<sessionKey>:<role>:<hash>:<seq>（无位置分量）", () => {
      const h = messageContentHash("内容");
      expect(buildMessageId("s", "user", h, 0)).toBe(`gm:s:user:${h}:0`);
      expect(buildMessageId("s", "user", h, 0)).not.toBe(buildMessageId("s", "user", h, 1));
    });
  });
});