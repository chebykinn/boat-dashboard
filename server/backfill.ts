import type { Point } from "../shared/api.ts";
import type { BoatClient, BoatSandbox } from "./boat.ts";
import { overlaps } from "./metrics.ts";
import { pool } from "./spend.ts";

export const BACKFILL_MS = 6 * 3600_000;
export const SLOT_MS = 5 * 60_000;

export type Backfill = {
  points: Point[];
  problem: string | null;
};

export function slotsToFill(now: number, known: Point[], spanMs: number = BACKFILL_MS, slotMs: number = SLOT_MS): number[] {
  const last = Math.floor(now / slotMs) * slotMs;
  const covered = new Set(known.map((point) => Math.ceil(point.at / slotMs) * slotMs - slotMs));
  const starts: number[] = [];
  for (let start = last - spanMs; start < last; start += slotMs) if (!covered.has(start)) starts.push(start);
  return starts;
}

export async function backfill(client: BoatClient, sandboxes: BoatSandbox[], starts: number[], slotMs: number = SLOT_MS, concurrency = 6): Promise<Backfill> {
  const slotSeconds = slotMs / 1000;
  const totals = new Map<number, Point>(starts.map((start) => [start, { at: start + slotMs, running: 0, cpuUsed: null, cpuAllocated: 0, ramUsedGB: null, ramAllocatedGB: 0, ratePerHour: 0, walletDollars: null }]));
  const failed = new Set<number>();
  const jobs = starts.flatMap((start) => sandboxes.filter((sandbox) => overlaps(sandbox, start, start + slotMs)).map((sandbox) => ({ start, sandbox })));
  let problem: string | null = null;
  await pool(jobs, concurrency, async ({ start, sandbox }) => {
    try {
      const usage = await client.usage(sandbox.id, new Date(start), new Date(start + slotMs));
      const multiplier = usage.billingMultiplier || sandbox.billingMultiplier || 1;
      const share = Math.min(1, usage.seconds / multiplier / slotSeconds);
      const point = totals.get(start)!;
      point.running += share;
      point.cpuAllocated += share * (sandbox.vcpu ?? 0);
      point.ramAllocatedGB += share * (sandbox.memoryGB ?? 0);
      point.ratePerHour += (usage.dollars * 3600) / slotSeconds;
    } catch (error) {
      failed.add(start);
      problem = `backfill: ${(error as Error).message}`;
    }
  });
  return {
    points: [...totals.entries()].filter(([start]) => !failed.has(start)).map(([, point]) => point),
    problem,
  };
}
