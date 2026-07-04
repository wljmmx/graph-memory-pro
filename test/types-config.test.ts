/**
 * graph-memory-pro v2.1.2 — 类型与配置完整性测试
 *
 * 验证 GmConfig / GmNode 的字段定义覆盖路线图全部 5 批次任务，
 * 防止后续重构意外删除字段。
 */

import { describe, it, expect } from "vitest";
import type { GmConfig, GmNode, EdgeType, NodeState, NodeSource } from "../src/types.ts";

describe("GmConfig 路线图字段完整性", () => {
  it("第一批字段：temporal / state / staleness / causalEdges / graphHealth", () => {
    const cfg: GmConfig = {
      temporal: { enabled: true },
      state: { enabled: true, filterSupersededInRecall: true },
      staleness: { enabled: true, threshold: 0.7, mode: "heuristic" },
      causalEdges: { enabled: true },
      graphHealth: { enabled: true, alertOnAnomaly: true },
    };
    expect(cfg.temporal?.enabled).toBe(true);
    expect(cfg.state?.filterSupersededInRecall).toBe(true);
    expect(cfg.staleness?.mode).toBe("heuristic");
    expect(cfg.graphHealth?.alertOnAnomaly).toBe(true);
  });

  it("第二批字段：queryCache / judge / feedback / warmup", () => {
    const cfg: GmConfig = {
      queryCache: { enabled: true, maxSize: 100, ttlMs: 1800000, similarityThreshold: 0.95 },
      judge: { enabled: true, asyncMode: true, judgeWarmupFeedbacks: 50, heuristicMatch: "both" },
      feedback: { enabled: true, retentionDays: 90 },
      warmup: { warmupFeedbacks: 100, judgeWarmupFeedbacks: 50 },
    };
    expect(cfg.queryCache?.maxSize).toBe(100);
    expect(cfg.judge?.heuristicMatch).toBe("both");
    expect(cfg.feedback?.retentionDays).toBe(90);
    expect(cfg.warmup?.warmupFeedbacks).toBe(100);
  });

  it("第三批字段：associationMatrix / marginalUtility / evolvableEmbedding / importance", () => {
    const cfg: GmConfig = {
      associationMatrix: {
        enabled: true, dimensions: 1024, learningRate: 0.01,
        momentum: 0.9, adamBeta1: 0.9, adamBeta2: 0.999, adamEpsilon: 1e-8,
        warmupFeedbacks: 100,
      },
      marginalUtility: { enabled: true, neighborhoodSize: 5, minImprovement: 0.01 },
      evolvableEmbedding: { enabled: true, archiveKeepCount: 3 },
      importance: {
        enabled: true,
        weights: { recency: 0.3, frequency: 0.3, centrality: 0.2, source: 0.2 },
        recencyDecayDays: 30, frequencySaturation: 10,
      },
    };
    expect(cfg.associationMatrix?.dimensions).toBe(1024);
    expect(cfg.marginalUtility?.neighborhoodSize).toBe(5);
    expect(cfg.evolvableEmbedding?.archiveKeepCount).toBe(3);
    expect(cfg.importance?.weights?.centrality).toBe(0.2);
  });

  it("第四批字段：hierarchicalCommunity / conflictResolution / edgeWeights / reverseMemory", () => {
    const cfg: GmConfig = {
      hierarchicalCommunity: { enabled: true, depth: 3 },
      conflictResolution: {
        enabled: true, temporalPriority: true,
        sourcePriority: true, confidencePriority: true,
      },
      edgeWeights: {
        enabled: true, strengthenFactor: 1.1, decayFactor: 0.95,
        minWeight: 0.1, maxWeight: 5.0,
      },
      reverseMemory: {
        enabled: true, recallThreshold: 10,
        stalenessPenalty: 0.1, importanceFloor: 0.2,
      },
    };
    expect(cfg.hierarchicalCommunity?.depth).toBe(3);
    expect(cfg.conflictResolution?.temporalPriority).toBe(true);
    expect(cfg.edgeWeights?.strengthenFactor).toBe(1.1);
    expect(cfg.reverseMemory?.recallThreshold).toBe(10);
  });

  it("第五批字段：benchmark / autoTuner", () => {
    const cfg: GmConfig = {
      benchmark: {
        enabled: true, dataDir: "/data", maxCases: 50,
        buildGraph: true, caseTimeoutMs: 30000,
      },
      autoTuner: {
        enabled: true, regressionThreshold: 0.02, stagnationThreshold: 5,
        maxRounds: 10, benchmarkMaxCases: 50,
        llmDiagnosis: true, warmupFeedbacks: 100,
      },
    };
    expect(cfg.benchmark?.maxCases).toBe(50);
    expect(cfg.autoTuner?.regressionThreshold).toBe(0.02);
    expect(cfg.autoTuner?.stagnationThreshold).toBe(5);
  });
});

describe("GmNode 路线图字段完整性", () => {
  it("第一批：validFrom / validTo / recordedAt / source / supersededBy / state / stalenessScore", () => {
    const node: GmNode = {
      id: "n1", type: "Task", name: "test", content: "content",
      status: "active", createdAt: 1, updatedAt: 1,
      validFrom: 100, validTo: null, recordedAt: 100,
      source: "experience", supersededBy: undefined,
      state: "current", stalenessScore: 0,
    };
    expect(node.validFrom).toBe(100);
    expect(node.source).toBe("experience");
    expect(node.state).toBe("current");
    expect(node.stalenessScore).toBe(0);
  });

  it("第三批：embeddingHash / embeddingHistory / importanceScore", () => {
    const node: GmNode = {
      id: "n1", type: "Task", name: "test", content: "content",
      status: "active", createdAt: 1, updatedAt: 1,
      embeddingHash: "abc123",
      embeddingHistory: [{ hash: "old1", timestamp: 1, model: "v1" }],
      importanceScore: 0.75,
    };
    expect(node.embeddingHash).toBe("abc123");
    expect(node.embeddingHistory).toHaveLength(1);
    expect(node.importanceScore).toBe(0.75);
  });

  it("第四批：topicId / domainId / embeddingModel", () => {
    const node: GmNode = {
      id: "n1", type: "Task", name: "test", content: "content",
      status: "active", createdAt: 1, updatedAt: 1,
      topicId: "topic-1", domainId: "domain-1",
      embeddingModel: "text-embedding-3-small",
    };
    expect(node.topicId).toBe("topic-1");
    expect(node.domainId).toBe("domain-1");
    expect(node.embeddingModel).toBe("text-embedding-3-small");
  });
});

describe("EdgeType / NodeState / NodeSource 枚举完整性", () => {
  it("EdgeType 含第一批 S-5 因果关系：CAUSED_BY / LEADS_TO", () => {
    const types: EdgeType[] = [
      "RELATES_TO", "MENTIONS", "NEXT_SESSION", "CONTAINS",
      "CAUSED_BY", "LEADS_TO",
    ];
    expect(types).toContain("CAUSED_BY");
    expect(types).toContain("LEADS_TO");
  });

  it("NodeState 含 S-13 状态追踪三态", () => {
    const states: NodeState[] = ["current", "superseded", "transitional"];
    expect(states).toHaveLength(3);
    expect(states).toContain("superseded");
  });

  it("NodeSource 含 S-3 来源标记三类", () => {
    const sources: NodeSource[] = ["experience", "knowledge", "imported"];
    expect(sources).toHaveLength(3);
    expect(sources).toContain("knowledge");
  });
});
