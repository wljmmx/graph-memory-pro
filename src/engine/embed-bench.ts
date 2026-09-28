/**
 * v2.8.x — embed 批处理容量实测（核心，供插件工具与 CLI 共用）
 *
 * 目的：为 embedding.maxBatchChars（单请求累计字符数预算）在**目标机器**上
 * 实测出安全取值。条数上限（embedding.batchSize）管不住长度：32 条短句与
 * 32 条 800 字的单请求工作量相差数十倍，固定批量超时因而时松时紧。
 *
 * 与旧版脚本的关键差异（v2.8.x 完善）：
 *   1. 完全读取真实配置：baseURL / model / apiKey / apiFormat / keepAlive /
 *      options / batchSize / maxBatchChars —— 档位上限由配置的 batchSize 推导，
 *      不再写死（旧版忽略 batchSize，且段长硬编码 400）。
 *   2. 三个画像分别实测：short（短文本）/ mixed（混合）/ long（长文本）。
 *      因为**哪个上限先触顶取决于文本长度**：短文本永远是条数先触顶，
 *      maxBatchChars 对它们无收益；长/混合文本才是长度预算发挥作用的地方。
 *   3. 档位以「每请求条数」为步进（1/2/4/8/16/batchSize），比任意字符总额更贴合
 *      真实调参维度，也天然体现 batchSize 的上限作用。
 *   4. 给出可直接落盘的参考配置（取三画像中最保守者）。
 *
 * 纯计算部分（画像构造、档位推导、结论裁剪）与网络 I/O 分离，便于单测。
 */

import type { EmbeddingConfig } from "../types.ts";
import {
  resolveEmbedEndpoint,
  buildEmbedRequestBody,
  buildEmbedRequestHeaders,
  type EmbedEndpoint,
} from "./embed.ts";

/** 批量路径的请求超时（与 embed.ts 中 performEmbedRequest 的批量值一致） */
export const BATCH_TIMEOUT_MS = 120_000;

/** 画像：单条文本的目标字符数 */
export type BenchProfileName = "short" | "mixed" | "long";

export interface BenchProfile {
  name: BenchProfileName;
  /** 单条文本目标字符数（mixed 为循环序列的平均值） */
  label: string;
  /** 构造一条文本（按序号轮换长度，模拟真实分布） */
  seg: (seed: number) => string;
  /** 期望平均单条字符数，用于估算档位总量 */
  avgSegChars: number;
}

/** 真实配置里与 bench 相关的字段快照（供报告展示，证明读的是真配置） */
export interface BenchConfigSnapshot {
  batchSize: number;
  maxBatchChars: number;
  maxConcurrency: number;
  apiFormat: string;
  baseURL: string;
  model: string;
  requestTimeoutMs: number;
}

export interface BenchOptions {
  /** 单请求耗时上限（ms）；默认取批量超时的 50% */
  targetMs?: number;
  /** 安全系数（在达标档位上再打折），默认 0.9；targetMs 已含 2× 余量 */
  safety?: number;
  /** 每个档位的重复次数（取最大值，抗抖动），默认 2 */
  repeats?: number;
  /** 限制画像子集 */
  profiles?: BenchProfileName[];
  /** 覆盖档位（每请求条数）；缺省按 batchSize 推导 */
  itemCounts?: number[];
  /** 每档是否先热身一次（模型可能需加载），默认 true */
  warmup?: boolean;
}

export interface BenchSample {
  /** 本档每请求条数 */
  count: number;
  /** 实际累计字符数 */
  totalChars: number;
  ms: number;
  ok: boolean;
  note?: string;
}

export interface BenchProfileResult {
  profile: BenchProfileName;
  label: string;
  avgSegChars: number;
  /** 该画像下条数上限能装下的最大字符数（= batchSize × avgSegChars） */
  maxReachableChars: number;
  /** 哪个上限先触顶 */
  binding: "batchSize（条数先触顶，长度预算无收益）" | "maxBatchChars（长度预算可发挥作用）";
  samples: BenchSample[];
  /** 该画像实测达标的最大载荷（仅统计未打满条数的档位）；无可达标档位时为 undefined */
  safeChars?: number;
  note?: string;
}

export interface BenchReport {
  endpoint: string;
  config: BenchConfigSnapshot;
  targetMs: number;
  safety: number;
  results: BenchProfileResult[];
  /**
   * 参考配置值：
   *   - 数字 > 0 → 建议启用该长度预算
   *   - 0        → 实测条数上限本身已安全，建议**保持关闭**
   *   - undefined → 无任何档位达标，未测出结论
   */
  recommendedMaxBatchChars?: number;
  /** 结论理由（人类可读，说明为何是启用/保持关闭） */
  recommendationReason: string;
  /** 长度预算是否真的会改变请求构成（false = 装了也无收益） */
  beneficial: boolean;
  summary: string;
}

