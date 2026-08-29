import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { currencyCompact } from "../../lib/format";
import { ChartTooltip } from "./ChartTooltip";
import type { CompareRow, CompareSeriesDef } from "./compareData";

export function ComparisonChart(props: {
  rows: CompareRow[];
  series: CompareSeriesDef[];
}) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={props.rows} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
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
        <Legend
          iconType="plainline"
          iconSize={16}
          wrapperStyle={{ fontSize: 13 }}
          formatter={(value: string) => (
            <span style={{ color: "var(--text-secondary)" }}>{value}</span>
          )}
        />
        {props.series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
