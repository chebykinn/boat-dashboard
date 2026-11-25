import type { Message, PlanLimits, Point, Snapshot } from "../shared/api.ts";
import { compact, HISTORY_MS, hourEnd, LIVE_MS, liveCut } from "../shared/history.ts";
import { backfill, slotsToFill } from "./backfill.ts";
import type { BoatClient, BoatSandbox } from "./boat.ts";
import { isActive, planLimitsOf, sampleOf, SECONDS_PER_DOLLAR, summarize, type Sample } from "./metrics.ts";
import { pool, spendTracker, type SpendTracker } from "./spend.ts";
import { MINUTE_MS, startCounter } from "./starts.ts";
import type { Stores } from "./store.ts";

export type CollectorTiming = {
  listMs: number;
  sampleMs: number;
  spendMs: number;
  limitsMs: number;
  saveMs: number;
  historyMs: number;
  liveMs: number;
  slotMs: number;
  boxHistoryPoints: number;
  sampleConcurrency: number;
};

export const DEFAULT_TIMING: CollectorTiming = {
  listMs: 5_000,
  sampleMs: 10_000,
  spendMs: 60_000,
  limitsMs: 15_000,
  saveMs: 60_000,
  historyMs: HISTORY_MS,
  liveMs: LIVE_MS,
  slotMs: 5 * 60_000,
  boxHistoryPoints: 60,
  sampleConcurrency: 8,
};

export const FAILURES_SHOWN = 3;

export type Collector = {
  start(): void;
  stop(): Promise<void>;
  restore(): Promise<void>;
  list(): Promise<void>;
  sample(): Promise<void>;
  spend(): Promise<void>;
  fill(): Promise<void>;
  limits(): Promise<void>;
  countStarts(): Promise<void>;
  save(): Promise<void>;
  snapshot(): Snapshot;
  history(): Point[];
  subscribe(listener: (message: Message) => void): () => void;
};

export function mergePoints(points: Point[], added: Point[], from: number): Point[] {
  const byTime = new Map<number, Point>();
  for (const point of [...points, ...added]) if (point.at >= from && !byTime.has(point.at)) byTime.set(point.at, point);
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}

