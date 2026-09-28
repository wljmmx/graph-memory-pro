/**
 * v2.8.x — embed 批处理性能实测：得出「单次提交可处理的总长度阈值」(maxBatchChars)
 *
 * 背景：批量嵌入此前只按「条数」装箱（embedding.batchSize，默认 32）。
 * 条数相同、长度差异极大时单请求工作量可差数十倍（32×短句 vs 32×800 字），
 * 固定的批量超时（embed.ts 批量路径 120s）因而时松时紧，长文本场景会被击穿
 * 并触发重试风暴。本脚本在**目标机器**上按总字符数递增提交，实测单请求耗时，
 * 据此给出 maxBatchChars 的建议值。
 *
 * 用法：
 *   npm run bench:embed-batch                      # 用 config.example.json 的 embedding 段
 *   npm run bench:embed-batch -- --config <path>   # 指定配置文件
 *   npm run bench:embed-batch -- --base-url http://192.168.50.5:11434 --model Qwen3.5-Embedding-0.6B-GGUF
 *   npm run bench:embed-batch -- --sizes 2000,4000,8000,16000 --target-ms 30000
 *
 * 判定规则：在实测耗时 ≤ --target-ms（默认取批量超时的 50%，即 60s→按 120s 超时算）
 * 的档位中，取最大档作为建议阈值；再按 --safety（默认 0.8）折算出留余量的建议值。
 *
 * 该脚本需要可用的 embedding 服务，故**不作为 CI 断言**（硬件/模型相关，会抖动）。
 * 批处理装箱逻辑本身由 test/embedding-write.test.ts 的确定性用例覆盖。
 *
 * 退出码：0 = 测出建议值；1 = 无任何档位达标或服务不可用。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Args {
  config?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  apiFormat?: "ollama" | "openai";
  keepAlive?: string | number;
  sizes: number[];
  targetMs: number;
  safety: number;
}

/** 批量路径的请求超时（与 src/engine/embed.ts 中 performEmbedRequest 的批量值一致） */
const BATCH_TIMEOUT_MS = 120_000;

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const sizesRaw = get("sizes");
  return {
    config: get("config"),
    baseUrl: get("base-url"),
    model: get("model"),
    apiKey: get("api-key"),
    apiFormat: get("api-format") as Args["apiFormat"],
    keepAlive: get("keep-alive"),
    sizes: sizesRaw
      ? sizesRaw.split(",").map((s) => Math.floor(Number(s.trim()))).filter((n) => n > 0)
      : [1000, 2000, 4000, 8000, 16_000, 32_000],
    targetMs: Math.floor(Number(get("target-ms") ?? BATCH_TIMEOUT_MS / 2)),
    safety: Number(get("safety") ?? 0.8),
  };
}

/** 从配置文件的 embedding 段读取端点（与插件同源的字段名） */
function loadFromConfig(path: string): Partial<Args> & { options?: Record<string, unknown> } {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as {
    embedding?: {
      baseURL?: string;
      model?: string;
      apiKey?: string;
      apiFormat?: "ollama" | "openai";
      keepAlive?: string | number;
      options?: Record<string, unknown>;
    };
  };
  const e = raw.embedding ?? {};
  return {
    baseUrl: e.baseURL,
    model: e.model,
    apiKey: e.apiKey,
    apiFormat: e.apiFormat,
    keepAlive: e.keepAlive,
    options: e.options,
  };
}

/** 判定接口格式：与 src/engine/embed.ts 的 resolveEmbedApiFormat 规则一致 */
function resolveFormat(baseURL: string, explicit?: string): "ollama" | "openai" {
  if (explicit === "ollama" || explicit === "openai") return explicit;
  if (/:11434(?:\/|$)/.test(baseURL)) return "ollama";
  if (/\/v\d+[a-z0-9._-]*(?:\/|$)/i.test(baseURL)) return "openai";
  return "ollama";
}

/**
 * 构造恰好 totalChars 字符的输入数组：优先用「每段 400 字」模拟分块后的真实载荷，
 * 末尾不足 400 用短段补齐，保证总长精确等于目标档位。
 */
function buildInputs(totalChars: number): string[] {
  const SEG = 400;
  const base = "内网服务嵌入接口排查记录，用于测量单次提交的总长度与耗时关系。";
  const seg = base.repeat(Math.ceil(SEG / base.length)).slice(0, SEG);
  const inputs: string[] = [];
  let left = totalChars;
  while (left > 0) {
    const n = Math.min(SEG, left);
    inputs.push(n === SEG ? seg : seg.slice(0, n));
    left -= n;
  }
  return inputs;
}

interface Sample {
  totalChars: number;
  count: number;
  ms: number;
  ok: boolean;
  note?: string;
}

