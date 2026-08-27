import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Plan } from "../../types/generated/Plan";
import { currencyCompact } from "../../lib/format";
import type { ChartRow } from "./chartData";
import { ChartTooltip } from "./ChartTooltip";

// Single series: no legend box (the card title names it). Retirement dates
// ride as labeled reference lines; a depletion year, if any, in the reserved
// critical status color.

export function NetWorthChart(props: {
  rows: ChartRow[];
  plan: Plan;
  depletionYear: number | null;
}) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={props.rows} margin={{ top: 32, right: 16, bottom: 0, left: 8 }}>
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
        <Tooltip
          content={<ChartTooltip />}
          cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
        />
        {props.plan.people.map((person, i) => (
          <ReferenceLine
            key={person.id}
            x={person.retirement.year}
            stroke="var(--axis)"
            label={{
              value: `${person.name} retires`,
              position: "top",
              // Stagger alternating labels so close retirement dates never collide.
              dy: i % 2 === 0 ? -2 : 14,
              fill: "var(--muted)",
              fontSize: 11,
            }}
          />
        ))}
        {props.depletionYear !== null && (
          <ReferenceLine
            x={props.depletionYear}
            stroke="var(--status-critical)"
            label={{
              value: "⚠ Funds depleted",
              position: "top",
              fill: "var(--status-critical)",
              fontSize: 11,
            }}
          />
        )}
        <Line
          type="monotone"
          dataKey="net_worth"
          name="Net worth"
          stroke="var(--series-1)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
