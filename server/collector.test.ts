import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Point } from "../shared/api.ts";
import { backfill, slotsToFill } from "./backfill.ts";
import type { BoatClient, BoatProcessList, BoatSandbox } from "./boat.ts";
import { collector, DEFAULT_TIMING, FAILURES_SHOWN, mergePoints } from "./collector.ts";
import { eventStream } from "./main.ts";
import { HOUR_MS, spendTracker } from "./spend.ts";
import { fileStore, type HistoryStore, type LedgerStore } from "./store.ts";

const NOW = Date.parse("2026-11-06T12:30:00Z");
const SLOT = 5 * 60_000;

function fakeClient(sandboxes: BoatSandbox[], options: { failProcesses?: boolean; runningShare?: number } = {}) {
  const usageCalls: string[] = [];
  const client: BoatClient = {
    sandboxes: async () => sandboxes,
    processes: async (): Promise<BoatProcessList> => {
      if (options.failProcesses) throw new Error("unreachable");
      return {
        live: true,
        sampledAt: null,
        total: 1,
        processes: [{ pid: 1, cpuPercent: 50, memoryMB: 1024, startedAt: new Date("2026-11-06T00:00:00Z"), command: "init" }],
      };
    },
    usage: async (id, since, until) => {
      usageCalls.push(`${id}@${since.toISOString()}`);
      const multiplier = sandboxes.find((sandbox) => sandbox.id === id)?.billingMultiplier ?? 1;
      const seconds = ((until.getTime() - since.getTime()) / 1000) * (options.runningShare ?? 1) * multiplier;
      return { seconds, dollars: seconds / 100_000, secondsPerDollar: 100_000, billingMultiplier: multiplier, running: true };
    },
    limits: async () => ({ activeSandboxes: sandboxes.length, maxActiveSandboxes: 10 }),
  };
  return { client, usageCalls };
}

const RUNNING: BoatSandbox = {
  id: "bx_a",
  name: "a",
  state: "running",
  type: "default",
  vcpu: 4,
  memoryGB: 8,
  billingMultiplier: 1,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  desktopAvailable: false,
  snapshotAvailable: true,
};

const SMALL: BoatSandbox = { ...RUNNING, id: "bx_s", type: "small", vcpu: 2, memoryGB: 4, billingMultiplier: 0.5 };

function point(at: number, fields: Partial<Point> = {}): Point {
  return { at, running: 1, cpuUsed: 1, cpuAllocated: 4, ramUsedGB: 1, ramAllocatedGB: 8, ratePerHour: 0.036, walletDollars: null, ...fields };
}

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("spendTracker", () => {
  test("fills 24 hourly buckets, then asks again only for the hour still open", async () => {
    const { client, usageCalls } = fakeClient([RUNNING]);
    const tracker = spendTracker(client, 6, 24);
    expect(await tracker.refresh([RUNNING], NOW)).toBeNull();
    const buckets = tracker.buckets(NOW);
    expect(buckets).toHaveLength(24);
    expect(buckets[0]!.dollars).toBeCloseTo(0.036);
    expect(buckets[23]!.dollars).toBeCloseTo(0.018);
    expect(buckets.filter((bucket) => bucket.complete)).toHaveLength(23);
    expect(usageCalls).toHaveLength(24);
    usageCalls.length = 0;
    await tracker.refresh([RUNNING], NOW + 60_000);
    expect(usageCalls).toEqual([new Date(Date.parse("2026-11-06T12:00:00Z")).toISOString()].map((at) => `bx_a@${at}`));
  });
});

