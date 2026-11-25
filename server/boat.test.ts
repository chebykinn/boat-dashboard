import { describe, expect, test } from "bun:test";
import { boatClient, BoatRequestError } from "./boat.ts";

function answering(...statuses: number[]) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
    const body = status === 200 ? { activeSandboxes: 1, maxActiveSandboxes: 5 } : { code: status === 500 ? "" : "nope", message: "Something went wrong" };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("boatClient", () => {
  test("retries a 500 and returns the answer that follows", async () => {
    const { fetcher, calls } = answering(500, 500, 200);
    const limits = await boatClient("key", "https://boat.test", fetcher, [0, 0]).limits();
    expect(limits.maxActiveSandboxes).toBe(5);
    expect(calls).toHaveLength(3);
  });

  test("gives up after the retries, with Boat's message", async () => {
    const { fetcher, calls } = answering(500);
    const error = await boatClient("key", "https://boat.test", fetcher, [0, 0]).limits().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BoatRequestError);
    expect((error as Error).message).toContain("Something went wrong");
    expect(calls).toHaveLength(3);
  });

  test("does not retry a refusal", async () => {
    const { fetcher, calls } = answering(403);
    await expect(boatClient("key", "https://boat.test", fetcher, [0, 0]).limits()).rejects.toThrow("403 nope");
    expect(calls).toHaveLength(1);
  });

  test("follows the list's pages", async () => {
    const pages = [
      { sandboxes: [{ id: "a", name: "a", state: "idle" }], pageInfo: { hasMore: true, nextCursor: "c1" } },
      { sandboxes: [{ id: "b", name: "b", state: "idle" }], pageInfo: { hasMore: false, nextCursor: null } },
    ];
    const urls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json(pages[urls.length - 1]);
    }) as typeof fetch;
    const sandboxes = await boatClient("key", "https://boat.test", fetcher).sandboxes();
    expect(sandboxes.map((sandbox) => sandbox.id)).toEqual(["a", "b"]);
    expect(urls[1]).toContain("cursor=c1");
  });
});
