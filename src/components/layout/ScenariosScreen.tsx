import { useEffect, useState } from "react";
import type { PlanSummary } from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
import { ComparisonView } from "./ComparisonView";

// The scenarios destination: manage the scenario list (switch, duplicate,
// delete) and, once there's more than one to compare, the comparison view
// right below it — one scenario-related surface instead of two.
//
// Grouped by household, because that is what a scenario now branches from
// (#109): every scenario under one heading projects the same balances as of
// the same month, and only the policy differs. A flat list would put two
// families' "Base plan" side by side and imply they were comparable.

interface HouseholdGroup {
  id: string;
  name: string;
  sample: boolean;
  scenarios: PlanSummary[];
}

/** Scenarios grouped by household, households in the order the backend
 * listed them (file order) and scenarios in the order within each. */
export function groupByHousehold(scenarios: PlanSummary[]): HouseholdGroup[] {
  const groups: HouseholdGroup[] = [];
  for (const scenario of scenarios) {
    const existing = groups.find((g) => g.id === scenario.household_id);
    if (existing) {
      existing.scenarios.push(scenario);
      continue;
    }
    groups.push({
      id: scenario.household_id,
      name: scenario.household_name,
      sample: scenario.sample,
      scenarios: [scenario],
    });
  }
  return groups;
}

export function ScenariosScreen() {
  const scenarios = usePlanStore((s) => s.scenarios);
  const plan = usePlanStore((s) => s.plan);
  const switchScenario = usePlanStore((s) => s.switchScenario);
  const duplicateActive = usePlanStore((s) => s.duplicateActive);
  const deleteScenario = usePlanStore((s) => s.deleteScenario);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (plan) setNewName(`${plan.name} copy`);
  }, [plan]);

  if (!plan) return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const groups = groupByHousehold(scenarios);
  const activeHousehold = groups.find((g) => g.scenarios.some((s) => s.id === plan.id));

  return (
    <main className="charts">
      <section className="card" aria-label="Scenarios">
        <h2>Scenarios</h2>
        <div className="scenario-households">
          {groups.map((group) => (
            <div className="scenario-household" key={group.id}>
              {/* The heading is shown even for a single household: it is what
                  says out loud that these scenarios share one set of
                  balances, which is the whole reason they are comparable. */}
              <h3>
                {group.name}
                {/* The same badge the header puts beside the plan name, for
                    the same reason (#103): the numbers are invented, and a
                    rename must not be enough to lose that. It belongs on the
                    household, because that is what holds the balances. */}
                {group.sample && (
                  <span
                    className="sample-badge"
                    title="Invented data — not your finances"
                  >
                    Example
                  </span>
                )}
              </h3>
              <ul className="scenario-list">
                {group.scenarios.map((s) => (
                  <li key={s.id} className={s.id === plan.id ? "scenario-active" : ""}>
                    <span className="scenario-name">{s.name}</span>
                    {s.id === plan.id ? (
                      <span className="scenario-badge">Current</span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => run(() => switchScenario(s.id))}
                      >
                        Switch
                      </button>
                    )}
                    {/* Enabled even for the last scenario: refusing that (#103)
                        left anyone handed the example household unable to get rid
                        of it. Deleting a household's last scenario returns to the
                        welcome screen, and its file moves to .trash either way. */}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => deleteScenario(s.id))}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="scenario-new">
          <input
            type="text"
            aria-label="New scenario name"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
          />
          <button
            type="button"
            disabled={busy || newName.trim() === ""}
            onClick={() => run(() => duplicateActive(newName.trim()))}
          >
            Duplicate current as new scenario
          </button>
        </div>
        <p className="field-hint">
          A new scenario branches{" "}
          {activeHousehold ? `“${activeHousehold.name}”` : "this household"} — it shares
          the same balances, and carries its own retirement dates, contributions, spending
          and claiming ages.
        </p>
      </section>

      {scenarios.length > 1 && <ComparisonView />}
    </main>
  );
}
