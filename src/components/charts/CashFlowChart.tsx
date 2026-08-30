import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { currency, currencyCompact } from "../../lib/format";
import type { Plan } from "../../types/generated/Plan";
import type { CashFlowRow } from "./cashFlowData";

// Diverging stack: money in above the axis, money out below it, with the
// surplus line running through. The crossover — salary giving way to
// withdrawals — is the shape this chart exists to show.

const INFLOWS = [
  { key: "income", label: "Income", color: "var(--series-2)" },
  { key: "withdrawals", label: "Withdrawals", color: "var(--series-1)" },
] as const;

const OUTFLOWS = [
  { key: "expenses", label: "Expenses", color: "var(--series-3)" },
  { key: "taxes", label: "Taxes", color: "var(--series-7)" },
  { key: "contributions", label: "Contributions", color: "var(--series-6)" },
] as const;

function CashFlowTooltip(props: {
  active?: boolean;
  label?: string | number;
  payload?: { dataKey?: string | number; value?: number; color?: string }[];
}) {
  if (!props.active || !props.payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{props.label}</div>
      {props.payload.map((entry) => (
        <div className="chart-tooltip-row" key={String(entry.dataKey)}>
          <span className="line-key" style={{ background: entry.color }} />
          <span className="series-name">
            {[...INFLOWS, ...OUTFLOWS].find((s) => s.key === entry.dataKey)?.label ??
              "Surplus"}
          </span>
          {/* Outflows are stored negative for the stack; show magnitudes. */}
          <strong>{currency(Math.abs(entry.value ?? 0))}</strong>
        </div>
      ))}
    </div>
  );
}

export function CashFlowChart(props: { rows: CashFlowRow[]; plan: Plan }) {
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
          tickFormatter={(v: number) => currencyCompact(Math.abs(v))}
          tick={{ fill: "var(--muted)", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={64}
        />
        <Tooltip
          content={<CashFlowTooltip />}
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

        {INFLOWS.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stackId="in"
            stroke={s.color}
            strokeWidth={1}
            fill={s.color}
            fillOpacity={0.85}
            isAnimationActive={false}
          />
        ))}
        {OUTFLOWS.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stackId="out"
            stroke={s.color}
            strokeWidth={1}
            fill={s.color}
            fillOpacity={0.85}
            isAnimationActive={false}
          />
        ))}

        {/* The axis itself carries meaning here: above is in, below is out. */}
        <ReferenceLine y={0} stroke="var(--text-primary)" strokeWidth={1} />

        <Line
          type="monotone"
          dataKey="surplus"
          name="Surplus"
          stroke="var(--text-primary)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
