import { currencyCompact } from "../../lib/format";
import type { MonteCarloRun } from "../../store/planStore";
import { successTone } from "./monteCarloData";
import type { HeadlineMetrics } from "./planData";

// Zone 1 — the three numbers that answer "are we still on track" with nothing
// clicked. Probability of success sits first and widest; it used to be two
// clicks deep behind a mode toggle.

/**
 * The success rate at the precision its sample supports, and the margin that
 * says how much that is.
 *
 * A rate measured from N paths carries sampling error of roughly `margin`, so
 * printing a first decimal when the margin is half a point wide advertises
 * precision that isn't there. Below half a point the decimal is meaningful
 * and is kept.
 */
function pct(rate: number, margin: number | null): string {
  const value = rate * 100;
  const marginPts = (margin ?? 0) * 100;
  const decimals = marginPts >= 0.5 ? 0 : 1;
  // Round toward the honest side: 99.96% should not read as 100%.
  if (value >= 100 - 0.5 * 10 ** -decimals && value < 100) {
    return `${(100 - 10 ** -decimals).toFixed(decimals)}%`;
  }
  return `${value.toFixed(decimals)}%`;
}

/** The ± that follows the headline, at the same precision as the headline. */
function marginPct(margin: number): string {
  const marginPts = margin * 100;
  const value = marginPts.toFixed(marginPts >= 0.5 ? 0 : 1);
  // Only exactly one point is singular — "±0.4 pts" is right, "±1 pts" isn't.
  return `±${value} ${value === "1" ? "pt" : "pts"}`;
}

/** The live controls on the success tile. Absent in the printable report,
 * where the tile is a record rather than a control surface. */
export interface MonteCarloTileControls {
  /** The run in flight, or null. */
  inFlight: MonteCarloRun | null;
  onRun: () => void;
  onCancel: () => void;
}

export function HeadlineTiles(props: {
  metrics: HeadlineMetrics;
  realDollars: boolean;
  monteCarlo?: MonteCarloTileControls;
}) {
  const m = props.metrics;
  const tone = m.successRate !== null ? successTone(m.successRate) : null;
  const basisLabel = props.realDollars ? "in today's dollars" : "nominal";
  const inFlight = props.monteCarlo?.inFlight ?? null;
  // Greyed only while nothing is on the way: a stale figure with a run in
  // flight is "updating", not "needs attention".
  const greyed = m.successStale && inFlight === null;

  return (
    <section className="headline" aria-label="Headline">
      <div className={`tile tile-wide ${greyed ? "tile-stale" : ""}`}>
        <span className="tile-label">Probability of success</span>
        {m.successRate === null ? (
          <div className="tile-hero tile-muted">—</div>
        ) : (
          <>
            <div className="tile-hero-row">
              <span className={`tile-hero stat-${tone}`}>
                {pct(m.successRate, m.successMargin)}
              </span>
              <span className="tile-aside">
                {/* The margin is always shown, including at 100%: the number
                    is a sample, and how big a sample is the whole reason the
                    path count is a setting. */}
                {m.successMargin !== null && <>{marginPct(m.successMargin)} · </>}
                of {m.nPaths?.toLocaleString()} paths
              </span>
            </div>
            <div className="tile-bar">
              <div
                className={`tile-bar-fill stat-${tone}`}
                style={{ width: `${Math.max(0, Math.min(1, m.successRate)) * 100}%` }}
              />
            </div>
          </>
        )}
        {inFlight ? (
          // The sub-line becomes the progress line for the duration, so the
          // tile does not change height when a run starts or lands.
          <div className="tile-sub tile-run">
            <span
              className="tile-progress"
              role="progressbar"
              aria-label="Monte Carlo progress"
              aria-valuemin={0}
              aria-valuemax={inFlight.total}
              aria-valuenow={inFlight.completed}
            >
              <span
                className="tile-progress-fill"
                style={{
                  width: `${inFlight.total > 0 ? (inFlight.completed / inFlight.total) * 100 : 0}%`,
                }}
              />
            </span>
            <span className="tile-run-count">
              {inFlight.completed.toLocaleString()} of {inFlight.total.toLocaleString()}{" "}
              paths
            </span>
            {props.monteCarlo && (
              <button
                type="button"
                className="tile-button"
                onClick={props.monteCarlo.onCancel}
              >
                Cancel
              </button>
            )}
          </div>
        ) : m.successStale || (m.successRate === null && props.monteCarlo) ? (
          <div className="tile-sub tile-run">
            <span>
              {m.successStale
                ? "From before the latest change."
                : "Simulation has not run yet."}
            </span>
            {props.monteCarlo && (
              <button
                type="button"
                className="tile-button"
                onClick={props.monteCarlo.onRun}
              >
                Run
              </button>
            )}
          </div>
        ) : (
          <div className="tile-sub">
            {m.successRate === null ? (
              "Simulation has not run yet."
            ) : m.failedPaths && m.failedPaths > 0 ? (
              <>
                {m.failedPaths.toLocaleString()} paths run dry
                {m.medianFailureYear !== null && (
                  <> — half of them by {m.medianFailureYear}</>
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
        )}
      </div>

      <div className="tile">
        <span className="tile-label">Funds deplete</span>
        <div className={`tile-hero ${m.depletionYear !== null ? "stat-critical" : ""}`}>
          {m.depletionYear !== null ? m.depletionYear : "Never"}
        </div>
        <div className="tile-sub">
          {m.depletionYear !== null ? (
            "Spending exceeds what the accounts can fund."
          ) : m.planEndYear !== null ? (
            <>
              Balances hold through {m.planEndYear}, when the plan ends at age{" "}
              {m.planEndAge}.
            </>
          ) : (
            "Balances hold through the full projection."
          )}
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
            ? `Net worth divided by expenses in ${m.coverYear}, the first full year of retirement.`
            : "No full year of retirement falls inside the projection."}
        </div>
      </div>
    </section>
  );
}
