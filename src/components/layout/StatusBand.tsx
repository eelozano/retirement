import type { HeadlineMetrics } from "../charts/planData";

// Zone 0 — one sentence, always rendered.
//
// Always present, in both tones, so nothing on the screen shifts position
// when a plan starts or stops depleting. The old UI mounted a warning banner
// only on failure, which moved every chart below it.

export function StatusBand(props: { metrics: HeadlineMetrics; warningCount: number }) {
  const m = props.metrics;
  const depleting = m.depletionYear !== null;

  return (
    <div
      className={`status-band ${depleting ? "status-band-critical" : "status-band-good"}`}
      // Not role="alert": this is always on screen, so it should be polite
      // rather than interrupting on every re-projection.
      role="status"
    >
      <span className="status-dot" />
      {depleting ? (
        <>
          <strong>Plan runs out of money in {m.depletionYear}.</strong>
          <span>
            {m.successRate !== null && m.failedPaths !== null && m.nPaths !== null ? (
              <>
                {m.failedPaths.toLocaleString()} of {m.nPaths.toLocaleString()} simulated
                paths also run dry.
              </>
            ) : (
              "Spending exceeds what the accounts can fund."
            )}
          </span>
        </>
      ) : (
        <>
          <strong>Plan is working.</strong>
          <span>
            {m.successRate !== null && m.nPaths !== null ? (
              <>
                Funds never deplete in the projection, and{" "}
                {Math.round(m.successRate * m.nPaths).toLocaleString()} of{" "}
                {m.nPaths.toLocaleString()} simulated paths stay solvent.
              </>
            ) : (
              "Funds never deplete across the projection."
            )}
          </span>
        </>
      )}
      <span className="status-spacer" />
      <span className="status-warnings">
        {props.warningCount === 0
          ? "no warnings"
          : `${props.warningCount} warning${props.warningCount === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}
