import { useMemo, useState } from "react";
import { useBacktest, useCohort } from "../../lib/backtest";
import { currencyCompact, ratePercent } from "../../lib/format";
import { stockBondMix } from "../../lib/returns";
import { usePlanStore } from "../../store/planStore";
import type { CohortSummary } from "../../types/generated/CohortSummary";
import {
  cohortBars,
  extremes,
  forecastGap,
  historyHeadline,
  NOTABLE_ERAS,
  outcomePhrase,
  STATUS_LABEL,
  yearsLasted,
} from "../charts/backtestData";
import { CohortChart, STATUS_COLOR } from "../charts/CohortChart";
import { CohortLedger } from "./CohortLedger";

// The History destination (#178): the plan replayed against every start
// year since 1871, with that era's returns *and* that era's inflation.
//
// One number leads, as on the Plan screen: how often the plan lasted. Its
// rule is the one decided in #178 — a recent start year that has already run
// out counts as a failure, and one still going is shown as a count but not
// in the percentage, because its outcome is not known yet.
//
// The second card exists because this number and the Monte Carlo one will
// often disagree by tens of points, and a reader with both in front of them
// deserves to know which question each answers before deciding which to
// believe. Then the bars, one per start year, and the ledger for whichever
// start year is open — the worst one, until the reader picks another.

function StartYearButton(props: {
  cohort: CohortSummary;
  selected: boolean;
  onSelect: (year: number) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      className={`era-chip ${props.selected ? "era-chip-selected" : ""}`}
      aria-pressed={props.selected}
      onClick={() => props.onSelect(props.cohort.start_year)}
    >
      <span
        className="era-dot"
        style={{ background: STATUS_COLOR[props.cohort.status] }}
        aria-hidden="true"
      />
      {props.label ?? props.cohort.start_year}
      <span className="visually-hidden"> — {STATUS_LABEL[props.cohort.status]}</span>
    </button>
  );
}

