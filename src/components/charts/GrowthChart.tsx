import { useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { currency, currencyCompact } from "../../lib/format";
import type { Plan } from "../../types/generated/Plan";
import type { GrowthRow } from "./growthData";

// Two panels, one shared year axis: what went in and what grew *this* year as
// paired bars above, the running totals of both as lines below.
//
// Not one chart. A year's growth and a lifetime of growth are two orders of
// magnitude apart, so a shared scale flattens the bars to a hairline — and a
// second y-axis would make the point where the two total lines cross an
// artifact of the scale rather than a fact about the plan. Two panels keep one
// honest scale each and still read down the same year.
//
// Net worth rides the lower panel as a thin neutral line. It is not one of the
// four figures the chart is about; it is there so the gap that opens between
// it and the totals — the money withdrawn and spent — is visible without a
// fifth series.

// Both panels must agree on where the plotting area starts, or the years stop
// lining up between them.
const MARGIN_LEFT = 8;
const MARGIN_RIGHT = 16;
const Y_AXIS_WIDTH = 64;

const ADDED = "var(--series-1)";
const GROWTH = "var(--series-3)";
const NET_WORTH = "var(--text-primary)";

const ROWS = [
  { key: "added", label: "Put in this year", color: ADDED },
  { key: "growth", label: "Grew this year", color: GROWTH },
  { key: "totalAdded", label: "Total put in", color: ADDED },
  { key: "totalGrowth", label: "Total growth", color: GROWTH },
] as const;

function GrowthTooltip(props: {
  active?: boolean;
  label?: string | number;
  payload?: { payload?: GrowthRow }[];
  /**
   * Whether this panel is the one under the pointer. `syncId` shares the
   * hovered year between the two charts, which is the point — but it shares
   * the tooltip with it, so without this both panels pop the same card.
   */
  hovered?: boolean;
}) {
  const row = props.payload?.[0]?.payload;
  if (!props.active || !props.hovered || !row) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{props.label}</div>
      {ROWS.map((s) => (
        <div className="chart-tooltip-row" key={s.key}>
          <span className="line-key" style={{ background: s.color }} />
          <span className="series-name">{s.label}</span>
          <strong>{currency(row[s.key])}</strong>
        </div>
      ))}
      <div className="chart-tooltip-row chart-tooltip-aside">
        <span className="line-key" style={{ background: NET_WORTH, opacity: 0.35 }} />
        <span className="series-name">Net worth</span>
        <strong>{currency(row.netWorth)}</strong>
      </div>
    </div>
  );
}

/** Dashed year markers, drawn on both panels so a year reads straight down. */
function retirementLines(plan: Plan, labelled: boolean) {
  return plan.people.map((person, i) => (
    <ReferenceLine
      key={person.id}
      x={person.retirement.year}
      stroke="var(--axis)"
      strokeDasharray="3 3"
      label={
        labelled
          ? {
              value: `${person.name} retires`,
              position: "top",
              dy: i % 2 === 0 ? -2 : 12,
              fill: "var(--muted)",
              fontSize: 10.5,
            }
          : undefined
      }
    />
  ));
}

export function GrowthChart(props: { rows: GrowthRow[]; plan: Plan }) {
  const [hovered, setHovered] = useState<"years" | "totals" | null>(null);
  const axis = {
    tick: { fill: "var(--muted)", fontSize: 11 },
    tickLine: false,
  } as const;

  return (
    <div className="growth-panels">
      <div className="chart-legend">
        <span>
          <span className="legend-key" style={{ background: ADDED }} />
          Money you put in
        </span>
        <span>
          <span className="legend-key" style={{ background: GROWTH }} />
          Market growth
        </span>
        <span>
          <span className="legend-rule" />
          Net worth
        </span>
      </div>

      <span className="chart-panel-label">Each year</span>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer tracking only, the chart carries its own semantics */}
      <div onMouseEnter={() => setHovered("years")} onMouseLeave={() => setHovered(null)}>
        <ResponsiveContainer width="100%" height={168}>
          <ComposedChart
            data={props.rows}
            syncId="growth"
            barGap={2}
            barCategoryGap="15%"
            margin={{ top: 28, right: MARGIN_RIGHT, bottom: 0, left: MARGIN_LEFT }}
          >
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="year" hide />
            <YAxis
              tickFormatter={(v: number) => currencyCompact(v)}
              axisLine={false}
              width={Y_AXIS_WIDTH}
              {...axis}
            />
            <Tooltip
              content={<GrowthTooltip hovered={hovered === "years"} />}
              cursor={{ fill: "var(--surface-3)", opacity: 0.6 }}
            />
            {retirementLines(props.plan, true)}
            <Bar dataKey="added" name="Put in" fill={ADDED} isAnimationActive={false} />
            <Bar dataKey="growth" name="Grew" fill={GROWTH} isAnimationActive={false} />
            <ReferenceLine y={0} stroke="var(--text-primary)" strokeWidth={1} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <span className="chart-panel-label">Running total, from your starting balance</span>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer tracking only, the chart carries its own semantics */}
      <div
        onMouseEnter={() => setHovered("totals")}
        onMouseLeave={() => setHovered(null)}
      >
        <ResponsiveContainer width="100%" height={210}>
          <ComposedChart
            data={props.rows}
            syncId="growth"
            margin={{ top: 12, right: MARGIN_RIGHT, bottom: 0, left: MARGIN_LEFT }}
          >
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="year" axisLine={{ stroke: "var(--axis)" }} {...axis} />
            <YAxis
              tickFormatter={(v: number) => currencyCompact(v)}
              axisLine={false}
              width={Y_AXIS_WIDTH}
              {...axis}
            />
            <Tooltip
              content={<GrowthTooltip hovered={hovered === "totals"} />}
              cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
            />
            {retirementLines(props.plan, false)}
            <Line
              type="monotone"
              dataKey="netWorth"
              name="Net worth"
              stroke={NET_WORTH}
              strokeOpacity={0.35}
              strokeWidth={1.25}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="totalAdded"
              name="Total put in"
              stroke={ADDED}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="totalGrowth"
              name="Total growth"
              stroke={GROWTH}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <ReferenceLine y={0} stroke="var(--text-primary)" strokeWidth={1} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
