import type { Plan } from "../../types/generated/Plan";
import type { Presets } from "../../types/generated/Presets";
import {
  CONTRIBUTION_MODES,
  contributionEndHint,
  contributionLegend,
  contributionMode,
  federalMaximumHint,
  ruleForMode,
} from "./accountContribution";
import {
  CheckboxField,
  NumberField,
  PercentField,
  SelectField,
  YearMonthField,
} from "./fields";
import type { UpdatePlan } from "./shared";
import { boundaryOptions, boundaryToChoice, choiceToBoundary } from "./streamBoundary";

/**
 * One `Contribution` entry on an account: how much goes in, and over what
 * window. The window controls are deliberately the same pair a
 * `CashFlowStream` gets in `StreamCard` — an entry that starts in three
 * years or runs past retirement is the same idea as a stream that does, and
 * a reader who has met one should not have to learn the other.
 *
 * The card has no name field; its legend is derived from the entry's data.
 */
export function ContributionCard(props: {
  plan: Plan;
  accountIndex: number;
  entryIndex: number;
  presets: Presets | null;
  updatePlan: UpdatePlan;
}) {
  const { plan, accountIndex: i, entryIndex: e, presets, updatePlan } = props;
  const account = plan.accounts[i];
  const entry = account.contributions[e];
  const rule = entry.rule;
  const mode = contributionMode(rule);

  return (
    <fieldset>
      <legend>{contributionLegend(entry, plan)}</legend>
      <SelectField
        label={account.kind === "Savings" ? "Savings rate" : "Contribution"}
        value={mode}
        options={
          account.plan_type === "None"
            ? CONTRIBUTION_MODES.filter((m) => m.value !== "FederalMaximum")
            : CONTRIBUTION_MODES
        }
        hint={
          mode === "FederalMaximum"
            ? federalMaximumHint(presets, account.plan_type)
            : undefined
        }
        onChange={(next) =>
          updatePlan((d) => {
            d.accounts[i].contributions[e].rule = ruleForMode(next);
          })
        }
      />
      {typeof rule === "object" && "PercentOfSalary" in rule && (
        <>
          <PercentField
            label="Of salary"
            rate={rule.PercentOfSalary.percent}
            minPercent={0}
            maxPercent={100}
            onChange={(rate) =>
              updatePlan((d) => {
                // Spread rather than replace: an escalation already on the
                // entry survives a change to the starting percentage.
                d.accounts[i].contributions[e].rule = {
                  PercentOfSalary: { ...rule.PercentOfSalary, percent: rate },
                };
              })
            }
          />
          <CheckboxField
            label="Increase each year"
            checked={rule.PercentOfSalary.step_up !== null}
            onChange={(on) =>
              updatePlan((d) => {
                const target = d.accounts[i].contributions[e].rule;
                if (typeof target !== "object" || !("PercentOfSalary" in target)) return;
                target.PercentOfSalary.step_up = on
                  ? {
                      points_per_year: 0.01,
                      cap: Math.max(target.PercentOfSalary.percent, 0.15),
                    }
                  : null;
              })
            }
          />
          {rule.PercentOfSalary.step_up !== null && (
            <>
              <PercentField
                label="By (points/yr)"
                rate={rule.PercentOfSalary.step_up.points_per_year}
                minPercent={0}
                maxPercent={100}
                onChange={(rate) =>
                  updatePlan((d) => {
                    const target = d.accounts[i].contributions[e].rule;
                    if (typeof target !== "object" || !("PercentOfSalary" in target))
                      return;
                    const stepUp = target.PercentOfSalary.step_up;
                    if (stepUp) stepUp.points_per_year = rate;
                  })
                }
              />
              <PercentField
                label="Up to"
                rate={rule.PercentOfSalary.step_up.cap}
                minPercent={0}
                maxPercent={100}
                onChange={(rate) =>
                  updatePlan((d) => {
                    const target = d.accounts[i].contributions[e].rule;
                    if (typeof target !== "object" || !("PercentOfSalary" in target))
                      return;
                    const stepUp = target.PercentOfSalary.step_up;
                    if (stepUp) stepUp.cap = rate;
                  })
                }
              />
            </>
          )}
        </>
      )}
      {typeof rule === "object" && "FlatAmount" in rule && (
        <>
          <NumberField
            label="Amount / yr ($)"
            value={rule.FlatAmount.amount}
            onChange={(amount) =>
              updatePlan((d) => {
                d.accounts[i].contributions[e].rule = {
                  FlatAmount: { ...rule.FlatAmount, amount },
                };
              })
            }
          />
          <SelectField
            label="Grows with"
            value={rule.FlatAmount.growth === "Inflation" ? "Inflation" : "None"}
            options={
              [
                { value: "Inflation", label: "Inflation" },
                { value: "None", label: "Nothing (flat)" },
              ] as const
            }
            hint="An amount that grows with inflation is entered in today's dollars."
            onChange={(growth) =>
              updatePlan((d) => {
                const target = d.accounts[i].contributions[e].rule;
                if (typeof target !== "object" || !("FlatAmount" in target)) return;
                target.FlatAmount.growth = growth;
              })
            }
          />
        </>
      )}
      <SelectField
        label="Starts"
        value={boundaryToChoice(entry.start)}
        options={boundaryOptions(plan, "start")}
        onChange={(choice) =>
          updatePlan((d) => {
            const target = d.accounts[i].contributions[e];
            target.start = choiceToBoundary(choice, target.start);
          })
        }
      />
      {typeof entry.start === "object" && "Date" in entry.start && (
        <YearMonthField
          label="Start month"
          value={entry.start.Date}
          onChange={(date) =>
            updatePlan((d) => {
              d.accounts[i].contributions[e].start = { Date: date };
            })
          }
        />
      )}
      <SelectField
        label="Ends"
        value={boundaryToChoice(entry.end)}
        options={boundaryOptions(plan, "end")}
        hint={contributionEndHint(account.plan_type)}
        onChange={(choice) =>
          updatePlan((d) => {
            const target = d.accounts[i].contributions[e];
            target.end = choiceToBoundary(choice, target.end);
          })
        }
      />
      {typeof entry.end === "object" && "Date" in entry.end && (
        <YearMonthField
          label="End month"
          value={entry.end.Date}
          onChange={(date) =>
            updatePlan((d) => {
              d.accounts[i].contributions[e].end = { Date: date };
            })
          }
        />
      )}
      <button
        type="button"
        className="remove"
        onClick={() =>
          updatePlan((d) => {
            d.accounts[i].contributions.splice(e, 1);
          })
        }
      >
        Remove contribution
      </button>
    </fieldset>
  );
}
