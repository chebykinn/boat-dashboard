import { describe, expect, test } from "bun:test";
import type { Point } from "../shared/api.ts";
import { HOUR_MS } from "../shared/history.ts";
import { appendPoint, dollars, duration } from "./live.ts";

function point(at: number): Point {
  return { at, running: 0, cpuUsed: 0, cpuAllocated: 0, ramUsedGB: 0, ramAllocatedGB: 0, ratePerHour: 0, walletDollars: null };
}

describe("appendPoint", () => {
  test("appends newer points, drops repeats and folds what left the live window into hours", () => {
    const start = 100 * HOUR_MS;
    let history = [point(start + 1000), point(start + 2000)];
    history = appendPoint(history, point(start + 2000));
    expect(history.map((entry) => entry.at)).toEqual([start + 1000, start + 2000]);
    history = appendPoint(history, point(start + 8 * HOUR_MS));
    expect(history.map((entry) => entry.at)).toEqual([start + HOUR_MS, start + 8 * HOUR_MS]);
  });
});

describe("formatting", () => {
  test("durations and dollars", () => {
    expect(duration(42 * 60_000)).toBe("42m");
    expect(duration((2 * 60 + 5) * 60_000)).toBe("2h 5m");
    expect(duration((3 * 1440 + 60) * 60_000)).toBe("3d 1h");
    expect(dollars(0.004)).toBe("<$0.01");
    expect(dollars(3.987)).toBe("$3.99");
  });
});
