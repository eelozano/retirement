import { useMemo, useState } from "react";
import { usePlanStore } from "../../store/planStore";
import { chartRows, seriesDefs } from "../charts/chartData";
import { BalancesChart } from "../charts/BalancesChart";
import { NetWorthChart } from "../charts/NetWorthChart";
import { SummaryStats } from "../charts/SummaryStats";
import { DataTable } from "../charts/DataTable";
import { PeopleSection } from "../inputs/PeopleSection";
import { AccountsSection } from "../inputs/AccountsSection";
import { StreamsSection } from "../inputs/StreamsSection";
import { AssumptionsSection } from "../inputs/AssumptionsSection";

export function Dashboard() {
  const plan = usePlanStore((s) => s.plan);
  const projection = usePlanStore((s) => s.projection);
  const projecting = usePlanStore((s) => s.projecting);
  const error = usePlanStore((s) => s.error);
  const realDollars = usePlanStore((s) => s.realDollars);
  const setRealDollars = usePlanStore((s) => s.setRealDollars);
  const [drawerOpen, setDrawerOpen] = useState(true);

  const series = useMemo(() => (plan ? seriesDefs(plan) : []), [plan]);
  const rows = useMemo(
    () => (plan && projection ? chartRows(plan, projection, realDollars) : []),
    [plan, projection, realDollars],
  );

  if (error) {
    return (
      <main className="page">
        <p role="alert" className="banner critical">
          {error}
        </p>
      </main>
    );
  }
  if (!plan || !projection) {
    return (
      <main className="page">
        <p>Loading…</p>
      </main>
    );
  }

  const depletion = projection.warnings.find(
    (w): w is { DepletedFunds: { period: number } } =>
      typeof w === "object" && "DepletedFunds" in w,
  );
  const depletionYear = depletion
    ? (projection.snapshots[depletion.DepletedFunds.period]?.period_start.year ?? null)
    : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          type="button"
          className="drawer-toggle"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          ☰ Inputs
        </button>
        <h1>{plan.name}</h1>
        <label className="dollar-toggle">
          <input
            type="checkbox"
            checked={realDollars}
            onChange={(e) => setRealDollars(e.currentTarget.checked)}
          />
          Today's dollars
        </label>
      </header>

      {depletionYear !== null && (
        <p role="alert" className="banner critical">
          ⚠ Portfolio depletes in {depletionYear} — spending exceeds what the
          accounts can fund.
        </p>
      )}

      <div className="content">
        {drawerOpen && (
          <aside className="drawer">
            <PeopleSection />
            <AccountsSection />
            <StreamsSection />
            <AssumptionsSection />
          </aside>
        )}

        <main className={`charts ${projecting ? "refreshing" : ""}`}>
          <SummaryStats
            plan={plan}
            projection={projection}
            realDollars={realDollars}
            depletionYear={depletionYear}
          />
          <section className="card">
            <h2>Account balances</h2>
            <BalancesChart rows={rows} series={series} />
          </section>
          <section className="card">
            <h2>Net worth</h2>
            <NetWorthChart rows={rows} plan={plan} depletionYear={depletionYear} />
          </section>
          <DataTable rows={rows} series={series} />
        </main>
      </div>
    </div>
  );
}
