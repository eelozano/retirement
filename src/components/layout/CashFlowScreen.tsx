import { useMemo } from "react";
import { currencyCompact } from "../../lib/format";
import { usePlanStore } from "../../store/planStore";
import { CashFlowChart } from "../charts/CashFlowChart";
import { cashFlowRows, cashFlowSummary } from "../charts/cashFlowData";

// The cash-flow destination. Nothing here needs new engine work: income,
// expenses, taxes, contributions, withdrawals, and surplus have been in every
// PeriodSnapshot since M1 with no view onto them.

export function CashFlowScreen() {
  const plan = usePlanStore((s) => s.plan);
  const projection = usePlanStore((s) => s.projection);
  const projecting = usePlanStore((s) => s.projecting);
  const realDollars = usePlanStore((s) => s.realDollars);

  const rows = useMemo(
    () => (projection ? cashFlowRows(projection, realDollars) : []),
    [projection, realDollars],
  );
  const summary = useMemo(() => cashFlowSummary(rows), [rows]);

  if (!plan || !projection) return null;

  const basisNote = realDollars ? "today's dollars · deflated" : "nominal dollars";

  return (
    <main className={`plan-screen ${projecting ? "refreshing" : ""}`}>
      <div className="plan-scroll">
        <section className="headline" aria-label="Cash flow headline">
          <div className="tile tile-wide">
            <span className="tile-label">Withdrawals overtake income</span>
            <div className="tile-hero-row">
              <span className="tile-hero">{summary.crossoverYear ?? "Never"}</span>
            </div>
            <div className="tile-sub">
              {summary.crossoverYear !== null
                ? "The first year the portfolio funds more of the household than earnings do."
                : "Earnings cover the household for the whole projection."}
            </div>
          </div>

          <div className="tile">
            <span className="tile-label">Largest withdrawal</span>
            <div className="tile-metric">{currencyCompact(summary.peakWithdrawal)}</div>
            <div className="tile-sub">
              {summary.peakWithdrawalYear !== null
                ? `In ${summary.peakWithdrawalYear}, ${basisNote}.`
                : "No withdrawals in this projection."}
            </div>
          </div>

          <div className="tile">
            <span className="tile-label">Lifetime taxes</span>
            <div className="tile-metric">{currencyCompact(summary.lifetimeTaxes)}</div>
            <div className="tile-sub">Summed across the projection, {basisNote}.</div>
          </div>
        </section>

        <section className="card" aria-label="Cash flow">
          <div className="card-head">
            <h2>Money in and out</h2>
            <span className="card-note">{basisNote}</span>
            <span className="card-spacer" />
            <span className="card-note">above the line in · below the line out</span>
          </div>
          <CashFlowChart rows={rows} plan={plan} />
        </section>
      </div>
    </main>
  );
}
