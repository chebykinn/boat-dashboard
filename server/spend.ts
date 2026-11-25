import type { CostRow, CostWindow, Point, SpendBucket } from "../shared/api.ts";
import { HISTORY_MS, HOUR_MS } from "../shared/history.ts";
import type { BoatClient, BoatSandbox, BoatUsage } from "./boat.ts";
import { isActive, overlaps, ratePerHour } from "./metrics.ts";

export { HOUR_MS };
export const SPEND_HOURS = HISTORY_MS / HOUR_MS;
export const SETTLE_MS = 2 * 60_000;
export const COST_WINDOWS = [1, 6, 24, 168];

export type BoxHour = {
  name: string;
  subdomain: string | null;
  type: string;
  vcpu: number;
  memoryGB: number;
  multiplier: number;
  dollars: number;
  seconds: number;
};

export type SavedHour = {
  start: number;
  boxes: (BoxHour & {
    id: string;
  })[];
};

type Bucket = {
  perBox: Map<string, BoxHour>;
  complete: boolean;
};

export type SpendTracker = {
  refresh(sandboxes: BoatSandbox[], now: number): Promise<string | null>;
  buckets(now: number): SpendBucket[];
  costs(now: number, sandboxes: BoatSandbox[], secondsPerDollar: number): CostWindow[];
  points(now: number): Point[];
  saved(): SavedHour[];
  restore(hours: SavedHour[]): void;
};

export async function pool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
}

function hourOf(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

function windowOf(now: number, hours: number): number[] {
  const current = hourOf(now);
  return Array.from({ length: hours }, (_, index) => current - (hours - 1 - index) * HOUR_MS);
}

function boxHour(sandbox: BoatSandbox, usage: BoatUsage): BoxHour {
  return {
    name: sandbox.name,
    subdomain: sandbox.subdomain ?? null,
    type: sandbox.type ?? "",
    vcpu: sandbox.vcpu ?? 0,
    memoryGB: sandbox.memoryGB ?? 0,
    multiplier: usage.billingMultiplier || sandbox.billingMultiplier || 1,
    dollars: usage.dollars,
    seconds: usage.seconds,
  };
}

function runHours(entry: BoxHour): number {
  return Math.min(1, entry.seconds / entry.multiplier / 3600);
}

export function spendTracker(client: BoatClient, concurrency = 6, hours: number = SPEND_HOURS): SpendTracker {
  const kept = new Map<number, Bucket>();

  return {
    async refresh(sandboxes, now) {
      const starts = windowOf(now, hours);
      for (const start of kept.keys()) if (!starts.includes(start)) kept.delete(start);
      const jobs: {
        start: number;
        until: number;
        sandbox: BoatSandbox;
        bucket: Bucket;
      }[] = [];
      const settled = new Map<number, boolean>();
      for (const start of [...starts].reverse()) {
        const previous = kept.get(start);
        if (previous?.complete) continue;
        const bucket: Bucket = { perBox: new Map(previous?.perBox), complete: false };
        kept.set(start, bucket);
        settled.set(start, start + HOUR_MS <= now - SETTLE_MS);
        const until = Math.min(start + HOUR_MS, now);
        for (const sandbox of sandboxes) if (overlaps(sandbox, start, until)) jobs.push({ start, until, sandbox, bucket });
      }
      let problem: string | null = null;
      await pool(jobs, concurrency, async ({ start, until, sandbox, bucket }) => {
        try {
          const usage = await client.usage(sandbox.id, new Date(start), new Date(until));
          if (usage.seconds || usage.dollars) bucket.perBox.set(sandbox.id, boxHour(sandbox, usage));
          else bucket.perBox.delete(sandbox.id);
        } catch (error) {
          settled.set(start, false);
          problem = `spend of ${sandbox.id}: ${(error as Error).message}`;
        }
      });
      for (const [start, complete] of settled) {
        const bucket = kept.get(start);
        if (bucket) bucket.complete = complete;
      }
      return problem;
    },
    buckets(now) {
      return windowOf(now, hours).map((start) => {
        const bucket = kept.get(start);
        return {
          start,
          dollars: bucket ? [...bucket.perBox.values()].reduce((sum, entry) => sum + entry.dollars, 0) : 0,
          complete: bucket?.complete ?? false,
        };
      });
    },
    costs(now, sandboxes, secondsPerDollar) {
      const byId = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
      return COST_WINDOWS.filter((window) => window <= hours).map((window) => {
        const from = hourOf(now) - (window - 1) * HOUR_MS;
        const totals = new Map<string, CostRow>();
        for (const [start, bucket] of kept) {
          if (start < from) continue;
          for (const [id, entry] of bucket.perBox) {
            const sandbox = byId.get(id);
            const row = totals.get(id) ?? {
              id,
              name: sandbox?.name ?? entry.name,
              subdomain: sandbox ? (sandbox.subdomain ?? null) : entry.subdomain,
              state: sandbox?.state ?? "deleted",
              type: sandbox?.type ?? entry.type,
              since: null,
              stopsAt: null,
              vcpu: sandbox?.vcpu ?? entry.vcpu,
              memoryGB: sandbox?.memoryGB ?? entry.memoryGB,
              cpuUsed: null,
              ramUsedGB: null,
              cpuHistory: [],
              dollars: 0,
              hours: 0,
              ratePerHour: sandbox && isActive(sandbox) ? ratePerHour(sandbox, secondsPerDollar) : 0,
            };
            row.dollars += entry.dollars;
            row.hours += runHours(entry);
            totals.set(id, row);
          }
        }
        return {
          hours: window,
          rows: [...totals.values()].sort((a, b) => b.dollars - a.dollars),
        };
      });
    },
    points(now) {
      const points: Point[] = [];
      for (const start of windowOf(now, hours)) {
        const bucket = kept.get(start);
        if (!bucket?.complete) continue;
        const point: Point = { at: start + HOUR_MS, running: 0, cpuUsed: null, cpuAllocated: 0, ramUsedGB: null, ramAllocatedGB: 0, ratePerHour: 0, walletDollars: null };
        for (const entry of bucket.perBox.values()) {
          const share = runHours(entry);
          point.running += share;
          point.cpuAllocated += share * entry.vcpu;
          point.ramAllocatedGB += share * entry.memoryGB;
          point.ratePerHour += entry.dollars;
        }
        points.push(point);
      }
      return points;
    },
    saved() {
      return [...kept.entries()]
        .filter(([, bucket]) => bucket.complete)
        .sort(([a], [b]) => a - b)
        .map(([start, bucket]) => ({ start, boxes: [...bucket.perBox.entries()].map(([id, entry]) => ({ id, ...entry })) }));
    },
    restore(saved) {
      for (const hour of saved) {
        if (kept.get(hour.start)?.complete) continue;
        kept.set(hour.start, { perBox: new Map(hour.boxes.map(({ id, ...entry }) => [id, entry])), complete: true });
      }
    },
  };
}
