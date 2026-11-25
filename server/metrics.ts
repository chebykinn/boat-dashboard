import type { BoxRow, CostWindow, PlanLimits, Point, Snapshot, SpendBucket, StartBucket, Usage } from "../shared/api.ts";
import type { BoatLimits, BoatProcessList, BoatSandbox } from "./boat.ts";

export const ACTIVE_STATES: string[] = ["ready", "idle", "running"];
export const STARTING_STATES: string[] = ["init", "provisioning", "provisioned", "cloning", "archiving"];
export const SECONDS_PER_DOLLAR = 100_000;

export type Sample = {
  at: number;
  cpuUsed: number;
  ramUsedGB: number;
  bootedAt: number | null;
};

export type SummaryInput = {
  now: number;
  sandboxes: BoatSandbox[];
  samples: Map<string, Sample>;
  cpuHistory: Map<string, number[]>;
  maxActive: number | null;
  limits: PlanLimits | null;
  costs: CostWindow[];
  starts: StartBucket[];
  startsLastHour: number;
  spend: SpendBucket[];
  secondsPerDollar: number;
  problem: string | null;
};

export function time(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

export function isActive(sandbox: BoatSandbox): boolean {
  return ACTIVE_STATES.includes(sandbox.state);
}

export function ratePerHour(sandbox: BoatSandbox, secondsPerDollar: number = SECONDS_PER_DOLLAR): number {
  return ((sandbox.billingMultiplier ?? 1) * 3600) / secondsPerDollar;
}

export function sampleOf(sandbox: BoatSandbox, list: BoatProcessList, at: number): Sample {
  const cpuPercent = list.processes.reduce((sum, process) => sum + (process.cpuPercent || 0), 0);
  const memoryMB = list.processes.reduce((sum, process) => sum + (process.memoryMB || 0), 0);
  const init = list.processes.find((process) => process.pid === 1);
  return {
    at,
    cpuUsed: Math.min(sandbox.vcpu ?? Infinity, cpuPercent / 100),
    ramUsedGB: Math.min(sandbox.memoryGB ?? Infinity, memoryMB / 1024),
    bootedAt: time(init?.startedAt),
  };
}

function usageOf(window: { limit?: number; used?: number } | undefined): Usage | null {
  return window && typeof window.limit === "number" ? { used: window.used ?? 0, limit: window.limit } : null;
}

export function planLimitsOf(answer: BoatLimits): PlanLimits {
  const included = answer.planIncluded;
  const unlimited = answer.starts?.unlimited ?? false;
  return {
    plan: answer.planName ?? answer.sandboxPlanKey ?? null,
    active: { used: answer.activeSandboxes, limit: answer.maxActiveSandboxes },
    startsMinute: unlimited ? null : usageOf(answer.starts?.minute),
    startsHour: unlimited ? null : usageOf(answer.starts?.hour),
    startsDay: unlimited ? null : usageOf(answer.starts?.day),
    includedHours: included && typeof included.vmHours === "number" ? { used: Math.max(0, included.vmHours - (included.vmHoursRemaining ?? 0)), limit: included.vmHours } : null,
    periodEnd: time(included?.periodEnd ?? null),
    walletDollars: answer.wallet?.balanceDollars ?? null,
    nextStartDollars: answer.nextStartDollars ?? null,
    overageVmHourDollars: answer.overagePrices?.vmHourDollars ?? null,
  };
}

export function runningSince(sandbox: BoatSandbox, sample: Sample | undefined): number | null {
  if (sample?.bootedAt) return sample.bootedAt;
  const candidates = [sandbox.createdAt, sandbox.hydratedAt, sandbox.lastReboot?.at].map(time).filter((at): at is number => at !== null);
  return candidates.length ? Math.max(...candidates) : null;
}

export function overlaps(sandbox: BoatSandbox, start: number, end: number): boolean {
  const created = time(sandbox.createdAt);
  if (created !== null && created >= end) return false;
  if (isActive(sandbox) || STARTING_STATES.includes(sandbox.state)) return true;
  const stopped = time(sandbox.stoppedAt) ?? time(sandbox.updatedAt);
  return stopped === null || stopped >= start;
}

export function summarize(input: SummaryInput): Snapshot {
  const active = input.sandboxes.filter(isActive);
  const byState: Record<string, number> = {};
  for (const sandbox of input.sandboxes) byState[sandbox.state] = (byState[sandbox.state] ?? 0) + 1;
  const rows: BoxRow[] = active.map((sandbox) => {
    const sample = input.samples.get(sandbox.id);
    return {
      id: sandbox.id,
      name: sandbox.name,
      subdomain: sandbox.subdomain ?? null,
      type: sandbox.type ?? "",
      state: sandbox.state,
      since: runningSince(sandbox, sample) ?? input.now,
      stopsAt: time(sandbox.archiveAfter),
      vcpu: sandbox.vcpu ?? 0,
      memoryGB: sandbox.memoryGB ?? 0,
      cpuUsed: sample?.cpuUsed ?? null,
      ramUsedGB: sample?.ramUsedGB ?? null,
      ratePerHour: ratePerHour(sandbox, input.secondsPerDollar),
      cpuHistory: input.cpuHistory.get(sandbox.id) ?? [],
    };
  });
  const live = new Map(rows.map((row) => [row.id, row]));
  const sampled = rows.length === 0 || rows.some((row) => row.cpuUsed !== null);
  const point: Point = {
    at: input.now,
    running: active.length,
    cpuUsed: sampled ? rows.reduce((sum, row) => sum + (row.cpuUsed ?? 0), 0) : null,
    cpuAllocated: rows.reduce((sum, row) => sum + row.vcpu, 0),
    ramUsedGB: sampled ? rows.reduce((sum, row) => sum + (row.ramUsedGB ?? 0), 0) : null,
    ramAllocatedGB: rows.reduce((sum, row) => sum + row.memoryGB, 0),
    ratePerHour: rows.reduce((sum, row) => sum + row.ratePerHour, 0),
    walletDollars: input.limits?.walletDollars ?? null,
  };
  return {
    point,
    total: input.sandboxes.length,
    byState,
    maxActive: input.maxActive,
    limits: input.limits,
    costs: input.costs.map((window) => ({ ...window, rows: window.rows.map((row) => ({ ...row, ...live.get(row.id) })) })),
    starts: input.starts,
    startsLastHour: input.startsLastHour,
    longest: rows.sort((a, b) => (a.since ?? 0) - (b.since ?? 0)),
    spend: input.spend,
    problem: input.problem,
  };
}
