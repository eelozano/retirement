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
import { SocialSecuritySection } from "../inputs/SocialSecuritySection";
import { AssumptionsSection } from "../inputs/AssumptionsSection";
import { StorageSettings } from "./StorageSettings";
import { ScenariosSettings } from "./ScenariosSettings";
import { ComparisonView } from "./ComparisonView";
import { MonteCarloView } from "./MonteCarloView";
import { depletionYear as computeDepletionYear } from "../../lib/projection";

export function Dashboard() {
  const plan = usePlanStore((s) => s.plan);
  const projection = usePlanStore((s) => s.projection);
  const projecting = usePlanStore((s) => s.projecting);
  const error = usePlanStore((s) => s.error);
  const realDollars = usePlanStore((s) => s.realDollars);
  const setRealDollars = usePlanStore((s) => s.setRealDollars);
  const scenarios = usePlanStore((s) => s.scenarios);
  const switchScenario = usePlanStore((s) => s.switchScenario);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [storageOpen, setStorageOpen] = useState(false);
  const [scenariosOpen, setScenariosOpen] = useState(false);
  // One exclusive main view rather than independent booleans, so opening
  // one analysis panel always closes the other.
  const [view, setView] = useState<"edit" | "compare" | "monteCarlo">("edit");

  const series = useMemo(() => (plan ? seriesDefs(plan) : []), [plan]);
  const rows = useMemo(
    () => (plan && projection ? chartRows(plan, projection, realDollars) : []),
    [plan, projection, realDollars],
  );

  // A hard failure (nothing has ever loaded) has no drawer to show yet.
  // Once a plan exists, keep the shell up — the error banner below sits
  // alongside the last good projection so the offending input stays
  // editable and fixable, rather than replacing the whole screen.
  if (!plan || !projection) {
    return (
      <main className="page">
        {error ? (
          <p role="alert" className="banner critical">
            {error}
          </p>
        ) : (
          <p>Loading…</p>
        )}
      </main>
    );
  }

  const depletionYear = computeDepletionYear(projection);

  return (
    <div className="app-shell">
      <header className="topbar">
        {view === "edit" && (
          <button
            type="button"
            className="drawer-toggle"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            ☰ Inputs
          </button>
        )}
        <input
          className="plan-name"
          aria-label="Scenario name"
          value={plan.name}
          onChange={(e) =>
            updatePlan((draft) => {
              draft.name = e.currentTarget.value;
            })
          }
        />
        {scenarios.length > 1 && (
          <select
            className="scenario-switcher"
            aria-label="Switch scenario"
            value={plan.id}
            disabled={projecting}
            onChange={(e) => void switchScenario(e.currentTarget.value)}
          >
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <label className="dollar-toggle">
          <input
            type="checkbox"
            checked={realDollars}
            onChange={(e) => setRealDollars(e.currentTarget.checked)}
          />
          Today's dollars
        </label>
        <button
          type="button"
          className="drawer-toggle"
          onClick={() => setScenariosOpen(true)}
        >
          Scenarios…
        </button>
        {scenarios.length > 1 && (
          <button
            type="button"
            className="drawer-toggle"
            aria-pressed={view === "compare"}
            onClick={() => setView((v) => (v === "compare" ? "edit" : "compare"))}
          >
            {view === "compare" ? "Back to editing" : "Compare…"}
          </button>
        )}
        <button
          type="button"
          className="drawer-toggle"
          aria-pressed={view === "monteCarlo"}
          onClick={() => setView((v) => (v === "monteCarlo" ? "edit" : "monteCarlo"))}
        >
          {view === "monteCarlo" ? "Back to editing" : "Monte Carlo…"}
        </button>
        <button
          type="button"
          className="drawer-toggle"
          onClick={() => setStorageOpen(true)}
        >
          Storage…
        </button>
      </header>

      <StorageSettings open={storageOpen} onClose={() => setStorageOpen(false)} />
      <ScenariosSettings open={scenariosOpen} onClose={() => setScenariosOpen(false)} />

      {error && (
        <p role="alert" className="banner critical">
          Something went wrong:
          {"\n"}
          {error}
        </p>
      )}

      {depletionYear !== null && (
        <p role="alert" className="banner critical">
          ⚠ Portfolio depletes in {depletionYear} — spending exceeds what the
          accounts can fund.
        </p>
      )}

      <div className="content">
        {view === "edit" && drawerOpen && (
          <aside className="drawer">
            <PeopleSection />
            <AccountsSection />
            <StreamsSection />
            <SocialSecuritySection />
            <AssumptionsSection />
          </aside>
        )}

        {view === "compare" ? (
          <main className="charts">
            <ComparisonView />
          </main>
        ) : view === "monteCarlo" ? (
          <main className="charts">
            <MonteCarloView />
          </main>
        ) : (
          <main className={`charts ${projecting ? "refreshing" : ""}`}>
            <SummaryStats
              plan={plan}
              projection={projection}
              realDollars={realDollars}
              depletionYear={depletionYear}
            />
            {series.length === 0 ? (
              <section className="card">
                <p className="empty-state">
                  Add an account in the drawer to see balance and net-worth
                  projections.
                </p>
              </section>
            ) : (
              <>
                <section className="card">
                  <h2>Account balances</h2>
                  <BalancesChart rows={rows} series={series} />
                </section>
                <section className="card">
                  <h2>Net worth</h2>
                  <NetWorthChart rows={rows} plan={plan} depletionYear={depletionYear} />
                </section>
                <DataTable rows={rows} series={series} />
              </>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