export function HistoryScreen() {
  const plan = usePlanStore((s) => s.plan);
  const projection = usePlanStore((s) => s.projection);
  const presets = usePlanStore((s) => s.presets);
  const monteCarlo = usePlanStore((s) => s.monteCarlo);
  const monteCarloStale = usePlanStore((s) => s.monteCarloStale);
  const realDollars = usePlanStore((s) => s.realDollars);

  const backtest = useBacktest(plan, projection);
  const result = backtest.data;
  const [picked, setPicked] = useState<number | null>(null);

  const ends = useMemo(() => (result ? extremes(result) : null), [result]);
  const selectedYear = picked ?? ends?.worst.start_year ?? null;
  const cohort = useCohort(plan, projection, selectedYear);
  const bars = useMemo(() => (result ? cohortBars(result) : []), [result]);

  if (!plan || !projection) return null;

  if (!result) {
    return (
      <main className="plan-screen">
        <div className="plan-scroll history-scroll">
          <section className="card">
            <p className={backtest.error ? "banner critical" : "empty-state"}>
              {backtest.error ?? "Replaying your plan against history…"}
            </p>
          </section>
        </div>
      </main>
    );
  }

  const headline = historyHeadline(result);
  const gap = forecastGap(plan, result);
  const byYear = new Map(result.cohorts.map((c) => [c.start_year, c]));
  const step = (delta: number) => {
    if (selectedYear === null) return null;
    const year = selectedYear + delta;
    return byYear.has(year) ? () => setPicked(year) : null;
  };
  const mcRate = monteCarlo && !monteCarloStale ? monteCarlo.success_rate : null;
  const detail =
    cohort.data && cohort.data.start_year === selectedYear ? cohort.data : null;

  return (
    <main className={`plan-screen ${backtest.loading ? "refreshing" : ""}`}>
      <div className="plan-scroll history-scroll">
        <section className="headline headline-four" aria-label="History headline">
          <div className="tile tile-wide">
            <span className="tile-label">Lasted through history</span>
            <div className="tile-hero-row">
              <span className="tile-hero">
                {headline.rate === null ? "—" : `${Math.round(headline.rate * 100)}%`}
              </span>
              <span className="tile-aside">
                {headline.failed} of {headline.decided} start years ran out
              </span>
            </div>
            <div className="tile-sub">
              Every start year {headline.firstYear}–{headline.lastYear}.
              {headline.inProgress > 0 &&
                ` ${headline.inProgress} recent ones are still going and aren't counted yet: history doesn't have their last ${headline.horizon > 1 ? "years" : "year"}.`}
            </div>
          </div>
          {ends &&
            (
              [
                ["Worst start year", ends.worst],
                ["Median", ends.median],
                ["Best", ends.best],
              ] as const
            ).map(([label, c]) => (
              <button
                type="button"
                className="tile tile-button-tile"
                key={label}
                onClick={() => setPicked(c.start_year)}
              >
                <span className="tile-label">{label}</span>
                <div className="tile-metric">{c.start_year}</div>
                <div className="tile-sub">{outcomePhrase(c, headline.horizon)}</div>
              </button>
            ))}
        </section>

        <section
          className="card history-vs-forecast"
          aria-label="History and your forecast"
        >
          <div className="card-head">
            <h2>Why this differs from your Monte Carlo number</h2>
          </div>
          <div className="history-grid">
            <div className="history-finding">
              <div className="tile-label">Two questions</div>
              <p className="why-fail-sentence">
                <strong>
                  History:{" "}
                  {headline.rate === null ? "—" : `${Math.round(headline.rate * 100)}%`}
                </strong>{" "}
                asks whether your plan would have survived the years that actually
                happened, in the order they came.{" "}
                <strong>
                  Monte Carlo: {mcRate === null ? "—" : `${Math.round(mcRate * 100)}%`}
                </strong>{" "}
                asks whether it survives the returns you typed in, with every year drawn
                at random.
              </p>
            </div>
            {gap && (
              <div className="history-finding">
                <div className="tile-label">What history paid</div>
                <p className="why-fail-sentence">
                  Over {headline.firstYear}–{headline.lastYear}, the {gap.strategyLabel}{" "}
                  mix
                  {presets &&
                    ` (${stockBondMix(presets.strategy_stock_share[gap.strategy])})`}{" "}
                  earned <strong>{ratePercent(gap.historicalReal)}</strong> a year after
                  inflation. Your plan assumes{" "}
                  <strong>{ratePercent(gap.typedReal)}</strong>.
                  {gap.historicalReal > gap.typedReal + 0.005
                    ? " History was the more generous of the two, which is most of the gap: your typed returns are a forecast, and a cautious one."
                    : gap.historicalReal < gap.typedReal - 0.005
                      ? " Your forecast is more generous than history was, so here history is the stricter test."
                      : " The two are close, so what separates the rates is mostly the order bad years came in."}
                </p>
              </div>
            )}
            <div className="history-finding">
              <div className="tile-label">What history ignores</div>
              <p className="why-fail-sentence">
                This replay doesn't use your typed returns or volatilities. Each strategy
                earns its stock/bond mix of that year's S&amp;P and 10-year Treasury
                returns, rebalanced yearly, and every year brings its own inflation.
                Fixed-rate and savings accounts keep the rate you set. Today's tax law
                applies in every era.
              </p>
            </div>
          </div>
        </section>

        <section className="card" aria-label="Every start year">
          <div className="card-head">
            <h2>Every start year</h2>
            <span className="card-note">
              What your plan ends with in today's dollars, had it started that year
            </span>
          </div>
          <div className="chart-legend">
            {(["Succeeded", "Depleted", "InProgress"] as const).map((status) => (
              <span className="legend-item" key={status}>
                <span
                  className="row-swatch"
                  style={{
                    background: STATUS_COLOR[status],
                    opacity: status === "InProgress" ? 0.45 : 1,
                  }}
                />
                {status === "InProgress"
                  ? "Still going (balance when the data ends)"
                  : STATUS_LABEL[status]}
              </span>
            ))}
          </div>
          <CohortChart
            bars={bars}
            cohorts={result.cohorts}
            horizon={headline.horizon}
            selectedYear={selectedYear}
            onSelect={setPicked}
          />
          <fieldset className="era-chips">
            <legend className="visually-hidden">Notable start years</legend>
            {NOTABLE_ERAS.map((era) => {
              const c = byYear.get(era.year);
              return c ? (
                <StartYearButton
                  key={era.year}
                  cohort={c}
                  selected={selectedYear === era.year}
                  onSelect={setPicked}
                  label={era.label}
                />
              ) : null;
            })}
          </fieldset>
        </section>

        {detail ? (
          <CohortLedger
            key={detail.start_year}
            plan={plan}
            detail={detail}
            horizon={headline.horizon}
            realDollars={realDollars}
            loading={cohort.loading}
            onPrevious={step(-1)}
            onNext={step(1)}
          />
        ) : (
          <section className="card">
            <p className={cohort.error ? "banner critical" : "empty-state"}>
              {cohort.error ?? `Loading ${selectedYear ?? ""}…`}
            </p>
          </section>
        )}

        <details className="data-table">
          <summary>All {result.cohorts.length} start years as a table</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Start year</th>
                  <th>Outcome</th>
                  <th>Years lasted</th>
                  <th>Ends with (today's $)</th>
                </tr>
              </thead>
              <tbody>
                {result.cohorts.map((c) => (
                  <tr key={c.start_year}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setPicked(c.start_year)}
                      >
                        {c.start_year}
                      </button>
                    </td>
                    <td style={{ color: STATUS_COLOR[c.status] }}>
                      {STATUS_LABEL[c.status]}
                    </td>
                    <td>
                      {yearsLasted(c)}
                      {c.status === "InProgress" ? " so far" : ""}
                    </td>
                    <td>
                      {c.status === "Depleted"
                        ? "—"
                        : currencyCompact(c.end_net_worth_real)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </main>
  );
}
