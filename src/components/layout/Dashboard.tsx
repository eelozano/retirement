import { useMemo, useState } from "react";
import { depletionYear as computeDepletionYear } from "../../lib/projection";
import { usePlanStore } from "../../store/planStore";
import { BalancesChart } from "../charts/BalancesChart";
import { chartRows, seriesDefs } from "../charts/chartData";
import { DataTable } from "../charts/DataTable";
import { NetWorthChart } from "../charts/NetWorthChart";
import { SummaryStats } from "../charts/SummaryStats";
import { AccountsSection } from "../inputs/AccountsSection";
import { AssumptionsSection } from "../inputs/AssumptionsSection";
import { PeopleSection } from "../inputs/PeopleSection";
import { SocialSecuritySection } from "../inputs/SocialSecuritySection";
import { StreamsSection } from "../inputs/StreamsSection";
import { ComparisonView } from "./ComparisonView";
import { MonteCarloView } from "./MonteCarloView";
import { type Destination, Rail } from "./Rail";
import { ScenariosSettings } from "./ScenariosSettings";
import { StorageSettings } from "./StorageSettings";

// Application shell: rail on the left, then a header and one destination.
//
// Compare and Monte Carlo are still exclusive views of the plan area here.
// Turning them into additive overlays on a single canvas is R2's job — this
// change is the shell, the token layer, and the navigation model only.

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

  const [destination, setDestination] = useState<Destination>("plan");
  const [storageOpen, setStorageOpen] = useState(false);
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const [view, setView] = useState<"charts" | "compare" | "monteCarlo">("charts");

  const series = useMemo(() => (plan ? seriesDefs(plan) : []), [plan]);
  const rows = useMemo(
    () => (plan && projection ? chartRows(plan, projection, realDollars) : []),
    [plan, projection, realDollars],
  );

  // A hard failure (nothing has ever loaded) has no shell to show yet.
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
      <Rail
        active={destination}
        onNavigate={setDestination}
        onOpenScenarios={() => setScenariosOpen(true)}
        onOpenStorage={() => setStorageOpen(true)}
      />

      <div className="shell-main">
        <header className="topbar">
          <div className="topbar-identity">
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
          </div>

          <div className="topbar-spacer" />

          {/* Display option, not navigation — hence a segmented control
              rather than another button in the row. */}
          <fieldset className="segmented">
            <legend className="visually-hidden">Dollar basis</legend>
            <button
              type="button"
              aria-pressed={realDollars}
              onClick={() => setRealDollars(true)}
            >
              Today's $
            </button>
            <button
              type="button"
              aria-pressed={!realDollars}
              onClick={() => setRealDollars(false)}
            >
              Nominal
            </button>
          </fieldset>

          <div className="topbar-divider" />

          {scenarios.length > 1 && (
            <button
              type="button"
              className="topbar-toggle"
              aria-pressed={view === "compare"}
              onClick={() => setView((v) => (v === "compare" ? "charts" : "compare"))}
            >
              Compare
            </button>
          )}
          <button
            type="button"
            className="topbar-toggle"
            aria-pressed={view === "monteCarlo"}
            onClick={() => setView((v) => (v === "monteCarlo" ? "charts" : "monteCarlo"))}
          >
            Monte Carlo
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

        {destination === "plan" && depletionYear !== null && (
          <p role="alert" className="banner critical">
            ⚠ Portfolio depletes in {depletionYear} — spending exceeds what the accounts
            can fund.
          </p>
        )}

        <div className="content">
          {destination === "inputs" ? (
            <main className="inputs-screen">
              <PeopleSection />
              <AccountsSection />
              <StreamsSection />
              <SocialSecuritySection />
              <AssumptionsSection />
            </main>
          ) : view === "compare" ? (
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
                    Add an account under Inputs to see balance and net-worth projections.
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
                    <NetWorthChart
                      rows={rows}
                      plan={plan}
                      depletionYear={depletionYear}
                    />
                  </section>
                  <DataTable rows={rows} series={series} />
                </>
              )}
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
