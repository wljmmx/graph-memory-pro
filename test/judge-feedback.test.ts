/**
 * I-2 LLM 裁判 + 反馈闭环 单元测试 (graph-memory-pro v2.1.2 第二批)
 *
 * 被测模块：
 *   - /workspace/src/recaller/judge.ts — JudgeManager 类
 *   - /workspace/src/recaller/recall.ts — Recaller.processFeedback（集成测试）
 *
 * 关键修复点验证：
 *   旧实现：asyncMode=true 时 processTurn 返回 null，导致 processFeedback 中
 *           `if (!feedback) return` 提前返回，upsertFeedback/incrementFeedback/
 *           updateAssociationMatrix 全部被跳过。
 *   新实现：processTurn 接收 onFeedback 回调，无论同步/异步模式都会执行回调内的
 *           持久化逻辑。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GmNode, GmConfig } from "../src/types.ts";
import { JudgeManager } from "../src/recaller/judge.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";

// ── vi.mock：拦截 store 模块，把 upsertFeedback 替换为可断言的 vi.fn ──
// 同时通过 importOriginal 保留其他导出，避免污染 Recaller 的其他依赖。
vi.mock("../src/store/store.ts", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    upsertFeedback: vi.fn().mockResolvedValue(undefined),
  };
});

// 在 mock 生效后导入（vitest 会把 vi.mock 提升到顶部）
import { upsertFeedback } from "../src/store/store.ts";
import { Recaller } from "../src/recaller/recall.ts";

// ── 辅助工厂 ──────────────────────────────────────────────────

function mkNode(id: string, name: string): GmNode {
  return {
    id,
    type: "SKILL",
    name,
    description: "",
    content: "",
    status: "active",
    pagerank: 0,
    validatedCount: 0,
    createdAt: 0,
    updatedAt: 0,
  } as GmNode;
}

function mkConfig(overrides: Partial<GmConfig> = {}): GmConfig {
  return {
    neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
    compactTurnCount: 6,
    recallMaxNodes: 20,
    recallMaxDepth: 3,
    freshTailCount: 6,
    dedupThreshold: 0.92,
    pagerankDamping: 0.85,
    pagerankIterations: 20,
    ...overrides,
  } as GmConfig;
}

/** 等待异步 fire-and-forget 任务落地 */
function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════
// 1. JudgeManager 单元测试
// ═══════════════════════════════════════════════════════════════

