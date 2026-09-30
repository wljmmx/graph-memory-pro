/**
 * v2.8.x — 嵌入端点解析（apiFormat 判定 + URL 构造）单测
 *
 * 背景：这一层此前**完全没有单测**，而它是「配置了 OVMS 却请求到 Ollama 路径」
 * 这类故障的唯一判定点。生产现象：`batch sub-batch failed` + `8/8 nodes failed batch embed`，
 * 但日志提示却让人去查 Ollama —— 因为判定兜底方向是 ollama。
 *
 * 判定规则（resolveEmbedApiFormat）：
 *   1. 显式 embedding.apiFormat 优先（"ollama" | "openai"）
 *   2. baseURL 含 :11434 → ollama
 *   3. baseURL 含 /v<N> 版本段（如 /v3、/v1）→ openai（OVMS 走这里）
 *   4. 以上都不满足 → **兜底 ollama**
 *
 * 第 4 条是风险点：OVMS 若只写 `http://host:9000`（不带 /v3），会被判成 ollama，
 * 请求发到 `<base>/api/embed` → 必然 404，表现为"全部嵌入失败"。
 * 本测试把该行为显式固定下来，使任何改动都会立刻暴露。
 */
import { describe, it, expect } from "vitest";
import { resolveEmbedEndpoint, buildEmbedRequestBody, buildEmbedRequestHeaders } from "../src/engine/embed.ts";

/** 构造最小 EmbeddingConfig（仅本文件关心的字段） */
const cfg = (over: Record<string, unknown>): any => ({
  baseURL: "",
  model: "qwen-embedding",
  ...over,
});

describe("resolveEmbedEndpoint — apiFormat 判定与 URL 构造（v2.8.x）", () => {
  describe("OVMS / OpenAI 兼容端点", () => {
    it("baseURL 带 /v3 → openai，请求发到 /v3/embeddings（绝不复写为 /api/embed）", () => {
      const ep = resolveEmbedEndpoint(cfg({ baseURL: "http://ovms-host:9000/v3" }));
      expect(ep.apiFormat).toBe("openai");
      expect(ep.url).toBe("http://ovms-host:9000/v3/embeddings");
    });

    it("baseURL 带 /v1 → openai，保留版本段", () => {
      const ep = resolveEmbedEndpoint(cfg({ baseURL: "http://host:9000/v1" }));
      expect(ep.apiFormat).toBe("openai");
      expect(ep.url).toBe("http://host:9000/v1/embeddings");
    });

    it("显式 apiFormat=openai 可救回「不带版本段」的 OVMS 地址（补 /v1）", () => {
      const ep = resolveEmbedEndpoint(cfg({ baseURL: "http://host:9000", apiFormat: "openai" }));
      expect(ep.apiFormat).toBe("openai");
      expect(ep.url).toBe("http://host:9000/v1/embeddings");
    });
  });

  describe("Ollama 端点", () => {
    it(":11434 → ollama，请求发到 /api/embed", () => {
      const ep = resolveEmbedEndpoint(cfg({ baseURL: "http://localhost:11434" }));
      expect(ep.apiFormat).toBe("ollama");
      expect(ep.url).toBe("http://localhost:11434/api/embed");
    });

    it("ollama 下剥离尾部 /v1（OpenAI 兼容路径 → 原生 /api/embed）", () => {
      const ep = resolveEmbedEndpoint(cfg({ baseURL: "http://localhost:11434/v1" }));
      expect(ep.apiFormat).toBe("ollama");
      expect(ep.url).toBe("http://localhost:11434/api/embed");
    });
  });

  describe("兜底行为（风险点，显式固定）", () => {
    it("无 :11434 也无版本段 → 兜底 ollama（OVMS 裸地址会因此走错路径）", () => {
      const ep = resolveEmbedEndpoint(cfg({ baseURL: "http://ovms-host:9000" }));
      // 这是已知的易踩点：OVMS 未带 /v3 且未显式设 apiFormat 时会被判成 ollama
      expect(ep.apiFormat).toBe("ollama");
      expect(ep.url).toBe("http://ovms-host:9000/api/embed");
    });
  });

  describe("请求体 / 请求头按 apiFormat 分发", () => {
    it("openai 格式：body 只含 model + input，绝不夹带 Ollama 专属字段", () => {
      const body = buildEmbedRequestBody(
        { apiFormat: "openai", model: "qwen-embedding", keepAlive: "1h", options: { num_ctx: 4096 } },
        ["a", "b"],
      );
      expect(body).toEqual({ model: "qwen-embedding", input: ["a", "b"] });
      expect(body).not.toHaveProperty("keep_alive");
      expect(body).not.toHaveProperty("options");
    });

    it("ollama 格式：body 含 keep_alive / options", () => {
      const body = buildEmbedRequestBody(
        { apiFormat: "ollama", model: "m", keepAlive: "1h", options: { num_ctx: 4096 } },
        ["a"],
      );
      expect(body).toMatchObject({ model: "m", input: ["a"], keep_alive: "1h", options: { num_ctx: 4096 } });
    });

    it("input 始终是数组（单文本也包成 [text]）—— 后端若不接受数组会 400", () => {
      expect(buildEmbedRequestBody({ apiFormat: "openai", model: "m" }, ["only-one"]))
        .toEqual({ model: "m", input: ["only-one"] });
    });

    it("有 apiKey → 带 Bearer；无 apiKey → 不带 Authorization", () => {
      expect(buildEmbedRequestHeaders({ apiKey: "sk-x" })).toMatchObject({ Authorization: "Bearer sk-x" });
      expect(buildEmbedRequestHeaders({ apiKey: "" })).not.toHaveProperty("Authorization");
    });
  });
});