import { useMemo, useRef, useState } from "react";
import { exportReportPdf, printWindow } from "../../lib/api";
import { dateStamp, sanitizedPlanName } from "../../lib/exportFilename";
import { rateToPercent } from "../../lib/format";
import { depletionYear as computeDepletionYear } from "../../lib/projection";
import { readableWarnings } from "../../lib/warnings";
import { usePlanStore } from "../../store/planStore";
import type { AssetClass } from "../../types/generated/AssetClass";
import { CashFlowChart } from "../charts/CashFlowChart";
import { cashFlowRows } from "../charts/cashFlowData";
import { chartRows, seriesDefs } from "../charts/chartData";
import { DataTable } from "../charts/DataTable";
import { HeadlineTiles } from "../charts/HeadlineTiles";
import { ProjectionChart } from "../charts/ProjectionChart";
import { headlineMetrics } from "../charts/planData";
import {
  ASSET_LABELS,
  FILING_STATUS_OPTIONS,
  STATE_LABELS,
} from "../inputs/AssumptionsSection";
import { Modal } from "./Modal";

// The document version of the Plan screen: the same numbers, assembled once
// for printing or filing rather than for interactive exploration — no hover,
// no pinning, no Monte Carlo band toggle. Everything here reads from
// functions the Plan/Cash flow screens already call; nothing is recomputed.

function noop() {}

export function ReportView(props: { open: boolean; onClose: () => void }) {
  const plan = usePlanStore((s) => s.plan);
  const projection = usePlanStore((s) => s.projection);
  const monteCarlo = usePlanStore((s) => s.monteCarlo);
  const realDollars = usePlanStore((s) => s.realDollars);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingPdf, setSavingPdf] = useState(false);

  const handlePrint = () => {
    setActionError(null);
    printWindow().catch((e) => setActionError(String(e)));
  };

  const handleSavePdf = async () => {
    if (!plan) return;
    setActionError(null);
    setSavingPdf(true);
    // createPDF has no print-media concept of its own: it captures the page
    // exactly as displayed, and only the rect it's told to. `.pdf-capturing`
    // (App.css) hides the app chrome and lets the report grow to its true,
    // unclipped height so there's an exact rect to measure and capture —
    // the same problem `@media print` solves for the interactive dialog,
    // solved by hand since createPDF never enters that mode.
    document.body.classList.add("pdf-capturing");
    try {
      window.scrollTo(0, 0);
      // One frame for the unclipped layout to settle before measuring it.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const rect = dialogRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        throw new Error("Could not measure the report for export.");
      }
      const basis = realDollars ? "real" : "nominal";
      const name = `${sanitizedPlanName(plan)}-report-${basis}-${dateStamp()}.pdf`;
      await exportReportPdf(name, rect.width, rect.height);
    } catch (e) {
      setActionError(String(e));
    } finally {
      document.body.classList.remove("pdf-capturing");
      setSavingPdf(false);
    }
  };

  const series = useMemo(() => (plan ? seriesDefs(plan) : []), [plan]);
  const rows = useMemo(
    () => (plan && projection ? chartRows(plan, projection, realDollars) : []),
    [plan, projection, realDollars],
  );
  const flows = useMemo(
    () => (projection ? cashFlowRows(projection, realDollars) : []),
    [projection, realDollars],
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

  // Not memoized: cheap, and re-reading it on every render is what keeps it
  // current across a reopen.
  const generated = new Date().toLocaleString();
  const basisLabel = realDollars ? "today's dollars · deflated" : "nominal dollars";
  const firstYear = projection?.snapshots[0]?.period_start.year ?? null;

  return (
    <Modal
      ref={dialogRef}
      open={props.open}
      onClose={props.onClose}
      title="Printable report"
      size="lg"
    >
      {!plan || !projection || !metrics ? (
        <p className="empty-state">Nothing to report yet.</p>
      ) : (
        <div className="report">
          <header className="report-header">
            <div>
              <h1>{plan.name}</h1>
              <p className="report-meta">
                Generated {generated} · {basisLabel}
              </p>
            </div>
            <div className="report-actions">
              <button type="button" onClick={handleSavePdf} disabled={savingPdf}>
                {savingPdf ? "Saving…" : "Save as PDF…"}
              </button>
              <button type="button" onClick={handlePrint}>
                Print…
              </button>
            </div>
          </header>

          {actionError && (
            <p role="alert" className="banner critical">
              {actionError}
            </p>
          )}

          <section className="report-section" aria-label="Warnings">
            <h2>Warnings</h2>
            {warnings.length === 0 ? (
              <p className="storage-badge">
                No warnings — the simulation ran without clamping or skipping anything.
              </p>
            ) : (
              <ul className="report-warnings">
                {warnings.map((w) => (
                  <li key={w.key}>
                    <strong className="report-warning-title">{w.title}</strong>
                    <span className="report-warning-detail">{w.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="report-section" aria-label="Assumptions">
            <h2>Assumptions</h2>
            <table className="report-table">
              <tbody>
                {plan.people.map((p) => (
                  <tr key={p.id}>
                    <th>{p.name}</th>
                    <td>
                      Retires {p.retirement.year} · plans to age {p.life_expectancy_age}
                    </td>
                  </tr>
                ))}
                <tr>
                  <th>Inflation</th>
                  <td>{rateToPercent(plan.assumptions.inflation)}% / year</td>
                </tr>
                <tr>
                  <th>Expected returns</th>
                  <td>
                    {(
                      Object.entries(plan.assumptions.asset_returns) as [
                        AssetClass,
                        number,
                      ][]
                    )
                      .map(
                        ([cls, rate]) => `${ASSET_LABELS[cls]}: ${rateToPercent(rate)}%`,
                      )
                      .join(" · ")}
                  </td>
                </tr>
                <tr>
                  <th>Filing status</th>
                  <td>
                    {FILING_STATUS_OPTIONS.find(
                      (o) => o.value === plan.assumptions.filing_status,
                    )?.label ?? plan.assumptions.filing_status}
                  </td>
                </tr>
                <tr>
                  <th>State tax</th>
                  <td>{STATE_LABELS[plan.assumptions.state_tax.state]}</td>
                </tr>
                {plan.assumptions.survivor_expense_factor < 1 && (
                  <tr>
                    <th>Survivor spending</th>
                    <td>
                      Steps to{" "}
                      {Math.round(plan.assumptions.survivor_expense_factor * 100)}% after
                      the first death
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="report-section" aria-label="Headline">
            <h2>Headline</h2>
            <HeadlineTiles metrics={metrics} realDollars={realDollars} />
          </section>

          {series.length > 0 && (
            <section className="report-section" aria-label="Net worth and balances">
              <h2>Net worth &amp; account balances</h2>
              <ProjectionChart
                rows={rows}
                series={series}
                plan={plan}
                depletionYear={depletionYear}
                showBand={false}
                pinnedYear={firstYear ?? 0}
                onHoverYear={noop}
                onPinYear={noop}
              />
            </section>
          )}

          {flows.length > 0 && (
            <section className="report-section" aria-label="Cash flow">
              <h2>Cash flow</h2>
              <CashFlowChart rows={flows} plan={plan} />
            </section>
          )}

          <section className="report-section" aria-label="Year by year">
            <h2>Year by year</h2>
            <DataTable rows={rows} series={series} open />
          </section>

          <footer className="report-footer">
            <p>
              {plan.name} · {basisLabel} · generated {generated}
            </p>
          </footer>
        </div>
      )}
    </Modal>
  );
}
