/**
 * 测试 v2.4.0 点2/点4/点5/点6 的纯函数：
 * - src/recaller/chunk.ts   (chunkText / buildEmbedTexts)
 * - src/recaller/rerank.ts  (temporalRecency / combineScore / computeChunkSimilarities / cosineSimilarity)
 */
import { describe, it, expect } from "vitest";
import { chunkText, buildEmbedTexts } from "../src/recaller/chunk.ts";
import {
  temporalRecency,
  combineScore,
  computeChunkSimilarities,
  cosineSimilarity,
} from "../src/recaller/rerank.ts";
import type { GmNode } from "../src/types.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("chunkText (点6)", () => {
  it("短文本返回单段", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
  });

  it("空文本返回空数组", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("长文本按 chunkSize 切分并含重叠", () => {
    const text = "a".repeat(1000);
    const chunks = chunkText(text, { chunkSize: 400, chunkOverlap: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    // 每段长度不超过 chunkSize
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
    // 相邻段有重叠
    const firstEnd = chunks[0].slice(-40);
    expect(chunks[1].startsWith(firstEnd)).toBe(true);
    // 拼接后覆盖全部文本
    expect(chunks.join("").length).toBeGreaterThanOrEqual(1000);
  });

  it("overlap 收敛避免死循环", () => {
    const text = "b".repeat(100);
    const chunks = chunkText(text, { chunkSize: 10, chunkOverlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  // ── v2.8.x: 结构边界优先切分（此前为定长字符切，会拦腰砍断句子）──
  const isBoundaryEnd = (s: string) => /[。！？!?；;，,、：:）)】」』\n]$/.test(s);

  it("切点吸附到自然边界：非末段均以标点/换行收尾，不拦腰砍断句子", () => {
    const para = "开头短句。这是一段较长的补充说明，用于把长度推过切分边界。" + "更多描述内容".repeat(40) + "结尾句。";
    const text = Array(6).fill(para).join("\n\n"); // 1648 字 → 多段
    const chunks = chunkText(text, { chunkSize: 400, chunkOverlap: 40 });

    expect(chunks.length).toBeGreaterThan(2);
    // 除末段（切至文末）外，每段都应以自然边界收尾
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(isBoundaryEnd(chunks[i])).toBe(true);
    }
  });

  it("无任何边界字符时退回硬切，每段仍 ≤ chunkSize，覆盖完整", () => {
    const text = "a".repeat(1000);
    const chunks = chunkText(text, { chunkSize: 400, chunkOverlap: 40 });
    // 无边界可用 → 硬切，段长严格按 chunkSize/step 推进
    expect(chunks.map((c) => c.length)).toEqual([400, 400, 280]);
    // 覆盖完整（重叠导致拼接长度 > 原文）
    expect(chunks.join("")).toHaveLength(1080);
  });

  it("单句超过 chunkSize 时该段硬切（界内无可用边界）", () => {
    const text = "无标点的超长单句".repeat(80); // 640 字，全无边界字符
    const chunks = chunkText(text, { chunkSize: 400, chunkOverlap: 40 });
    expect(chunks[0]).toHaveLength(400);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("过早出现的标点不被吸附：段长不小于 chunkSize 的 50%（防段数暴涨）", () => {
    // 第 5 字即为句号，其后为无边界长串 → 不得在位置 5 切断
    const text = "短句。" + "摸".repeat(995);
    const chunks = chunkText(text, { chunkSize: 400, chunkOverlap: 40 });
    for (const c of chunks) expect(c.length).toBeGreaterThanOrEqual(200);
    expect(chunks[0]).toHaveLength(400);
  });

  it("边界吸附后仍保留 chunkOverlap 约定的重叠字符", () => {
    const para = "内容句子。另一句说明文字，用于把长度推过切分边界。" + "补充内容".repeat(60);
    const text = Array(6).fill(para).join("\n\n"); // 1600 字 → 多段
    const chunks = chunkText(text, { chunkSize: 400, chunkOverlap: 40 });
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startsWith(chunks[i - 1].slice(-40))).toBe(true);
    }
  });

  it("末段直接切至文本末尾（不吸附边界）", () => {
    const text = "甲。".repeat(200) + "收尾无标点"; // 末段不以标点结束
    const chunks = chunkText(text, { chunkSize: 400, chunkOverlap: 40 });
    expect(chunks[chunks.length - 1].endsWith("收尾无标点")).toBe(true);
  });
});

describe("buildEmbedTexts (点2+点6)", () => {
  it("默认不 chunking，按 memorySliceChars 截断", () => {
    const content = "c".repeat(2000);
    const { texts, chunked } = buildEmbedTexts({
      name: "n",
      description: "d",
      content,
      memorySliceChars: 800,
    });
    expect(chunked).toBe(false);
    expect(texts).toHaveLength(1);
    expect(texts[0].length).toBeLessThanOrEqual(800);
  });

  it("启用 chunking 且文本超长时分块", () => {
    const content = "c".repeat(2000);
    const { texts, chunked } = buildEmbedTexts({
      name: "n",
      description: "d",
      content,
      memorySliceChars: 800,
      chunking: { enabled: true, chunkSize: 400, chunkOverlap: 40 },
    });
    expect(chunked).toBe(true);
    expect(texts.length).toBeGreaterThan(1);
  });

  it("启用 chunking 但文本短时仍返回单段", () => {
    const { texts, chunked } = buildEmbedTexts({
      name: "n",
      description: "d",
      content: "short",
      memorySliceChars: 800,
      chunking: { enabled: true, chunkSize: 400, chunkOverlap: 40 },
    });
    expect(chunked).toBe(false);
    expect(texts).toHaveLength(1);
  });
});

describe("temporalRecency (点4)", () => {
  const now = Date.now();
  const base: GmNode = {
    id: "x", type: "TASK", name: "x", description: "", content: "",
    status: "active", pagerank: 0, validatedCount: 0, createdAt: now, updatedAt: now,
  };

  it("刚更新的节点 fresh ≈ 1", () => {
    expect(temporalRecency(base, now)).toBeCloseTo(1, 5);
  });

  it("已过期(validTo 在过去) → 0", () => {
    expect(temporalRecency({ ...base, validTo: now - DAY }, now)).toBe(0);
  });

  it("superseded/transitional 状态 → 0", () => {
    expect(temporalRecency({ ...base, state: "superseded" }, now)).toBe(0);
    expect(temporalRecency({ ...base, state: "transitional" }, now)).toBe(0);
  });

  it("老节点衰减到接近 0", () => {
    const old = { ...base, updatedAt: now - 10 * 30 * DAY };
    expect(temporalRecency(old, now)).toBeLessThan(0.1);
  });
});

describe("combineScore (点4)", () => {
  it("无时序权重时偏向向量相似度", () => {
    const highSim = combineScore({ vectorSim: 0.9, importance: 0.1, temporalWeight: 0 });
    const lowSim = combineScore({ vectorSim: 0.1, importance: 0.9, temporalWeight: 0 });
    expect(highSim).toBeGreaterThan(lowSim);
  });

  it("高过时惩罚降低分数", () => {
    const fresh = combineScore({ vectorSim: 0.8, importance: 0.5, staleness: 0, temporalWeight: 0 });
    const stale = combineScore({ vectorSim: 0.8, importance: 0.5, staleness: 0.9, temporalWeight: 0 });
    expect(fresh).toBeGreaterThan(stale);
  });

  it("时序权重越高，recency 影响越大", () => {
    const recencyHigh = combineScore({ vectorSim: 0, importance: 0, recency: 1, temporalWeight: 1 });
    const recencyLow = combineScore({ vectorSim: 0, importance: 0, recency: 0, temporalWeight: 1 });
    expect(recencyHigh).toBeGreaterThan(recencyLow);
  });
});

describe("computeChunkSimilarities (点5/点6)", () => {
  it("优先使用分块向量取最大相似度", () => {
    const q = [1, 0, 0];
    const node: GmNode = {
      id: "n", type: "TASK", name: "n", description: "", content: "",
      status: "active", pagerank: 0, validatedCount: 0, createdAt: 0, updatedAt: 0,
      chunkEmbeddings: [[0, 1, 0], [1, 1, 0]], // 第二块与 query 更相似
    };
    const sims = computeChunkSimilarities(q, [node]);
    expect(sims.get("n")).toBeGreaterThan(0.7);
  });

  it("无分块向量时回退主 embedding", () => {
    const q = [1, 0, 0];
    const node: GmNode = {
      id: "n", type: "TASK", name: "n", description: "", content: "",
      status: "active", pagerank: 0, validatedCount: 0, createdAt: 0, updatedAt: 0,
      embedding: [1, 0, 0],
    };
    const sims = computeChunkSimilarities(q, [node]);
    expect(sims.get("n")).toBeCloseTo(1, 5);
  });
});

describe("cosineSimilarity", () => {
  it("相同向量相似度为 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });
  it("正交向量相似度为 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
  it("维度不一致返回 0", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});