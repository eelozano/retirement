import type { Plan } from "../../types/generated/Plan";
import { oneTimeLegend, oneTimeNotCounted } from "./accountContribution";
import { BoundaryDetail } from "./BoundaryDetail";
import { NumberField, SelectField, TextField } from "./fields";
import type { UpdatePlan } from "./shared";
import {
  boundaryDateHint,
  boundaryToChoice,
  choiceToBoundary,
  landingOptions,
} from "./streamBoundary";

/**
 * One `OneTimeContribution` on an account: a lump sum from outside the plan —
 * a home sale, an inheritance — that lands once.
 *
 * Its own card rather than a fourth mode of `ContributionCard`, because the
 * engine treats the money differently: a contribution is paid out of that
 * year's income, and this is not. So it has a month rather than a window, an
 * amount rather than a rule, and a name up front — "$350,000 in Apr 2042"
 * says when and how much, never why.
 */
export function OneTimeContributionCard(props: {
  plan: Plan;
  accountIndex: number;
  entryIndex: number;
  updatePlan: UpdatePlan;
}) {
  const { plan, accountIndex: i, entryIndex: e, updatePlan } = props;
  const entry = plan.accounts[i].one_time_contributions[e];
  const notCounted = oneTimeNotCounted(entry, plan);

  return (
    <fieldset>
      <legend>{oneTimeLegend(entry, plan)}</legend>
      <p className="field-hint">
        Money from outside the plan, landing in this account once. It isn't taxed and
        doesn't come out of that year's income. Whatever it came from isn't counted before
        it arrives, so net worth jumps the year it lands.
      </p>
      <TextField
        label="Name"
        value={entry.name}
        placeholder="e.g. House sale"
        onChange={(name) =>
          updatePlan((d) => {
            d.accounts[i].one_time_contributions[e].name = name;
          })
        }
      />
      <NumberField
        label="Amount ($)"
        value={entry.amount}
        hint="What actually arrives: after paying off any mortgage, selling costs, and tax on a gain."
        onChange={(amount) =>
          updatePlan((d) => {
            d.accounts[i].one_time_contributions[e].amount = amount;
          })
        }
      />
      <SelectField
        label="Amount is in"
        value={entry.growth === "Inflation" ? "Inflation" : "None"}
        options={
          [
            { value: "Inflation", label: "Today's dollars" },
            { value: "None", label: "Dollars of the month it lands" },
          ] as const
        }
        hint={
          entry.growth === "Inflation"
            ? "Grows with inflation until it lands: type what it would be if it happened today."
            : "Lands as exactly this many dollars, however far off that month is."
        }
        onChange={(growth) =>
          updatePlan((d) => {
            d.accounts[i].one_time_contributions[e].growth = growth;
          })
        }
      />
      <SelectField
        label="Lands"
        value={boundaryToChoice(entry.date)}
        options={landingOptions(plan)}
        tooltip={boundaryDateHint(entry.date, plan)}
        onChange={(choice) =>
          updatePlan((d) => {
            const target = d.accounts[i].one_time_contributions[e];
            target.date = choiceToBoundary(choice, target.date);
          })
        }
      />
      <BoundaryDetail
        label="Landing"
        boundary={entry.date}
        onChange={(boundary) =>
          updatePlan((d) => {
            d.accounts[i].one_time_contributions[e].date = boundary;
          })
        }
      />
      {notCounted && <p className="field-hint">{notCounted}</p>}
      <button
        type="button"
        className="remove"
        onClick={() =>
          updatePlan((d) => {
            d.accounts[i].one_time_contributions.splice(e, 1);
          })
        }
      >
        Remove one-time contribution
      </button>
    </fieldset>
  );
}
