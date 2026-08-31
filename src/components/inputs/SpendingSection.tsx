import { usePlanStore } from "../../store/planStore";
import { StreamCard } from "./StreamCard";
import { ownedBy } from "./shared";

/**
 * Household costs — the streams no single person owns (`owner: null`).
 * Personal income and expenses live on the owning person's card in the
 * People pane instead; `CashFlowStream.owner` is what decides which pane a
 * stream shows up in.
 */
export function SpendingSection() {
  const plan = usePlanStore((s) => s.plan);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  if (!plan) return null;

  const household = ownedBy(plan.streams, null);

  const addExpense = () =>
    updatePlan((d) => {
      d.streams.push({
        id: `stream-${Date.now()}`,
        name: "New expense",
        owner: null,
        direction: "Expense",
        annual_amount: 0,
        start: "PlanStart",
        end: "PlanEnd",
        growth: "Inflation",
      });
    });

  return (
    <div className="pane-section">
      <div className="pane-head">
        <h3>Spending</h3>
        <p>Household costs — the things no single person owns.</p>
      </div>

      <div className="input-card">
        {household.length === 0 ? (
          <p className="field-hint">No household spending yet.</p>
        ) : (
          household.map(({ index: streamIndex }) => (
            <StreamCard
              key={plan.streams[streamIndex].id}
              plan={plan}
              streamIndex={streamIndex}
              updatePlan={updatePlan}
              removeLabel="Remove expense"
            />
          ))
        )}
        <button type="button" className="add" onClick={addExpense}>
          Add expense
        </button>
      </div>
    </div>
  );
}
