import { useMemo, useState } from "react";
import type uPlot from "uplot";
import type { BoxRow, CostRow, PlanLimits, Point, Snapshot, Usage } from "../shared/api.ts";
import { HOUR_MS } from "../shared/history.ts";
import { Icon } from "./icons.tsx";
import { Logo } from "./logo.tsx";
import { BLUE, BLUE_FILL, Chart, GREY, Sparkline, type Series } from "./chart.tsx";
import { ago, dollars, duration, useLive, useNow, type Live } from "./live.ts";

const RANGES = [
  { label: "15m", ms: 15 * 60_000 },
  { label: "1h", ms: 3600_000 },
  { label: "6h", ms: 6 * 3600_000 },
  { label: "24h", ms: 24 * 3600_000 },
  { label: "7d", ms: 7 * 24 * 3600_000 },
];
const SPEND_MIN_MS = 6 * HOUR_MS;

const count = (value: number) => String(Math.round(value));
const cores = (value: number) => `${value.toFixed(value < 10 ? 1 : 0)}`;
const gigabytes = (value: number) => `${value.toFixed(value < 10 ? 1 : 0)} GB`;
const money = (value: number) => (value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`);

const RUNNING: Series[] = [{ label: "Running", color: BLUE, fill: BLUE_FILL, step: true, format: count }];
const CPU: Series[] = [
  { label: "Used vCPU", color: BLUE, fill: BLUE_FILL, format: cores },
  { label: "Allocated vCPU", color: GREY, dash: [5, 4], step: true, format: cores },
];
const RAM: Series[] = [
  { label: "Used", color: BLUE, fill: BLUE_FILL, format: gigabytes },
  { label: "Allocated", color: GREY, dash: [5, 4], step: true, format: gigabytes },
];
const SPEND: Series[] = [{ label: "Spend", color: BLUE, bars: true, format: money }];
const whole = (value: number) => (Number.isInteger(value) ? String(value) : "");
const STARTS: Series[] = [
  { label: "Starts", color: GREY, bars: true, format: whole },
  { label: "Extra starts", color: BLUE, bars: true, format: whole },
];
const WALLET: Series[] = [{ label: "Balance", color: BLUE, fill: BLUE_FILL, format: (value) => `$${value.toFixed(2)}` }];
const thousands = (value: number) => Math.round(value).toLocaleString("en-US");

function column(history: Point[], pick: (point: Point) => number | null): (number | null)[] {
  return history.map(pick);
}

function Sidebar() {
  return (
    <aside className="sidebar">
      <Logo />
      <div className="scope">Dashboard</div>
      <nav>
        <a className="active" href="/" aria-current="page">
          <Icon name="chart-bar" /> Overview
        </a>
        <a href="https://boat.dev/dashboard" target="_blank" rel="noreferrer">
          <Icon name="list" /> Sandboxes <Icon name="external-link" size={16} className="external" />
        </a>
        <a href="https://docs.boat.dev" target="_blank" rel="noreferrer">
          <Icon name="book" /> Docs <Icon name="external-link" size={16} className="external" />
        </a>
      </nav>
    </aside>
  );
}

function Tile({ label, value, total, detail, meter }: { label: string; value: string; total?: string; detail?: string; meter?: number }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        {value}
        {total && <span className="tile-total"> {total}</span>}
      </div>
      {meter !== undefined && (
        <div className="meter">
          <div style={{ width: `${Math.min(100, Math.max(0, meter * 100)).toFixed(1)}%` }} />
        </div>
      )}
      {detail && <div className="tile-detail">{detail}</div>}
    </div>
  );
}

function Tiles({ snapshot }: { snapshot: Snapshot }) {
  const point = {
    ...snapshot.point,
    cpuUsed: snapshot.point.cpuUsed ?? 0,
    ramUsedGB: snapshot.point.ramUsedGB ?? 0,
  };
  const day = snapshot.spend.slice(-24).reduce((sum, bucket) => sum + bucket.dollars, 0);
  const starting = ["init", "provisioning", "provisioned", "cloning"].reduce((sum, state) => sum + (snapshot.byState[state] ?? 0), 0);
  return (
    <section className="tiles">
      <Tile
        label="Boxes running"
        value={count(point.running)}
        total={snapshot.maxActive ? `/ ${snapshot.maxActive}` : undefined}
        detail={`${starting ? `${starting} starting · ` : ""}${snapshot.total} total`}
        meter={snapshot.maxActive ? point.running / snapshot.maxActive : undefined}
      />
      <Tile label="vCPU used" value={cores(point.cpuUsed)} total={`/ ${point.cpuAllocated}`} detail={`${point.cpuAllocated ? Math.round((point.cpuUsed / point.cpuAllocated) * 100) : 0}% of allocated`} meter={point.cpuAllocated ? point.cpuUsed / point.cpuAllocated : 0} />
      <Tile label="RAM used" value={cores(point.ramUsedGB)} total={`/ ${point.ramAllocatedGB} GB`} detail={`${point.ramAllocatedGB ? Math.round((point.ramUsedGB / point.ramAllocatedGB) * 100) : 0}% of allocated`} meter={point.ramAllocatedGB ? point.ramUsedGB / point.ramAllocatedGB : 0} />
      <Tile label="Spend rate" value={`${money(point.ratePerHour)}/h`} detail={`${dollars(day)} in the last 24h`} />
    </section>
  );
}

function LimitTile({ label, usage, unit = "" }: { label: string; usage: Usage | null; unit?: string }) {
  if (!usage) return <Tile label={label} value="—" detail="no limit" />;
  const left = Math.max(0, usage.limit - usage.used);
  return <Tile label={label} value={thousands(usage.used)} total={`/ ${thousands(usage.limit)}${unit}`} detail={`${thousands(left)}${unit} left · ${usage.limit ? Math.round((usage.used / usage.limit) * 100) : 0}% used`} meter={usage.limit ? usage.used / usage.limit : 0} />;
}

function Limits({ limits }: { limits: PlanLimits }) {
  const included = limits.includedHours;
  const resets = limits.periodEnd ? new Date(limits.periodEnd).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  return (
    <section className="limits">
      <header>
        <h2>Plan limits</h2>
        {limits.plan && <span className="muted">{limits.plan}</span>}
      </header>
      <div className="tiles">
        <LimitTile label="Starts this minute" usage={limits.startsMinute} />
        <LimitTile label="Starts this hour" usage={limits.startsHour} />
        <LimitTile label="Starts today" usage={limits.startsDay} />
        <LimitTile label="Active boxes" usage={limits.active} />
        {included ? (
          <Tile
            label="Plan VM hours used"
            value={thousands(included.used)}
            total={`of ${thousands(included.limit)} h`}
            detail={[
              included.used >= included.limit ? "all used" : `${thousands(included.limit - included.used)} h left`,
              resets ? `resets ${resets}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            meter={included.limit ? included.used / included.limit : 0}
          />
        ) : (
          <Tile label="Plan VM hours used" value="—" detail="none in this plan" />
        )}
        <Tile
          label="Wallet"
          value={limits.walletDollars === null ? "—" : dollars(limits.walletDollars)}
          detail={[limits.overageVmHourDollars === null ? null : `${money(limits.overageVmHourDollars)} per VM hour`, limits.nextStartDollars ? `${money(limits.nextStartDollars)} per start` : null].filter(Boolean).join(" · ")}
        />
      </div>
    </section>
  );
}

