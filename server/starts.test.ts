import { describe, expect, test } from "bun:test";
import type { PlanLimits } from "../shared/api.ts";
import { HOUR_MS } from "../shared/history.ts";
import { MINUTE_MS, startCounter } from "./starts.ts";

const HOUR = Date.parse("2026-11-24T10:00:00Z");

function plan(minute: number, hour: number, day: number, nextStartDollars = 0): PlanLimits {
  return {
    plan: "box_100",
    active: { used: 1, limit: 300 },
    startsMinute: { used: minute, limit: 30 },
    startsHour: { used: hour, limit: 210 },
    startsDay: { used: day, limit: 840 },
    includedHours: null,
    periodEnd: null,
    walletDollars: 100,
    nextStartDollars,
    overageVmHourDollars: 0.036,
  };
}

describe("startCounter", () => {
  test("adds up the last minute's count read just after each minute, once per minute, into its hour", () => {
    const counter = startCounter(24);
    counter.record(HOUR + 5 * MINUTE_MS + 1000, plan(3, 10, 100));
    counter.record(HOUR + 5 * MINUTE_MS + 16_000, plan(3, 10, 100));
    counter.record(HOUR + 5 * MINUTE_MS + 40_000, plan(9, 10, 100));
    counter.record(HOUR + 6 * MINUTE_MS + 1000, plan(2, 12, 102));
    expect(counter.buckets(HOUR + 6 * MINUTE_MS)).toEqual([{ start: HOUR, starts: 5, extra: 0, extraDollars: 0 }]);
    expect(counter.lastHour(HOUR + 6 * MINUTE_MS + 1000)).toBe(5);
  });

  test("takes Boat's hour count as the hour's total at the hour's end", () => {
    const counter = startCounter(24);
    counter.record(HOUR + 59 * MINUTE_MS + 1000, plan(4, 40, 100));
    counter.record(HOUR + HOUR_MS + 1000, plan(1, 41, 101));
    expect(counter.buckets(HOUR + HOUR_MS + 1000).map((bucket) => [bucket.start, bucket.starts])).toEqual([
      [HOUR, 41],
      [HOUR + HOUR_MS, 0],
    ]);
  });

  test("counts the starts past a window's limit as extra, at the next start's price", () => {
    const counter = startCounter(24);
    counter.record(HOUR + MINUTE_MS + 1000, plan(5, 100, 843, 0.03));
    expect(counter.buckets(HOUR + MINUTE_MS)[0]).toMatchObject({ starts: 5, extra: 3, extraDollars: 0.09 });
  });

  test("reports only the hours it watched, and adds restored hours to what it counted since", () => {
    const counter = startCounter(24);
    counter.restore([{ start: HOUR - 2 * HOUR_MS, starts: 5, extra: 1, extraDollars: 0.05 }]);
    counter.record(HOUR + MINUTE_MS + 1000, plan(1, 1, 1));
    expect(counter.buckets(HOUR + MINUTE_MS).map((bucket) => bucket.starts)).toEqual([5, 1]);
    expect(counter.saved()).toHaveLength(2);
  });
});