describe("spendTracker ledger", () => {
  const STOPPED: BoatSandbox = { ...RUNNING, id: "bx_gone", name: "gone", state: "archived", stoppedAt: new Date("2026-11-06T11:00:00Z") };

  test("ranks the boxes by what they cost in each window, stopped ones included", async () => {
    const { client } = fakeClient([RUNNING, SMALL, STOPPED]);
    const tracker = spendTracker(client, 6, 24);
    await tracker.refresh([RUNNING, SMALL, STOPPED], NOW);
    const windows = tracker.costs(NOW, [RUNNING, SMALL], 100_000);
    expect(windows.map((window) => window.hours)).toEqual([1, 6, 24]);
    const day = windows[2]!.rows;
    expect(day.map((row) => row.id)).toEqual(["bx_a", "bx_gone", "bx_s"]);
    expect(day[0]!.hours).toBeCloseTo(23.5);
    expect(day[0]!.dollars).toBeCloseTo(23.5 * 0.036);
    expect(day[0]!.ratePerHour).toBeCloseTo(0.036);
    expect(day[1]).toMatchObject({ name: "gone", state: "deleted", ratePerHour: 0 });
    expect(windows[0]!.rows.map((row) => row.id)).toEqual(["bx_a", "bx_s"]);
  });

  test("turns each settled hour into a point, and saves and restores the settled hours", async () => {
    const { client, usageCalls } = fakeClient([RUNNING, SMALL], { runningShare: 0.5 });
    const tracker = spendTracker(client, 6, 24);
    await tracker.refresh([RUNNING, SMALL], NOW);
    const points = tracker.points(NOW);
    expect(points).toHaveLength(23);
    expect(points[22]!.at).toBe(Date.parse("2026-11-06T12:00:00Z"));
    expect(points[22]).toMatchObject({ cpuUsed: null, walletDollars: null });
    expect(points[22]!.running).toBeCloseTo(1);
    expect(points[22]!.cpuAllocated).toBeCloseTo(3);
    expect(points[22]!.ratePerHour).toBeCloseTo(0.027);
    const restored = spendTracker(client, 6, 24);
    restored.restore(JSON.parse(JSON.stringify(tracker.saved())));
    usageCalls.length = 0;
    await restored.refresh([RUNNING, SMALL], NOW);
    expect(usageCalls).toHaveLength(2);
    expect(restored.points(NOW)).toEqual(points);
  });
});

describe("backfill", () => {
  test("asks for the slots no point covers", () => {
    const starts = slotsToFill(NOW, [point(NOW - SLOT + 1000), point(NOW - 3 * SLOT)], 6 * SLOT, SLOT);
    const last = Math.floor(NOW / SLOT) * SLOT;
    expect(starts).toEqual([last - 6 * SLOT, last - 5 * SLOT, last - 3 * SLOT, last - 2 * SLOT]);
  });

  test("turns billed seconds into running boxes and allocation, leaving use unknown", async () => {
    const { client } = fakeClient([RUNNING, SMALL], { runningShare: 0.5 });
    const start = Math.floor(NOW / SLOT) * SLOT - SLOT;
    const { points, problem } = await backfill(client, [RUNNING, SMALL], [start], SLOT);
    expect(problem).toBeNull();
    expect(points).toHaveLength(1);
    expect(points[0]!.at).toBe(start + SLOT);
    expect(points[0]!.running).toBeCloseTo(1);
    expect(points[0]!.cpuAllocated).toBeCloseTo(3);
    expect(points[0]!.ramAllocatedGB).toBeCloseTo(6);
    expect(points[0]!.ratePerHour).toBeCloseTo(0.027);
    expect(points[0]!.cpuUsed).toBeNull();
  });

  test("leaves out a slot whose answer failed", async () => {
    const { client } = fakeClient([RUNNING]);
    const failing: BoatClient = { ...client, usage: async () => Promise.reject(new Error("boom")) };
    const { points, problem } = await backfill(failing, [RUNNING], [NOW - SLOT], SLOT);
    expect(points).toEqual([]);
    expect(problem).toContain("boom");
  });
});

describe("mergePoints", () => {
  test("orders by time, keeps the first of a repeat and drops what is too old", () => {
    const merged = mergePoints([point(30, { running: 3 }), point(10)], [point(20), point(30, { running: 9 }), point(1)], 5);
    expect(merged.map((entry) => [entry.at, entry.running])).toEqual([
      [10, 1],
      [20, 1],
      [30, 3],
    ]);
  });
});

describe("fileStore", () => {
  test("saves through a staging file and loads what it saved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "boat-dashboard-"));
    temporary.push(directory);
    const store = fileStore(join(directory, "nested", "history.json"));
    expect(await store.load()).toEqual([]);
    await store.save([point(1), point(2)]);
    expect((await store.load()).map((entry) => entry.at)).toEqual([1, 2]);
    expect(await readdir(join(directory, "nested"))).toEqual(["history.json"]);
  });
});

