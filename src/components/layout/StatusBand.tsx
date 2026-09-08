import { yearMonth } from "../../lib/format";
import { monthsAgoLabel, monthsSince, stalenessTone } from "../../lib/staleness";
import type { ReadableWarning } from "../../lib/warnings";
import type { YearMonth } from "../../types/generated/YearMonth";
import type { HeadlineMetrics } from "../charts/planData";

// Zone 0 — one sentence, always rendered.
//
// Always present, in both tones, so nothing on the screen shifts position
// when a plan starts or stops depleting. The old UI mounted a warning banner
// only on failure, which moved every chart below it.

export function StatusBand(props: {
  metrics: HeadlineMetrics;
  warnings: ReadableWarning[];
  /** The household's as-of date — the month its balances were last
   * observed, and therefore the month the projection starts (#106). */
  asOf: YearMonth;
  /** Where "Update balances" sends the user: the Refresh destination, where
   * every balance is re-read in one sitting and the projection's start moves
   * with them (#111). */
  onOpenRefresh: () => void;
  /** The wall clock the "N months ago" count is measured against. Defaults
   * to the real time; a test passes a fixed instant instead of mocking
   * `Date` globally. */
  now?: Date;
}) {
  const m = props.metrics;
  const count = props.warnings.length;
  const depleting = m.depletionYear !== null;
  // A stale sample is still worth stating — it is the best figure there is —
  // but never as if it described the plan on screen.
  const staleNote = m.successStale ? " (from before the latest change)" : "";

  const monthsAgo = monthsSince(props.asOf, props.now ?? new Date());
  const tone = stalenessTone(monthsAgo);

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
                paths also run dry{staleNote}.
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
                {/* Derived from failedPaths, which is the engine's exact
                    count, so the two halves of "X of Y" always add up. */}
                {(m.nPaths - (m.failedPaths ?? 0)).toLocaleString()} of{" "}
                {m.nPaths.toLocaleString()} simulated paths stay solvent{staleNote}.
              </>
            ) : (
              "Funds never deplete across the projection."
            )}
          </span>
        </>
      )}
      <span className={`status-asof status-asof-${tone}`}>
        Balances as of {yearMonth(props.asOf)} · {monthsAgoLabel(monthsAgo)}
        {tone === "stale" && (
          <>
            {" — "}
            <button
              type="button"
              className="status-asof-link"
              onClick={props.onOpenRefresh}
            >
              Update balances to bring the projection up to date
            </button>
          </>
        )}
      </span>
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
