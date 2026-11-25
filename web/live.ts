import { useEffect, useState } from "react";
import type { Message, Point, Snapshot } from "../shared/api.ts";
import { compact } from "../shared/history.ts";

export type Live = {
  history: Point[];
  snapshot: Snapshot | null;
  connected: boolean;
  receivedAt: number | null;
};

export function appendPoint(history: Point[], point: Point): Point[] {
  const last = history[history.length - 1];
  if (last && point.at <= last.at) return history;
  return compact([...history, point], point.at);
}

export function reduceMessage(live: Live, message: Message, at: number): Live {
  if (message.kind === "init") return { history: message.history, snapshot: message.snapshot, connected: true, receivedAt: at };
  return { history: appendPoint(live.history, message.snapshot.point), snapshot: message.snapshot, connected: true, receivedAt: at };
}

export function useLive(url = "/events"): Live {
  const [live, setLive] = useState<Live>({ history: [], snapshot: null, connected: false, receivedAt: null });
  useEffect(() => {
    const source = new EventSource(url);
    source.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as Message;
      setLive((previous) => reduceMessage(previous, message, Date.now()));
    };
    source.onerror = () => setLive((previous) => ({ ...previous, connected: false }));
    return () => source.close();
  }, [url]);
  return live;
}

export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

export function dollars(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${duration(ms)} ago`;
}
