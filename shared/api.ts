export type Point = {
  at: number;
  running: number;
  cpuUsed: number | null;
  cpuAllocated: number;
  ramUsedGB: number | null;
  ramAllocatedGB: number;
  ratePerHour: number;
  walletDollars: number | null;
};

export type Usage = {
  used: number;
  limit: number;
};

export type PlanLimits = {
  plan: string | null;
  active: Usage;
  startsMinute: Usage | null;
  startsHour: Usage | null;
  startsDay: Usage | null;
  includedHours: Usage | null;
  periodEnd: number | null;
  walletDollars: number | null;
  nextStartDollars: number | null;
  overageVmHourDollars: number | null;
};

export type StartBucket = {
  start: number;
  starts: number;
  extra: number;
  extraDollars: number;
};



export type BoxRow = {
  id: string;
  name: string;
  subdomain: string | null;
  type: string;
  state: string;
  since: number | null;
  stopsAt: number | null;
  vcpu: number;
  memoryGB: number;
  cpuUsed: number | null;
  ramUsedGB: number | null;
  ratePerHour: number;
  cpuHistory: number[];
};

export type CostRow = BoxRow & {
  dollars: number;
  hours: number;
};

export type CostWindow = {
  hours: number;
  rows: CostRow[];
};

export type SpendBucket = {
  start: number;
  dollars: number;
  complete: boolean;
};

export type Snapshot = {
  point: Point;
  total: number;
  byState: Record<string, number>;
  maxActive: number | null;
  limits: PlanLimits | null;
  costs: CostWindow[];
  starts: StartBucket[];
  startsLastHour: number;
  longest: BoxRow[];
  spend: SpendBucket[];
  problem: string | null;
};

export type Message =
  | {
      kind: "init";
      history: Point[];
      snapshot: Snapshot;
    }
  | {
      kind: "tick";
      snapshot: Snapshot;
    };
