import {
  currency,
  currencyCompact,
  successMarginPercent,
  successPercent,
  successPointsDelta,
} from "../../lib/format";
import type { ComparisonSummaryRow } from "./compareData";
import { successTone } from "./monteCarloData";

/** Which side of the table a number came from. Without the grouping,
 * "Net worth at plan end" beside "p10 at end" invites the reading that both
 * describe the same run — one is a single deterministic path, the other the
 * 10th percentile of thousands. */
function GroupHeaders(props: { monteCarloPending: boolean }) {
  return (
    <tr>
      <th rowSpan={2} scope="col">
        Scenario
      </th>
      <th colSpan={4} scope="colgroup" className="comparison-group">
        Deterministic projection
      </th>
      <th colSpan={3} scope="colgroup" className="comparison-group">
        Monte Carlo{props.monteCarloPending && <span className="comparison-pending" />}
      </th>
    </tr>
  );
}

export function ComparisonTable(props: {
  rows: ComparisonSummaryRow[];
  /** True while the Monte Carlo batch is still in flight — the deterministic
   * columns render first and these three fill in behind them. */
  monteCarloPending?: boolean;
}) {
  const pending = props.monteCarloPending ?? false;
  // A cell with nothing in it yet reads differently from one whose run
  // failed, so the placeholder differs: a spinner while work is outstanding,
  // an em dash once it is not.
  const blank = pending ? <span className="comparison-pending" /> : "—";

  return (
    <div className="table-scroll">
      <table className="comparison-table">
        <thead>
          <GroupHeaders monteCarloPending={pending} />
          <tr>
            <th scope="col">Net worth at plan end</th>
            <th scope="col">Vs. base</th>
            <th scope="col">Funds depleted</th>
            <th scope="col">Lifetime taxes</th>
            <th scope="col">Success</th>
            <th scope="col">Vs. base</th>
            <th scope="col">p10 at end</th>
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
              <td className="comparison-success">
                {row.successRate === null ? (
                  blank
                ) : (
                  <>
                    <span className={`stat-${successTone(row.successRate)}`}>
                      {successPercent(row.successRate, row.successMargin)}
                    </span>
                    {/* The margin rides along for the same reason it does on
                        the headline tile: the rate is a sample, and how big a
                        sample is a setting the user controls. */}
                    {row.successMargin !== null && (
                      <span className="comparison-margin">
                        {successMarginPercent(row.successMargin)}
                      </span>
                    )}
                  </>
                )}
              </td>
              <td
                className={
                  row.successDeltaVsBase === null
                    ? ""
                    : row.successDeltaVsBase > 0
                      ? "delta-positive"
                      : row.successDeltaVsBase < 0
                        ? "delta-negative"
                        : ""
                }
              >
                {row.isBase
                  ? "—"
                  : row.successDeltaVsBase === null
                    ? blank
                    : successPointsDelta(row.successDeltaVsBase, row.successMargin)}
              </td>
              <td>{row.p10AtEnd === null ? blank : currencyCompact(row.p10AtEnd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
