import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { currencyCompact } from "../../lib/format";
import { ChartTooltip } from "./ChartTooltip";
import type { CompareRow, CompareSeriesDef } from "./compareData";

/** The scenario lines only. The band is drawn as a transparent riser plus a
 * height, so left alone it contributes two rows to the tooltip: one printing
 * the raw `bandBase` key, and one printing p90 minus p10 as though it were a
 * balance. It is a shape to be seen, not a number to be read off — and
 * recharts 3 ignores `tooltipType`, so the rows are dropped here. */
function ComparisonTooltip(props: {
  active?: boolean;
  label?: string | number;
  payload?: readonly { dataKey?: string | number; name?: string | number }[];
}) {
  return (
    <ChartTooltip
      active={props.active}
      label={props.label}
      payload={props.payload?.filter(
        (row) => row.dataKey !== "bandBase" && row.dataKey !== "bandHeight",
      )}
    />
  );
}

export function ComparisonChart(props: {
  rows: CompareRow[];
  series: CompareSeriesDef[];
  /** Draw one scenario's p10–p90 band behind the lines. Requires rows from
   * `mergeActiveBand`; ignored otherwise. */
  showBand?: boolean;
  /** Whose band it is. The comparison view shades the base scenario; the
   * What-if sandbox shades the draft, which is the one being weighed. A band
   * labelled with the wrong scenario is worse than no band. */
  bandLabel?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      {/* Composed rather than a plain LineChart so the band can be an Area
          under the same axes as the scenario lines. */}
      <ComposedChart data={props.rows} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
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
          content={<ComparisonTooltip />}
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
        {/* A transparent riser to p10, then the band's height — the same
            stacked-pair trick as the projection chart's fan, and drawn before
            the lines so every scenario stays legible on top of it. */}
        {props.showBand && (
          <>
            <Area
              dataKey="bandBase"
              stackId="compare-band"
              stroke="none"
              fill="none"
              isAnimationActive={false}
              activeDot={false}
              legendType="none"
            />
            <Area
              dataKey="bandHeight"
              name={props.bandLabel ?? "Base: 10th–90th percentile"}
              stackId="compare-band"
              stroke="none"
              fill="var(--band)"
              isAnimationActive={false}
              activeDot={false}
            />
          </>
        )}
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
      </ComposedChart>
    </ResponsiveContainer>
  );
}
