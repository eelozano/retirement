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
import { PinnableYears } from "./PinnableYears";

// One canvas: stacked account balances, the net-worth line on top, and the
// Monte Carlo percentile band as an additive overlay rather than a separate
// screen. Hovering reads a year into the inspector; clicking pins it — the
// interaction itself lives in PinnableYears, shared with the cash-flow chart.
// The <Tooltip> is kept purely for its crosshair cursor and renders nothing.

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
    p10: fan[i].p10,
    p50: fan[i].p50,
    p90: fan[i].p90,
    outerBase: fan[i].outerBase,
    outerBand: fan[i].outerBand,
    innerBase: fan[i].innerBase,
    innerBand: fan[i].innerBand,
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
  return (
    <PinnableYears
      className="projection-chart"
      years={props.rows.map((r) => r.year)}
      pinnedYear={props.pinnedYear}
      plotLeft={PLOT_LEFT}
      plotRight={MARGIN_RIGHT}
      ariaLabel="Projection — pinned year"
      onHoverYear={props.onHoverYear}
      onPinYear={props.onPinYear}
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

          {/* Percentile bands: each a transparent riser to its lower bound,
              then the band's height, on its own stack so the inner and
              outer ranges sit at their own offsets rather than adding onto
              each other. Drawn first so the stack and line sit on top, but
              the stack below is thinned (fillOpacity) while a band is on so
              the range still reads through it rather than being painted
              over — see #26. */}
          {props.showBand && (
            <>
              <Area
                dataKey="outerBase"
                stackId="fan-outer"
                stroke="none"
                fill="none"
                isAnimationActive={false}
                activeDot={false}
              />
              <Area
                dataKey="outerBand"
                name="10th–90th percentile"
                stackId="fan-outer"
                stroke="none"
                fill="var(--band)"
                isAnimationActive={false}
                activeDot={false}
              />
              <Area
                dataKey="innerBase"
                stackId="fan-inner"
                stroke="none"
                fill="none"
                isAnimationActive={false}
                activeDot={false}
              />
              <Area
                dataKey="innerBand"
                name="25th–75th percentile"
                stackId="fan-inner"
                stroke="none"
                fill="var(--band-inner)"
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
              fillOpacity={props.showBand ? 0.55 : 0.9}
              isAnimationActive={false}
              activeDot={false}
            />
          ))}

          {props.showBand && (
            <>
              <Line
                type="monotone"
                dataKey="p90"
                name="90th percentile"
                stroke="var(--band-edge)"
                strokeWidth={1}
                strokeDasharray="2 2"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p10"
                name="10th percentile"
                stroke="var(--band-edge)"
                strokeWidth={1}
                strokeDasharray="2 2"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p50"
                name="Median (p50)"
                stroke="var(--text-primary)"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                isAnimationActive={false}
              />
            </>
          )}

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
    </PinnableYears>
  );
}
