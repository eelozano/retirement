import { currentSpendingEstimate, lastToRetire } from "../../lib/currentSpending";
import { currency } from "../../lib/format";
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
  const projection = usePlanStore((s) => s.projection);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  if (!plan) return null;

  const household = ownedBy(plan.streams, null);

  // Retirement spending is the one input a projection cannot do without, and
  // the standard way to arrive at one is to start from what you spend now
  // and adjust. For a plan that budgets savings rather than spending, the
  // engine has already computed that figure (#50) — so the hardest required
  // input can be offered prefilled instead of asked for cold.
  //
  // Offered only until the plan has an expense that starts at a retirement,
  // so it is a starting point rather than a permanent nag.
  const retiree = lastToRetire(plan);
  const alreadySeeded = plan.streams.some(
    (s) =>
      s.direction === "Expense" &&
      typeof s.start === "object" &&
      "AtRetirement" in s.start,
  );
  const estimate =
    projection && retiree && !alreadySeeded
      ? currentSpendingEstimate(plan, projection)
      : null;

  // Rounded, and left in today's dollars — the amount field's own basis. A
  // figure to the dollar would claim a precision the derivation does not
  // have, so the same rounded number is what is shown and what is seeded.
  const seedAmount = estimate ? Math.round(estimate.annualAmount / 100) * 100 : 0;

  const seedRetirementSpending = (retireeId: string) =>
    updatePlan((d) => {
      d.streams.push({
        id: `stream-${Date.now()}`,
        name: "Retirement spending",
        owner: null,
        direction: "Expense",
        annual_amount: seedAmount,
        start: { AtRetirement: retireeId },
        end: "PlanEnd",
        growth: "Inflation",
        survivor_percentage: null,
      });
    });

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
        survivor_percentage: null,
      });
    });

  return (
    <div className="pane-section">
      <div className="pane-head">
        <h3>Spending</h3>
        <p>Household costs — the things no single person owns.</p>
      </div>

      {estimate && retiree && (
        <div className="input-card">
          <p className="field-hint">
            This plan says you live on about <strong>{currency(seedAmount)}</strong> a
            year in today&rsquo;s dollars — {estimate.year} pay, less what you save and
            pay in tax. Retirement spending usually starts there and gets adjusted: a
            mortgage ending, commuting stopping, healthcare changing.
          </p>
          <p className="field-hint">
            It only reads right if every dollar you save is in this plan. Saving that
            happens outside it — mortgage principal, a 529, cash piling up in the bank —
            looks like spending from in here, so treat it as a starting point to
            sanity-check rather than a measurement.
          </p>
          <button
            type="button"
            className="add"
            onClick={() => seedRetirementSpending(retiree.id)}
          >
            Start retirement spending at {currency(seedAmount)}/yr
          </button>
        </div>
      )}

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
