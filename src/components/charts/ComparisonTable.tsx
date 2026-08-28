import { currency, currencyCompact } from "../../lib/format";
import type { ComparisonSummaryRow } from "./compareData";

export function ComparisonTable(props: { rows: ComparisonSummaryRow[] }) {
  return (
    <div className="table-scroll">
      <table className="comparison-table">
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Net worth at plan end</th>
            <th>Vs. base</th>
            <th>Funds depleted</th>
            <th>Lifetime taxes</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.id} className={row.isBase ? "comparison-base-row" : ""}>
              <td>
                {row.name}
                {row.isBase && <span className="scenario-badge"> Base</span>}
              </td>
              <td>{currencyCompact(row.finalNetWorth)}</td>
              <td
                className={
                  row.deltaVsBase > 0
                    ? "delta-positive"
                    : row.deltaVsBase < 0
                      ? "delta-negative"
                      : ""
                }
              >
                {row.isBase
                  ? "—"
                  : `${row.deltaVsBase >= 0 ? "+" : ""}${currencyCompact(row.deltaVsBase)}`}
              </td>
              <td className={row.depletionYear !== null ? "delta-negative" : ""}>
                {row.depletionYear !== null ? `⚠ ${row.depletionYear}` : "Never"}
              </td>
              <td>{currency(row.lifetimeTaxes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
