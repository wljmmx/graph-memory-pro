/**
 * graph-memory-pro — 进程级共享状态（跨模块实例单例）
 *
 * 问题：宿主（openclaw）可在同一进程内加载本插件的多个模块实例
 *   —— `~/.openclaw/extensions/graph-memory-pro/dist/index.js` 一份，
 *   被 lcm-graph-extra 的 graph-adapter 按包名 import 的 node_modules 副本另一份。
 *   ESM 模块缓存按 specifier 隔离，于是模块级 `let _x` 各持一份，导致：
 *     1. 双份 server 抢同一端口 → EADDRINUSE + 端口漂移（API 7850→7852，MCP 7800→7803）
 *     2. 非所有者实例 `_mcpServerHandle` 恒为 null → 心跳探针恒 false
 *        → 每 30s 触发一次"重建"，而重建仍从 7800 试到 7803 全部占用 → 永不收敛
 *     3. `getRecaller()` 跨实例返回 null → graph-adapter 回退自建 Recaller → M 矩阵分叉
 *     4. 双份 Neo4j 连接池 / extractor / maintenance 定时器
 *
 * 方案：模块级状态 → 进程级单例。**资源全局唯一，注册按实例各一份**
 *   （tools / hooks / services 是宿主 API，必须由宿主实际调用的那个实例注册；
 *    driver / recaller / server 句柄 / 定时器是进程级资源，只允许一份）。
 *
 * 不变量：
 *   S1  同一 (host, port) 在进程内最多一个监听者 —— 只有所有者实例启动 server
 *   S2  核心资源在同一进程内至多初始化一次
 *   S3  非所有者实例不得对共享资源发起重启
 *   L1  任一实例都能读到同一份句柄与 recaller，故心跳探针能观察到真实健康态
 *   L2  所有者初始化失败后允许重新认领，但非所有者不进入紧凑重试
 *
 * 关键区分（易错点）：
 *   - **共享状态对象**（本模块的 `getProcessState()`）在同一进程内所有模块实例间共享；
 *   - **实例身份**（`getInstanceId()`）必须留在模块作用域 —— 若把 instanceId 放进共享
 *     对象，第二个实例读到的会是第一个实例的 id，于是 `coreOwnerId === instanceId`
 *     对两个实例同时成立，两个都会自认为"所有者"，单例守卫形同虚设。
 *
 * 边界：仅在进程内生效。跨进程（多个 gateway 进程）不适用，也不需要 ——
 *   端口是进程级资源，跨进程本就应该让内核来仲裁。
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "./types.ts";
import type { CompleteFn } from "./engine/llm.ts";
import type { EmbedFn, BatchEmbedFn } from "./engine/embed.ts";
import type { Recaller } from "./recaller/recall.ts";
import type { Extractor } from "./extractor/extract.ts";
import type { HeartbeatHandle } from "./server/heartbeat.ts";

/** server 句柄的最小结构（http-server / mcp-server 的实际监听端口可能 ≠ 配置端口） */
export interface ServerHandleLike {
  port: number;
  close(): Promise<void>;
}

export interface ProcessSharedState {
  // ── 所有权 ──────────────────────────────────────────────
  /** 核心资源所有者实例号；null = 尚无所有者 */
  coreOwnerId: number | null;
  /** 所有者初始化进行中的 promise（供并发实例等待同一结果） */
  coreInitInFlight: Promise<void> | null;
  /** 所有者初始化是否已失败（失败时允许其他实例重新认领） */
  coreInitFailed: boolean;

  // ── 核心资源 ────────────────────────────────────────────
  driver: Driver | null;
  cfg: GmConfig | null;
  llm: CompleteFn | null;
  embed: EmbedFn | null;
  batchEmbed: BatchEmbedFn | null;
  recaller: Recaller | null;
  extractor: Extractor | null;

  // ── server 句柄 ─────────────────────────────────────────
  apiServerHandle: ServerHandleLike | null;
  mcpServerHandle: ServerHandleLike | null;
  apiServerAutoStarted: boolean;
  heartbeatHandle: HeartbeatHandle | null;

  // ── 后台定时器 ──────────────────────────────────────────
  extractorTimer: ReturnType<typeof setInterval> | null;
  maintenanceTimer: ReturnType<typeof setInterval> | null;
  autoStartRetryTimer: ReturnType<typeof setInterval> | null;
}

const STATE_KEY = Symbol.for("graph-memory-pro.process-state.v1");
const COUNTER_KEY = Symbol.for("graph-memory-pro.process-state.instance-counter");

/**
 * 本模块实例的序号。
 *
 * 在 **模块作用域** 求值：每个模块实例各自执行一次模块体，因此拿到互不相同的 id。
 * 绝不能放进共享状态对象 —— 那样第二个实例会读到第一个实例的 id，
 * 导致 `coreOwnerId === instanceId` 对两者同时成立，认领机制失效。
 */
const INSTANCE_ID: number = (() => {
  const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>;
  const next = ((globalRecord[COUNTER_KEY] as number | undefined) ?? 0) + 1;
  globalRecord[COUNTER_KEY] = next;
  return next;
})();

