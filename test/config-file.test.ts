/**
 * v2.8.x — openclaw.json 插件配置持久化单测
 *
 * 覆盖 gm_embed_bench persist:true 的落盘路径与其安全闸门：
 *   - 正常写入（对象形态 / 数组形态）
 *   - 备份文件生成 + 原有字段与缩进风格保留
 *   - 值未变 → 不写、不备份
 *   - 非严格 JSON（含注释）→ 拒绝改写（不破坏格式）
 *   - 定位不到插件配置 / 无 embedding 段 → 拒绝（绝不新建结构）
 *   - 文件不存在 → 友好报错
 *
 * 全部在临时目录内进行，绝不触碰真实 ~/.openclaw/openclaw.json。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistEmbeddingParams, resolveOpenclawConfigPath } from "../src/config-file.ts";

let dir: string;
let configPath: string;

/** 写一份 openclaw.json（对象形态，entries 为键值对象） */
function objectForm(embedding: Record<string, unknown> = { baseURL: "http://h:11434", model: "m", batchSize: 32 }) {
  return JSON.stringify(
    {
      gateway: { port: 18789 },
      plugins: {
        entries: {
          "graph-memory-pro": {
            config: {
              neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "pw" },
              embedding,
            },
          },
          "other-plugin": { config: { keep: true } },
        },
      },
    },
    null,
    2,
  ) + "\n";
}

