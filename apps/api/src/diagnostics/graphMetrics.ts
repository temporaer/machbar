import type { GraphLoadMetrics } from "@machbar/shared";

const MAX_RECENT_SAMPLES = 200;
const recentDurations: number[] = [];
let totalLoads = 0;
let totalDurationMs = 0;
let maximumDurationMs: number | null = null;
let lastDurationMs: number | null = null;
let lastTaskCount: number | null = null;
let lastProjectCount: number | null = null;

export function recordGraphLoad(
  durationMs: number,
  taskCount: number,
  projectCount: number,
): void {
  totalLoads += 1;
  totalDurationMs += durationMs;
  maximumDurationMs = Math.max(maximumDurationMs ?? durationMs, durationMs);
  lastDurationMs = durationMs;
  lastTaskCount = taskCount;
  lastProjectCount = projectCount;
  recentDurations.push(durationMs);
  if (recentDurations.length > MAX_RECENT_SAMPLES) {
    recentDurations.shift();
  }
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * fraction),
  );
  return sorted[index] ?? null;
}

function rounded(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(3));
}

export function getGraphLoadMetrics(): GraphLoadMetrics {
  const sorted = [...recentDurations].sort((a, b) => a - b);
  return {
    totalLoads,
    recentSamples: sorted.length,
    averageMs: rounded(totalLoads === 0 ? null : totalDurationMs / totalLoads),
    p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    maxMs: rounded(maximumDurationMs),
    lastMs: rounded(lastDurationMs),
    lastTaskCount,
    lastProjectCount,
  };
}
