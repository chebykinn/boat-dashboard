import { describe, expect, test } from "bun:test";
import type { BoatProcessList, BoatSandbox } from "./boat.ts";
import { overlaps, planLimitsOf, ratePerHour, runningSince, sampleOf, summarize, type Sample } from "./metrics.ts";

const NOW = Date.parse("2026-11-06T12:00:00Z");

const at = (iso: string) => new Date(iso);

function box(fields: Partial<BoatSandbox> & { id: string }): BoatSandbox {
  return { name: fields.id, state: "idle", type: "default", vcpu: 4, memoryGB: 8, billingMultiplier: 1, createdAt: at("2026-11-01T00:00:00Z"), desktopAvailable: false, snapshotAvailable: true, ...fields };
}

function processes(...entries: [number, number, number, string?][]): BoatProcessList {
  return {
    live: true,
    sampledAt: null,
    total: entries.length,
    processes: entries.map(([pid, cpuPercent, memoryMB, startedAt]) => ({ pid, cpuPercent, memoryMB, startedAt: startedAt ? at(startedAt) : undefined, command: "x" })),
  };
}

describe("sampleOf", () => {
  test("sums the processes into cores and GB, and takes the boot from pid 1", () => {
    const sample = sampleOf(box({ id: "a" }), processes([1, 10, 512, "2026-11-05T00:00:00Z"], [7, 140, 1536]), NOW);
    expect(sample.cpuUsed).toBeCloseTo(1.5);
    expect(sample.ramUsedGB).toBeCloseTo(2);
    expect(sample.bootedAt).toBe(Date.parse("2026-11-05T00:00:00Z"));
  });

  test("never reports more than the box has", () => {
    const sample = sampleOf(box({ id: "a", vcpu: 2, memoryGB: 1 }), processes([7, 900, 4096]), NOW);
    expect(sample.cpuUsed).toBe(2);
    expect(sample.ramUsedGB).toBe(1);
    expect(sample.bootedAt).toBeNull();
  });
});

describe("runningSince", () => {
  test("prefers the boot time, then the latest of creation, restore and reboot", () => {
    const sandbox = box({ id: "a", createdAt: at("2026-10-01T00:00:00Z"), hydratedAt: at("2026-11-02T00:00:00Z") });
    expect(runningSince(sandbox, undefined)).toBe(Date.parse("2026-11-02T00:00:00Z"));
    const sample: Sample = { at: NOW, cpuUsed: 0, ramUsedGB: 0, bootedAt: 5 };
    expect(runningSince(sandbox, sample)).toBe(5);
  });
});

describe("ratePerHour", () => {
  test("follows the billing multiplier", () => {
    expect(ratePerHour(box({ id: "a" }))).toBeCloseTo(0.036);
    expect(ratePerHour(box({ id: "a", billingMultiplier: 0.5 }))).toBeCloseTo(0.018);
  });
});

describe("overlaps", () => {
  const start = Date.parse("2026-11-06T10:00:00Z");
  const end = Date.parse("2026-11-06T11:00:00Z");

  test("takes running boxes and boxes stopped inside the hour", () => {
    expect(overlaps(box({ id: "a" }), start, end)).toBe(true);
    expect(overlaps(box({ id: "b", state: "archived", stoppedAt: at("2026-11-06T10:30:00Z") }), start, end)).toBe(true);
  });

  test("leaves boxes stopped before it or created after it", () => {
    expect(overlaps(box({ id: "a", state: "archived", stoppedAt: at("2026-11-06T09:00:00Z") }), start, end)).toBe(false);
    expect(overlaps(box({ id: "b", createdAt: at("2026-11-06T11:30:00Z") }), start, end)).toBe(false);
  });
});

