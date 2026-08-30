import { useMemo, useState } from "react";
import { currencyCompact } from "../../lib/format";
import { depletionYear as computeDepletionYear } from "../../lib/projection";
import { usePlanStore } from "../../store/planStore";
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

export function PlanScreen(props: { showBand: boolean }) {
  const plan = usePlanStore((s) => s.plan);
  const projection = usePlanStore((s) => s.projection);
  const monteCarlo = usePlanStore((s) => s.monteCarlo);
  const projecting = usePlanStore((s) => s.projecting);
  const realDollars = usePlanStore((s) => s.realDollars);

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

  const stones = useMemo(
    () =>
      plan && projection ? milestones(plan, projection, depletionYear, realDollars) : [],
    [plan, projection, depletionYear, realDollars],
  );

  if (!plan || !projection || !metrics) return null;

  // Default the pin to the first retirement — the year the plan turns over —
  // rather than to the start, where nothing has happened yet.
  const defaultPin =
    plan.people.map((p) => p.retirement.year).sort((a, b) => a - b)[0] ??
    projection.snapshots[0]?.period_start.year ??
    0;
  const activeYear = hoverYear ?? pinnedYear ?? defaultPin;
  const detail = yearDetail(plan, projection, activeYear, series, realDollars);

  return (
    <main className={`plan-screen ${projecting ? "refreshing" : ""}`}>
      <StatusBand metrics={metrics} warningCount={projection.warnings.length} />

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
                <div className="card-head">
                  <h2>Net worth &amp; account balances</h2>
                  <span className="card-note">
                    {realDollars ? "today's dollars · deflated" : "nominal dollars"}
                  </span>
                  <span className="card-spacer" />
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
                  </div>
                </div>
                <ProjectionChart
                  rows={chartData}
                  series={series}
                  plan={plan}
                  depletionYear={depletionYear}
                  showBand={props.showBand && monteCarlo !== null}
                  pinnedYear={pinnedYear ?? defaultPin}
                  onHoverYear={setHoverYear}
                  onPinYear={setPinnedYear}
                />
              </div>
              <YearInspector detail={detail} hovering={hoverYear !== null} />
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

            <DataTable rows={rows} series={series} />
          </>
        )}
      </div>
    </main>
  );
}
