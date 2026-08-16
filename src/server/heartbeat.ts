/**
 * graph-memory-pro — 心跳自愈服务
 *
 * v2.5.x: 周期性探测关键能力（HTTP API server / MCP server / Neo4j driver），
 * 在能力降级或崩溃后自动重新初始化并重建，避免 API 接口丢失。
 *
 * 设计要点：
 *   - failThreshold: 连续失败 N 次才触发恢复，避免瞬时抖动导致无谓重建
 *   - recoverCooldownMs: 两次恢复尝试之间的最小间隔，防止无限快速重试
 *   - recovering 标志: 同一探针的恢复不可并发执行
 */

export interface HeartbeatProbe {
  /** 探针唯一名（用于日志与状态） */
  name: string;
  /** 返回 true 表示健康 */
  check: () => Promise<boolean>;
  /** 健康检查失败后的重建逻辑 */
  recover: () => Promise<void>;
}

export interface HeartbeatOptions {
  /** 心跳周期 ms */
  intervalMs: number;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** 连续失败多少次触发恢复（默认 2） */
  failThreshold?: number;
  /** 同探针两次恢复的最小间隔 ms（默认 30_000） */
  recoverCooldownMs?: number;
  /** 每次探测结果回调（可选，用于监控/测试） */
  onProbeResult?: (name: string, healthy: boolean) => void;
}

export interface HeartbeatHandle {
  /** 停止心跳（清理定时器） */
  stop(): void;
  /** 手动触发一次完整探测（返回的 Promise 在全部探针处理完后 resolve） */
  trigger(): Promise<void>;
  /** 返回各探针当前健康状态快照 */
  status(): Record<string, boolean>;
}

export function startHeartbeat(probes: HeartbeatProbe[], opts: HeartbeatOptions): HeartbeatHandle {
  const failThreshold = opts.failThreshold ?? 2;
  const recoverCooldownMs = opts.recoverCooldownMs ?? 30_000;
  const logger = opts.logger ?? {};

  const status: Record<string, boolean> = {};
  const failures: Record<string, number> = {};
  const recovering: Record<string, boolean> = {};
  const lastRecoverAt: Record<string, number> = {};
  let stopped = false;

  async function tick(): Promise<void> {
    for (const probe of probes) {
      let healthy = false;
      try {
        healthy = await probe.check();
      } catch {
        healthy = false;
      }
      status[probe.name] = healthy;
      opts.onProbeResult?.(probe.name, healthy);

      if (healthy) {
        failures[probe.name] = 0;
        continue;
      }

      failures[probe.name] = (failures[probe.name] ?? 0) + 1;
      if (failures[probe.name] < failThreshold) {
        logger.debug?.(`[heartbeat] '${probe.name}' unhealthy (${failures[probe.name]}/${failThreshold})`);
        continue;
      }
      // 恢复中或冷却期内跳过，避免并发重建 / 无限快速重试
      if (recovering[probe.name]) continue;
      const sinceRecover = Date.now() - (lastRecoverAt[probe.name] ?? 0);
      if (sinceRecover < recoverCooldownMs) continue;

      recovering[probe.name] = true;
      lastRecoverAt[probe.name] = Date.now();
      logger.warn?.(`[heartbeat] '${probe.name}' unhealthy (${failures[probe.name]} consecutive), recovering...`);
      try {
        await probe.recover();
      } catch (err) {
        logger.error?.(`[heartbeat] '${probe.name}' recover failed: ${err}`);
      } finally {
        recovering[probe.name] = false;
      }
    }
  }

  const run = () => {
    tick().catch((err) => logger.error?.(`[heartbeat] tick error: ${err}`));
  };

  // 立即执行首轮探测，随后按周期运行
  run();
  const timer = setInterval(() => {
    if (!stopped) run();
  }, opts.intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    trigger() {
      return tick();
    },
    status() {
      return { ...status };
    },
  };
}