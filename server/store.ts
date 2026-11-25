import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Point } from "../shared/api.ts";
import type { StartBucket } from "../shared/api.ts";
import type { SavedHour } from "./spend.ts";

export type HistoryStore = {
  load(): Promise<Point[]>;
  save(points: Point[]): Promise<void>;
};

export type LedgerStore = {
  load(): Promise<SavedHour[]>;
  save(hours: SavedHour[]): Promise<void>;
};

function stateDir(): string {
  return process.env.DASHBOARD_STATE_DIR ?? join(homedir(), ".local", "state", "boat-dashboard");
}

export function defaultHistoryPath(): string {
  return join(stateDir(), "history.json");
}

export type StartsStore = {
  load(): Promise<StartBucket[]>;
  save(buckets: StartBucket[]): Promise<void>;
};

export type Stores = {
  history?: HistoryStore;
  ledger?: LedgerStore;
  starts?: StartsStore;
};

export function defaultStartsPath(): string {
  return join(stateDir(), "starts.json");
}

export function defaultLedgerPath(): string {
  return join(stateDir(), "ledger.json");
}

function isPoint(value: unknown): value is Point {
  return typeof value === "object" && value !== null && typeof (value as Point).at === "number" && typeof (value as Point).running === "number";
}

function isStartBucket(value: unknown): value is StartBucket {
  return typeof value === "object" && value !== null && typeof (value as StartBucket).start === "number" && typeof (value as StartBucket).starts === "number";
}

function isSavedHour(value: unknown): value is SavedHour {
  return typeof value === "object" && value !== null && typeof (value as SavedHour).start === "number" && Array.isArray((value as SavedHour).boxes);
}

async function loadArray(path: string): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(staging, JSON.stringify(value));
  await rename(staging, path);
}

export function fileStore(path: string = defaultHistoryPath()): HistoryStore {
  return {
    async load() {
      return (await loadArray(path)).filter(isPoint).map(({ errors: _errors, ...point }: Point & { errors?: unknown }) => ({ ...point, walletDollars: point.walletDollars ?? null }));
    },
    save: (points) => saveAtomically(path, points),
  };
}

export function ledgerFile(path: string = defaultLedgerPath()): LedgerStore {
  return {
    async load() {
      return (await loadArray(path)).filter(isSavedHour);
    },
    save: (hours) => saveAtomically(path, hours),
  };
}

export function startsFile(path: string = defaultStartsPath()): StartsStore {
  return {
    async load() {
      return (await loadArray(path)).filter(isStartBucket);
    },
    save: (buckets) => saveAtomically(path, buckets),
  };
}