// ─── 画像构造（纯函数） ────────────────────────────────────────

/** 可复现的伪随机：避免不同运行间文本长度分布漂移，保证测量可比 */
function makeSeg(len: number, seed: number): string {
  const unit = "内网服务嵌入接口排查记录与处置说明，用于测量单次提交的总长度与耗时关系。";
  const rotated = unit.slice(seed % unit.length) + unit.repeat(Math.ceil(len / unit.length));
  return rotated.slice(0, len);
}

/** 短文本画像：贴近 recall 里的 query / 短节点名（几十字） */
const SHORT_SEG_CHARS = 40;
/** 中文本画像：贴近分块后的 chunk（chunkSize 量级） */
const MID_SEG_CHARS = 400;
/** 长文本画像：贴近未分块的单向量路径（memorySliceChars 量级） */
const LONG_SEG_CHARS = 800;

export const BENCH_PROFILES: Record<BenchProfileName, BenchProfile> = {
  short: {
    name: "short",
    label: "短文本（约 40 字/条，如 query、短节点名）",
    avgSegChars: SHORT_SEG_CHARS,
    seg: (seed) => makeSeg(SHORT_SEG_CHARS, seed),
  },
  long: {
    name: "long",
    label: "长文本（约 800 字/条，如未分块的节点 content）",
    avgSegChars: LONG_SEG_CHARS,
    seg: (seed) => makeSeg(LONG_SEG_CHARS, seed),
  },
  mixed: {
    name: "mixed",
    label: "混合（40/400/800 字轮换，最贴近真实载荷）",
    avgSegChars: (SHORT_SEG_CHARS + MID_SEG_CHARS + LONG_SEG_CHARS) / 3,
    // 轮换长度：使同一请求内长度方差大 —— 这正是动态批处理要解决的场景
    seg: (seed) => makeSeg([SHORT_SEG_CHARS, MID_SEG_CHARS, LONG_SEG_CHARS][seed % 3], seed),
  },
};

/**
 * 按画像构造一个请求的输入数组：条数由 count 决定且**不超过 batchSize**，
 * 与引擎装箱一致（条数上限永远生效）。
 */
export function buildProfileInputs(
  profile: BenchProfile,
  count: number,
  batchSize: number,
): string[] {
  const n = Math.max(1, Math.min(count, batchSize));
  return Array.from({ length: n }, (_, i) => profile.seg(i));
}

/**
 * 档位（每请求条数）：几何递增到 batchSize，天然体现条数上限。
 * 1/2/4/8/16/batchSize（去重升序）。
 */
export function deriveItemCounts(batchSize: number): number[] {
  const out = new Set<number>();
  for (const n of [1, 2, 4, 8, 16, 32]) {
    if (n <= batchSize) out.add(n);
  }
  out.add(Math.max(1, batchSize));
  return [...out].sort((a, b) => a - b);
}

/** 请求体与端点统一走 embed.ts 的导出，避免与引擎逻辑漂移 */
function requestOf(ep: EmbedEndpoint, inputs: string[]) {
  return {
    url: ep.url,
    headers: buildEmbedRequestHeaders(ep),
    body: buildEmbedRequestBody(ep, inputs),
  };
}

async function postOnce(
  ep: EmbedEndpoint,
  inputs: string[],
  timeoutMs: number,
): Promise<{ ms: number; ok: boolean; note?: string }> {
  const { url, headers, body } = requestOf(ep, inputs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ms, ok: false, note: `HTTP ${res.status} ${text.slice(0, 100)}` };
    }
    const data = (await res.json()) as { embeddings?: unknown[]; data?: unknown[] };
    const n = data.embeddings?.length ?? data.data?.length ?? 0;
    return { ms, ok: n > 0, note: n > 0 ? undefined : "响应无向量（模型/维度可能不匹配）" };
  } catch (err) {
    return { ms: Date.now() - started, ok: false, note: (err as Error)?.message ?? String(err) };
  }
}

/**
 * 实测入口。
 *
 * @param config 真实 embedding 配置（插件内直接传 _cfg.embedding）
 * @param onProgress 可选进度回调（工具场景下用于输出中间态）
 */
