import { currency, currencyCompact } from "../../lib/format";
import type { YearDetail } from "./planData";

// Right-hand readout for one year of the projection. Shows every cash-flow
// field on PeriodSnapshot — income, withdrawals, expenses, taxes,
// contributions, surplus — plus per-account balances, and a note on the
// years after the first death so the drop in income reads as the survivor
// transition rather than as a glitch.

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

      <div className="inspector-block">
        {detail.flows.map((row) => (
          <div className="inspector-row" key={row.key}>
            <span className="row-chip" style={{ background: row.color }} />
            <span className="row-label">{row.label}</span>
            <span className="row-leader" />
            <span className={`row-value ${row.critical ? "row-critical" : ""}`}>
              {currency(row.value)}
            </span>
          </div>
        ))}
      </div>

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
