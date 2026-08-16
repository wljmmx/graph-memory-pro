/**
 * graph-memory-pro — LLM 引擎（带重试和超时）
 *
 * 从 V1 移植 retry 逻辑：3 次重试 + 30s 超时
 * 所有凭据只从配置对象读取，不做 process.env 回退
 */

import type { LlmConfig } from "../types.ts";
import { combineSignals } from "../utils.ts";

/**
 * LLM 补全函数签名
 *
 * v2.3.5 B2: 新增可选 signal 参数，调用方可传入 AbortSignal 以便在外部
 * 超时（如 judge 的 8s 超时）触发时取消底层 fetch，避免 orphan request。
 * 不传 signal 时引擎仍会应用 30s 内部安全超时。
 *
 * v2.3.5 B3: 新增可选 purpose 参数，用于 LLM token 用量按用途分组统计
 * （extract / recall / judge / community / diagnose / benchmark / probe）。
 * 调用方应传入自身用途，供 /api/usage 的 byPurpose 维度展示。
 * 不传时记为 "unknown"（向后兼容）。
 */
export type CompleteFn = (
  system: string,
  user: string,
  signal?: AbortSignal,
  purpose?: string,
) => Promise<string>;

/** 重试延迟 */
const RETRY_DELAYS = [2000, 5000, 10_000];
// v2.3.2 S6: 重试 jitter 上限 — 防止并发失败时重试波峰对齐加剧下游过载
const RETRY_JITTER_MAX_MS = 500;

// v2.3.2 阶段二: 简易信号量（限制 LLM 并发请求数，防 Ollama 单流排队级联超时）
// 无外部依赖，基于 Promise 队列实现
const DEFAULT_LLM_MAX_CONCURRENCY = 1;

// v2.5.1: 周期性重探测间隔。同 session 内用户可能用 /model 切换模型。
// 即使切换后未触发 runtime 调用（如 远程→本地 跨路径切换），至多每 5min
// 重探测一次，避免 decision 长期停留在过期路径。
// v2.5.2: 30s → 5min。过于频繁的重探测会对本地模型产生额外 "ping" 调用，
// 冷启动（模型已卸载）时每次探测触发一次模型加载，导致"反复加载/处理缓慢"。
// 常见的 /model 切换已由单次调用后的 provider|model 指纹即时比对处理，
// 周期兜底重探测无需如此高频。
const RERPROBE_COOLDOWN_MS = 5 * 60_000;

// v2.4.2: 按 purpose 放宽输出上限（maxTokens）。
// 背景：社区摘要是"一句话≤30字"任务，但推理型模型（如 Qwen3 系列，
// 默认开启思考模式）会先输出长链 chain-of-thought，1024 上限会在到达
// 最终答案前截断；截断时返回给插件的 text 往往为空 → 被当作
// "LLM returned no content"。Qwen3 系列官方输出上限默认 8192（8K），
// 设为 8K 可让思考跑完再收敛到答案，且不超服务端上限（避免 400）。
const MAX_TOKENS_BY_PURPOSE: Record<string, number> = {
  community: 8192,
};
const DEFAULT_MAX_TOKENS = 1024;

interface Semaphore {
  acquire(): Promise<() => void>;
  activeCount(): number;
  waitCount(): number;
}

function createSemaphore(max: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<() => void> {
      if (active >= max) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
        const next = waiters.shift();
        if (next) next();
      };
    },
    activeCount(): number { return active; },
    waitCount(): number { return waiters.length; },
  };
}

// 模块级共享信号量（同配置的 CompleteFn 共享同一限制器）
// key = `${baseURL}|${model}`，确保不同 LLM 配置互不干扰
const _semaphores = new Map<string, Semaphore>();
function getSemaphore(baseURL: string, model: string, maxConcurrency: number): Semaphore {
  const key = `${baseURL}|${model}`;
  let sem = _semaphores.get(key);
  if (!sem) {
    sem = createSemaphore(maxConcurrency);
    _semaphores.set(key, sem);
  }
  return sem;
}