function Panel({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="panel">
      <header>
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Charts({ live, rangeMs, rangeLabel, now }: { live: Live; rangeMs: number; rangeLabel: string; now: number }) {
  const { history, snapshot } = live;
  const range: [number, number] = [(now - rangeMs) / 1000, now / 1000];
  const data = useMemo(() => {
    const at = column(history, (point) => point.at / 1000);
    return {
      running: [at, column(history, (point) => point.running)] as uPlot.AlignedData,
      cpu: [at, column(history, (point) => point.cpuUsed), column(history, (point) => point.cpuAllocated)] as uPlot.AlignedData,
      ram: [at, column(history, (point) => point.ramUsedGB), column(history, (point) => point.ramAllocatedGB)] as uPlot.AlignedData,
      wallet: [at, column(history, (point) => point.walletDollars)] as uPlot.AlignedData,
    };
  }, [history]);
  const spendMs = Math.max(rangeMs, SPEND_MIN_MS);
  const spendFrom = Math.floor((now - spendMs) / HOUR_MS) * HOUR_MS;
  const buckets = useMemo(() => (snapshot?.spend ?? []).filter((bucket) => bucket.start >= spendFrom), [snapshot?.spend, spendFrom]);
  const spend = useMemo(() => [buckets.map((bucket) => (bucket.start + HOUR_MS / 2) / 1000), buckets.map((bucket) => bucket.dollars)] as uPlot.AlignedData, [buckets]);
  const spendRange: [number, number] | undefined = buckets.length ? [buckets[0]!.start / 1000, (buckets[buckets.length - 1]!.start + HOUR_MS) / 1000] : undefined;
  const spendTotal = buckets.reduce((sum, bucket) => sum + bucket.dollars, 0);
  const startBuckets = useMemo(() => (snapshot?.starts ?? []).filter((bucket) => bucket.start >= spendFrom), [snapshot?.starts, spendFrom]);
  const starts = useMemo(
    () => [startBuckets.map((bucket) => (bucket.start + HOUR_MS / 2) / 1000), startBuckets.map((bucket) => bucket.starts), startBuckets.map((bucket) => bucket.extra)] as uPlot.AlignedData,
    [startBuckets],
  );
  const startsRange: [number, number] = [spendFrom / 1000, (Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS) / 1000];
  const extra = startBuckets.reduce((sum, bucket) => sum + bucket.extra, 0);
  const extraDollars = startBuckets.reduce((sum, bucket) => sum + bucket.extraDollars, 0);
  const boatHour = snapshot?.limits?.startsHour?.used;
  const spanLabel = spendMs === rangeMs ? rangeLabel : "6h";
  return (
    <div className="grid">
      <Panel title="Boxes running">
        <Chart data={data.running} series={RUNNING} range={range} />
      </Panel>
      <Panel
        title="Starts per hour"
        aside={
          <span className="muted" title="Boat's count of the last minute, read after every minute and added up; Boat's own count for the last hour is next to it">
            {`${extra} extra (${dollars(extraDollars)}) in the last ${spanLabel} · last hour: ${snapshot?.startsLastHour ?? 0} counted, ${boatHour ?? "—"} by Boat`}
          </span>
        }
      >
        {startBuckets.some((bucket) => bucket.starts > 0) ? (
          <Chart data={starts} series={STARTS} range={startsRange} />
        ) : (
          <div className="empty">
            {`No starts since counting began${startBuckets[0] ? ` (in the ${new Date(startBuckets[0].start).toLocaleTimeString("en-US", { hour: "numeric" })} hour)` : ""}. Boat counts ${boatHour ?? "—"} in the last hour and ${snapshot?.limits?.startsDay?.used ?? "—"} in the last 24h, but keeps no per-hour history, so the hours before counting can't be shown.`}
          </div>
        )}
      </Panel>
      <Panel title="CPU: used vs allocated">
        <Chart data={data.cpu} series={CPU} range={range} />
      </Panel>
      <Panel title="RAM: used vs allocated">
        <Chart data={data.ram} series={RAM} range={range} />
      </Panel>
      <Panel title="Spend per hour" aside={<span className="muted">{`${dollars(spendTotal)} in the last ${spanLabel}`}</span>}>
        <Chart data={spend} series={SPEND} range={spendRange} />
      </Panel>
      <Panel title="Wallet balance">
        <Chart data={data.wallet} series={WALLET} range={range} yFit />
      </Panel>
    </div>
  );
}

function StateDot({ state }: { state: string }) {
  const kind = state === "running" ? "on" : state === "error" ? "bad" : ["ready", "idle"].includes(state) ? "on" : "off";
  return (
    <span className="state">
      <span className={`dot ${kind}`} /> {state}
    </span>
  );
}

const PAGE_SIZE = 10;

function runtime(box: BoxRow | CostRow, now: number): string {
  if (box.since === null) return "hours" in box && box.hours > 0 ? `${duration(box.hours * HOUR_MS)} / —` : "—";
  const left = box.stopsAt === null ? "∞" : duration(Math.max(0, box.stopsAt - now));
  return `${duration(now - box.since)} / ${left}`;
}

function BoxTable<Row extends BoxRow>({ rows, now, cost }: { rows: Row[]; now: number; cost: (box: Row) => string }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  return (
    <>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="box-name">Name</th>
              <th>State</th>
              <th>Type</th>
              <th title="How long it has been up / how long until Boat stops it by itself (∞: auto-stop is off)">Runtime / Stops in</th>
              <th>CPU</th>
              <th>RAM</th>
              <th>Cost</th>
              <th>Usage</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((box) => (
              <tr key={box.id}>
                <td className="box-name">
                  <div className="name" title={box.name}>
                    {box.name}
                  </div>
                  <div className="mono muted small" title={[box.id, box.subdomain].filter(Boolean).join(" · ")}>
                    {box.id}
                    {box.subdomain && ` · ${box.subdomain}`}
                  </div>
                </td>
                <td>
                  <StateDot state={box.state} />
                </td>
                <td>{box.type}</td>
                <td>{runtime(box, now)}</td>
                <td>{box.cpuUsed === null ? "—" : `${cores(box.cpuUsed)} / ${box.vcpu}`}</td>
                <td>{box.ramUsedGB === null ? "—" : `${gigabytes(box.ramUsedGB)} / ${box.memoryGB}`}</td>
                <td>{cost(box)}</td>
                <td>{box.cpuHistory.length ? <Sparkline values={box.cpuHistory} /> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager">
          <span className="muted">{`${current * PAGE_SIZE + 1}–${current * PAGE_SIZE + shown.length} of ${rows.length}`}</span>
          <button disabled={current === 0} onClick={() => setPage(current - 1)}>
            Previous
          </button>
          <span className="muted">{`${current + 1} / ${pages}`}</span>
          <button disabled={current === pages - 1} onClick={() => setPage(current + 1)}>
            Next
          </button>
        </div>
      )}
    </>
  );
}

function Longest({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  return <Panel title="Longest running">{snapshot.longest.length === 0 ? <div className="empty">No boxes are running.</div> : <BoxTable rows={snapshot.longest} now={now} cost={(box) => (box.ratePerHour ? `${money(box.ratePerHour)}/h` : "—")} />}</Panel>;
}

const SPENT = (box: CostRow) => dollars(box.dollars);

function Costs({ snapshot, rangeMs, rangeLabel, now }: { snapshot: Snapshot; rangeMs: number; rangeLabel: string; now: number }) {
  const wanted = Math.max(1, Math.ceil(rangeMs / HOUR_MS));
  const window = snapshot.costs.find((entry) => entry.hours >= wanted) ?? snapshot.costs[snapshot.costs.length - 1];
  if (!window) return null;
  const from = Math.floor(now / HOUR_MS) * HOUR_MS - (window.hours - 1) * HOUR_MS;
  const loading = snapshot.spend.some((bucket) => bucket.start >= from && bucket.start + HOUR_MS < now - 5 * 60_000 && !bucket.complete);
  const label = window.hours === 1 ? "this hour" : `last ${window.hours === wanted ? rangeLabel : `${window.hours}h`}`;
  return (
    <Panel title="Top boxes by cost" aside={<span className="muted">{loading ? `${label} · still loading` : label}</span>}>
      {window.rows.length === 0 ? <div className="empty">No spend in this window.</div> : <BoxTable key={window.hours} rows={window.rows} now={now} cost={SPENT} />}
    </Panel>
  );
}

export function App() {
  const live = useLive();
  const now = useNow();
  const [range, setRange] = useState(RANGES[1]!);
  const { snapshot } = live;
  return (
    <div className="layout">
      <Sidebar />
      <main>
        <header className="top">
          <h1>Overview</h1>
          <div className="controls">
            <span className="status">
              <span className={`dot ${live.connected ? "on" : "off"}`} /> {live.connected ? (live.receivedAt ? `live · ${ago(now - live.receivedAt)}` : "live") : "reconnecting"}
            </span>
            <div className="segmented">
              {RANGES.map((option) => (
                <button key={option.label} className={option === range ? "active" : ""} onClick={() => setRange(option)}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </header>
        {snapshot?.problem && <div className="problem">{snapshot.problem}</div>}
        {!snapshot ? (
          <div className="empty">Connecting to Boat…</div>
        ) : (
          <>
            <Tiles snapshot={snapshot} />
            {snapshot.limits && <Limits limits={snapshot.limits} />}
            <Charts live={live} rangeMs={range.ms} rangeLabel={range.label} now={now} />
            <Costs snapshot={snapshot} rangeMs={range.ms} rangeLabel={range.label} now={now} />
            <Longest snapshot={snapshot} now={now} />
          </>
        )}
      </main>
    </div>
  );
}
