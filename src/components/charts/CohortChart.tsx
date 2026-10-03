import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { currencyCompact } from "../../lib/format";
import type { CohortStatus } from "../../types/generated/CohortStatus";
import type { CohortSummary } from "../../types/generated/CohortSummary";
import { type CohortBar, outcomePhrase } from "./backtestData";

// One bar per historical start year: what the plan ends with, in today's
// dollars, had it started that year. A start year that ran out has nothing
// to end with, so its bar is a short red stub at the baseline
// (`minPointSize`) rather than nothing at all — the failures are the bars
// that matter most and must not be the ones that disappear. A start year
// still in progress is drawn faint: its bar is where it stands at the end of
// the data, not where it ends.
//
// Clicking a bar opens that start year's ledger. The table under the chart
// does the same for keyboard and screen-reader users.

export const STATUS_COLOR: Record<CohortStatus, string> = {
  Succeeded: "var(--series-1)",
  Depleted: "var(--status-critical)",
  InProgress: "var(--muted)",
};

export function CohortChart(props: {
  bars: CohortBar[];
  cohorts: CohortSummary[];
  horizon: number;
  selectedYear: number | null;
  onSelect: (year: number) => void;
}) {
  const byYear = new Map(props.cohorts.map((c) => [c.start_year, c]));
  return (
    <div className="cohort-chart">
      <ResponsiveContainer width="100%" height={240}>
        <BarChart
          data={props.bars}
          margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
          barCategoryGap={1}
        >
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis
            dataKey="startYear"
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "var(--axis)" }}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(v: number) => currencyCompact(v)}
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <Tooltip
            cursor={{ fill: "var(--surface-3)" }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const bar = active
                ? (payload?.[0]?.payload as CohortBar | undefined)
                : undefined;
              const cohort = bar ? byYear.get(bar.startYear) : undefined;
              if (!bar || !cohort) return null;
              return (
                <div className="chart-tooltip">
                  <div className="chart-tooltip-label">Starting in {bar.startYear}</div>
                  <div>{outcomePhrase(cohort, props.horizon)}</div>
                </div>
              );
            }}
          />
          <Bar
            dataKey="value"
            minPointSize={3}
            isAnimationActive={false}
            cursor="pointer"
            onClick={(data) => {
              const year = (data as unknown as { payload?: CohortBar }).payload
                ?.startYear;
              if (year !== undefined) props.onSelect(year);
            }}
          >
            {props.bars.map((bar) => (
              <Cell
                key={bar.startYear}
                fill={STATUS_COLOR[bar.status]}
                fillOpacity={bar.status === "InProgress" ? 0.45 : 1}
                stroke={
                  bar.startYear === props.selectedYear ? "var(--text-primary)" : "none"
                }
                strokeWidth={bar.startYear === props.selectedYear ? 1.5 : 0}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
