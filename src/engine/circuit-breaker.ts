/**
 * graph-memory-pro v2.3.2 阶段三: 降级熔断器
 *
 * 经典三态熔断器：CLOSED → OPEN → HALF_OPEN → CLOSED/OPEN
 *
 * 场景：下游（embed/llm/neo4j）宕机时避免持续重试打满队列级联超时。
 * OPEN 状态快速失败跳过重试链路（embed ~9s / llm ~17s），降级到 FTS/默认值。
 *
 * 线程模型：单进程 Node.js 事件循环，无锁竞争，模块级单例即可。
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** 连续失败多少次后打开（OPEN），默认 5 */
  failureThreshold: number;
  /** OPEN 状态持续多久后转 HALF_OPEN 尝试探测，默认 60s */
  cooldownMs: number;
  /** HALF_OPEN 状态下允许的探测请求数，默认 1 */
  halfOpenMaxRequests: number;
  /** 标识名（用于日志/metrics） */
  name: string;
}

export interface CircuitBreakerStatus {
  name: string;
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureAt: number | null;
  lastStateChangeAt: number;
}

/**
 * 判断请求是否放行。OPEN 时拒绝（除非 cooldown 到期转 HALF_OPEN 放行探测）。
 *
 * 用法:
 *   const permit = await breaker.allow();
 *   if (!permit) return fallbackValue;
 *   try {
 *     const result = await callDownstream();
 *     breaker.recordSuccess();
 *     return result;
 *   } catch (e) {
 *     breaker.recordFailure();
 *     throw e;
 *   }
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureAt: number | null = null;
  private lastStateChangeAt = Date.now();
  private halfOpenInFlight = 0;
  private readonly opts: CircuitBreakerOptions;

  constructor(opts: Partial<CircuitBreakerOptions> & { name: string }) {
    this.opts = {
      name: opts.name,
      failureThreshold: opts.failureThreshold ?? 5,
      cooldownMs: opts.cooldownMs ?? 60_000,
      halfOpenMaxRequests: opts.halfOpenMaxRequests ?? 1,
    };
  }

  /**
   * 判断是否放行请求。
   * - CLOSED: 始终放行
   * - OPEN: cooldown 到期转 HALF_OPEN 放行探测，否则拒绝
   * - HALF_OPEN: 限制并发探测数，超限拒绝
   */
  allow(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      // 检查 cooldown 是否到期
      if (this.lastFailureAt && (Date.now() - this.lastFailureAt) >= this.opts.cooldownMs) {
        // 转 HALF_OPEN，允许探测
        this.transition("half_open");
        this.halfOpenInFlight = 1;
        return true;
      }
      return false;
    }

    // half_open 状态
    if (this.halfOpenInFlight < this.opts.halfOpenMaxRequests) {
      this.halfOpenInFlight++;
      return true;
    }
    return false;
  }

  /** 请求成功 — CLOSED 时重置计数，HALF_OPEN 时转 CLOSED */
  recordSuccess(): void {
    this.successCount++;
    if (this.state === "half_open") {
      // 探测成功 → 恢复 CLOSED
      this.halfOpenInFlight = 0;
      this.failureCount = 0;
      this.transition("closed");
    } else if (this.state === "closed") {
      // CLOSED 状态成功重置失败计数
      this.failureCount = 0;
    }
  }

  /** 请求失败 — 累加失败计数，达阈值转 OPEN */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureAt = Date.now();

    if (this.state === "half_open") {
      // 探测失败 → 重新 OPEN
      this.halfOpenInFlight = 0;
      this.transition("open");
    } else if (this.state === "closed" && this.failureCount >= this.opts.failureThreshold) {
      // CLOSED 连续失败达阈值 → OPEN
      this.transition("open");
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getStatus(): CircuitBreakerStatus {
    return {
      name: this.opts.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureAt: this.lastFailureAt,
      lastStateChangeAt: this.lastStateChangeAt,
    };
  }

  /** 手动重置（如运维干预） */
  reset(): void {
    this.transition("closed");
    this.failureCount = 0;
    this.halfOpenInFlight = 0;
    this.lastFailureAt = null;
  }

  private transition(newState: CircuitState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.lastStateChangeAt = Date.now();
  }
}

/**
 * 模块级熔断器注册表 — 全局单例，供 health/metrics 查询状态
 */
const _breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(name: string, opts?: Partial<CircuitBreakerOptions>): CircuitBreaker {
  let breaker = _breakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker({ name, ...opts });
    _breakers.set(name, breaker);
  }
  return breaker;
}

export function getAllCircuitBreakers(): Map<string, CircuitBreaker> {
  return new Map(_breakers);
}

export function resetAllCircuitBreakers(): void {
  for (const b of _breakers.values()) b.reset();
}
