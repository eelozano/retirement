import { useMemo, useState } from "react";
import { currencyCompact } from "../../lib/format";
import { depletionYear as computeDepletionYear } from "../../lib/projection";
import { readableWarnings } from "../../lib/warnings";
import { usePlanStore } from "../../store/planStore";
import { cashFlowRows, cashFlowSummary } from "../charts/cashFlowData";
import { chartRows, seriesDefs } from "../charts/chartData";
import { DataTable } from "../charts/DataTable";
import { HeadlineTiles } from "../charts/HeadlineTiles";
import { fanRows } from "../charts/monteCarloData";
import { mergeFan, ProjectionChart } from "../charts/ProjectionChart";
import { headlineMetrics, milestones, yearDetail } from "../charts/planData";
import { YearInspector } from "../charts/YearInspector";
import { StatusBand } from "./StatusBand";

// The default destination, in four zones:
//   0  status band — always present, one sentence
//   1  headline — three numbers, zero clicks
//   2  projection + year inspector
//   3  supporting detail, below the fold

export function PlanScreen(props: { onOpenCashFlow: () => void }) {
  const plan = usePlanStore((s) => s.plan);
  const projection = usePlanStore((s) => s.projection);
  const monteCarlo = usePlanStore((s) => s.monteCarlo);
  const projecting = usePlanStore((s) => s.projecting);
  const realDollars = usePlanStore((s) => s.realDollars);
  const showBand = usePlanStore((s) => s.showMonteCarloBand);
  const setShowBand = usePlanStore((s) => s.setShowMonteCarloBand);

  const [hoverYear, setHoverYear] = useState<number | null>(null);
  const [pinnedYear, setPinnedYear] = useState<number | null>(null);

  const series = useMemo(() => (plan ? seriesDefs(plan) : []), [plan]);
  const rows = useMemo(
    () => (plan && projection ? chartRows(plan, projection, realDollars) : []),
    [plan, projection, realDollars],
  );
  const chartData = useMemo(
    () => (monteCarlo ? mergeFan(rows, fanRows(monteCarlo, realDollars)) : rows),
    [rows, monteCarlo, realDollars],
  );

  const depletionYear = projection ? computeDepletionYear(projection) : null;

  const metrics = useMemo(
    () =>
      plan && projection
        ? headlineMetrics(plan, projection, monteCarlo, depletionYear, realDollars)
        : null,
    [plan, projection, monteCarlo, depletionYear, realDollars],
  );

  const warnings = useMemo(
    () => (plan && projection ? readableWarnings(plan, projection) : []),
    [plan, projection],
  );

  const stones = useMemo(
    () =>
      plan && projection ? milestones(plan, projection, depletionYear, realDollars) : [],
    [plan, projection, depletionYear, realDollars],
  );

  if (!plan || !projection || !metrics) return null;

  // Three real numbers on the entry card, so the inversion is legible before
  // anyone clicks through.
  const flows = cashFlowRows(projection, realDollars);
  const firstFlow = flows[0];
  const crossover = cashFlowSummary(flows).crossoverYear;
  const atCrossover =
    crossover !== null ? flows.find((f) => f.year === crossover) : undefined;
  const cashPeek = [
    {
      label: `Income ${firstFlow?.year ?? ""}`,
      value: firstFlow?.income ?? 0,
      color: "var(--series-2)",
    },
    {
      label: `Outflow ${firstFlow?.year ?? ""}`,
      value: Math.abs((firstFlow?.expenses ?? 0) + (firstFlow?.taxes ?? 0)),
      color: "var(--series-3)",
    },
    {
      label: atCrossover ? `Withdrawals ${atCrossover.year}` : "Withdrawals",
      value: atCrossover?.withdrawals ?? 0,
      color: "var(--series-1)",
    },
  ];

  // Default the pin to the first retirement — the year the plan turns over —
  // rather than to the start, where nothing has happened yet.
  const defaultPin =
    plan.people.map((p) => p.retirement.year).sort((a, b) => a - b)[0] ??
    projection.snapshots[0]?.period_start.year ??
    0;
  const activeYear = hoverYear ?? pinnedYear ?? defaultPin;
  const detail = yearDetail(plan, projection, activeYear, series, realDollars);

  const bandOn = showBand && monteCarlo !== null;
  // `chartData` already carries the percentile fields when `monteCarlo` is
  // set (via `mergeFan`), regardless of whether the band is toggled on.
  const activeFanRow = monteCarlo
    ? chartData.find((r) => r.year === activeYear)
    : undefined;
  const activeFan = activeFanRow
    ? {
        p10: activeFanRow.p10,
        p25: activeFanRow.innerBase,
        p50: activeFanRow.p50,
        p75: activeFanRow.innerBase + activeFanRow.innerBand,
        p90: activeFanRow.p90,
      }
    : null;

  return (
    <main className={`plan-screen ${projecting ? "refreshing" : ""}`}>
      <StatusBand metrics={metrics} warnings={warnings} />

      <div className="plan-scroll">
        <HeadlineTiles metrics={metrics} realDollars={realDollars} />

        {series.length === 0 ? (
          <section className="card">
            <p className="empty-state">
              Add an account under Inputs to see balance and net-worth projections.
            </p>
          </section>
        ) : (
          <>
            <section className="projection-zone" aria-label="Projection">
              <div className="card projection-card">
                {/* The overlay toggle belongs to this chart — it shades this
                    chart and fills this inspector, and does nothing anywhere
                    else in the app. */}
                <div className="card-head">
                  <h2>Net worth &amp; account balances</h2>
                  <span className="card-note">
                    {realDollars ? "today's dollars · deflated" : "nominal dollars"}
                  </span>
                  <span className="card-spacer" />
                  <button
                    type="button"
                    className="chart-toggle"
                    aria-pressed={bandOn}
                    disabled={monteCarlo === null}
                    title={
                      monteCarlo === null
                        ? "Monte Carlo results are not available for this plan"
                        : "Show the Monte Carlo percentile band on this chart"
                    }
                    aria-describedby="monte-carlo-toggle-hint"
                    onClick={() => setShowBand(!showBand)}
                  >
                    Monte Carlo
                  </button>
                  <span id="monte-carlo-toggle-hint" className="visually-hidden">
                    Shades the projection chart with the 10th–90th and 25th–75th
                    percentile ranges from the Monte Carlo simulation, and adds those
                    percentiles to the year inspector.
                  </span>
                  <span className="visually-hidden" role="status">
                    {bandOn
                      ? "Monte Carlo percentile band shown."
                      : "Monte Carlo percentile band hidden."}
                  </span>
                </div>
                <div className="chart-legend">
                  {series.map((s) => (
                    <span className="legend-item" key={s.key}>
                      <span className="row-swatch" style={{ background: s.color }} />
                      {s.label}
                    </span>
                  ))}
                  <span className="legend-item">
                    <span className="legend-rule" />
                    Net worth
                  </span>
                  {bandOn && (
                    <>
                      <span className="legend-item">
                        <span
                          className="legend-swatch"
                          style={{ background: "var(--band)" }}
                        />
                        10th–90th percentile
                      </span>
                      <span className="legend-item">
                        <span
                          className="legend-swatch"
                          style={{ background: "var(--band-inner)" }}
                        />
                        25th–75th percentile
                      </span>
                      <span className="legend-item">
                        <span className="legend-rule legend-rule-dashed" />
                        Median (p50)
                      </span>
                    </>
                  )}
                </div>
                <ProjectionChart
                  rows={chartData}
                  series={series}
                  plan={plan}
                  depletionYear={depletionYear}
                  showBand={bandOn}
                  pinnedYear={pinnedYear ?? defaultPin}
                  onHoverYear={setHoverYear}
                  onPinYear={setPinnedYear}
                />
              </div>
              <YearInspector
                detail={detail}
                hovering={hoverYear !== null}
                percentiles={bandOn ? activeFan : null}
              />
            </section>

            <section className="milestones" aria-label="Milestones">
              {stones.map((m) => (
                <div className="tile" key={m.key}>
                  <span className="tile-label">{m.label}</span>
                  <div className={`tile-metric ${m.critical ? "stat-critical" : ""}`}>
                    {m.value !== null ? currencyCompact(m.value) : "—"}
                  </div>
                  <div className="tile-sub">{m.sub}</div>
                </div>
              ))}
            </section>

            <button type="button" className="entry-card" onClick={props.onOpenCashFlow}>
              <span className="entry-card-text">
                <span className="entry-card-title">Cash flow</span>
                <span className="entry-card-sub">
                  Where money comes from and where it goes — and how that inverts at
                  retirement.
                </span>
              </span>
              <span className="card-spacer" />
              {cashPeek.map((c) => (
                <span className="entry-card-peek" key={c.label}>
                  <span className="tile-label">{c.label}</span>
                  <span className="entry-card-value" style={{ color: c.color }}>
                    {currencyCompact(c.value)}
                  </span>
                </span>
              ))}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--muted)"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <title>Open cash flow</title>
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>

            <DataTable rows={rows} series={series} />
          </>
        )}
      </div>
    </main>
  );
}
