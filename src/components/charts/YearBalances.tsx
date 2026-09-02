import { currencyCompact } from "../../lib/format";
import type { YearDetail } from "./planData";

// Per-account balances for the inspected year, laid out wide beneath the
// chart rather than stacked in the inspector column.
//
// They sit here because this is where they are read: the swatches are the
// same colors as the stacked areas directly above, so a band and its figure
// are one glance apart. In the inspector they were last in a tall column and
// fell below the fold, which is the one place a balance is no use — and the
// space under a fixed-height chart was empty anyway.

export function YearBalances(props: { detail: YearDetail | null }) {
  if (!props.detail) return null;
  const { detail } = props;

  return (
    <div className="chart-balances">
      <div className="tile-label">Balances · {detail.year}</div>
      <div className="chart-balances-grid">
        {detail.balances.map((row) => (
          <div className="inspector-row" key={row.key}>
            <span className="row-swatch" style={{ background: row.color }} />
            <span className="row-label" title={row.label}>
              {row.label}
            </span>
            <span className="row-leader" />
            <span className="row-value">{currencyCompact(row.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
