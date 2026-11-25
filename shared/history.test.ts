import { describe, expect, test } from "bun:test";
import type { Point } from "./api.ts";
import { compact, HOUR_MS } from "./history.ts";

function point(at: number, fields: Partial<Point> = {}): Point {
  return { at, running: 1, cpuUsed: 1, cpuAllocated: 4, ramUsedGB: 1, ramAllocatedGB: 8, ratePerHour: 0.036, walletDollars: null, ...fields };
}

describe("compact", () => {
  const now = 1000 * HOUR_MS + 30 * 60_000;

  test("keeps the live window as it is, averages each older hour into one point and drops what is too old", () => {
    const old = 900 * HOUR_MS;
    const points = [
      point(now - 8 * 24 * HOUR_MS),
      point(old + 10 * 60_000, { running: 2, cpuUsed: null }),
      point(old + 40 * 60_000, { running: 4, cpuUsed: 3 }),
      point(now - HOUR_MS),
      point(now),
    ];
    const compacted = compact(points, now, 6 * HOUR_MS, 7 * 24 * HOUR_MS);
    expect(compacted.map((entry) => entry.at)).toEqual([old + HOUR_MS, now - HOUR_MS, now]);
    expect(compacted[0]).toMatchObject({ running: 3, cpuUsed: 3, walletDollars: null });
  });

  test("gives the same points when run again", () => {
    const points = Array.from({ length: 200 }, (_, index) => point(now - index * 5 * 60_000, { running: index % 3 })).reverse();
    const once = compact(points, now);
    expect(compact(once, now)).toEqual(once);
    expect(compact(once, now + 60_000)).toEqual(once);
  });
});
