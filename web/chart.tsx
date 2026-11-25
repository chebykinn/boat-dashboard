import { useEffect, useRef } from "react";
import uPlot from "uplot";

export const BLUE = "#2f44b8";
export const BLUE_FILL = "rgba(47, 68, 184, 0.12)";
export const GREY = "#9a9eae";
export const GRID = "#eceef3";
export const AXIS = "#6b6f80";
const CHART_PADDING = 24;

export type Series = {
  label: string;
  color: string;
  fill?: string;
  dash?: number[];
  bars?: boolean;
  step?: boolean;
  format: (value: number) => string;
};

export type ChartProps = {
  data: uPlot.AlignedData;
  series: Series[];
  range?: [number, number];
  yMin?: number;
  yFit?: boolean;
  height?: number;
};

const bars = uPlot.paths.bars!({ size: [0.7, 48], gap: 2 });
const stepped = uPlot.paths.stepped!({ align: 1 });

function optionsOf(read: () => ChartProps, width: number): uPlot.Options {
  const props = read();
  const font = "12px -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif";
  return {
    width,
    height: props.height ?? 220,
    padding: [12, 8, 0, 0],
    cursor: {
      points: { size: 6 },
      drag: { x: false, y: false },
    },
    legend: { show: true, live: true },
    scales: {
      x: {
        time: true,
        range: (_self, min, max) => read().range ?? [min, max],
      },
      y: {
        range: (_self, min, max) => (read().yFit && max > 0 ? [Math.max(0, min - Math.max(1, (max - min) * 0.2)), max + Math.max(1, (max - min) * 0.2)] : [read().yMin ?? 0, max > 0 ? max * 1.15 : 1]),
      },
    },
    axes: [
      {
        stroke: AXIS,
        font,
        grid: { stroke: GRID, width: 1 },
        ticks: { stroke: GRID, width: 1 },
      },
      {
        stroke: AXIS,
        font,
        size: 56,
        grid: { stroke: GRID, width: 1 },
        ticks: { show: false },
        values: (_self, ticks) => ticks.map((tick) => props.series[0]!.format(tick)),
      },
    ],
    series: [
      {},
      ...props.series.map(
        (series): uPlot.Series => ({
          label: series.label,
          stroke: series.color,
          width: series.bars ? 0 : 2,
          fill: series.bars ? series.color : series.fill,
          dash: series.dash,
          paths: series.bars ? bars : series.step ? stepped : undefined,
          points: { show: false },
          value: (_self, value) => (value == null ? "—" : series.format(value)),
          spanGaps: false,
        }),
      ),
    ],
  };
}

export function Chart(props: ChartProps) {
  const holder = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const element = holder.current!;
    const made = new uPlot(optionsOf(() => latest.current, Math.max(100, element.clientWidth - CHART_PADDING)), latest.current.data, element);
    plot.current = made;
    const observer = new ResizeObserver(() => made.setSize({ width: Math.max(100, element.clientWidth - CHART_PADDING), height: latest.current.height ?? 220 }));
    observer.observe(element);
    return () => {
      observer.disconnect();
      made.destroy();
      plot.current = null;
    };
  }, [props.series.length]);

  useEffect(() => {
    plot.current?.setData(props.data, true);
  }, [props.data, props.range]);

  return <div className="chart" ref={holder} />;
}

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="muted">—</span>;
  const width = 120;
  const height = 22;
  const top = Math.max(...values, 0.05) * 1.2;
  const step = width / (values.length - 1);
  const line = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 1 - (value / top) * (height - 2)).toFixed(1)}`).join(" ");
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <line x1="0" x2={width} y1={height - 1} y2={height - 1} stroke={GRID} />
      <polyline points={line} fill="none" stroke={BLUE} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