export async function runEmbedBatchBench(
  config: EmbeddingConfig,
  options: BenchOptions = {},
  onProgress?: (line: string) => void,
): Promise<BenchReport> {
  const ep = resolveEmbedEndpoint(config);
  // batchSize 从真实配置读取（与引擎同一回退规则）
  const batchSize = Number.isFinite(config.batchSize) && (config.batchSize as number) >= 1
    ? Math.floor(config.batchSize as number)
    : 32;
  const currentMaxBatchChars = Number.isFinite(config.maxBatchChars) && (config.maxBatchChars as number) > 0
    ? Math.floor(config.maxBatchChars as number)
    : 0;

  const targetMs = options.targetMs ?? Math.floor(BATCH_TIMEOUT_MS / 2);
  const safety = options.safety ?? 0.9;
  const repeats = Math.max(1, options.repeats ?? 2);
  const warmup = options.warmup ?? true;
  const names = options.profiles ?? (["short", "mixed", "long"] as BenchProfileName[]);
  const counts = options.itemCounts?.length ? options.itemCounts : deriveItemCounts(batchSize);

  const snapshot: BenchConfigSnapshot = {
    batchSize,
    maxBatchChars: currentMaxBatchChars,
    maxConcurrency: config.maxConcurrency ?? 2,
    apiFormat: ep.apiFormat,
    baseURL: ep.baseURL,
    model: ep.model,
    requestTimeoutMs: BATCH_TIMEOUT_MS,
  };

  onProgress?.(`端点 ${ep.url}（${ep.apiFormat}）`);
  onProgress?.(`模型 ${ep.model}｜batchSize=${batchSize}（来自配置）｜档位条数 ${counts.join("/")}`);
  onProgress?.(`当前 maxBatchChars=${currentMaxBatchChars || "0（未启用）"}｜目标单请求耗时 ≤ ${targetMs}ms`);

  const results: BenchProfileResult[] = [];
  for (const name of names) {
    const profile = BENCH_PROFILES[name];
    if (!profile) continue;
    const samples: BenchSample[] = [];
    onProgress?.(`\n── 画像 ${profile.name}：${profile.label}`);

    for (const count of counts) {
      const inputs = buildProfileInputs(profile, count, batchSize);
      const totalChars = inputs.reduce((n, s) => n + s.length, 0);
      // 热身用完整批量超时（冷启动可能要加载模型），不用 targetMs 以免误判
      if (warmup) await postOnce(ep, inputs, BATCH_TIMEOUT_MS);
      let slowestOk: { ms: number; ok: boolean; note?: string } | null = null;
      let last: { ms: number; ok: boolean; note?: string } | null = null;
      for (let r = 0; r < repeats; r++) {
        const got = await postOnce(ep, inputs, BATCH_TIMEOUT_MS);
        last = got;
        // 取最慢的成功样本：容量规划要看尾部而非最好情况
        if (got.ok && (!slowestOk || got.ms >= slowestOk.ms)) slowestOk = got;
      }
      const picked = slowestOk ?? last ?? { ms: 0, ok: false, note: "无样本" };
      samples.push({ count, totalChars, ms: picked.ms, ok: picked.ok, note: picked.note });
      onProgress?.(
        `   ${String(count).padStart(3)} 条 / ${String(totalChars).padStart(6)} 字  ` +
          `${picked.ok ? "OK " : "ERR"}  ${String(picked.ms).padStart(7)} ms` +
          `${picked.note ? `  ${picked.note}` : ""}`,
      );
    }

    // 该画像条数上限能装下的最大字符数（= batchSize × 平均段长）
    const maxReachableChars = Math.round(batchSize * profile.avgSegChars);

    // 仅用「未打满条数」的档位推导阈值：条数 == batchSize 的档位，其字符数由
    // 条数上限决定，拿来当 maxBatchChars 会把条数上限误当成长度阈值。
    const okWithin = samples.filter((s) => s.ok && s.ms <= targetMs && s.count < batchSize);
    const safe = okWithin.length
      ? okWithin.reduce((a, b) => (b.totalChars > a.totalChars ? b : a))
      : undefined;

    results.push({
      profile: name,
      label: profile.label,
      avgSegChars: Math.round(profile.avgSegChars),
      maxReachableChars,
      // 占位：是否真正触顶要等参考值算出来才能判定（见下方后处理）
      binding: "maxBatchChars（长度预算可发挥作用）",
      samples,
      safeChars: safe?.totalChars,
      note: safe
        ? undefined
        : samples.some((s) => s.ok)
          ? `⚠ 除最大批次外无档位在 ${targetMs}ms 内完成；该画像可用 batchSize 直接限流，或放宽 targetMs`
          : "⚠ 全部档位失败，见各档 note",
    });
    if (safe) {
      onProgress?.(`   ↳ 达标上限 ${safe.totalChars} 字（${safe.count} 条，${safe.ms}ms）`);
    }
  }

  // ── 汇总 ────────────────────────────────────────────────
  //
  // 关键：约束对象是「单请求总字符数」，与画像无关（耗时基本 ∝ 总字符数）。
  // 因此不能用 min(各画像达标值)——那会取出短文本的小载荷（如 160 字），
  // 把长文本请求压成 1 条/请求，反而制造 8× 请求量，比不启用更差。
  //
  // 正确判据是「条数上限本身是否已经安全」：
  //   - 各画像「打满 batchSize」的档位全部达标 → 条数上限已足以兜住最坏载荷，
  //     长度预算无必要，建议保持 0（关闭）。
  //   - 否则 → 取「已验证安全的最大载荷」作为预算。它必然小于失败的那个满批载荷，
  //     因此会对超长画像真正生效，同时不约束载荷上限更小的画像（如短文本）。
  const allOk = results.flatMap((r) => r.samples.filter((s) => s.ok && s.ms <= targetMs));
  const largestSafeTotal = allOk.length ? Math.max(...allOk.map((s) => s.totalChars)) : undefined;

  const fullBatchSamples = results
    .map((r) => ({ profile: r.profile, sample: r.samples.find((s) => s.count === batchSize) }))
    .filter((x): x is { profile: BenchProfileName; sample: BenchSample } => x.sample !== undefined);
  const countCapAlreadySafe =
    fullBatchSamples.length > 0 && fullBatchSamples.every((x) => x.sample.ok && x.sample.ms <= targetMs);

  let recommendedMaxBatchChars: number | undefined;
  let recommendationReason: string;
  if (largestSafeTotal === undefined) {
    recommendedMaxBatchChars = undefined;
    recommendationReason = "无任何档位达标——请检查服务可用性，或放宽 targetMs。";
  } else if (countCapAlreadySafe) {
    // 明确建议 0：装了反而会把本来安全的请求切碎
    recommendedMaxBatchChars = 0;
    recommendationReason =
      `各画像打满 batchSize 的档位均在 ${targetMs}ms 内完成，条数上限本身已能兜住最坏载荷，` +
      `无需长度预算（maxBatchChars 保持 0）。`;
  } else {
    recommendedMaxBatchChars = Math.max(100, Math.floor((largestSafeTotal * safety) / 100) * 100);
    const failed = fullBatchSamples.filter((x) => !x.sample.ok || x.sample.ms > targetMs).map((x) => x.profile);
    recommendationReason =
      `画像 ${failed.join("/")} 打满 batchSize 时超标，故需要长度预算；` +
      `已实测安全的最大载荷 ${largestSafeTotal} 字 × 安全系数 ${safety}。`;
  }

  // 后处理：判定长度预算对该画像是否真的会生效。
  // 只有当预算小于「条数装满可达的字符数」时，装箱才会因长度而提前封箱；
  // 否则条数上限必然先触顶，长度预算对该画像没有任何影响。
  for (const r of results) {
    const binds = recommendedMaxBatchChars !== undefined
      && recommendedMaxBatchChars > 0
      && recommendedMaxBatchChars < r.maxReachableChars;
    r.binding = binds
      ? "maxBatchChars（长度预算可发挥作用）"
      : "batchSize（条数先触顶，长度预算无收益）";
  }
  const beneficial = recommendedMaxBatchChars !== undefined && recommendedMaxBatchChars > 0;

  const summaryLines: string[] = [];
  summaryLines.push(
    `batchSize=${batchSize}（配置值）｜目标耗时 ≤ ${targetMs}ms｜档位条数 ${counts.join("/")}`,
  );
  summaryLines.push("");
  summaryLines.push(
    "画像".padEnd(12) + "平均段长".padEnd(12) + "满批载荷".padEnd(14) + "满批耗时".padEnd(14) + "长度预算是否生效",
  );
  for (const r of results) {
    const full = r.samples.find((s) => s.count === batchSize);
    summaryLines.push(
      r.profile.padEnd(14) +
        `${r.avgSegChars} 字`.padEnd(13) +
        `${r.maxReachableChars} 字`.padEnd(16) +
        (full ? `${full.ok ? "" : "ERR "}${full.ms} ms` : "—").padEnd(16) +
        (r.binding.startsWith("maxBatchChars") ? "是" : "否（条数先触顶）"),
    );
  }
  summaryLines.push("");
  summaryLines.push(recommendationReason);
  if (recommendedMaxBatchChars !== undefined && recommendedMaxBatchChars > 0) {
    summaryLines.push("");
    summaryLines.push(`参考配置（可直接落盘）：`);
    summaryLines.push(`  "embedding": { "maxBatchChars": ${recommendedMaxBatchChars} }`);
  }

  return {
    endpoint: ep.url,
    config: snapshot,
    targetMs,
    safety,
    results,
    recommendedMaxBatchChars,
    recommendationReason,
    beneficial,
    summary: summaryLines.join("\n"),
  };
}