/**
 * 内置 LLM 补全引擎
 * 使用 fetch + retry，支持 OpenAI-compatible API
 */
export function createCompleteFn(config?: LlmConfig): CompleteFn | null {
  if (!config?.model && !config?.baseURL && !config?.apiKey) {
    return null;
  }
  if (!config?.model && !config?.baseURL) {
    return null;
  }
  return createOpenAICompatibleComplete(config);
}

/**
 * 创建 OpenAI-compatible 补全函数
 *
 * 兼容 OpenAI / Ollama OpenAI-compat (/v1/chat/completions) / 其他兼容服务。
 * 同时支持 Ollama 原生接口：当 baseURL 命中默认端口 11434 且不含 /v1 时，
 * 自动走原生 /api/chat 端点（见下方 isOllamaNative 检测），keep_alive 完整支持。
 * 否则使用 OpenAI 兼容端点 ${baseURL}/chat/completions。
 */
function createOpenAICompatibleComplete(config: LlmConfig): CompleteFn {
  const apiKey = config.apiKey || "";
  // 清洗 baseURL：去除反引号/首尾空格/尾部斜杠（防止 markdown 标记误入 JSON）
  const baseURL = ((config?.baseURL ?? "https://api.openai.com/v1") as string)
    .replace(/`/g, "")
    .trim()
    .replace(/\/+$/, "");
  const model = config.model || "gpt-4o-mini";
  // Ollama keep_alive 参数（仅 Ollama 识别，OpenAI 会忽略）
  // 默认 "1h"（与 embed 引擎一致），不传时 Ollama 默认 5m 后卸载模型，
  // 导致周期性调用冷启动延迟（LLM 模型加载通常数秒到数十秒）。
  // 注意：数值型（含数值字符串如 "-1"）必须传 number，否则 Go 的 time.ParseDuration
  // 解析字符串 "-1" 会报 `time: missing unit in duration "-1"`（400）。
  const keepAlive = (() => {
    const raw = config.keepAlive;
    if (raw === undefined || raw === null || raw === "") return "1h";
    if (typeof raw === "number") return raw;
    const trimmed = String(raw).trim();
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    return trimmed;
  })();

  // P2-B2: 检测是否为 Ollama 本地服务。
  // Ollama 的 OpenAI 兼容层 (/v1/*) 是实验性支持，keep_alive 可能被忽略。
  // 如果检测到 Ollama（127.0.0.1:11434 或 localhost:11434），优先用原生 /api/chat 端点，
  // 该端点完整支持 keep_alive，避免模型反复卸载加载。
  // v2.4.2: 识别 Ollama 原生端点。Ollama 默认端口 11434，不区分 host（localhost、
  // LAN IP、容器 hostname 均可），且不在 /v1 路径下 → 走原生 /api/chat（完整支持
  // keep_alive/think）。此前仅匹配 localhost，非本机 Ollama 会被误判为 OpenAI 兼容，
  // 请求 /chat/completions（无 /v1）而返回 404。
  const isOllamaNative = /:11434(?:\/|$)/.test(baseURL) && !/\/v1\b/.test(baseURL);

  // v2.3.2 阶段二: 并发控制信号量
  // Ollama 默认单流处理（OLLAMA_NUM_PARALLEL=1），并发请求排队易级联超时。
  // 云端 API 可配置 maxConcurrency 提高吞吐。同 baseURL+model 共享同一信号量。
  const maxConcurrency = config.maxConcurrency ?? DEFAULT_LLM_MAX_CONCURRENCY;
  const semaphore = getSemaphore(baseURL, model, maxConcurrency);

  return async function complete(system: string, user: string, signal?: AbortSignal, purpose: string = "unknown"): Promise<string> {
    const lastErr: Error[] = [];
    const delays = [...RETRY_DELAYS];
    // v2.4.2: 按 purpose 放宽输出上限（如 community=8K，供推理型模型跑完思考）
    const maxTokens = MAX_TOKENS_BY_PURPOSE[purpose] ?? DEFAULT_MAX_TOKENS;

    // v2.3.2 阶段二: acquire 信号量，确保并发不超限（重试在持锁期间复用同一槽位）
    const release = await semaphore.acquire();
    try {
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        let response: Response;
        let apiFormat: 'openai' | 'ollama';

        // v2.3.5 B2: 合并外部 signal（调用方超时）与 30s 内部安全超时。
        // 每次重试重新计算，确保每次 attempt 有独立的 30s 预算。
        // 任一信号 abort 即取消底层 fetch，避免 orphan request。
        const requestSignal = combineSignals(signal, AbortSignal.timeout(30_000));

        if (isOllamaNative) {
          // Ollama 原生 /api/chat 端点：keep_alive 完整支持
          apiFormat = 'ollama';
          response = await fetch(`${baseURL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              stream: false,
              options: {
                num_predict: maxTokens,
                temperature: 0.3,
                // v2.4.1: 思考模式开关（Ollama 推理模型支持 think:false 关闭思考）
                ...(config.thinking !== undefined ? { think: config.thinking } : {}),
              },
              keep_alive: keepAlive,
            }),
            signal: requestSignal,
          });
        } else {
          // OpenAI 兼容端点 /v1/chat/completions（含 Ollama /v1 路径和云端 API）
          apiFormat = 'openai';
          // v2.4.2: OpenAI 兼容服务统一要求在 /v1 下。baseURL 缺 /v1 时自动补全，
          // 避免网关/非 /v1 端点因请求 /chat/completions（无 /v1）返回 404。
          // 已含 /v1 或更高版本路径（如 /v1beta）则原样使用。
          const compatBase = /\/v\d+\b/.test(baseURL) ? baseURL : `${baseURL}/v1`;
          response = await fetch(`${compatBase}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              max_tokens: maxTokens,
              temperature: 0.3,
              // v2.4.1: 思考模式开关（OpenAI 兼容服务未知字段一般会忽略）
              ...(config.thinking !== undefined ? { think: config.thinking } : {}),
              // keep_alive 仅 Ollama 识别，OpenAI 兼容服务会忽略未知字段
              ...(keepAlive != null ? { keep_alive: keepAlive } : {}),
            }),
            signal: requestSignal,
          });
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`LLM API ${response.status}: ${body.slice(0, 200)}`);
        }

        const data = await response.json() as {
          message?: { content?: unknown };
          choices?: Array<{ message?: { content?: unknown } }>;
          prompt_eval_count?: number;
          eval_count?: number;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        // 响应格式适配：Ollama /api/chat 返回 { message: { content } }，
        // OpenAI /v1/chat/completions 返回 { choices: [{ message: { content } }] }
        const rawContent = apiFormat === 'ollama'
          ? data?.message?.content
          : data?.choices?.[0]?.message?.content;
        const usage = apiFormat === 'ollama'
          ? { prompt_tokens: data?.prompt_eval_count, completion_tokens: data?.eval_count, total_tokens: (data?.prompt_eval_count ?? 0) + (data?.eval_count ?? 0) }
          : data?.usage;
        const content = normalizeContent(rawContent);
        if (!content) {
          throw new Error("LLM returned no content");
        }

        // v2.3.0: 记录 token 用量（OpenAI-compatible API 通常返回 usage 字段，Ollama 不返回）
        // v2.3.5 B3: purpose 由调用方传入（extract/judge/community/...），不再硬编码 "unknown"
        try {
          const { recordUsage } = await import("../store/usage.ts");
          recordUsage(
            "config-llm",  // provider 标识（配置的 LLM，非 runtime）
            purpose,
            usage?.prompt_tokens ?? 0,
            usage?.completion_tokens ?? 0,
          );
        } catch { /* usage 记录失败不影响主流程 */ }

        return (content ?? "").trim();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastErr.push(error);

        // 对 4xx 错误（非 429 限流）不重试，因为重试也不会成功
        if (error.message.match(/LLM API 4\d{2}/) && !error.message.includes("429")) {
          throw error;
        }

        // v2.3.5 B2: 外部 signal 已 abort（调用方超时）→ 不重试。
        // 外部 signal 跨重试共享，一旦 abort 不会恢复，重试只会白等 delay 后再 abort。
        if (signal?.aborted) {
          throw error;
        }

        if (attempt < delays.length) {
          // v2.3.2 S6: 加 jitter 防并发重试波峰对齐
          const jitter = Math.random() * RETRY_JITTER_MAX_MS;
          await new Promise((r) => setTimeout(r, delays[attempt] + jitter));
        }
      }
    }

    throw lastErr[lastErr.length - 1] || new Error("LLM completion failed");
    } finally {
      // v2.3.2 阶段二: 无论成功/失败/重试耗尽，都释放信号量槽位
      release();
    }
  };
}

/**
 * 规范化 LLM 响应 content 字段
 *
 * OpenAI 标准返回 string，但部分 OpenAI-compatible 实现（含 Ollama 推理模型、
 * 多模态模型）可能返回：
 *   - string → 直接使用
 *   - null/undefined → 返回 ""（触发上层 "no content" 错误）
 *   - Array<{type: "text", text: string}> → 拼接所有 text part
 *   - 其他 → JSON.stringify 兜底
 */
function normalizeContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // OpenAI multimodal format: [{type: "text", text: "..."}, ...]
    return content
      .map((part) => {
        if (part == null) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  // 兜底：未知类型转字符串
  try { return String(content); } catch { return ""; }
}

// ─── 主会话本地模型优先策略 ────────────────────────────────────────
//
// 设计目标：当插件运行在 OpenClaw 容器内时，如果主会话模型是本地模型
// （ollama / lmstudio / localai / llamafile 等），优先使用主会话模型进行
// LLM 能力处理；如果主会话模型是云端模型（如 OpenAI / Anthropic），
// 则切换到插件配置的 llm（fallbackConfig）。
//
// 探测策略：首次调用时执行一次轻量 probe（maxTokens=8，单条 user 消息
// "ping"），从返回的 result.provider 判断本地/云端，结果缓存为 decision，
// 所有后续调用按 decision 分发，避免重复探测。

/**
 * 本地模型 provider 关键字（小写匹配）
 *
 * 主会话模型 provider 命中以下任一关键字时视为本地模型：
 *   ollama / ollama-256k / lmstudio / localai / llamafile / llama.cpp / llamacpp
 */
const LOCAL_PROVIDER_KEYWORDS = [
  "ollama",
  "lmstudio",
  "localai",
  "llamafile",
  "llama.cpp",
  "llamacpp",
];

function isLocalProvider(provider: string): boolean {
  if (!provider) return false;
  const lower = provider.toLowerCase();
  return LOCAL_PROVIDER_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * OpenClaw 主会话 runtime LLM 接口（仅依赖 complete 方法）
 *
 * 与 SDK 的 LlmCompleteParams / LlmCompleteResult 保持结构兼容，
 * 但用结构化类型避免直接依赖 SDK 内部类型。
 */
export interface RuntimeLlm {
  complete: (params: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    signal?: AbortSignal;
    purpose?: string;
    agentId?: string;
  }) => Promise<{
    text: string;
    provider: string;
    model: string;
    agentId?: string;
    usage?: unknown;
    audit?: unknown;
  }>;
}

/** logger 最小接口（兼容 console 与 SDK logger） */
interface RuntimeLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

// ─── Agent 提供方解析（v2.6.x）──────────────────────────────────────────
//
// 背景：插件通过 api.runtime.llm 调用时会命中 OpenClaw 内置网关地址
// （runtimeContext.llm.baseURL，如 http://127.0.0.1:18789/v1），而非 agent 实际
// 使用的 provider 端点。导致"主会话本地模型优先策略"里 agent 用 qwen3.8:27b，
// 但 runtime 却解析到插件配置的 Qwen3.6-35B-A3B-MTP，加载两个不同本地模型。
//
// 修复：从 agent 的 provider 配置（openclaw.json 的 models.providers）解析出
// 该模型真实 baseURL + 模型名，直接调用底层 provider，绕过网关。匹配规则优先级：
//   1. provider/model 前缀命中（如 ollama/qwen3.8:27b 的 ollama 前缀）
//   2. modelId 短 ID 命中（在某 provider 的 models[].id/name 精确或规范化命中）
//   3. 唯一 provider 兜底（仅配置了一个 provider 时直接使用其 baseUrl）

/** 单个 provider 的模型条目 */
export interface AgentProviderModel {
  id?: string;
  name?: string;
  [k: string]: unknown;
}

/** models.providers.<id> 条目（宽松结构，兼容官方配置） */
export interface AgentProviderInfo {
  baseUrl?: string;
  baseURL?: string;
  apiKey?: string;
  api?: string;
  models?: AgentProviderModel[];
  [k: string]: unknown;
}

/** agent LLM 上下文（从 runtime 配置快照提取的最小视图） */
export interface AgentModelContext {
  /** 当前激活模型 ref，形如 "ollama/qwen3.8:27b" 或裸 "qwen3.8:27b" */
  currentModel?: string;
  /** provider 注册表：models.providers 映射 id -> provider 信息 */
  providers?: Record<string, AgentProviderInfo>;
}

/** 解析出的真实 LLM 端点（绕过网关） */
export interface ResolvedLlmEndpoint {
  baseURL: string;
  model: string;
  apiKey?: string;
  providerId?: string;
}

function pickProviderBaseURL(p: AgentProviderInfo): string | undefined {
  const v = p?.baseURL?.trim() || p?.baseUrl?.trim();
  return v || undefined;
}

function providerModelNames(p: AgentProviderInfo): string[] {
  const out: string[] = [];
  for (const m of p?.models ?? []) {
    if (typeof m?.id === "string" && m.id) out.push(m.id);
    if (typeof m?.name === "string" && m.name) out.push(m.name);
  }
  return out;
}

/** 规范化 token：去空格/大小写/分隔符（/ : 空白），用于宽松比对 */
function normalizeModelToken(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/[\s:/]+/g, "");
}

/** 拆分 "provider/model[...]" → 前缀 + 模型部分（模型部分允许含斜杠，如 qwen3/8b） */
export function splitModelRef(ref: string): { prefix: string; model: string } {
  const s = (ref ?? "").trim();
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return { prefix: "", model: s };
  return { prefix: s.slice(0, i).trim(), model: s.slice(i + 1).trim() };
}

/**
 * 按三级优先级从 agent provider 配置解析当前激活模型的真实端点。
 * 解析失败或无法唯一确定时返回 null（调用方回退到 runtime LLM 路径）。
 */
export function resolveAgentLlmEndpoint(ctx?: AgentModelContext): ResolvedLlmEndpoint | null {
  const providers = ctx?.providers;
  if (!providers) return null;
  const entries = Object.entries(providers).filter(([, p]) => p && typeof p === "object") as [string, AgentProviderInfo][];
  if (entries.length === 0) return null;

  const current = (ctx?.currentModel ?? "").trim();

  // 1) provider/model 前缀匹配
  if (current.includes("/")) {
    const { prefix, model } = splitModelRef(current);
    const prov = providers[prefix];
    if (prov) {
      const baseURL = pickProviderBaseURL(prov);
      if (baseURL) {
        const m = model || providerModelNames(prov)[0] || prefix;
        return { baseURL, model: m, apiKey: prov.apiKey, providerId: prefix };
      }
    }
  }

  // 2) modelId 短 ID 命中：精确或规范化命中某 provider 的模型 id/name
  const modelPart = current.includes("/") ? splitModelRef(current).model : current;
  const normTarget = normalizeModelToken(modelPart);
  let hit: ResolvedLlmEndpoint | null = null;
  for (const [id, prov] of entries) {
    const baseURL = pickProviderBaseURL(prov);
    if (!baseURL) continue;
    for (const name of providerModelNames(prov)) {
      if (name.trim() === modelPart || (normTarget && normalizeModelToken(name) === normTarget)) {
        // 不同 provider 命中同一短 ID → 命中不唯一，视为无法解析
        if (hit && hit.providerId !== id) return null;
        if (!hit) hit = { baseURL, model: name.trim(), apiKey: prov.apiKey, providerId: id };
      }
    }
  }
  if (hit) return hit;

  // 3) 唯一 provider 兜底
  if (entries.length === 1) {
    const [id, prov] = entries[0];
    const baseURL = pickProviderBaseURL(prov);
    if (baseURL) {
      const model = modelPart || providerModelNames(prov)[0] || id;
      return { baseURL, model, apiKey: prov.apiKey, providerId: id };
    }
  }

  return null;
}

/**
 * 创建基于 OpenClaw 主会话 runtime LLM 的补全函数（带 provider 探测 + 缓存）
 *
 * 策略：
 * 1. 首次调用时执行一次轻量 probe（~8 token）探测主会话 provider
 * 2. 检查 result.provider：
 *    - 本地模型 → 后续继续用 runtime LLM（避免云端调用与费用）
 *    - 云端模型 → 后续切换到 fallbackConfig 配置的 LLM
 * 3. 探测结果缓存为 decision，所有后续调用按 decision 分发
 *
 * 设计目标：
 * - 仅一次 ~8 token 的 probe 调用即可完成 provider 探测
 * - 并发安全：所有并发调用共享 detectPromise，避免重复探测
 * - probe 失败时优雅降级到 fallback LLM（如未配置则仍用 runtime LLM）
 */
export function createRuntimeCompleteFn(
  runtimeLlm: RuntimeLlm,
  fallbackConfig?: LlmConfig,
  logger?: RuntimeLogger,
  // v2.6.x: 可选 getter，返回 agent 当前激活模型 + provider 注册表（models.providers）。
  // 能解析出真实端点时直接调用底层 provider，绕过 OpenClaw 网关（避免 runtime 落到
  // 插件配置模型导致加载两个不同本地模型）。
  getAgentModelCtx?: () => AgentModelContext,
): CompleteFn {
  let decision: "runtime" | "fallback" | null = null;
  let detectPromise: Promise<void> | null = null;
  // v2.5.1: 最近一次探测得到的 provider|model，用于 /model 切换后的即时指纹比对
  let detectedKey: string | null = null;
  // v2.5.1: 最近一次探测时间戳，用于周期性兜底重探测
  let lastProbeAt = 0;
  // fallback CompleteFn（lazy init — 仅在 decision === "fallback" 时创建）
  let cachedFallback: CompleteFn | null = null;

  // v2.6.x: 解析出的真实 provider 端点直连 CompleteFn（lazy init）。
  // 以 "baseURL|model" 为指纹，agent /model 切换后自动重建。
  let cachedDirect: CompleteFn | null = null;
  let cachedDirectKey: string | null = null;

  /**
   * v2.6.x: 尝试从 agent provider 配置解析真实端点并构造直连 CompleteFn。
   * 返回 null 表示无法解析或不应直连（回退到 runtime LLM / fallback 路径）。
   *
   * 仅当该端点可被 createCompleteFn 直接鉴权时才直连，避免破坏 OAuth 云端：
   *   - 提供方给了 apiKey（OpenAI 兼容，任意 baseURL）
   *   - 本地 Ollama（无需鉴权，命中默认端口 11434 走原生 /api/chat）
   * 其余（如 OAuth 云端、无法鉴权的第三方）仍走 runtime 网关路径分发。
   */
  function getDirect(): CompleteFn | null {
    let ctx: AgentModelContext;
    try {
      ctx = getAgentModelCtx?.() ?? {};
    } catch (err) {
      logger?.warn?.(`[graph-memory-pro:llm] agent model context unavailable — ${err}`);
      return null;
    }
    let resolved: ResolvedLlmEndpoint | null;
    try {
      resolved = resolveAgentLlmEndpoint(ctx);
    } catch {
      resolved = null;
    }
    if (!resolved) return null;

    // 鉴权门控：无 apiKey 且非本地 Ollama → 不直连（可能需 OAuth，交给网关）
    const isLocal = isLocalProvider(resolved.providerId ?? "");
    const isOllamaPort = /:11434(?:\/|$)/.test(resolved.baseURL);
    if (!resolved.apiKey && !isLocal && !isOllamaPort) return null;

    const key = `${resolved.baseURL}|${resolved.model}`;
    if (cachedDirectKey === key) return cachedDirect ?? null;
    cachedDirect = createCompleteFn({
      baseURL: resolved.baseURL,
      model: resolved.model,
      apiKey: resolved.apiKey,
      keepAlive: fallbackConfig?.keepAlive,
      thinking: fallbackConfig?.thinking,
      maxConcurrency: fallbackConfig?.maxConcurrency,
    });
    cachedDirectKey = key;
    logger?.info?.(
      `[graph-memory-pro:llm] direct agent provider resolved: providerId=${resolved.providerId} baseURL=${resolved.baseURL} model=${resolved.model}`,
    );
    return cachedDirect;
  }

  function getFallback(): CompleteFn | null {
    if (!cachedFallback) {
      cachedFallback = createCompleteFn(fallbackConfig);
    }
    return cachedFallback;
  }

  /**
   * 执行一次 provider 探测；并发调用共享同一次探测。
   * 探测完成后重置 detectPromise，允许周期性重探测。
   */
  function ensureDetected(): Promise<void> {
    if (!detectPromise) {
      detectPromise = detectProvider().finally(() => {
        detectPromise = null;
      });
    }
    return detectPromise;
  }

  // v2.3.2 阶段二: runtime LLM 并发控制（与 fallback 路径独立，避免双重限流）
  // runtime LLM 通常为本地 Ollama，默认 maxConcurrency=1 防级联超时
  const runtimeSemaphore = getSemaphore(
    `runtime:${(fallbackConfig?.baseURL ?? "runtime")}`,
    fallbackConfig?.model ?? "runtime",
    fallbackConfig?.maxConcurrency ?? DEFAULT_LLM_MAX_CONCURRENCY,
  );

  /**
   * 基于 runtime LLM 的补全调用（含 content 规范化）
   */
  async function runtimeComplete(system: string, user: string, signal?: AbortSignal, purpose: string = "unknown"): Promise<{ text: string; provider: string; model: string }> {
    // v2.3.2 阶段二: 信号量限流（runtime LLM 通常本地单流）
    const release = await runtimeSemaphore.acquire();
    try {
      // v2.3.3 ERR-1: runtime LLM 也需要超时控制，防 SDK complete 挂起导致信号量槽位永久占用
      // v2.3.5 B2: 合并外部 signal（调用方超时）与 30s 内部安全超时
      const requestSignal = combineSignals(signal, AbortSignal.timeout(30_000));
      const result = await runtimeLlm.complete({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // v2.5.1: 不传 model —— 让 runtime 使用 agent 当前会话模型（本地 Ollama 场景）。
        // 设计意图：agent 模型为本地/局域网 ollama 时，直接复用 agent 正在用的模型
        // （如 qwen3.8:27b），忽略插件配置的 llm（fallbackConfig.model，仅用于远程场景），
        // 避免同一 Ollama 上加载/卸载两个不同模型造成资源争抢。
        maxTokens: MAX_TOKENS_BY_PURPOSE[purpose] ?? DEFAULT_MAX_TOKENS,
        temperature: 0.3,
        purpose: "graph-memory-pro:llm",
        signal: requestSignal,
      });
      const text = normalizeContent(result?.text);
      if (!text) {
        throw new Error("runtime LLM returned no content");
      }

      // v2.3.0: 记录 runtime LLM token 用量（usage 字段来自 OpenClaw runtime）
      // v2.3.5 B3: purpose 由调用方传入，不再硬编码 "unknown"
      try {
        const { recordUsage } = await import("../store/usage.ts");
        const usage = result?.usage as { promptTokens?: number; completionTokens?: number } | undefined;
        recordUsage(
          result?.provider ? `runtime-${result.provider}` : "runtime",
          purpose,
          usage?.promptTokens ?? 0,
          usage?.completionTokens ?? 0,
        );
      } catch { /* usage 记录失败不影响主流程 */ }

      return { text: (text ?? "").trim(), provider: (result?.provider ?? "").toString(), model: (result?.model ?? "").toString() };
    } finally {
      release();
    }
  }

  /**
   * 探测主会话 runtime LLM 的 provider，缓存 decision
   *
   * 使用极小 probe（单条 "ping" 消息）以最小化 token 开销。
   * v2.4.2: 推理型模型（如 Qwen3 系列默认开启思考）在 maxTokens=8 下无法产出，
   * 会卡满 10s 探针超时 → catch 误判 fallback → 后续走可能未配置好的 fallback LLM
   * 而报 404。故 maxTokens 提到 64、超时放宽到 30s，让思考模型能完成探测。
   * probe 失败时优雅降级到 fallback（如未配置则 decision 仍为 runtime，
   * 后续 runtimeComplete 调用会抛出真实错误）。
   */
  async function detectProvider(): Promise<void> {
    lastProbeAt = Date.now();
    try {
      const result = await runtimeLlm.complete({
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 64,
        temperature: 0,
        purpose: "graph-memory-pro:provider-detect",
        signal: AbortSignal.timeout(30_000),  // v2.4.2: 思考模型慢启动，放宽到 30s
      });
      const provider = (result?.provider ?? "").toString();
      const model = (result?.model ?? "").toString();
      // v2.5.1: 记录 provider|model 指纹，供 /model 切换后的即时比对
      detectedKey = `${provider}|${model}`;
      const local = isLocalProvider(provider);
      logger?.info?.(
        `[graph-memory-pro:llm] runtime provider detected: provider=${provider} model=${model} local=${local}`,
      );
      if (local) {
        decision = "runtime";
      } else if (fallbackConfig?.model || fallbackConfig?.baseURL) {
        decision = "fallback";
      } else {
        // 云端 provider 但无 fallback 配置 → 继续用 runtime
        logger?.warn?.(
          `[graph-memory-pro:llm] runtime provider is cloud but no fallback llm config — staying on runtime`,
        );
        decision = "runtime";
      }
    } catch (err) {
      logger?.warn?.(
        `[graph-memory-pro:llm] provider detection failed — switching to fallback: ${err}`,
      );
      decision = "fallback";
    }
  }

  return async (system: string, user: string, signal?: AbortSignal, purpose: string = "unknown"): Promise<string> => {
    // v2.6.x: 优先使用从 agent provider 配置解析出的真实端点（绕过网关）。
    // 解析失败/无配置时回退到下方的 runtime 探测分发路径。
    const direct = getDirect();
    if (direct) {
      return direct(system, user, signal, purpose);
    }

    // v2.5.1: 首次调用，或距上次探测超过重探测间隔时，重新探测。
    // 覆盖同 session /model 切换（含 远程→本地 跨路径切换，此时未走 runtime 调用）。
    if (decision === null || Date.now() - lastProbeAt >= RERPROBE_COOLDOWN_MS) {
      await ensureDetected();
    }

    if (decision === "fallback") {
      const fb = getFallback();
      if (fb) return fb(system, user, signal, purpose);
      // fallback 配置无效（如未配置 model/baseURL）→ 退回 runtime
    }

    // decision === "runtime" 或 fallback 无效时
    const { text, provider, model } = await runtimeComplete(system, user, signal, purpose);
    // v2.5.1: 本次 runtime 实际使用的 provider/model 与上次探测不一致（如 本地↔本地 /model 切换）
    // → 立即重探测，刷新 decision/detectedKey，供后续调用使用。
    if (detectedKey && provider && model && `${provider}|${model}` !== detectedKey) {
      await ensureDetected();
    }
    return text;
  };
}

// 导出内部辅助函数供测试使用（仅测试引用，不影响打包）
export const __test__ = {
  isLocalProvider,
  normalizeContent,
  LOCAL_PROVIDER_KEYWORDS,
  resolveAgentLlmEndpoint,
  splitModelRef,
};
