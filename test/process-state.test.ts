/**
 * 测试 src/process-state.ts — 进程级共享状态（跨模块实例单例）
 *
 * 复现的真实故障（用户环境日志）：
 *   同一 gateway 进程内加载了本插件的两个模块实例，各自执行 full init →
 *   API server 从 7850 漂移到 7852/7853、MCP 从 7800 漂移到 7803，
 *   第二个实例抢 7803 失败后 _mcpServerHandle 恒为 null，
 *   心跳每 30s 触发一次注定失败的重建，永不收敛。
 *
 * 测试手法：`vi.resetModules()` + 二次动态 import，制造**两个真实的模块实例**
 *   （各自执行模块体、各持模块级变量），而 globalThis 共享。
 *   这正是宿主加载 extensions 副本 + node_modules 副本时的形态。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const STATE_KEY = Symbol.for("graph-memory-pro.process-state.v1");
const COUNTER_KEY = Symbol.for("graph-memory-pro.process-state.instance-counter");

/** 清掉 globalThis 上的进程级槽位，让各用例从干净状态开始 */
function resetProcessState(): void {
  const g = globalThis as unknown as Record<PropertyKey, unknown>;
  delete g[STATE_KEY];
  delete g[COUNTER_KEY];
}

type ProcessStateModule = typeof import("../src/process-state.ts");

/** 取一个新的模块实例（模拟宿主再加载一份副本） */
async function loadInstance(): Promise<ProcessStateModule> {
  vi.resetModules();
  return await import("../src/process-state.ts");
}

describe("process-state 进程级共享状态", () => {
  beforeEach(() => {
    resetProcessState();
  });

  it("同一进程内多个模块实例共享同一份状态对象", async () => {
    const a = await loadInstance();
    const b = await loadInstance();

    // 两个模块实例（不同模块对象）…
    expect(a).not.toBe(b);
    // …但看到的是同一个进程级状态
    expect(a.getProcessState()).toBe(b.getProcessState());
  });

  it("实例身份必须互不相同（否则认领机制失效）", async () => {
    const a = await loadInstance();
    const b = await loadInstance();

    expect(a.getInstanceId()).not.toBe(b.getInstanceId());
  });

  it("只有第一个实例能认领核心资源，其余实例一律 reuse", async () => {
    const a = await loadInstance();
    const b = await loadInstance();

    // 首个认领者拿到所有权
    expect(a.claimCoreInit()).toBe("owner");
    // 第二个模块实例绝不能也自认为 owner —— 那会导致双份 full init
    expect(b.claimCoreInit()).toBe("reuse");
    // 幂等：同一实例重复认领仍是 owner
    expect(a.claimCoreInit()).toBe("owner");
  });

  it("所有者初始化失败后允许重新认领（可恢复，不停留在死状态）", async () => {
    const a = await loadInstance();
    const b = await loadInstance();

    expect(a.claimCoreInit()).toBe("owner");
    a.beginCoreInit();
    a.settleCoreInit(false);

    expect(a.getProcessState().coreInitFailed).toBe(true);
    expect(b.claimCoreInit()).toBe("owner");
  });

  it("waitForCoreInit 在所有者完成后返回 ready，失败后返回 failed", async () => {
    const a = await loadInstance();
    const b = await loadInstance();

    a.claimCoreInit();
    a.beginCoreInit();
    const waiting = b.waitForCoreInit(5_000);
    a.settleCoreInit(true);
    await expect(waiting).resolves.toBe("ready");

    const c = await loadInstance();
    a.claimCoreInit();
    a.beginCoreInit();
    const waiting2 = c.waitForCoreInit(5_000);
    a.settleCoreInit(false);
    await expect(waiting2).resolves.toBe("failed");
  });

  it("waitForCoreInit 有界：所有者既不成功也不失败时超时返回而不永久阻塞", async () => {
    const a = await loadInstance();
    const b = await loadInstance();

    a.claimCoreInit();
    a.beginCoreInit(); // 永不 settle
    await expect(b.waitForCoreInit(20)).resolves.toBe("timeout");
  });

  it("releaseServerHandle 只关闭一次（并发重复调用不会 double close）", async () => {
    const a = await loadInstance();
    const close = vi.fn(async () => {});
    a.publishSharedState({ mcpServerHandle: { port: 7803, close } });

    const [first, second] = await Promise.all([
      a.releaseServerHandle("mcp"),
      a.releaseServerHandle("mcp"),
    ]);

    // 恰好一个调用方拿到句柄并负责关闭，另一个拿到 null
    expect(close).toHaveBeenCalledTimes(1);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(a.getProcessState().mcpServerHandle).toBeNull();
  });
});