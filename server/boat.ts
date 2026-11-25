import { BoatApi, Configuration, ResponseError, type LimitsResponse, type ProcessListResponse, type Sandbox, type SandboxUsageResponse } from "@boatdev/sdk";

export const BOAT_API_URL = "https://boat.dev/api/v1";
export const RETRY_DELAYS_MS = [500, 1500];

export type BoatSandbox = Sandbox;
export type BoatProcessList = Pick<ProcessListResponse, "live" | "sampledAt" | "total" | "processes">;
export type BoatUsage = Pick<SandboxUsageResponse, "seconds" | "dollars" | "secondsPerDollar" | "billingMultiplier" | "running">;
export type BoatLimits = Pick<LimitsResponse, "activeSandboxes" | "maxActiveSandboxes" | "creditSecondsPerDollar" | "starts" | "planIncluded" | "sandboxPlanKey" | "planName" | "wallet" | "nextStartDollars" | "overagePrices">;

export type BoatClient = {
  sandboxes(): Promise<BoatSandbox[]>;
  processes(id: string): Promise<BoatProcessList>;
  usage(id: string, since: Date, until: Date): Promise<BoatUsage>;
  limits(): Promise<BoatLimits>;
};

export class BoatRequestError extends Error {
  override name = "BoatRequestError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const LISTED_PER_PAGE = 200;
const REQUEST_TIMEOUT_MS = 20_000;

function retryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

export function retryingFetch(fetcher: typeof fetch, delays: number[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= delays.length;
      try {
        const response = await fetcher(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (last || !retryableStatus(response.status)) return response;
      } catch (error) {
        if (last) throw error;
      }
      await Bun.sleep(delays[attempt]!);
    }
  }) as typeof fetch;
}

async function call<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ResponseError)) throw error;
    const text = await error.response.text().catch(() => "");
    let body: {
      code?: string;
      message?: string;
    } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      body = { message: text };
    }
    const status = error.response.status;
    throw new BoatRequestError(status, body.code ?? "", `${what} failed (${status}${body.code ? ` ${body.code}` : ""}): ${body.message ?? text}`);
  }
}

export function boatClient(apiKey: string, base: string = BOAT_API_URL, fetcher: typeof fetch = fetch, delays: number[] = RETRY_DELAYS_MS): BoatClient {
  const api = new BoatApi(new Configuration({ basePath: base, accessToken: apiKey, fetchApi: retryingFetch(fetcher, delays) }));

  return {
    async sandboxes() {
      const all: BoatSandbox[] = [];
      let cursor: string | null = null;
      do {
        const page = await call("listing the sandboxes", () => api.sandboxes({ limit: LISTED_PER_PAGE, cursor }));
        all.push(...page.sandboxes);
        cursor = page.pageInfo?.hasMore ? (page.pageInfo.nextCursor ?? null) : null;
      } while (cursor);
      return all;
    },
    processes(id) {
      return call(`processes of ${id}`, () => api.processes({ sandboxId: id }));
    },
    usage(id, since, until) {
      return call(`usage of ${id}`, () => api.usage({ sandboxId: id, since: since.toISOString(), until: until.toISOString() }));
    },
    limits() {
      return call("limits", () => api.limits());
    },
  };
}
