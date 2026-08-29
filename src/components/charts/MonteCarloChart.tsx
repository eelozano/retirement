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
import type { Plan } from "../../types/generated/Plan";
import { currency, currencyCompact } from "../../lib/format";
import type { FanRow } from "./monteCarloData";

// Percentile fan: two nested stacked bands (p10-p90, p25-p75) under a
// median line. Each band is a transparent base area plus a visible height
// area, which is how Recharts expresses a floating range.

function FanTooltip(props: {
  active?: boolean;
  label?: string | number;
  payload?: readonly { payload?: FanRow }[];
}) {
  const row = props.payload?.[0]?.payload;
  if (!props.active || !row) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{props.label}</div>
      {(
        [
          ["90th percentile", row.p90],
          ["Median", row.p50],
          ["10th percentile", row.p10],
        ] as const
      ).map(([name, value]) => (
        <div className="chart-tooltip-row" key={name}>
          <span className="line-key" style={{ background: "var(--series-1)" }} />
          <strong>{currency(value)}</strong>
          <span className="series-name">{name}</span>
        </div>
      ))}
    </div>
  );
}

export function MonteCarloChart(props: { rows: FanRow[]; plan: Plan }) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={props.rows} margin={{ top: 32, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis
          dataKey="year"
          tick={{ fill: "var(--muted)", fontSize: 12 }}
          tickLine={false}
          axisLine={{ stroke: "var(--axis)" }}
        />
        <YAxis
          tickFormatter={(v: number) => currencyCompact(v)}
          tick={{ fill: "var(--muted)", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={64}
        />
        <Tooltip content={<FanTooltip />} cursor={{ stroke: "var(--axis)", strokeWidth: 1 }} />
        {props.plan.people.map((person, i) => (
          <ReferenceLine
            key={person.id}
            x={person.retirement.year}
            stroke="var(--axis)"
            label={{
              value: `${person.name} retires`,
              position: "top",
              dy: i % 2 === 0 ? -2 : 14,
              fill: "var(--muted)",
              fontSize: 11,
            }}
          />
        ))}
        <Area
          type="monotone"
          dataKey="outerBase"
          stackId="outer"
          stroke="none"
          fill="none"
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="outerBand"
          stackId="outer"
          stroke="none"
          fill="var(--series-1)"
          fillOpacity={0.15}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="innerBase"
          stackId="inner"
          stroke="none"
          fill="none"
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="innerBand"
          stackId="inner"
          stroke="none"
          fill="var(--series-1)"
          fillOpacity={0.28}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="p50"
          stroke="var(--series-1)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
