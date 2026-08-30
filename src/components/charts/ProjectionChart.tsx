import { useRef } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { currencyCompact } from "../../lib/format";
import type { Plan } from "../../types/generated/Plan";
import type { ChartRow, SeriesDef } from "./chartData";
import type { FanRow } from "./monteCarloData";

// One canvas: stacked account balances, the net-worth line on top, and the
// Monte Carlo percentile band as an additive overlay rather than a separate
// screen. Hovering reads a year into the inspector; clicking pins it.
//
// The hovered year is derived from pointer position, not from Recharts.
//
// In Recharts 3 the chart's own `onMouseMove` never fires, `onClick` arrives
// with `activeIndex: null` and `activeLabel` undefined, and the tooltip's
// `label` lags a click by a render. Reading the pointer against the plotting
// area is deterministic and needs none of that. The <Tooltip> is kept purely
// for its crosshair cursor and renders nothing.

// Must match the <ComposedChart margin> and <YAxis width> below — the pointer
// math and the chart have to agree on where the plotting area starts.
const MARGIN_LEFT = 8;
const MARGIN_RIGHT = 16;
const Y_AXIS_WIDTH = 64;
const PLOT_LEFT = MARGIN_LEFT + Y_AXIS_WIDTH;

// ChartRow's index signature already admits extra numeric series, so the
// band rides along as two more keys rather than a widened row type.
export type ProjectionRow = ChartRow;

/** Merges the percentile fan into the chart rows by period. */
export function mergeFan(rows: ChartRow[], fan: FanRow[]): ProjectionRow[] {
  // The engine guarantees one percentile entry per snapshot; bail rather than
  // mismatch periods if that ever stops being true.
  if (fan.length !== rows.length) return rows;
  return rows.map((row, i) => ({
    ...row,
    outerBase: fan[i].outerBase,
    outerBand: fan[i].outerBand,
  }));
}

export function ProjectionChart(props: {
  rows: ProjectionRow[];
  series: SeriesDef[];
  plan: Plan;
  depletionYear: number | null;
  showBand: boolean;
  pinnedYear: number;
  onHoverYear: (year: number | null) => void;
  onPinYear: (year: number) => void;
}) {
  const years = props.rows.map((r) => r.year);
  const first = years[0];
  const last = years[years.length - 1];

  const box = useRef<HTMLDivElement>(null);
  /** Year under the pointer, or null when it is outside the plotting area. */
  const yearAtPointer = (clientX: number): number | null => {
    const el = box.current;
    if (!el || last === first) return null;
    const rect = el.getBoundingClientRect();
    const plotWidth = rect.width - PLOT_LEFT - MARGIN_RIGHT;
    if (plotWidth <= 0) return null;
    const t = (clientX - rect.left - PLOT_LEFT) / plotWidth;
    if (t < 0 || t > 1) return null;
    return Math.round(first + t * (last - first));
  };

  const movePin = (delta: number) => {
    const next = Math.min(last, Math.max(first, props.pinnedYear + delta));
    props.onPinYear(next);
  };

  return (
    // Focusable so the pinned year is reachable without a mouse; arrow keys
    // step it, which is the keyboard equivalent of clicking the chart.
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the chart's keyboard affordance — slider is the closest role for stepping a pinned year, and it carries the valuemin/max/now below
    <div
      className="projection-chart"
      role="slider"
      tabIndex={0}
      aria-label="Projection — pinned year"
      aria-valuemin={first}
      aria-valuemax={last}
      aria-valuenow={props.pinnedYear}
      aria-valuetext={String(props.pinnedYear)}
      ref={box}
      onMouseMove={(e) => props.onHoverYear(yearAtPointer(e.clientX))}
      onMouseLeave={() => props.onHoverYear(null)}
      onClick={(e) => {
        const year = yearAtPointer(e.clientX);
        if (year !== null) props.onPinYear(year);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          movePin(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          movePin(1);
        } else if (e.key === "Home") {
          e.preventDefault();
          props.onPinYear(first);
        } else if (e.key === "End") {
          e.preventDefault();
          props.onPinYear(last);
        }
      }}
    >
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart
          data={props.rows}
          margin={{ top: 28, right: MARGIN_RIGHT, bottom: 0, left: MARGIN_LEFT }}
        >
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis
            dataKey="year"
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "var(--axis)" }}
          />
          <YAxis
            tickFormatter={(v: number) => currencyCompact(v)}
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={Y_AXIS_WIDTH}
          />
          <Tooltip
            content={() => null}
            cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
            isAnimationActive={false}
          />

          {/* Percentile band: a transparent riser to p10, then the p10-p90
              height. Drawn first so the stack and line sit on top of it. */}
          {props.showBand && (
            <>
              <Area
                dataKey="outerBase"
                stackId="fan"
                stroke="none"
                fill="none"
                isAnimationActive={false}
                activeDot={false}
              />
              <Area
                dataKey="outerBand"
                name="10th–90th percentile"
                stackId="fan"
                stroke="none"
                fill="var(--band)"
                isAnimationActive={false}
                activeDot={false}
              />
            </>
          )}

          {props.series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stackId="balances"
              stroke={s.color}
              strokeWidth={1}
              fill={s.color}
              fillOpacity={0.9}
              isAnimationActive={false}
              activeDot={false}
            />
          ))}

          {props.plan.people.map((person, i) => (
            <ReferenceLine
              key={person.id}
              x={person.retirement.year}
              stroke="var(--axis)"
              strokeDasharray="3 3"
              label={{
                value: `${person.name} retires`,
                position: "top",
                dy: i % 2 === 0 ? -2 : 12,
                fill: "var(--muted)",
                fontSize: 10.5,
              }}
            />
          ))}
          {props.depletionYear !== null && (
            <ReferenceLine
              x={props.depletionYear}
              stroke="var(--status-critical)"
              strokeDasharray="3 3"
              label={{
                value: "⚠ Funds deplete",
                position: "top",
                fill: "var(--status-critical)",
                fontSize: 10.5,
              }}
            />
          )}

          <ReferenceLine
            x={props.pinnedYear}
            stroke="var(--text-primary)"
            strokeWidth={1}
          />

          <Line
            type="monotone"
            dataKey="net_worth"
            name="Net worth"
            stroke="var(--text-primary)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
