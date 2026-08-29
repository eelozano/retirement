import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { currencyCompact } from "../../lib/format";
import { ChartTooltip } from "./ChartTooltip";
import type { ChartRow, SeriesDef } from "./chartData";

export function BalancesChart(props: { rows: ChartRow[]; series: SeriesDef[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={props.rows} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
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
          iconType="square"
          iconSize={10}
          wrapperStyle={{ fontSize: 13 }}
          formatter={(value: string) => (
            // Identity comes from the swatch; text stays in ink tokens.
            <span style={{ color: "var(--text-secondary)" }}>{value}</span>
          )}
        />
        {props.series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stackId="balances"
            stroke={s.color}
            strokeWidth={1.5}
            fill={s.color}
            fillOpacity={0.35}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