describe("collector", () => {
  test("lists, samples and keeps a point per list", async () => {
    const { client } = fakeClient([RUNNING, { ...RUNNING, id: "bx_off", state: "archived", stoppedAt: new Date("2026-10-01T00:00:00Z") }]);
    let clock = NOW;
    const source = collector(client, DEFAULT_TIMING, () => clock);
    await source.limits();
    await source.list();
    await source.sample();
    clock += 5000;
    await source.list();
    const snapshot = source.snapshot();
    expect(snapshot.point).toMatchObject({ running: 1, cpuUsed: 0.5, cpuAllocated: 4, ramUsedGB: 1, ramAllocatedGB: 8 });
    expect(snapshot.maxActive).toBe(10);
    expect(snapshot.longest[0]!.since).toBe(Date.parse("2026-11-06T00:00:00Z"));
    expect(source.history()).toHaveLength(2);
    expect(snapshot.problem).toBeNull();
  });

  test("names what keeps failing, not a one-off failure, and keeps going", async () => {
    const { client } = fakeClient([RUNNING], { failProcesses: true });
    const source = collector(client, DEFAULT_TIMING, () => NOW);
    await source.list();
    for (let failures = 1; failures < FAILURES_SHOWN; failures++) {
      await source.sample();
      expect(source.snapshot().problem).toBeNull();
    }
    await source.sample();
    expect(source.snapshot().problem).toContain("processes of bx_a");
    expect(source.snapshot().point.cpuUsed).toBeNull();
  });

  test("restores the saved history, backfills only the gaps and sends the history again", async () => {
    const saved: Point[][] = [];
    const store: HistoryStore = {
      load: async () => [point(NOW - 2 * SLOT), point(NOW - 3 * 3600_000)],
      save: async (points) => void saved.push(points),
    };
    const { client, usageCalls } = fakeClient([RUNNING]);
    const timing = { ...DEFAULT_TIMING, historyMs: 3600_000 };
    const source = collector(client, timing, () => NOW, { history: store });
    const messages: Message[] = [];
    source.subscribe((message) => messages.push(message));
    await source.restore();
    expect(source.history().map((entry) => entry.at)).toEqual([NOW - 2 * SLOT]);
    await source.list();
    await source.fill();
    expect(usageCalls).toHaveLength(10);
    expect(source.history()).toHaveLength(12);
    expect(messages.map((message) => message.kind)).toEqual(["init", "tick", "init"]);
    usageCalls.length = 0;
    await source.fill();
    expect(usageCalls).toHaveLength(0);
    await source.save();
    expect(saved[0]).toHaveLength(12);
  });
});

describe("collector with a ledger", () => {
  test("fills the hours past the live window from the ledger, and saves the ledger", async () => {
    const savedLedger: unknown[] = [];
    const ledger: LedgerStore = { load: async () => [], save: async (hours) => void savedLedger.push(hours) };
    const { client } = fakeClient([RUNNING]);
    const timing = { ...DEFAULT_TIMING, historyMs: 12 * HOUR_MS, liveMs: 2 * HOUR_MS };
    const source = collector(client, timing, () => NOW, { ledger });
    await source.limits();
    await source.list();
    await source.spend();
    await source.fill();
    const history = source.history();
    const hourly = history.filter((entry) => entry.at <= Date.parse("2026-11-06T10:00:00Z"));
    expect(hourly.map((entry) => new Date(entry.at).toISOString().slice(11, 16))).toEqual(["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00", "08:00", "09:00", "10:00"]);
    expect(hourly[0]!.running).toBeCloseTo(1);
    expect(history.filter((entry) => entry.at > Date.parse("2026-11-06T10:00:00Z")).length).toBeGreaterThan(20);
    const snapshot = source.snapshot();
    expect(snapshot.limits?.active).toEqual({ used: 1, limit: 10 });
    expect(snapshot.costs.find((window) => window.hours === 24)?.rows[0]?.id).toBe("bx_a");
    await source.save();
    expect(savedLedger).toHaveLength(1);
  });
});

describe("eventStream", () => {
  test("sends the history first, then each tick", async () => {
    const { client } = fakeClient([RUNNING]);
    const source = collector(client, DEFAULT_TIMING, () => NOW);
    await source.list();
    const abort = new AbortController();
    const reader = eventStream(source, abort.signal).body!.getReader();
    const read = async (): Promise<Message> => JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, "")) as Message;
    const first = await read();
    expect(first.kind).toBe("init");
    expect(first.kind === "init" && first.history).toHaveLength(1);
    await source.list();
    expect((await read()).kind).toBe("tick");
    abort.abort();
  });
});