/** 提交一次批量请求并计时（返回是否成功；失败信息进 note） */
async function runOnce(
  endpoint: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ ms: number; ok: boolean; note?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ms, ok: false, note: `HTTP ${res.status} ${text.slice(0, 80)}` };
    }
    const data = (await res.json()) as { embeddings?: unknown[]; data?: unknown[] };
    const n = data.embeddings?.length ?? data.data?.length ?? 0;
    return { ms, ok: n > 0, note: n > 0 ? undefined : "响应无向量" };
  } catch (err) {
    return { ms: Date.now() - started, ok: false, note: (err as Error)?.message ?? String(err) };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fromCfg = args.config ? loadFromConfig(args.config) : {};
  const baseURL = (args.baseUrl ?? fromCfg.baseUrl ?? "http://localhost:11434").replace(/`/g, "").replace(/\/+$/, "");
  const model = args.model ?? fromCfg.model ?? "";
  const apiKey = args.apiKey ?? fromCfg.apiKey ?? "";
  const keepAlive = args.keepAlive ?? fromCfg.keepAlive ?? "1h";
  const format = resolveFormat(baseURL, args.apiFormat ?? fromCfg.apiFormat);

  if (!model) {
    console.error("缺少 model：用 --model 指定，或用 --config 指向含 embedding.model 的配置文件");
    process.exit(1);
  }

  // 端点与 body 与 embed.ts 保持一致（ollama → /api/embed；openai → /embeddings）
  const stripV1 = (u: string) => u.replace(/\/v1$/, "");
  const ollamaBase = stripV1(baseURL);
  const openaiBase = /\/v\d+[a-z0-9._-]*(?:\/|$)/i.test(baseURL) ? baseURL : `${baseURL}/v1`;
  const endpoint = format === "ollama" ? `${ollamaBase}/api/embed` : `${openaiBase}/embeddings`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  console.log(`端点      ${endpoint}  (${format})`);
  console.log(`模型      ${model}`);
  console.log(`目标耗时  ≤ ${args.targetMs} ms（批量超时 ${BATCH_TIMEOUT_MS} ms 的 ${Math.round(args.targetMs / BATCH_TIMEOUT_MS * 100)}%）`);
  console.log(`档位      ${args.sizes.join(" / ")} 字\n`);

  const samples: Sample[] = [];
  for (const size of args.sizes) {
    const inputs = buildInputs(size);
    const body: Record<string, unknown> = format === "ollama"
      ? { model, input: inputs, keep_alive: keepAlive, ...(fromCfg.options ? { options: fromCfg.options } : {}) }
      : { model, input: inputs };
    // 每档先热身一次（模型可能需加载），再正式计时一次
    await runOnce(endpoint, body, headers);
    const r = await runOnce(endpoint, body, headers);
    samples.push({ totalChars: size, count: inputs.length, ms: r.ms, ok: r.ok, note: r.note });
    const status = r.ok ? "OK " : "ERR";
    console.log(
      `  ${String(size).padStart(6)} 字 / ${String(inputs.length).padStart(3)} 条   ${status}   ${String(r.ms).padStart(7)} ms` +
        `${r.note ? `   ${r.note}` : ""}`,
    );
  }

  const okOnes = samples.filter((s) => s.ok);
  if (okOnes.length === 0) {
    console.error("\n所有档位均失败——请确认 embedding 服务可用、模型已拉取、baseURL/模型名正确。");
    process.exit(1);
  }

  const within = okOnes.filter((s) => s.ms <= args.targetMs);
  if (within.length === 0) {
    console.error(`\n没有任何档位满足 ≤ ${args.targetMs} ms。建议改用更小的档位重测（--sizes 500,1000,2000），或放宽 --target-ms。`);
    process.exit(1);
  }

  const best = within.reduce((a, b) => (b.totalChars > a.totalChars ? b : a));
  const recommended = Math.floor((best.totalChars * args.safety) / 100) * 100;

  console.log("\n──────── 结论 ────────");
  console.log(`实测达标上限   ${best.totalChars} 字（${best.count} 条，${best.ms} ms）`);
  console.log(`安全系数       ${args.safety}`);
  console.log(`建议 maxBatchChars = ${recommended}`);
  console.log(`\n写入配置：`);
  console.log(`  "embedding": { "maxBatchChars": ${recommended} }`);
  console.log(`\n说明：该值为「单请求累计字符数」预算，条数仍受 embedding.batchSize 上限约束；`);
  console.log(`      0 = 关闭（仅按条数装箱，即旧行为）。若你的文本普遍很短（如 ≤50 字），`);
  console.log(`      条数上限通常先触顶，收益有限，可不启用。`);
}

main().catch((err) => {
  console.error("bench 执行失败：", err);
  process.exit(1);
});