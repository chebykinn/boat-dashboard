import type { Point } from "./api.ts";

export const HOUR_MS = 3600_000;
export const LIVE_MS = 6 * HOUR_MS;
export const HISTORY_MS = 7 * 24 * HOUR_MS;

export function hourEnd(at: number): number {
  return Math.ceil(at / HOUR_MS) * HOUR_MS;
}

export function liveCut(now: number, liveMs: number = LIVE_MS): number {
  return Math.floor((now - liveMs) / HOUR_MS) * HOUR_MS;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanOf(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? mean(known) : null;
}

function average(at: number, group: Point[]): Point {
  if (group.length === 1 && group[0]!.at === at) return group[0]!;
  return {
    at,
    running: mean(group.map((point) => point.running)),
    cpuUsed: meanOf(group.map((point) => point.cpuUsed)),
    cpuAllocated: mean(group.map((point) => point.cpuAllocated)),
    ramUsedGB: meanOf(group.map((point) => point.ramUsedGB)),
    ramAllocatedGB: mean(group.map((point) => point.ramAllocatedGB)),
    ratePerHour: mean(group.map((point) => point.ratePerHour)),
    walletDollars: meanOf(group.map((point) => point.walletDollars)),
  };
}

export function compact(points: Point[], now: number, liveMs: number = LIVE_MS, historyMs: number = HISTORY_MS): Point[] {
  const cut = liveCut(now, liveMs);
  const from = now - historyMs;
  const groups = new Map<number, Point[]>();
  const live: Point[] = [];
  for (const point of points) {
    if (point.at < from) continue;
    if (point.at > cut) {
      live.push(point);
      continue;
    }
    const end = hourEnd(point.at);
    const group = groups.get(end);
    if (group) group.push(point);
    else groups.set(end, [point]);
  }
  const hourly = [...groups.entries()].map(([end, group]) => average(end, group)).sort((a, b) => a.at - b.at);
  return [...hourly, ...live];
}
