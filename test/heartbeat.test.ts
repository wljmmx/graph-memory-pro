/**
 * 测试 src/server/heartbeat.ts — 心跳自愈服务
 */
import { describe, it, expect, vi } from "vitest";
import { startHeartbeat } from "../src/server/heartbeat.ts";

describe("startHeartbeat 心跳自愈", () => {
  it("健康探针不触发恢复", async () => {
    const recover = vi.fn(async () => {});
    const handle = startHeartbeat(
      [{ name: "probe", check: async () => true, recover }],
      { intervalMs: 1000, failThreshold: 2, recoverCooldownMs: 1000 },
    );
    await handle.trigger();
    await handle.trigger();
    expect(recover).not.toHaveBeenCalled();
    expect(handle.status()["probe"]).toBe(true);
    handle.stop();
  });

  it("连续失败达到阈值后触发恢复", async () => {
    const recover = vi.fn(async () => {});
    const handle = startHeartbeat(
      [{ name: "probe", check: async () => false, recover }],
      { intervalMs: 1000, failThreshold: 2, recoverCooldownMs: 1000 },
    );
    // 构造时立即执行首轮探测（fail 1），未达阈值
    expect(recover).not.toHaveBeenCalled();
    await handle.trigger(); // fail 2，触发恢复
    expect(recover).toHaveBeenCalledTimes(1);
    expect(handle.status()["probe"]).toBe(false);
    handle.stop();
  });

  it("冷却期内不重复恢复", async () => {
    const recover = vi.fn(async () => {});
    const handle = startHeartbeat(
      [{ name: "probe", check: async () => false, recover }],
      { intervalMs: 1000, failThreshold: 1, recoverCooldownMs: 10_000 },
    );
    await handle.trigger(); // 构造首轮已恢复，本轮处于冷却期内，跳过
    expect(recover).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("恢复后健康状态清零连续失败", async () => {
    const check = vi.fn(async () => false);
    const recover = vi.fn(async () => {});
    const handle = startHeartbeat(
      [{ name: "probe", check, recover }],
      { intervalMs: 1000, failThreshold: 2, recoverCooldownMs: 0 },
    );
    await handle.trigger(); // fail 2（含构造首轮）→ recover
    expect(recover).toHaveBeenCalledTimes(1);
    // 恢复后置为健康 → 连续失败清零
    check.mockResolvedValue(true);
    await handle.trigger();
    await handle.trigger(); // 若未清零，会再触发一次 recover
    expect(recover).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("恢复函数抛错不会中断后续 tick", async () => {
    const recover = vi.fn(async () => { throw new Error("boom"); });
    const handle = startHeartbeat(
      [{ name: "probe", check: async () => false, recover }],
      { intervalMs: 1000, failThreshold: 1, recoverCooldownMs: 0 },
    );
    await expect(handle.trigger()).resolves.toBeUndefined();
    handle.stop();
  });
});