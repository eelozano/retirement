import { useState } from "react";
import { usePlanStore } from "../../store/planStore";
import { InputsScreen, type InputsSection } from "../inputs/InputsScreen";
import { CashFlowScreen } from "./CashFlowScreen";
import { ComparisonView } from "./ComparisonView";
import { PlanScreen } from "./PlanScreen";
import { type Destination, Rail } from "./Rail";
import { ScenariosSettings } from "./ScenariosSettings";
import { StorageSettings } from "./StorageSettings";

// Application shell: rail on the left, then a header and one destination.
//
// Monte Carlo is no longer a mode. It is an additive overlay that paints the
// percentile band onto the same chart, so the fan is read against the plan
// rather than replacing it. Compare is still a separate view; whether it
// becomes an overlay too is R3's call, once the band has proven the pattern.

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
  // Lifted above InputsScreen so the selected sub-destination survives
  // navigating away to Plan/Cash flow and back, rather than resetting to
  // People every time the screen remounts.
  const [inputsSection, setInputsSection] = useState<InputsSection>("people");
  const [storageOpen, setStorageOpen] = useState(false);
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const [showBand, setShowBand] = useState(false);
  const [comparing, setComparing] = useState(false);

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
              aria-pressed={comparing}
              onClick={() => setComparing((c) => !c)}
            >
              Compare
            </button>
          )}
          <button
            type="button"
            className="topbar-toggle"
            aria-pressed={showBand}
            onClick={() => setShowBand((b) => !b)}
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

        <div className="content">
          {destination === "cashflow" ? (
            <CashFlowScreen />
          ) : destination === "inputs" ? (
            <InputsScreen section={inputsSection} onSectionChange={setInputsSection} />
          ) : comparing ? (
            <main className="charts">
              <ComparisonView />
            </main>
          ) : (
            <PlanScreen
              showBand={showBand}
              onOpenCashFlow={() => setDestination("cashflow")}
            />
          )}
        </div>
      </div>
    </div>
  );
}
