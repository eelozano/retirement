import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { currency, currencyCompact } from "../../lib/format";
import type { Plan } from "../../types/generated/Plan";
import type { GrowthRow } from "./growthData";

// Single stack, principal below growth, summing to the same net-worth line
// as the Plan screen — the shape that answers "is my money growing" rather
// than re-expressing the return rate in dollars.

const SERIES = [
  { key: "principal", label: "Net contributions", color: "var(--series-1)" },
  { key: "growth", label: "Market growth", color: "var(--series-8)" },
] as const;

function GrowthTooltip(props: {
  active?: boolean;
  label?: string | number;
  payload?: { dataKey?: string | number; value?: number }[];
}) {
  if (!props.active || !props.payload?.length) return null;
  const byKey = new Map(props.payload.map((p) => [p.dataKey, p.value ?? 0]));
  const netWorth = (byKey.get("principal") ?? 0) + (byKey.get("growth") ?? 0);
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{props.label}</div>
      {SERIES.map((s) => (
        <div className="chart-tooltip-row" key={s.key}>
          <span className="line-key" style={{ background: s.color }} />
          <span className="series-name">{s.label}</span>
          <strong>{currency(byKey.get(s.key) ?? 0)}</strong>
        </div>
      ))}
      <div className="chart-tooltip-row">
        <span className="line-key" style={{ background: "var(--text-primary)" }} />
        <span className="series-name">Net worth</span>
        <strong>{currency(netWorth)}</strong>
      </div>
    </div>
  );
}

export function GrowthChart(props: { rows: GrowthRow[]; plan: Plan }) {
  return (
    <ResponsiveContainer width="100%" height={360}>
      <ComposedChart
        data={props.rows}
        margin={{ top: 28, right: 16, bottom: 0, left: 8 }}
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
          width={64}
        />
        <Tooltip
          content={<GrowthTooltip />}
          cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
        />
        <Legend
          iconType="square"
          iconSize={10}
          wrapperStyle={{ fontSize: 11.5 }}
          formatter={(value: string) => (
            <span style={{ color: "var(--text-secondary)" }}>{value}</span>
          )}
        />

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

        {SERIES.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stackId="growth"
            stroke={s.color}
            strokeWidth={1}
            fill={s.color}
            fillOpacity={0.85}
            isAnimationActive={false}
          />
        ))}

        <ReferenceLine y={0} stroke="var(--text-primary)" strokeWidth={1} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