describe("summarize", () => {
  test("adds up the running boxes and orders the longest running first", () => {
    const sandboxes = [box({ id: "new", createdAt: at("2026-11-05T00:00:00Z") }), box({ id: "old", createdAt: at("2026-10-01T00:00:00Z"), type: "small", vcpu: 2, memoryGB: 4, billingMultiplier: 0.5 }), box({ id: "off", state: "archived" })];
    const samples = new Map<string, Sample>([["new", { at: NOW, cpuUsed: 1, ramUsedGB: 3, bootedAt: null }]]);
    const snapshot = summarize({ now: NOW, sandboxes, samples, cpuHistory: new Map([["new", [0.5, 1]]]), maxActive: 100, limits: null, costs: [], starts: [], startsLastHour: 0, spend: [], secondsPerDollar: 100_000, problem: null });
    expect(snapshot.point).toMatchObject({ running: 2, cpuUsed: 1, cpuAllocated: 6, ramUsedGB: 3, ramAllocatedGB: 12 });
    expect(snapshot.point.ratePerHour).toBeCloseTo(0.054);
    expect(snapshot.byState).toEqual({ idle: 2, archived: 1 });
    expect(snapshot.longest.map((row) => row.id)).toEqual(["old", "new"]);
    expect(snapshot.longest[0]!.cpuUsed).toBeNull();
    expect(snapshot.longest[1]!.cpuHistory).toEqual([0.5, 1]);
  });

  test("gives the cost rows of running boxes their live use, and keeps the cost", () => {
    const samples = new Map<string, Sample>([["new", { at: NOW, cpuUsed: 1, ramUsedGB: 3, bootedAt: null }]]);
    const row = { id: "new", name: "new", subdomain: null, state: "deleted", type: "", since: null, stopsAt: null, vcpu: 4, memoryGB: 8, cpuUsed: null, ramUsedGB: null, ratePerHour: 0, cpuHistory: [], dollars: 2, hours: 5 };
    const gone = { ...row, id: "gone" };
    const snapshot = summarize({ now: NOW, sandboxes: [box({ id: "new", archiveAfter: at("2026-11-06T14:00:00Z") })], samples, cpuHistory: new Map(), maxActive: null, limits: null, costs: [{ hours: 24, rows: [row, gone] }], starts: [], startsLastHour: 0, spend: [], secondsPerDollar: 100_000, problem: null });
    const [live, stopped] = snapshot.costs[0]!.rows;
    expect(live).toMatchObject({ state: "idle", cpuUsed: 1, dollars: 2, hours: 5, stopsAt: Date.parse("2026-11-06T14:00:00Z") });
    expect(live!.since).not.toBeNull();
    expect(stopped).toMatchObject({ state: "deleted", since: null, cpuUsed: null });
  });

  test("leaves use unknown until a running box has been sampled", () => {
    const snapshot = summarize({ now: NOW, sandboxes: [box({ id: "a" })], samples: new Map(), cpuHistory: new Map(), maxActive: null, limits: null, costs: [], starts: [], startsLastHour: 0, spend: [], secondsPerDollar: 100_000, problem: null });
    expect(snapshot.point.cpuUsed).toBeNull();
    expect(snapshot.point.ramUsedGB).toBeNull();
    expect(summarize({ now: NOW, sandboxes: [], samples: new Map(), cpuHistory: new Map(), maxActive: null, limits: null, costs: [], starts: [], startsLastHour: 0, spend: [], secondsPerDollar: 100_000, problem: null }).point.cpuUsed).toBe(0);
  });
});

describe("planLimitsOf", () => {
  test("turns Boat's limits into used against available, per window", () => {
    const limits = planLimitsOf({
      activeSandboxes: 11,
      maxActiveSandboxes: 300,
      sandboxPlanKey: "box_100",
      starts: { unlimited: false, minute: { limit: 30, used: 0, remaining: 30 }, hour: { limit: 210, used: 8, remaining: 202 }, day: { limit: 840, used: 276, remaining: 564 } },
      planIncluded: { vmHours: 2777.78, vmHoursRemaining: 0, periodEnd: at("2026-12-12T11:38:58Z") },
      wallet: { balanceDollars: 153.38 },
      nextStartDollars: 0,
      overagePrices: { vmHourDollars: 0.036 },
    });
    expect(limits).toMatchObject({ walletDollars: 153.38, nextStartDollars: 0, overageVmHourDollars: 0.036 });
    expect(limits.plan).toBe("box_100");
    expect(limits.active).toEqual({ used: 11, limit: 300 });
    expect(limits.startsMinute).toEqual({ used: 0, limit: 30 });
    expect(limits.startsHour).toEqual({ used: 8, limit: 210 });
    expect(limits.startsDay).toEqual({ used: 276, limit: 840 });
    expect(limits.includedHours).toEqual({ used: 2777.78, limit: 2777.78 });
    expect(limits.periodEnd).toBe(Date.parse("2026-12-12T11:38:58Z"));
  });

  test("leaves out the start windows of an unlimited plan and included hours it doesn't have", () => {
    const limits = planLimitsOf({ activeSandboxes: 1, maxActiveSandboxes: 5, starts: { unlimited: true, day: { limit: 0, used: 3 } } });
    expect(limits.startsDay).toBeNull();
    expect(limits.includedHours).toBeNull();
    expect(limits.plan).toBeNull();
  });
});
