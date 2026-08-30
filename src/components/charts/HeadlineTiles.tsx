import { currencyCompact } from "../../lib/format";
import { successTone } from "./monteCarloData";
import type { HeadlineMetrics } from "./planData";

// Zone 1 — the three numbers that answer "are we still on track" with nothing
// clicked. Probability of success sits first and widest; it used to be two
// clicks deep behind a mode toggle.

function pct(rate: number): string {
  // Round toward the honest side: 99.96% should not read as 100%.
  const value = rate * 100;
  const rounded = value >= 99.95 && value < 100 ? 99.9 : Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

export function HeadlineTiles(props: { metrics: HeadlineMetrics; realDollars: boolean }) {
  const m = props.metrics;
  const tone = m.successRate !== null ? successTone(m.successRate) : null;
  const basisLabel = props.realDollars ? "in today's dollars" : "nominal";

  return (
    <section className="headline" aria-label="Headline">
      <div className="tile tile-wide">
        <span className="tile-label">Probability of success</span>
        {m.successRate === null ? (
          <div className="tile-hero tile-muted">—</div>
        ) : (
          <>
            <div className="tile-hero-row">
              <span className={`tile-hero stat-${tone}`}>{pct(m.successRate)}</span>
              <span className="tile-aside">of {m.nPaths?.toLocaleString()} paths</span>
            </div>
            <div className="tile-bar">
              <div
                className={`tile-bar-fill stat-${tone}`}
                style={{ width: `${Math.max(0, Math.min(1, m.successRate)) * 100}%` }}
              />
            </div>
          </>
        )}
        <div className="tile-sub">
          {m.successRate === null ? (
            "Simulation has not run yet."
          ) : m.failedPaths && m.failedPaths > 0 ? (
            <>
              {m.failedPaths.toLocaleString()} paths run dry
              {m.medianZeroYear !== null && (
                <> — the median path reaches zero in {m.medianZeroYear}</>
              )}
              .
            </>
          ) : (
            <>
              {/* p10, not the worst path — MonteCarloResult carries
                  percentiles, so there is no minimum to report. */}
              The 10th-percentile path still ends above{" "}
              {m.p10AtEnd !== null ? currencyCompact(m.p10AtEnd) : "—"} {basisLabel}.
            </>
          )}
        </div>
      </div>

      <div className="tile">
        <span className="tile-label">Funds deplete</span>
        <div className={`tile-hero ${m.depletionYear !== null ? "stat-critical" : ""}`}>
          {m.depletionYear !== null ? m.depletionYear : "Never"}
        </div>
        <div className="tile-sub">
          {m.depletionYear !== null
            ? "Spending exceeds what the accounts can fund."
            : "Balances hold through the full projection."}
        </div>
      </div>

      <div className="tile">
        <span className="tile-label">Expenses covered at retirement</span>
        <div className="tile-hero-row">
          <span className="tile-hero">
            {m.coverYears !== null ? m.coverYears.toFixed(1) : "—"}
          </span>
          {m.coverYears !== null && <span className="tile-aside">years</span>}
        </div>
        <div className="tile-sub">
          {m.coverYear !== null
            ? `Net worth divided by that year's expenses, at the first retirement in ${m.coverYear}.`
            : "No retirement falls inside the projection."}
        </div>
      </div>
    </section>
  );
}
