import { useMemo, useState } from "react";
import { currency, currencyCompact } from "../../lib/format";
import { usePlanStore } from "../../store/planStore";
import { CashFlowChart } from "../charts/CashFlowChart";
import { CashFlowSankey } from "../charts/CashFlowSankey";
import { cashFlowRows, cashFlowSummary } from "../charts/cashFlowData";
import { yearComposition } from "../charts/cashFlowSankeyData";
import { seriesDefs } from "../charts/chartData";
import { CURRENT_SPENDING_NOTE, defaultPinYear } from "../charts/planData";

// The cash-flow destination: the whole projection as a diverging stack, and
// one year of it decomposed by stream and account (#67). The stack answers
// "how much"; the composition under it answers "which" — and it follows the
// year pinned on the stack, so the two are read together.

export function CashFlowScreen() {
  const plan = usePlanStore((s) => s.plan);
  const projection = usePlanStore((s) => s.projection);
  const projecting = usePlanStore((s) => s.projecting);
  const realDollars = usePlanStore((s) => s.realDollars);

  const [pinnedYear, setPinnedYear] = useState<number | null>(null);

  const rows = useMemo(
    () => (projection ? cashFlowRows(projection, realDollars) : []),
    [projection, realDollars],
  );
  const summary = useMemo(() => cashFlowSummary(rows), [rows]);
  const series = useMemo(() => (plan ? seriesDefs(plan) : []), [plan]);

  if (!plan || !projection) return null;

  const basisNote = realDollars ? "today's dollars · deflated" : "nominal dollars";
  // Pinned from the stack, not hovered: a diagram that re-laid itself out
  // under the pointer would be unreadable.
  const year = pinnedYear ?? defaultPinYear(plan, projection);
  const composition = yearComposition(plan, projection, year, series, realDollars);

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
          <CashFlowChart
            rows={rows}
            plan={plan}
            pinnedYear={year}
            onPinYear={setPinnedYear}
          />
        </section>

        <section className="card" aria-label="Cash flow composition">
          <div className="card-head">
            <h2>Where the money went · {year}</h2>
            <span className="card-note">{basisNote}</span>
            <span className="card-spacer" />
            <span className="card-note">
              click the chart above, or ← → with it focused
            </span>
          </div>
          {!composition || composition.empty ? (
            <p className="composition-empty">
              No money moved through the household in {year}.
            </p>
          ) : (
            <>
              <CashFlowSankey composition={composition} />
              <ul className="composition-notes">
                {composition.shortfall > 0 && (
                  <li className="row-critical">
                    {currency(composition.shortfall)} of this year's outflows had nothing
                    to fund them — the portfolio is depleted.
                  </li>
                )}
                {composition.requiredDistributions > 0 && (
                  <li>
                    {currency(composition.requiredDistributions)} of the withdrawals were
                    required minimum distributions, not the household's choice.
                  </li>
                )}
                {composition.employerMatch > 0 && (
                  <li>
                    An employer match of {currency(composition.employerMatch)} went
                    straight into accounts. It never passed through household cash, so it
                    is not a flow here.
                  </li>
                )}
                {composition.working && <li>{CURRENT_SPENDING_NOTE}</li>}
              </ul>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
