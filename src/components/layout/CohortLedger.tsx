import { useMemo, useState } from "react";
import { exportTextFile } from "../../lib/api";
import { dateStamp, sanitizedPlanName } from "../../lib/exportFilename";
import { currency, ratePercent } from "../../lib/format";
import { depletionYear } from "../../lib/projection";
import type { CohortDetail } from "../../types/generated/CohortDetail";
import type { Plan } from "../../types/generated/Plan";
import {
  cohortLedgerRows,
  cohortVerdict,
  ledgerCsv,
  NOTABLE_ERAS,
  STATUS_LABEL,
} from "../charts/backtestData";
import { STATUS_COLOR } from "../charts/CohortChart";
import { chartRows, seriesDefs } from "../charts/chartData";
import { ProjectionChart } from "../charts/ProjectionChart";
import { defaultPinYear, yearDetail } from "../charts/planData";
import { YearBalances } from "../charts/YearBalances";
import { YearInspector } from "../charts/YearInspector";

// One start year, year by year: how the plan would have gone had it begun in
// 1966 or 2000. The same chart, balances and inspector as the Plan screen,
// drawn from this start year's run, then the ledger — every year's inflation,
// what the markets did, what the portfolio earned, and the household's money
// in and out. A row pins that year in the chart and inspector, the way a
// click on the chart does.
//
// Years are the plan's own calendar on the chart and in the inspector; the
// ledger names both, because "2031" is the year the household lives and
// "1971" is the year whose markets it lives through.

export function CohortLedger(props: {
  plan: Plan;
  detail: CohortDetail;
  horizon: number;
  realDollars: boolean;
  loading: boolean;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const { plan, detail, realDollars } = props;
  const projection = detail.projection;
  const [hoverYear, setHoverYear] = useState<number | null>(null);
  const [pinnedYear, setPinnedYear] = useState<number | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const series = useMemo(() => seriesDefs(plan), [plan]);
  const rows = useMemo(
    () => chartRows(plan, projection, realDollars),
    [plan, projection, realDollars],
  );
  const ledger = useMemo(
    () => cohortLedgerRows(plan, detail, realDollars),
    [plan, detail, realDollars],
  );

  const firstYear = rows[0]?.year ?? 0;
  const lastYear = rows[rows.length - 1]?.year ?? 0;
  const defaultPin = Math.min(
    lastYear,
    Math.max(firstYear, defaultPinYear(plan, projection)),
  );
  const pin = pinnedYear !== null && pinnedYear <= lastYear ? pinnedYear : defaultPin;
  const activeYear = hoverYear ?? pin;
  const inspected = yearDetail(plan, projection, activeYear, series, realDollars);
  const era = NOTABLE_ERAS.find((e) => e.year === detail.start_year);
  const basis = realDollars
    ? "today's dollars · this start year's own inflation"
    : "nominal dollars";

  async function exportCsv() {
    const name = `${sanitizedPlanName(plan)}-history-${detail.start_year}-${dateStamp()}.csv`;
    const written = await exportTextFile(name, ledgerCsv(plan, detail, realDollars));
    setExportNote(written ? `Saved to ${written}` : null);
  }

  return (
    <section
      className={`card cohort-ledger ${props.loading ? "refreshing" : ""}`}
      aria-label={`Starting in ${detail.start_year}`}
    >
      <div className="card-head">
        <h2>
          Starting in {detail.start_year}
          {era && <span className="cohort-era"> · {era.label}</span>}
        </h2>
        <span className="cohort-status" style={{ color: STATUS_COLOR[detail.status] }}>
          {STATUS_LABEL[detail.status]}
        </span>
        <span className="card-spacer" />
        <button
          type="button"
          className="card-action"
          disabled={!props.onPrevious}
          onClick={props.onPrevious ?? undefined}
          aria-label="Previous start year"
        >
          ← {detail.start_year - 1}
        </button>
        <button
          type="button"
          className="card-action"
          disabled={!props.onNext}
          onClick={props.onNext ?? undefined}
          aria-label="Next start year"
        >
          {detail.start_year + 1} →
        </button>
        <button type="button" className="card-action" onClick={() => void exportCsv()}>
          Export CSV
        </button>
      </div>
      <p className="cohort-verdict">
        {cohortVerdict(plan, detail, props.horizon, realDollars)}
      </p>
      {exportNote && <p className="card-note">{exportNote}</p>}

      <div className="projection-zone cohort-zone">
        <div className="projection-card">
          <span className="card-note">Your plan's years, {basis}</span>
          <ProjectionChart
            rows={rows}
            series={series}
            plan={plan}
            depletionYear={depletionYear(projection)}
            showBand={false}
            pinnedYear={pin}
            onHoverYear={setHoverYear}
            onPinYear={setPinnedYear}
          />
          <YearBalances detail={inspected} />
        </div>
        <YearInspector
          detail={inspected}
          hovering={hoverYear !== null}
          percentiles={null}
        />
      </div>

      <div className="data-table cohort-table">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Market year</th>
                <th>Plan year</th>
                <th>Ages</th>
                <th>Inflation</th>
                <th>Stocks</th>
                <th>Bonds</th>
                <th>Portfolio</th>
                <th>Portfolio, real</th>
                <th>Income</th>
                <th>Spending</th>
                <th>Taxes</th>
                <th>Withdrawals</th>
                <th>Net worth</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((row) => (
                <tr
                  key={row.period}
                  className={`${row.shortfall ? "row-shortfall" : ""} ${row.planYear === pin ? "row-pinned" : ""}`}
                >
                  <td>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setPinnedYear(row.planYear)}
                      aria-label={`Inspect ${row.planYear} (market year ${row.historicalYear})`}
                    >
                      {row.historicalYear}
                    </button>
                  </td>
                  <td>{row.planYear}</td>
                  <td>{row.ages}</td>
                  <td>{ratePercent(row.inflation)}</td>
                  <td>{ratePercent(row.stocks)}</td>
                  <td>{ratePercent(row.bonds)}</td>
                  <td>
                    {row.portfolioReturn === null
                      ? "—"
                      : ratePercent(row.portfolioReturn)}
                  </td>
                  <td>
                    {row.portfolioRealReturn === null
                      ? "—"
                      : ratePercent(row.portfolioRealReturn)}
                  </td>
                  <td>{currency(row.income)}</td>
                  <td>{currency(row.spending)}</td>
                  <td>{currency(row.taxes)}</td>
                  <td>{currency(row.withdrawals)}</td>
                  <td className={row.shortfall ? "row-critical" : ""}>
                    {row.shortfall && row.netWorth <= 0.5
                      ? "Ran out"
                      : currency(row.netWorth)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="card-note cohort-footnote">
          Inflation, stocks and bonds are the market year's figures, January to January
          (Shiller: S&amp;P Composite and 10-year Treasury total returns, CPI). Portfolio
          is what your accounts earned that year at their stock/bond mixes
          {plan.sim_config.start.month !== 1 &&
            "; the first row is only the months left in your plan's first year"}
          . Rows in red are years the plan could not cover its spending.
        </p>
      </div>
    </section>
  );
}
