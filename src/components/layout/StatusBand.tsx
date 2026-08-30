import type { ReadableWarning } from "../../lib/warnings";
import type { HeadlineMetrics } from "../charts/planData";

// Zone 0 — one sentence, always rendered.
//
// Always present, in both tones, so nothing on the screen shifts position
// when a plan starts or stops depleting. The old UI mounted a warning banner
// only on failure, which moved every chart below it.

export function StatusBand(props: {
  metrics: HeadlineMetrics;
  warnings: ReadableWarning[];
}) {
  const m = props.metrics;
  const count = props.warnings.length;
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
      {/* A count on its own was the whole problem: a plan could run on
          materially different contributions than the ones entered and say
          only "2 warnings". A native <details> disclosure keeps the band one
          line tall, opens on click or Enter, and needs no outside-click
          handling. */}
      {count === 0 ? (
        <span className="status-warnings">no warnings</span>
      ) : (
        <details className="status-warnings-disclosure">
          <summary className="status-warnings">
            {count} warning{count === 1 ? "" : "s"}
          </summary>
          <ul className="warning-list">
            {props.warnings.map((w) => (
              <li key={w.key}>
                <strong>{w.title}</strong>
                <span>{w.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