export function collector(client: BoatClient, timing: CollectorTiming = DEFAULT_TIMING, now: () => number = Date.now, stores: Stores = {}): Collector {
  const { history: store, ledger, starts: startsStore } = stores;
  const counter = startCounter();
  let sandboxes: BoatSandbox[] = [];
  let maxActive: number | null = null;
  let plan: PlanLimits | null = null;
  let secondsPerDollar = SECONDS_PER_DOLLAR;
  const samples = new Map<string, Sample>();
  const cpuHistory = new Map<string, number[]>();
  let points: Point[] = [];
  const listeners = new Set<(message: Message) => void>();
  const problems = new Map<string, {
    failures: number;
    message: string;
  }>();
  const tracker: SpendTracker = spendTracker(client);
  const timers: Timer[] = [];
  let listed = false;

  const note = (source: string, problem: string | null) => {
    if (problem) problems.set(source, { failures: (problems.get(source)?.failures ?? 0) + 1, message: problem });
    else problems.delete(source);
  };

  const shown = (): string | null => {
    const lasting = [...problems.values()].filter((problem) => problem.failures >= FAILURES_SHOWN).map((problem) => `${problem.message} (${problem.failures} times in a row)`);
    return lasting.length ? lasting.join("; ") : null;
  };

  const current = (): Snapshot =>
    summarize({
      now: now(),
      sandboxes,
      samples,
      cpuHistory,
      maxActive,
      limits: plan,
      costs: tracker.costs(now(), sandboxes, secondsPerDollar),
      starts: counter.buckets(now()),
      startsLastHour: counter.lastHour(now()),
      spend: tracker.buckets(now()),
      secondsPerDollar,
      problem: shown(),
    });

  const send = (message: Message) => {
    for (const listener of listeners) listener(message);
  };

  const keep = (added: Point[]) => {
    points = compact(mergePoints(points, added, now() - timing.historyMs), now(), timing.liveMs, timing.historyMs);
  };

  const emit = () => {
    const snapshot = current();
    if (listed) keep([snapshot.point]);
    send({ kind: "tick", snapshot });
  };

  const resend = () => send({ kind: "init", history: [...points], snapshot: current() });

  const guarded = (run: () => Promise<void>) => {
    let running = false;
    return async () => {
      if (running) return;
      running = true;
      try {
        await run();
      } finally {
        running = false;
      }
    };
  };

  const restore = async () => {
    if (ledger) tracker.restore(await ledger.load());
    if (startsStore) counter.restore(await startsStore.load());
    if (!store) return;
    keep(await store.load());
    resend();
  };

  const save = guarded(async () => {
    try {
      if (store) await store.save(points);
      if (ledger) await ledger.save(tracker.saved());
      if (startsStore) await startsStore.save(counter.saved());
      note("save", null);
    } catch (error) {
      note("save", `saving the history: ${(error as Error).message}`);
    }
  });

  const list = guarded(async () => {
    try {
      sandboxes = await client.sandboxes();
      listed = true;
      note("list", null);
      const active = new Set(sandboxes.filter(isActive).map((sandbox) => sandbox.id));
      for (const id of samples.keys()) if (!active.has(id)) samples.delete(id);
      for (const id of cpuHistory.keys()) if (!active.has(id)) cpuHistory.delete(id);
      for (const source of problems.keys()) if (source.startsWith("sample:") && !active.has(source.slice("sample:".length))) problems.delete(source);
    } catch (error) {
      note("list", `sandboxes: ${(error as Error).message}`);
    }
    emit();
  });

  const sample = guarded(async () => {
    await pool(sandboxes.filter(isActive), timing.sampleConcurrency, async (sandbox) => {
      try {
        const taken = sampleOf(sandbox, await client.processes(sandbox.id), now());
        samples.set(sandbox.id, taken);
        const history = [...(cpuHistory.get(sandbox.id) ?? []), taken.cpuUsed];
        cpuHistory.set(sandbox.id, history.slice(-timing.boxHistoryPoints));
        note(`sample:${sandbox.id}`, null);
      } catch (error) {
        note(`sample:${sandbox.id}`, `processes of ${sandbox.id}: ${(error as Error).message}`);
      }
    });
  });

  const spend = guarded(async () => {
    if (!listed) return;
    note("spend", await tracker.refresh(sandboxes, now()));
  });

  const fill = guarded(async () => {
    if (!listed) return;
    const cut = liveCut(now(), timing.liveMs);
    const covered = new Set(points.map((point) => hourEnd(point.at)));
    const hourly = tracker.points(now()).filter((point) => point.at <= cut && !covered.has(point.at));
    const starts = slotsToFill(now(), points, Math.min(timing.liveMs, timing.historyMs), timing.slotMs);
    if (!starts.length && !hourly.length) return;
    if (starts.length) {
      const filled = await backfill(client, sandboxes, starts, timing.slotMs);
      note("backfill", filled.problem);
      keep(filled.points);
    }
    keep(hourly);
    resend();
  });

  const readLimits = async (): Promise<PlanLimits | null> => {
    try {
      const answer = await client.limits();
      maxActive = answer.maxActiveSandboxes ?? null;
      plan = planLimitsOf(answer);
      if (answer.creditSecondsPerDollar) secondsPerDollar = answer.creditSecondsPerDollar;
      note("limits", null);
      return plan;
    } catch (error) {
      note("limits", `limits: ${(error as Error).message}`);
      return null;
    }
  };

  const limits = guarded(async () => void (await readLimits()));

  const countStarts = guarded(async () => {
    const at = now();
    const read = await readLimits();
    if (read) counter.record(at, read);
  });

  let minuteTimer: Timer | undefined;
  const everyMinute = () => {
    const wait = MINUTE_MS - (now() % MINUTE_MS) + 1000;
    minuteTimer = setTimeout(() => {
      void countStarts();
      everyMinute();
    }, wait);
  };

  return {
    start() {
      void limits();
      void restore()
        .then(list)
        .then(() => Promise.all([sample(), spend(), fill()]))
        .then(emit);
      everyMinute();
      timers.push(
        setInterval(list, timing.listMs),
        setInterval(sample, timing.sampleMs),
        setInterval(() => void spend().then(fill), timing.spendMs),
        setInterval(limits, timing.limitsMs),
        setInterval(save, timing.saveMs),
      );
    },
    async stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
      clearTimeout(minuteTimer);
      await save();
    },
    restore,
    list,
    sample,
    spend,
    fill,
    limits,
    countStarts,
    save,
    snapshot: current,
    history: () => [...points],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
