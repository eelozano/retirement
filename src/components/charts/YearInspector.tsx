import { currency, currencyCompact } from "../../lib/format";
import type { FlowRow, YearDetail } from "./planData";

// Right-hand readout for one year of the projection. The cash-flow fields on
// PeriodSnapshot are shown as the two sides of the identity the engine pins
// — money in against money out, each closing on its own total — with market
// growth lifted up beside net worth, the number it actually explains. Below
// that: per-account balances, a note on the years after the first death so
// the drop in income reads as the survivor transition rather than a glitch,
// and one on working years, where what's left over is really current
// spending.

// One side of the cash identity: its rows, then its total. Subset rows are
// annotations on the row above (RMDs inside withdrawals, the employer's share
// beside contributions) — indented, muted, and already excluded from the
// total by yearDetail.
function FlowGroup(props: {
  heading: string;
  rows: FlowRow[];
  totalLabel: string;
  total: number;
  totalCritical?: boolean;
  note?: string | null;
}) {
  return (
    <div className="inspector-block">
      <div className="tile-label">{props.heading}</div>
      {props.rows.map((row) => (
        <div
          className={`inspector-row ${row.subset ? "inspector-row-subset" : ""}`}
          key={row.key}
        >
          <span className="row-label">{row.label}</span>
          <span className="row-leader" />
          <span className={`row-value ${row.critical ? "row-critical" : ""}`}>
            {currency(row.value)}
          </span>
        </div>
      ))}
      <div className="inspector-total">
        <span className={props.totalCritical ? "row-critical" : ""}>
          {props.totalLabel}
        </span>
        <span className={`row-value ${props.totalCritical ? "row-critical" : ""}`}>
          {currency(props.total)}
        </span>
      </div>
      {props.note && <p className="inspector-note">{props.note}</p>}
    </div>
  );
}

export interface YearPercentiles {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export function YearInspector(props: {
  detail: YearDetail | null;
  hovering: boolean;
  /** Net-worth percentiles for this year from the Monte Carlo run, or null
   * when the percentile band is off (or there is no Monte Carlo result). */
  percentiles: YearPercentiles | null;
}) {
  if (!props.detail) return null;
  const { detail } = props;

  return (
    <aside className="inspector" aria-label="Year detail">
      <div className="inspector-head">
        <span className="tile-label">
          {props.hovering ? "Hovered year" : "Pinned year"}
        </span>
        <span className="inspector-year">{detail.year}</span>
      </div>
      <div className="inspector-ages">
        {detail.ages
          .map((a) =>
            a.status === "died"
              ? `${a.name} · died`
              : `${a.name} ${a.age}${a.status ? ` · ${a.status}` : ""}`,
          )
          .join(" · ")}
      </div>
      {detail.transition && <p className="inspector-note">{detail.transition}</p>}

      <div className="inspector-block">
        <div className="tile-label">Net worth</div>
        <div className="inspector-networth">{currency(detail.netWorth)}</div>
        {/* Growth belongs to the number above it, not to the cash equation
            below — it never passes through the household's hands. This is
            also the one row where a "+" unambiguously means net worth grew. */}
        <div className="inspector-row">
          <span
            className={`row-sign ${detail.growth.critical ? "row-critical" : "row-sign-add"}`}
          >
            {detail.growth.critical ? "−" : "+"}
          </span>
          <span className="row-label">Market growth</span>
          <span className="row-leader" />
          {/* The glyph carries the sign, so the figure is a magnitude —
              otherwise a losing year reads "− -$20,000". */}
          <span className={`row-value ${detail.growth.critical ? "row-critical" : ""}`}>
            {currency(Math.abs(detail.growth.value))}
          </span>
        </div>
      </div>

      {props.percentiles && (
        <div className="inspector-block">
          <div className="tile-label">Net worth range · this year</div>
          <div className="inspector-percentiles">
            <div className="percentile-cell">
              <span className="tile-label">p10</span>
              <span>{currencyCompact(props.percentiles.p10)}</span>
            </div>
            <div className="percentile-cell">
              <span className="tile-label">p25</span>
              <span>{currencyCompact(props.percentiles.p25)}</span>
            </div>
            <div className="percentile-cell">
              <span className="tile-label">p50</span>
              <span>{currencyCompact(props.percentiles.p50)}</span>
            </div>
            <div className="percentile-cell">
              <span className="tile-label">p75</span>
              <span>{currencyCompact(props.percentiles.p75)}</span>
            </div>
            <div className="percentile-cell">
              <span className="tile-label">p90</span>
              <span>{currencyCompact(props.percentiles.p90)}</span>
            </div>
          </div>
        </div>
      )}

      {/* The two sides of the engine's cash identity, each closing on its own
          total, so the panel adds up in front of the reader instead of asking
          to be trusted. Direction lives in the group headings — no per-row
          signs, which would contradict the subtotals. */}
      <FlowGroup
        heading="Money in"
        rows={detail.flows.filter((r) => r.group === "in")}
        totalLabel="Money in"
        total={detail.moneyIn}
      />
      <FlowGroup
        heading="Money out"
        rows={detail.flows.filter((r) => r.group === "out")}
        totalLabel={detail.leftOverLabel}
        total={detail.leftOver}
        totalCritical={detail.shortfall}
        note={detail.spendingNote}
      />

      <div className="inspector-block">
        <div className="tile-label">Balances</div>
        {detail.balances.map((row) => (
          <div className="inspector-row" key={row.key}>
            <span className="row-swatch" style={{ background: row.color }} />
            <span className="row-label">{row.label}</span>
            <span className="row-leader" />
            <span className="row-value">{currencyCompact(row.value)}</span>
          </div>
        ))}
      </div>

      <p className="inspector-hint">
        Click the chart to pin a year, or focus it and use the arrow keys. Hovering reads
        without changing the pin.
      </p>
    </aside>
  );
}