describe("JudgeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1.1 judge() 启发式匹配 ────────────────────────────────

  describe("judge() 启发式匹配", () => {
    it("id 模式：reply 包含 node.id → used", async () => {
      const jm = new JudgeManager({ heuristicMatch: "id" });
      const nodes = [mkNode("n-001", "conda-env-create")];
      const reply = "我使用了 n-001 来完成任务";
      const r = await jm.judge(nodes, reply);
      expect(r.usedNodeIds).toEqual(["n-001"]);
      expect(r.unusedNodeIds).toEqual([]);
    });

    it("name 模式：reply 包含 node.name（>=3 字符）→ used", async () => {
      const jm = new JudgeManager({ heuristicMatch: "name" });
      const nodes = [mkNode("n-001", "conda-env-create")];
      const reply = "执行 conda-env-create 命令创建环境";
      const r = await jm.judge(nodes, reply);
      expect(r.usedNodeIds).toEqual(["n-001"]);
      expect(r.unusedNodeIds).toEqual([]);
    });

    it("name 模式：name < 3 字符不匹配 → unused（防误匹配）", async () => {
      const jm = new JudgeManager({ heuristicMatch: "name" });
      // id 即使出现在 reply 中，name 模式也不会查 id
      const nodes = [mkNode("n1", "ab")]; // name 长度 2 < 3
      const reply = "用 ab 和 n1 都行";
      const r = await jm.judge(nodes, reply);
      expect(r.usedNodeIds).toEqual([]);
      expect(r.unusedNodeIds).toEqual(["n1"]);
    });

    it("both 模式：先匹配 id 后匹配 name（id 命中即跳过 name）", async () => {
      const jm = new JudgeManager({ heuristicMatch: "both" });
      const nodes = [mkNode("n-001", "conda-env-create")];
      // reply 仅包含 id
      const r1 = await jm.judge(nodes, "调用 n-001");
      expect(r1.usedNodeIds).toEqual(["n-001"]);
      // reply 仅包含 name
      const r2 = await jm.judge(nodes, "调用 conda-env-create");
      expect(r2.usedNodeIds).toEqual(["n-001"]);
    });

    it("未匹配 → unused", async () => {
      const jm = new JudgeManager({ heuristicMatch: "both" });
      const nodes = [
        mkNode("n-001", "conda-env-create"),
        mkNode("n-002", "docker-compose-up"),
      ];
      const reply = "我用了完全不同的方法解决问题，与召回无关";
      const r = await jm.judge(nodes, reply);
      expect(r.usedNodeIds).toEqual([]);
      expect(r.unusedNodeIds).toEqual(["n-001", "n-002"]);
    });

    it("冷启动期返回 matchedBy=cold-start", async () => {
      const jm = new JudgeManager({ judgeWarmupFeedbacks: 50 });
      const r = await jm.judge([mkNode("n1", "abc")], "abc");
      expect(r.coldStart).toBe(true);
      expect(r.matchedBy).toBe("cold-start");
    });

    it("已过冷启动期返回 matchedBy=heuristic", async () => {
      const jm = new JudgeManager({ judgeWarmupFeedbacks: 2 });
      jm.incrementFeedback();
      jm.incrementFeedback();
      // feedbackCount(2) >= warmup(2) → 不再冷启动
      const r = await jm.judge([mkNode("n1", "abc")], "abc");
      expect(r.coldStart).toBe(false);
      expect(r.matchedBy).toBe("heuristic");
    });

    it("enabled=false 时返回空结果", async () => {
      const jm = new JudgeManager({ enabled: false });
      const r = await jm.judge([mkNode("n1", "abc")], "abc");
      expect(r.usedNodeIds).toEqual([]);
      expect(r.unusedNodeIds).toEqual([]);
    });
  });

  // ── 1.2 processTurn 同步模式 ──────────────────────────────

  describe("processTurn 同步模式 (asyncMode=false)", () => {
    it("返回 JudgeFeedback 对象且 onFeedback 回调被调用", async () => {
      const jm = new JudgeManager({ asyncMode: false, enabled: true });
      const onFeedback = vi.fn().mockResolvedValue(undefined);
      const nodes = [mkNode("n-001", "conda-env-create")];

      const result = await jm.processTurn(
        "如何创建 conda 环境",
        nodes,
        "我使用了 n-001 来创建环境",
        "sess-1",
        onFeedback,
      );

      expect(result).not.toBeNull();
      expect(result!.query).toBe("如何创建 conda 环境");
      expect(result!.recalledNodeIds).toEqual(["n-001"]);
      expect(result!.usedNodeIds).toEqual(["n-001"]);
      expect(result!.unusedNodeIds).toEqual([]);
      expect(result!.sessionId).toBe("sess-1");
      expect(typeof result!.timestamp).toBe("number");

      expect(onFeedback).toHaveBeenCalledTimes(1);
      expect(onFeedback.mock.calls[0][0]).toMatchObject({
        query: "如何创建 conda 环境",
        usedNodeIds: ["n-001"],
        sessionId: "sess-1",
      });
    });

    it("未传 onFeedback 也能正常返回 feedback", async () => {
      const jm = new JudgeManager({ asyncMode: false });
      const result = await jm.processTurn(
        "q",
        [mkNode("n1", "abc")],
        "abc",
      );
      expect(result).not.toBeNull();
      expect(result!.query).toBe("q");
    });
  });

  // ── 1.3 processTurn 异步模式（关键修复点） ────────────────

  describe("processTurn 异步模式 (asyncMode=true) — 关键修复点", () => {
    it("立即返回 null，但 onFeedback 回调仍被调用", async () => {
      const jm = new JudgeManager({ asyncMode: true, enabled: true });
      const onFeedback = vi.fn().mockResolvedValue(undefined);
      const nodes = [mkNode("n-001", "conda-env-create")];

      const result = await jm.processTurn(
        "如何创建 conda 环境",
        nodes,
        "我使用了 n-001 来创建环境",
        "sess-async",
        onFeedback,
      );

      // 修复点 1：异步模式立即返回 null
      expect(result).toBeNull();

      // 等待 fire-and-forget 后台任务完成
      await flushAsync(50);

      // 修复点 2：onFeedback 仍被调用（旧实现此处不会执行）
      expect(onFeedback).toHaveBeenCalledTimes(1);
      const fb = onFeedback.mock.calls[0][0];
      expect(fb.query).toBe("如何创建 conda 环境");
      expect(fb.usedNodeIds).toEqual(["n-001"]);
      expect(fb.sessionId).toBe("sess-async");
    });

    it("异步模式下未传 onFeedback 也不会抛错", async () => {
      const jm = new JudgeManager({ asyncMode: true });
      const result = await jm.processTurn("q", [mkNode("n1", "abc")], "abc");
      expect(result).toBeNull();
      await flushAsync(50);
      // 不抛错即视为通过
    });
  });

  // ── 1.4 processTurn disabled ─────────────────────────────

  describe("processTurn disabled", () => {
    it("返回 null 且 onFeedback 不被调用", async () => {
      const jm = new JudgeManager({ enabled: false, asyncMode: false });
      const onFeedback = vi.fn().mockResolvedValue(undefined);

      const result = await jm.processTurn(
        "q",
        [mkNode("n1", "abc")],
        "abc",
        "sess",
        onFeedback,
      );

      expect(result).toBeNull();
      await flushAsync(50);
      expect(onFeedback).not.toHaveBeenCalled();
    });
  });

  // ── 1.5 冷启动判断 ───────────────────────────────────────

  describe("isColdStart()", () => {
    it("feedbackCount < judgeWarmupFeedbacks 时为 true", () => {
      const jm = new JudgeManager({ judgeWarmupFeedbacks: 50 });
      expect(jm.isColdStart()).toBe(true);
    });

    it("累计达到阈值后变为 false", () => {
      const jm = new JudgeManager({ judgeWarmupFeedbacks: 3 });
      expect(jm.isColdStart()).toBe(true);
      jm.incrementFeedback();
      expect(jm.isColdStart()).toBe(true); // 1 < 3
      jm.incrementFeedback();
      expect(jm.isColdStart()).toBe(true); // 2 < 3
      jm.incrementFeedback();
      expect(jm.isColdStart()).toBe(false); // 3 >= 3
    });

    it("默认阈值 50", () => {
      const jm = new JudgeManager();
      for (let i = 0; i < 49; i++) jm.incrementFeedback();
      expect(jm.isColdStart()).toBe(true);
      jm.incrementFeedback();
      expect(jm.isColdStart()).toBe(false);
    });
  });

  // ── 1.6 incrementFeedback 计数 ───────────────────────────

  describe("incrementFeedback / getFeedbackCount", () => {
    it("计数从 0 开始，递增后正确反映", () => {
      const jm = new JudgeManager();
      expect(jm.getFeedbackCount()).toBe(0);
      jm.incrementFeedback();
      expect(jm.getFeedbackCount()).toBe(1);
      jm.incrementFeedback();
      jm.incrementFeedback();
      expect(jm.getFeedbackCount()).toBe(3);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Recaller.processFeedback 集成测试（修复后链路完整性）
// ═══════════════════════════════════════════════════════════════

describe("Recaller.processFeedback 集成测试", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asyncMode=true 时 upsertFeedback 仍被调用（修复后）", async () => {
    const driver = mockDriver();
    const recaller = new Recaller(driver as any, mkConfig());

    // 注入 asyncMode=true 的 JudgeManager（默认配置即 asyncMode=true）
    const jm = new JudgeManager({ asyncMode: true, judgeWarmupFeedbacks: 50 });
    recaller.setJudgeManager(jm);

    const nodes = [mkNode("n-001", "conda-env-create")];

    // 调用 processFeedback（旧实现此处会因 feedback=null 提前 return，跳过持久化）
    await recaller.processFeedback(
      "如何创建 conda 环境",
      nodes,
      "我使用了 n-001 来创建环境",
      "sess-int-1",
    );

    // 等待异步 fire-and-forget 完成
    await flushAsync(50);

    // 修复点验证：upsertFeedback 仍被调用（旧实现此处应为 0）
    expect(upsertFeedback).toHaveBeenCalledTimes(1);

    const callArgs = (upsertFeedback as ReturnType<typeof vi.fn>).mock.calls[0];
    const driverArg = callArgs[0];
    const feedbackArg = callArgs[1];

    // driver 透传
    expect(driverArg).toBe(driver);

    // feedback 字段完整
    expect(feedbackArg).toMatchObject({
      query: "如何创建 conda 环境",
      recalledNodeIds: ["n-001"],
      usedNodeIds: ["n-001"],
      unusedNodeIds: [],
      sessionId: "sess-int-1",
      matchedBy: "cold-start",
    });
    expect(typeof feedbackArg.id).toBe("string");
    expect(feedbackArg.id.length).toBeGreaterThan(0);
    expect(typeof feedbackArg.timestamp).toBe("number");
  });

  it("asyncMode=true 时 incrementFeedback 被调用，coldStart 状态正确变化", async () => {
    const driver = mockDriver();
    const recaller = new Recaller(driver as any, mkConfig());
    // 阈值设为 1，第一次反馈后即脱离冷启动
    const jm = new JudgeManager({ asyncMode: true, judgeWarmupFeedbacks: 1 });
    recaller.setJudgeManager(jm);

    expect(jm.getFeedbackCount()).toBe(0);
    expect(jm.isColdStart()).toBe(true);

    await recaller.processFeedback(
      "q1",
      [mkNode("n1", "abc")],
      "abc",
      "s1",
    );
    await flushAsync(50);

    // 修复点验证：incrementFeedback 被回调调用（旧实现此处应为 0）
    expect(jm.getFeedbackCount()).toBe(1);
    // 达到阈值后脱离冷启动
    expect(jm.isColdStart()).toBe(false);
    expect(upsertFeedback).toHaveBeenCalledTimes(1);
  });

  it("asyncMode=false 时链路同样完整", async () => {
    const driver = mockDriver();
    const recaller = new Recaller(driver as any, mkConfig());
    const jm = new JudgeManager({ asyncMode: false, judgeWarmupFeedbacks: 50 });
    recaller.setJudgeManager(jm);

    await recaller.processFeedback(
      "q-sync",
      [mkNode("n1", "abc")],
      "abc",
      "s-sync",
    );
    // 同步模式无需 flushAsync，但加一道保险
    await flushAsync(20);

    expect(upsertFeedback).toHaveBeenCalledTimes(1);
    expect(jm.getFeedbackCount()).toBe(1);
  });

  it("未注入 JudgeManager 时安全跳过", async () => {
    const driver = mockDriver();
    const recaller = new Recaller(driver as any, mkConfig());
    // 不调用 setJudgeManager
    await recaller.processFeedback("q", [mkNode("n1", "abc")], "abc", "s");
    await flushAsync(20);
    expect(upsertFeedback).not.toHaveBeenCalled();
  });

  it("多次反馈：计数持续递增，冷启动状态正确翻转", async () => {
    const driver = mockDriver();
    const recaller = new Recaller(driver as any, mkConfig());
    const jm = new JudgeManager({ asyncMode: true, judgeWarmupFeedbacks: 2 });
    recaller.setJudgeManager(jm);

    // 第 1 次：count=1, 仍冷启动
    await recaller.processFeedback("q1", [mkNode("n1", "abc")], "abc", "s1");
    await flushAsync(50);
    expect(jm.getFeedbackCount()).toBe(1);
    expect(jm.isColdStart()).toBe(true);
    expect(upsertFeedback).toHaveBeenCalledTimes(1);

    // 第 2 次：count=2, 达到阈值脱离冷启动
    await recaller.processFeedback("q2", [mkNode("n2", "def")], "def", "s2");
    await flushAsync(50);
    expect(jm.getFeedbackCount()).toBe(2);
    expect(jm.isColdStart()).toBe(false);
    expect(upsertFeedback).toHaveBeenCalledTimes(2);

    // 第 3 次：count=3, 已脱离冷启动，matchedBy 应为 heuristic
    await recaller.processFeedback("q3", [mkNode("n3", "ghi")], "ghi", "s3");
    await flushAsync(50);
    expect(jm.getFeedbackCount()).toBe(3);
    expect(jm.isColdStart()).toBe(false);

    const lastCall = (upsertFeedback as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(lastCall[1].matchedBy).toBe("heuristic");
  });
});
