import index from "../web/index.html";
import type { Message } from "../shared/api.ts";
import { boatClient } from "./boat.ts";
import { collector, DEFAULT_TIMING, type Collector } from "./collector.ts";
import { fileStore, ledgerFile, startsFile } from "./store.ts";

const PING_MS = 15_000;

export function eventStream(source: Collector, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let ping: Timer | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (message: Message) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      send({ kind: "init", history: source.history(), snapshot: source.snapshot() });
      unsubscribe = source.subscribe(send);
      ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), PING_MS);
      signal.addEventListener("abort", () => {
        unsubscribe();
        clearInterval(ping);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      unsubscribe();
      clearInterval(ping);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

if (import.meta.main) {
  const apiKey = process.env.BOAT_API_KEY;
  if (!apiKey) throw new Error("the dashboard needs Boat's API key: set BOAT_API_KEY in .env");
  const running = globalThis as {
    boatDashboard?: Collector;
  };
  await running.boatDashboard?.stop();
  const source = collector(boatClient(apiKey), DEFAULT_TIMING, Date.now, { history: fileStore(), ledger: ledgerFile(), starts: startsFile() });
  running.boatDashboard = source;
  source.start();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void source.stop().finally(() => process.exit(0)));
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 3010),
    hostname: process.env.HOST ?? "0.0.0.0",
    idleTimeout: 0,
    development: process.env.NODE_ENV === "production" ? false : { hmr: false },
    routes: {
      "/": index,
      "/events": (request) => eventStream(source, request.signal),
      "/api/snapshot": () => Response.json({ history: source.history(), snapshot: source.snapshot() }),
    },
  });
  console.log(`boat dashboard on ${server.url}`);
}