/** 数组形态：entries 为数组，元素含 id */
function arrayForm(embedding: Record<string, unknown> = { baseURL: "http://h:11434", model: "m", batchSize: 32 }) {
  return JSON.stringify(
    {
      plugins: {
        entries: [
          { id: "graph-memory-pro", config: { neo4j: { uri: "bolt://x" }, embedding } },
          { id: "other", config: { keep: true } },
        ],
      },
    },
    null,
    2,
  ) + "\n";
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gm-cfg-"));
  configPath = join(dir, "openclaw.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveOpenclawConfigPath", () => {
  it("默认解析到 ~/.openclaw/openclaw.json", () => {
    expect(resolveOpenclawConfigPath("/home/tester")).toBe("/home/tester/.openclaw/openclaw.json");
  });
});

describe("persistEmbeddingParams", () => {
  it("对象形态：写入 maxBatchChars，保留其它字段与缩进风格，并生成备份", async () => {
    await writeFile(configPath, objectForm(), "utf-8");
    const before = await readFile(configPath, "utf-8");

    const r = await persistEmbeddingParams({ maxBatchChars: 2800 }, configPath);

    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.backupPath).toBeDefined();

    const after = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(after);
    const cfg = parsed.plugins.entries["graph-memory-pro"].config;
    expect(cfg.embedding.maxBatchChars).toBe(2800);
    // 原有字段一字不动
    expect(cfg.embedding.baseURL).toBe("http://h:11434");
    expect(cfg.embedding.model).toBe("m");
    expect(cfg.embedding.batchSize).toBe(32);
    expect(cfg.neo4j.uri).toBe("bolt://localhost:7687");
    expect(parsed.plugins.entries["other-plugin"].config.keep).toBe(true);
    expect(parsed.gateway.port).toBe(18789);
    // 缩进风格（两空格）与结尾换行保留
    expect(after).toContain('\n  "gateway"');
    expect(after.endsWith("\n")).toBe(true);
    // 备份内容 == 写入前的原文
    expect(await readFile(r.backupPath!, "utf-8")).toBe(before);
  });

  it("数组形态（entries 为数组、元素含 id）：同样能定位并写入", async () => {
    await writeFile(configPath, arrayForm(), "utf-8");

    const r = await persistEmbeddingParams({ maxBatchChars: 6400, batchSize: 16 }, configPath);

    expect(r.ok).toBe(true);
    const parsed = JSON.parse(await readFile(configPath, "utf-8"));
    expect(parsed.plugins.entries[0].config.embedding.maxBatchChars).toBe(6400);
    expect(parsed.plugins.entries[0].config.embedding.batchSize).toBe(16);
    expect(parsed.plugins.entries[1].config.keep).toBe(true);
  });

  it("仅写指定字段：只传 maxBatchChars 时不动 batchSize", async () => {
    await writeFile(configPath, objectForm({ baseURL: "http://h", model: "m", batchSize: 8 }), "utf-8");
    await persistEmbeddingParams({ maxBatchChars: 100 }, configPath);
    const emb = JSON.parse(await readFile(configPath, "utf-8")).plugins.entries["graph-memory-pro"].config.embedding;
    expect(emb.maxBatchChars).toBe(100);
    expect(emb.batchSize).toBe(8); // 未被改动
  });

  it("值已相同 → changed=false，不写文件、不产生备份", async () => {
    await writeFile(configPath, objectForm({ baseURL: "http://h", model: "m", maxBatchChars: 2800 }), "utf-8");
    const before = await readFile(configPath, "utf-8");

    const r = await persistEmbeddingParams({ maxBatchChars: 2800 }, configPath);

    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.backupPath).toBeUndefined();
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });

  it("含注释/非严格 JSON → 拒绝改写，文件保持原样（不破坏格式）", async () => {
    const jsonc = `{
  // 这是注释
  "plugins": { "entries": { "graph-memory-pro": { "config": { "embedding": { "baseURL": "http://h" } } } } }
}\n`;
    await writeFile(configPath, jsonc, "utf-8");

    const r = await persistEmbeddingParams({ maxBatchChars: 100 }, configPath);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("严格 JSON");
    expect(await readFile(configPath, "utf-8")).toBe(jsonc); // 原样未动
  });

  it("定位不到插件配置 → 拒绝写入，绝不新建结构", async () => {
    await writeFile(configPath, JSON.stringify({ plugins: { entries: { "some-other": {} } } }, null, 2), "utf-8");
    const before = await readFile(configPath, "utf-8");

    const r = await persistEmbeddingParams({ maxBatchChars: 100 }, configPath);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("未定位到插件配置");
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });

  it("插件配置存在但没有 embedding 段 → 拒绝写入（可能不是生效来源）", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ plugins: { entries: { "graph-memory-pro": { config: { neo4j: { uri: "bolt://x" } } } } } }, null, 2),
      "utf-8",
    );
    const before = await readFile(configPath, "utf-8");

    const r = await persistEmbeddingParams({ maxBatchChars: 100 }, configPath);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("不存在 embedding 段");
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });

  it("文件不存在 → 友好报错，不抛异常", async () => {
    const r = await persistEmbeddingParams({ maxBatchChars: 100 }, join(dir, "nope.json"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("读取失败");
  });

  it("未指定任何字段 → 拒绝", async () => {
    await writeFile(configPath, objectForm(), "utf-8");
    const r = await persistEmbeddingParams({}, configPath);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未指定要写入的字段");
  });

  it("写入 0（关闭）也有效：不应被当成空值跳过", async () => {
    await writeFile(configPath, objectForm({ baseURL: "http://h", model: "m", maxBatchChars: 2800 }), "utf-8");
    const r = await persistEmbeddingParams({ maxBatchChars: 0 }, configPath);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    const emb = JSON.parse(await readFile(configPath, "utf-8")).plugins.entries["graph-memory-pro"].config.embedding;
    expect(emb.maxBatchChars).toBe(0);
  });

  it("原子替换：写入后目录内无残留临时文件", async () => {
    await writeFile(configPath, objectForm(), "utf-8");
    await persistEmbeddingParams({ maxBatchChars: 500 }, configPath);
    const files = await readdir(dir);
    expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
    // 只应有：配置文件 + 1 个备份
    expect(files.filter((f) => f.startsWith("openclaw.json")).length).toBe(2);
  });
});