/** 取本模块实例序号（诊断/日志用） */
export function getInstanceId(): number {
  return INSTANCE_ID;
}

function readState(): ProcessSharedState | undefined {
  return (globalThis as unknown as Record<PropertyKey, unknown>)[STATE_KEY] as
    | ProcessSharedState
    | undefined;
}

function writeState(state: ProcessSharedState): void {
  (globalThis as unknown as Record<PropertyKey, unknown>)[STATE_KEY] = state;
}

/** 取（必要时创建）进程级共享状态。同一进程内所有模块实例返回同一对象。 */
export function getProcessState(): ProcessSharedState {
  const existing = readState();
  if (existing) return existing;

  const state: ProcessSharedState = {
    coreOwnerId: null,
    coreInitInFlight: null,
    coreInitFailed: false,
    driver: null,
    cfg: null,
    llm: null,
    embed: null,
    batchEmbed: null,
    recaller: null,
    extractor: null,
    apiServerHandle: null,
    mcpServerHandle: null,
    apiServerAutoStarted: false,
    heartbeatHandle: null,
    extractorTimer: null,
    maintenanceTimer: null,
    autoStartRetryTimer: null,
  };
  writeState(state);
  return state;
}

/**
 * 认领核心资源初始化权。
 *
 * - `"owner"`：本实例负责初始化，调用方必须在结束后调用 `settleCoreInit()`
 * - `"reuse"`：已有其他实例负责（或正在负责），调用方应改为复用共享状态、不得启动资源
 *
 * 幂等：同一实例重复调用始终返回 `"owner"`。
 * 可恢复：前任所有者失败（`coreInitFailed`）时允许重新认领，避免永久失效。
 */
export function claimCoreInit(): "owner" | "reuse" {
  const state = getProcessState();
  if (state.coreOwnerId === INSTANCE_ID) return "owner";
  if (state.coreOwnerId === null || state.coreInitFailed) {
    state.coreOwnerId = INSTANCE_ID;
    state.coreInitFailed = false;
    state.coreInitInFlight = null;
    return "owner";
  }
  return "reuse";
}

/** 所有者登记"初始化进行中"，供并发实例等待。幂等：已在进行中时不重置。 */
export function beginCoreInit(): void {
  const state = getProcessState();
  // 幂等：同一实例的嵌套调用（doGatewayInit → startApiServerFromDriver）不得
  // 重置 in-flight promise，否则先前的等待者会挂在一个永不兑现的 promise 上。
  if (state.coreInitInFlight) return;
  state.coreInitFailed = false;
  // 用 pending promise 占位，settleCoreInit 时兑现
  let settle: (ok: boolean) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    settle = (ok: boolean) => (ok ? resolve() : reject(new Error("core init failed")));
  });
  // 无人等待时 reject 不应变成 unhandledRejection
  promise.catch(() => {});
  settleCoreInitRef = settle;
  state.coreInitInFlight = promise;
}

/** 内部：settle 回调。仅所有者实例会赋值（只有所有者调用 beginCoreInit）。 */
let settleCoreInitRef: ((ok: boolean) => void) | null = null;

/** 所有者宣告初始化结束。失败时标记 `coreInitFailed`，允许后续重新认领。 */
export function settleCoreInit(ok: boolean): void {
  const state = getProcessState();
  state.coreInitFailed = !ok;
  const settle = settleCoreInitRef;
  settleCoreInitRef = null;
  state.coreInitInFlight = null;
  settle?.(ok);
}

/**
 * 非所有者等待所有者初始化完成（有界等待，超时返回 `"timeout"`）。
 * 有界是必要的：所有者可能既不成功也不失败地卡住，非所有者不能因此永久阻塞。
 */
export async function waitForCoreInit(
  timeoutMs = 30_000,
): Promise<"ready" | "failed" | "timeout"> {
  const state = getProcessState();
  const inFlight = state.coreInitInFlight;
  if (!inFlight) return state.coreInitFailed ? "failed" : "ready";

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      inFlight.then(() => "ready" as const).catch(() => "failed" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把所有者实例的资源引用发布到进程级状态。
 * 由所有者在初始化成功后调用；非所有者实例随后即可读到同一份引用。
 */
export function publishSharedState(patch: Partial<ProcessSharedState>): void {
  Object.assign(getProcessState(), patch);
}

/**
 * 关闭并清空进程级 server 句柄。
 *
 * 幂等且并发安全：先摘句柄再关，避免两个实例同时进入关闭路径造成双重 close
 * （double close 会让第二个调用方拿到 ERR_SERVER_NOT_RUNNING）。
 */
export async function releaseServerHandle(
  which: "api" | "mcp",
): Promise<ServerHandleLike | null> {
  const state = getProcessState();
  const key = which === "api" ? "apiServerHandle" : "mcpServerHandle";
  const handle = state[key];
  if (!handle) return null;
  state[key] = null;
  try {
    await handle.close();
  } catch {
    // 已经关闭或关闭过程报错都视为"句柄已释放"
  }
  return handle;
}