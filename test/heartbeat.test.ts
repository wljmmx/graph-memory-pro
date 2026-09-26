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

  // v2.8.x: 复现用户环境的"MCP 永不收敛"抖动循环——
  //   端口被他人占用 → 重建失败 → recover() 返回但服务依然不健康 →
  //   旧实现在 recoverCooldownMs（30s）后原样重试，永远如此。
  //   新实现：recover() 后立即复检，未恢复则按指数退避拉长间隔。
  it("恢复后仍不健康时按指数退避拉长重试间隔（不再等间隔抖动）", async () => {
    vi.useFakeTimers();
    try {
      const recover = vi.fn(async () => {});
      const handle = startHeartbeat(
        // check 恒为 false：模拟端口始终被占用，recover() 无法真正修好
        [{ name: "probe", check: async () => false, recover }],
        { intervalMs: 60_000, failThreshold: 1, recoverCooldownMs: 1000, maxRecoverCooldownMs: 8000 },
      );
      await vi.advanceTimersByTimeAsync(0); // 让构造首轮 tick 结算完
      expect(recover).toHaveBeenCalledTimes(1); // attempt 1 → 下次退避 2s

      const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

      advance(1500); // 距上次 1.5s < 2s → 冷却期内，跳过
      await handle.trigger();
      expect(recover).toHaveBeenCalledTimes(1);

      advance(700); // 累计 2.2s ≥ 2s → attempt 2 → 下次退避 4s
      await handle.trigger();
      expect(recover).toHaveBeenCalledTimes(2);

      advance(3000); // 距上次 3.0s < 4s → 跳过
      await handle.trigger();
      expect(recover).toHaveBeenCalledTimes(2);

      advance(1200); // 累计 4.2s ≥ 4s → attempt 3 → 下次退避 8s（封顶）
      await handle.trigger();
      expect(recover).toHaveBeenCalledTimes(3);

      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("恢复成功后退避清零（再次故障按基础间隔重试，而非沿用已拉长的间隔）", async () => {
    vi.useFakeTimers();
    try {
      let healthy = false;
      let fixIt = false;
      const recover = vi.fn(async () => { if (fixIt) healthy = true; });
      const handle = startHeartbeat(
        [{ name: "probe", check: async () => healthy, recover }],
        { intervalMs: 60_000, failThreshold: 1, recoverCooldownMs: 1000, maxRecoverCooldownMs: 8000 },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(recover).toHaveBeenCalledTimes(1); // attempt 1 → 退避拉长到 2s

      // 恢复成功 → 退避清零
      fixIt = true;
      vi.setSystemTime(Date.now() + 2000);
      await handle.trigger();
      expect(recover).toHaveBeenCalledTimes(2);
      expect(handle.status()["probe"]).toBe(true);

      // 再次故障，且这次修不好
      fixIt = false;
      healthy = false;
      vi.setSystemTime(Date.now() + 1000); // 距上次 recover 仅 1.0s
      await handle.trigger();
      // 退避若未清零，此时应仍在 2s 冷却期内而被跳过
      expect(recover).toHaveBeenCalledTimes(3);

      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});