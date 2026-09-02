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
import { lastToRetire } from "../../lib/currentSpending";
import { currency, currencyCompact } from "../../lib/format";
import type { Plan } from "../../types/generated/Plan";
import type { CashFlowRow } from "./cashFlowData";
import { PinnableYears } from "./PinnableYears";

// Diverging stack: money in above the axis, money out below it, with the
// surplus line running through. The crossover — salary giving way to
// withdrawals — is the shape this chart exists to show.
//
// Optionally pinnable: given a pinned year and a handler, clicking the chart
// (or stepping with the arrow keys) chooses the year the composition diagram
// below it decomposes (#67). The report renders it without either and gets
// the plain chart.

// Must match the <ComposedChart margin> and <YAxis width> below — the pin's
// pointer math and the chart have to agree on where the plotting area starts.
const MARGIN_LEFT = 8;
const MARGIN_RIGHT = 16;
const Y_AXIS_WIDTH = 64;

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
  /** First year in which nobody in the household is earning any more. */
  retiredFrom?: number | null;
}) {
  if (!props.active || !props.payload?.length) return null;
  // The dashed line means two different things either side of retirement
  // (#50), and the tooltip is the one place on this chart that knows which
  // year it is being read at, so it is where the name can be honest.
  const year = Number(props.label);
  const working =
    props.retiredFrom !== null &&
    props.retiredFrom !== undefined &&
    year < props.retiredFrom;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{props.label}</div>
      {props.payload.map((entry) => (
        <div className="chart-tooltip-row" key={String(entry.dataKey)}>
          <span className="line-key" style={{ background: entry.color }} />
          <span className="series-name">
            {[...INFLOWS, ...OUTFLOWS].find((s) => s.key === entry.dataKey)?.label ??
              (working ? "Current spending" : "Surplus")}
          </span>
          {/* Outflows are stored negative for the stack; show magnitudes. */}
          <strong>{currency(Math.abs(entry.value ?? 0))}</strong>
        </div>
      ))}
    </div>
  );
}

export function CashFlowChart(props: {
  rows: CashFlowRow[];
  plan: Plan;
  pinnedYear?: number;
  onPinYear?: (year: number) => void;
}) {
  const retiredFrom = lastToRetire(props.plan)?.retirement.year ?? null;
  const chart = (
    <ResponsiveContainer width="100%" height={360}>
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
          tickFormatter={(v: number) => currencyCompact(Math.abs(v))}
          tick={{ fill: "var(--muted)", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={Y_AXIS_WIDTH}
        />
        <Tooltip
          content={<CashFlowTooltip retiredFrom={retiredFrom} />}
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
        {props.pinnedYear !== undefined && (
          <ReferenceLine
            x={props.pinnedYear}
            stroke="var(--text-primary)"
            strokeWidth={1}
          />
        )}

        <Line
          type="monotone"
          dataKey="surplus"
          // One static legend entry for a line that is spending money on the
          // left of the chart and leftover cash on the right; the tooltip
          // names it per year.
          name="Surplus / current spending"
          stroke="var(--text-primary)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );

  if (props.pinnedYear === undefined || !props.onPinYear) return chart;
  return (
    <PinnableYears
      className="cash-flow-chart"
      years={props.rows.map((r) => r.year)}
      pinnedYear={props.pinnedYear}
      plotLeft={MARGIN_LEFT + Y_AXIS_WIDTH}
      plotRight={MARGIN_RIGHT}
      ariaLabel="Cash flow — pinned year"
      onPinYear={props.onPinYear}
    >
      {chart}
    </PinnableYears>
  );
}
