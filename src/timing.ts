/**
 * graph-memory-pro — 延迟分布统计
 */

export type TimingPhase =
  | "recall_total"
  | "recall_precise"
  | "recall_generalized"
  | "fts_search"
  | "vec_embed"
  | "vec_search"
  | "graph_walk"
  | "ppr_seed_lookup"
  | "ppr_compute"
  | "ensure_projection"
  | "community_vec_search"
  | "community_reps"
  | "community_vec_reps"
  | "ppr_total"
  | "merge_results"
  | "extract_llm"
  | "recall_cache_hit"
  | "recall_cache_similar_hit";

export interface TimingRecord {
  phase: TimingPhase;
  ms: number;
}

export interface GmTiming {
  phases: Map<TimingPhase, number>;
  totalMs: number;
  breakdown: Array<{ phase: TimingPhase; ms: number }>;
}

const DEFAULT_THRESHOLDS = [5, 10, 20, 50, 100, 200, 500, 1000, 2000];

export class LatencyDistribution {
  private samples: number[] = [];
  private readonly thresholds: number[];
  private readonly maxSamples: number;

  constructor(thresholds: number[] = DEFAULT_THRESHOLDS, maxSamples: number = 1000) {
    this.thresholds = [...thresholds].sort((a, b) => a - b);
    this.maxSamples = maxSamples;
  }

  record(ms: number): void {
    this.samples.push(ms);
    // 防止内存泄漏：超过上限时移除最旧的样本
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  reset(): void {
    this.samples.length = 0;
  }

  get count(): number {
    return this.samples.length;
  }

  histogram(): Record<string, number> {
    const buckets: Record<string, number> = {};
    for (const t of this.thresholds) {
      buckets[`<=${t}ms`] = 0;
    }
    buckets[">last"] = 0;

    for (const s of this.samples) {
      let placed = false;
      for (const t of this.thresholds) {
        if (s <= t) {
          buckets[`<=${t}ms`]++;
          placed = true;
          break;
        }
      }
      if (!placed) buckets[">last"]++;
    }
    return buckets;
  }

  percentile(p: number): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  percentileSummary(): string {
    const p50 = this.percentile(50);
    const p90 = this.percentile(90);
    const p95 = this.percentile(95);
    const p99 = this.percentile(99);
    return `P50=${p50 ?? '-'}ms P90=${p90 ?? '-'}ms P95=${p95 ?? '-'}ms P99=${p99 ?? '-'}ms (n=${this.count})`;
  }

  report(phase: string = "recall"): string {
    if (this.samples.length === 0) return `[latency] ${phase}: no samples yet`;
    const hist = this.histogram();
    const histStr = Object.entries(hist).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    return `[latency-distribution] ${phase} (n=${this.count})\n${histStr}\n  ${this.percentileSummary()}`;
  }
}

const collectors = new Map<TimingPhase, LatencyDistribution>();

function getCollector(phase: TimingPhase): LatencyDistribution {
  if (!collectors.has(phase)) {
    collectors.set(phase, new LatencyDistribution());
  }
  return collectors.get(phase)!;
}

export function recordPhaseTiming(phase: TimingPhase, ms: number): void {
  getCollector(phase).record(ms);
}

export function printPhaseDistribution(phase: TimingPhase): string {
  const c = collectors.get(phase);
  if (!c || c.count === 0) return `[latency] ${phase}: no samples`;
  return c.report(phase);
}

export function printAllDistributions(): string {
  const lines: string[] = [];
  for (const [phase, collector] of collectors) {
    if (collector.count > 0) {
      lines.push(collector.report(phase));
    }
  }
  return lines.length ? lines.join("\n\n") : "[latency] no data collected";
}

export function resetAllDistributions(): void {
  for (const [, c] of collectors) {
    c.reset();
  }
}

let _timingEnabled = false;

export function setTimingEnabled(enabled: boolean): void {
  _timingEnabled = enabled;
}

export function isTimingEnabled(): boolean {
  return _timingEnabled || !!process.env.GM_DEBUG;
}

export function logPhase(phase: TimingPhase, ms: number, ctx?: Record<string, unknown>): void {
  if (!isTimingEnabled()) return;
  recordPhaseTiming(phase, ms);
  const parts = [phase, `+${ms.toFixed(1)}ms`];
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      parts.push(`${k}=${v}`);
    }
  }
  console.log(`[gm-timing] ${parts.join(" ")}`);
}

