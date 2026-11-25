import type { PlanLimits, StartBucket, Usage } from "../shared/api.ts";
import { HISTORY_MS, HOUR_MS } from "../shared/history.ts";

export const START_HOURS = HISTORY_MS / HOUR_MS;
export const MINUTE_MS = 60_000;
export const SAMPLE_LATE_MS = 20_000;

export type StartCounter = {
  record(at: number, plan: PlanLimits): void;
  buckets(now: number): StartBucket[];
  lastHour(now: number): number;
  saved(): StartBucket[];
  restore(buckets: StartBucket[]): void;
};

function hourOf(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

function over(window: Usage | null): number {
  return window ? Math.max(0, window.used - window.limit) : 0;
}

export function startCounter(hours: number = START_HOURS): StartCounter {
  const kept = new Map<number, StartBucket>();
  const minutes = new Map<number, number>();
  let lastMinute: number | null = null;

  const windowOf = (now: number) => Array.from({ length: hours }, (_, index) => hourOf(now) - (hours - 1 - index) * HOUR_MS);
  const bucketOf = (start: number) => {
    const bucket = kept.get(start) ?? { start, starts: 0, extra: 0, extraDollars: 0 };
    kept.set(start, bucket);
    return bucket;
  };

  return {
    record(at, plan) {
      bucketOf(hourOf(at));
      const boundary = Math.floor(at / MINUTE_MS) * MINUTE_MS;
      if (at - boundary > SAMPLE_LATE_MS || !plan.startsMinute) return;
      const minute = boundary - MINUTE_MS;
      if (lastMinute !== null && minute <= lastMinute) return;
      lastMinute = minute;
      const starts = plan.startsMinute.used;
      const extra = Math.min(starts, Math.max(over(plan.startsMinute), over(plan.startsHour), over(plan.startsDay)));
      minutes.set(minute, starts);
      const bucket = bucketOf(hourOf(minute));
      bucket.starts += starts;
      bucket.extra += extra;
      bucket.extraDollars += extra * (plan.nextStartDollars ?? 0);
      if (boundary % HOUR_MS === 0 && plan.startsHour) bucket.starts = plan.startsHour.used;
      for (const start of minutes.keys()) if (start < boundary - HOUR_MS) minutes.delete(start);
      const oldest = hourOf(at) - (hours - 1) * HOUR_MS;
      for (const start of kept.keys()) if (start < oldest) kept.delete(start);
    },
    buckets(now) {
      return windowOf(now)
        .filter((start) => kept.has(start))
        .map((start) => ({ ...kept.get(start)! }));
    },
    lastHour(now) {
      let sum = 0;
      for (const [start, starts] of minutes) if (start >= now - HOUR_MS - MINUTE_MS) sum += starts;
      return sum;
    },
    saved() {
      return [...kept.values()].sort((a, b) => a.start - b.start).map((bucket) => ({ ...bucket }));
    },
    restore(buckets) {
      for (const bucket of buckets) {
        const current = kept.get(bucket.start);
        kept.set(bucket.start, current ? { start: bucket.start, starts: current.starts + bucket.starts, extra: current.extra + bucket.extra, extraDollars: current.extraDollars + bucket.extraDollars } : { ...bucket });
      }
    },
  };
}
