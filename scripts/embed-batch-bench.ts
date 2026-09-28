/**
 * v2.8.x — embed 批处理容量实测 CLI（薄封装）
 *
 * 核心逻辑在 src/engine/embed-bench.ts，与插件工具 gm_embed_bench 共用同一份实现，
 * 避免「外部脚本」与「插件内工具」两套逻辑漂移。
 *
 * 用法：
 *   npm run bench:embed-batch                              # 用 config.example.json 的 embedding 段
 *   npm run bench:embed-batch -- --config <path>           # 指定配置文件（读全量 embedding 段）
 *   npm run bench:embed-batch -- --base-url URL --model M  # 直接指定端点，其余用默认
 *   npm run bench:embed-batch -- --profiles short,mixed    # 只测部分画像
 *   npm run bench:embed-batch -- --target-ms 30000 --safety 0.8 --repeats 3
 *
 * 注意：配置里的 batchSize 会被真实读取，档位上限由它推导（不再写死条数）。
 *
 * 退出码：0 = 测出参考值；1 = 无档位达标或服务不可用。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EmbeddingConfig } from "../src/types.ts";
import { runEmbedBatchBench, type BenchProfileName } from "../src/engine/embed-bench.ts";

function getArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const configPath = getArg(argv, "config") ?? "config.example.json";

  // 真实读取配置文件的 embedding 段（含 batchSize / maxBatchChars / options）
  let cfg: EmbeddingConfig = {};
  try {
    const raw = JSON.parse(readFileSync(resolve(configPath), "utf8")) as { embedding?: EmbeddingConfig };
    cfg = raw.embedding ?? {};
  } catch (err) {
    console.error(`读取配置失败（${configPath}）：${(err as Error).message}`);
    console.error("可改用 --base-url / --model 直接指定端点。");
    return 1;
  }

  // CLI 覆盖项（不给就不改配置里的值）
  const baseUrl = getArg(argv, "base-url");
  if (baseUrl) cfg.baseURL = baseUrl;
  const model = getArg(argv, "model");
  if (model) cfg.model = model;
  const apiKey = getArg(argv, "api-key");
  if (apiKey !== undefined) cfg.apiKey = apiKey;
  const apiFormat = getArg(argv, "api-format");
  if (apiFormat === "ollama" || apiFormat === "openai") cfg.apiFormat = apiFormat;
  const batchSize = getArg(argv, "batch-size");
  if (batchSize) cfg.batchSize = Math.floor(Number(batchSize));

  if (!cfg.model) {
    console.error("缺少 embedding.model：用 --model 指定，或改用含 embedding.model 的配置文件。");
    return 1;
  }

  const profilesRaw = getArg(argv, "profiles");
  const profiles = profilesRaw
    ? (profilesRaw.split(",").map((s) => s.trim()) as BenchProfileName[])
    : undefined;

  const started = Date.now();
  const report = await runEmbedBatchBench(
    cfg,
    {
      targetMs: getArg(argv, "target-ms") ? Math.floor(Number(getArg(argv, "target-ms"))) : undefined,
      safety: getArg(argv, "safety") ? Number(getArg(argv, "safety")) : undefined,
      repeats: getArg(argv, "repeats") ? Math.floor(Number(getArg(argv, "repeats"))) : undefined,
      profiles,
    },
    (line) => console.log(line),
  );

  console.log(`\n──────── 结论（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）────────`);
  console.log(report.summary);

  if (report.recommendedMaxBatchChars === undefined) {
    if (!report.results.some((r) => r.samples.some((s) => s.ok))) {
      console.error("\n所有档位均失败——请确认 embedding 服务可用、模型已拉取、baseURL / 模型名正确。");
    } else {
      console.error(`\n无档位满足 targetMs=${report.targetMs}ms。可放宽 --target-ms，或调小 batchSize 重测。`);
    }
    return 1;
  }
  if (report.recommendedMaxBatchChars === 0) {
    console.log("\n结论：保持 maxBatchChars = 0（关闭）——条数上限本身已能兜住最坏载荷。");
    return 0;
  }
  console.log("\n说明：该值是「单请求累计字符数」预算，条数仍受 embedding.batchSize 上限约束；");
  console.log("      0 = 关闭（仅按条数装箱，即旧行为）。");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("bench 执行失败：", err);
    process.exit(1);
  });