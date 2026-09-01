import { useState } from "react";
import { usePlanStore } from "../../store/planStore";
import { InputsScreen, type InputsSection } from "../inputs/InputsScreen";
import { CashFlowScreen } from "./CashFlowScreen";
import { PlanScreen } from "./PlanScreen";
import { type Destination, Rail } from "./Rail";
import { ScenariosScreen } from "./ScenariosScreen";
import { StorageSettings } from "./StorageSettings";

// Application shell: rail on the left, then a header and one destination.
//
// Monte Carlo is no longer a mode. It is an additive overlay that paints the
// percentile band onto the same chart, so the fan is read against the plan
// rather than replacing it. Comparison lives inside the Scenarios
// destination, below the scenario list, rather than as a separate toggle.

export function Dashboard() {
  const plan = usePlanStore((s) => s.plan);
  const projection = usePlanStore((s) => s.projection);
  const projecting = usePlanStore((s) => s.projecting);
  const error = usePlanStore((s) => s.error);
  const realDollars = usePlanStore((s) => s.realDollars);
  const setRealDollars = usePlanStore((s) => s.setRealDollars);
  const showBand = usePlanStore((s) => s.showMonteCarloBand);
  const setShowBand = usePlanStore((s) => s.setShowMonteCarloBand);
  const scenarios = usePlanStore((s) => s.scenarios);
  const switchScenario = usePlanStore((s) => s.switchScenario);
  const updatePlan = usePlanStore((s) => s.updatePlan);

  const [destination, setDestination] = useState<Destination>("plan");
  // Lifted above InputsScreen so the selected sub-destination survives
  // navigating away to Plan/Cash flow and back, rather than resetting to
  // People every time the screen remounts.
  const [inputsSection, setInputsSection] = useState<InputsSection>("people");
  const [storageOpen, setStorageOpen] = useState(false);

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

          <button
            type="button"
            className="topbar-toggle"
            aria-pressed={showBand}
            title="Show the Monte Carlo percentile band on the projection chart"
            aria-describedby="monte-carlo-toggle-hint"
            onClick={() => setShowBand(!showBand)}
          >
            Monte Carlo
          </button>
          <span id="monte-carlo-toggle-hint" className="visually-hidden">
            Shades the projection chart with the 10th–90th and 25th–75th percentile ranges
            from the Monte Carlo simulation, and adds those percentiles to the year
            inspector.
          </span>
          <span className="visually-hidden" role="status">
            {showBand
              ? "Monte Carlo percentile band shown."
              : "Monte Carlo percentile band hidden."}
          </span>
        </header>

        <StorageSettings open={storageOpen} onClose={() => setStorageOpen(false)} />

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
          ) : destination === "scenarios" ? (
            <ScenariosScreen />
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
