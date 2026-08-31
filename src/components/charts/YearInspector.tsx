import { currency, currencyCompact } from "../../lib/format";
import type { YearDetail } from "./planData";

// Right-hand readout for one year of the projection. Shows every cash-flow
// field on PeriodSnapshot — income, withdrawals, expenses, taxes,
// contributions, surplus — plus per-account balances, and a note on the
// years after the first death so the drop in income reads as the survivor
// transition rather than as a glitch.

export function YearInspector(props: { detail: YearDetail | null; hovering: boolean }) {
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
