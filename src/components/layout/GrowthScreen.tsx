import { useMemo } from "react";
import { currencyCompact } from "../../lib/format";
import { usePlanStore } from "../../store/planStore";
import { GrowthChart } from "../charts/GrowthChart";
import { growthRows, growthSummary } from "../charts/growthData";

// The growth destination (#61): net worth's slope alone can't distinguish
// still-contributing from compounding from withdrawals outpacing spending.
// `PeriodSnapshot.growth` makes that legible as its own series.

export function GrowthScreen() {
  const plan = usePlanStore((s) => s.plan);
  const projection = usePlanStore((s) => s.projection);
  const projecting = usePlanStore((s) => s.projecting);
  const realDollars = usePlanStore((s) => s.realDollars);

  const rows = useMemo(
    () => (projection ? growthRows(projection, realDollars) : []),
    [projection, realDollars],
  );
  const summary = useMemo(() => growthSummary(rows), [rows]);

  if (!plan || !projection) return null;

  const basisNote = realDollars ? "today's dollars · deflated" : "nominal dollars";

  return (
    <main className={`plan-screen ${projecting ? "refreshing" : ""}`}>
      <div className="plan-scroll">
        <section className="headline" aria-label="Growth headline">
          <div className="tile tile-wide">
            <span className="tile-label">Market growth overtakes what you put in</span>
            <div className="tile-hero-row">
              <span className="tile-hero">{summary.crossoverYear ?? "Never"}</span>
            </div>
            <div className="tile-sub">
              {summary.crossoverYear !== null
                ? "The first year compounding, not contributions, is the larger share of net worth."
                : "Net contributions stay the larger share for the whole projection."}
            </div>
          </div>

          <div className="tile">
            <span className="tile-label">Growth at plan end</span>
            <div className="tile-metric">{currencyCompact(summary.totalGrowth)}</div>
            <div className="tile-sub">Cumulative, {basisNote}.</div>
          </div>

          <div className="tile">
            <span className="tile-label">Share of net worth</span>
            <div className="tile-metric">
              {summary.growthShare !== null
                ? `${Math.round(summary.growthShare * 100)}%`
                : "—"}
            </div>
            <div className="tile-sub">Grown rather than contributed, at plan end.</div>
          </div>
        </section>

        <section className="card" aria-label="Growth">
          <div className="card-head">
            <h2>Contributions vs. growth</h2>
            <span className="card-note">{basisNote}</span>
            <span className="card-spacer" />
            <span className="card-note">stacked to net worth</span>
          </div>
          <GrowthChart rows={rows} plan={plan} />
        </section>
      </div>
    </main>
  );
}
