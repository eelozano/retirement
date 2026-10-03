import type { Account } from "../../types/generated/Account";
import type { MatchDestination } from "../../types/generated/MatchDestination";
import type { Plan } from "../../types/generated/Plan";
import {
  automaticDeposit,
  DEFAULT_MATCH,
  depositCandidates,
  MATCH_DESTINATIONS,
} from "./accountContribution";
import { CheckboxField, PercentField, SelectField } from "./fields";
import type { UpdatePlan } from "./shared";

/**
 * The employer's side of an employer plan: whether the employer puts
 * anything in, what it goes in as, the percent it adds outright and the
 * tiered match on top. Only an `EmployerPlan` has one, so the caller
 * renders this band only for that bucket.
 *
 * The two halves are shown in the order a plan document reads them: what
 * the employer gives regardless comes first, then what it gives back for
 * deferring. A plan with only one of them leaves the other at zero — and a
 * non-elective-only plan removes the last tier, which is why the remove
 * button is offered on a single tier once the percent is set.
 *
 * Which account the money is paid into (#175) is a separate choice from
 * what it goes in as. Left on automatic it is the engine's own rule, named
 * in the option so "the first account that fits" is never an accident; an
 * employer that keeps its own contract, or a pre-tax match on a Roth
 * deferral with an old 401(k) listed first, names the account instead.
 */
export function EmployerMatchFields(props: {
  plan: Plan;
  account: Account;
  accountIndex: number;
  updatePlan: UpdatePlan;
}) {
  const { plan, account, accountIndex: i, updatePlan } = props;
  const match = account.employer_match;

  return (
    <>
      <CheckboxField
        label="Employer contributions"
        checked={match !== null}
        tooltip={
          match !== null
            ? "Employer money: it does not count against your own contribution limit, only against the much higher cap on everything going into the plan."
            : undefined
        }
        onChange={(on) =>
          updatePlan((d) => {
            d.accounts[i].employer_match = on ? structuredClone(DEFAULT_MATCH) : null;
          })
        }
      />
      {match !== null && (
        <>
          <SelectField
            label="Employer money goes in as"
            value={match.destination}
            options={MATCH_DESTINATIONS}
            tooltip="Pre-tax employer money reduces this year's taxable income; Roth does not. It lands in an employer-plan account of that kind."
            onChange={(destination: MatchDestination) =>
              updatePlan((d) => {
                const draft = d.accounts[i].employer_match;
                if (!draft) return;
                draft.destination = destination;
                // A named account of the other kind can't take this money
                // any more; back to automatic rather than a validation error.
                const named = draft.deposit_into;
                if (
                  named !== null &&
                  !depositCandidates(d, d.accounts[i], destination).some(
                    (a) => a.id === named,
                  )
                ) {
                  draft.deposit_into = null;
                }
              })
            }
          />
          <SelectField
            label="Paid into"
            value={match.deposit_into ?? AUTOMATIC}
            options={depositOptions(plan, account, match.destination)}
            tooltip="Which account the employer's money lands in. Automatic is this account when it's the right kind, otherwise the first one that fits in the account list. Name one when your employer keeps its money in a contract of its own, or when an old job's plan is listed first."
            onChange={(choice) =>
              updatePlan((d) => {
                const draft = d.accounts[i].employer_match;
                if (draft) draft.deposit_into = choice === AUTOMATIC ? null : choice;
              })
            }
          />
          <PercentField
            label="Employer adds, whatever you contribute"
            rate={match.nonelective_percent}
            minPercent={0}
            maxPercent={100}
            hint="Leave at 0% if your employer only matches."
            tooltip="A percent of salary the employer puts in without asking you to contribute anything — a safe-harbor or profit-sharing contribution."
            onChange={(rate) =>
              updatePlan((d) => {
                const draft = d.accounts[i].employer_match;
                if (draft) draft.nonelective_percent = rate;
              })
            }
          />
          {match.tiers.map((tier, t) => (
            // Tiers are an ordered list with no identity of their own, so
            // position is the key. Reordering is not offered — "the first
            // 3%, then the next 2%" is what the order means.
            // biome-ignore lint/suspicious/noArrayIndexKey: tiers are positional
            <div className="match-tier" key={t}>
              <PercentField
                label={t === 0 ? "Matches the first" : "Then the next"}
                rate={tier.employee_percent}
                minPercent={0}
                maxPercent={100}
                onChange={(rate) =>
                  updatePlan((d) => {
                    const tiers = d.accounts[i].employer_match?.tiers;
                    if (tiers) tiers[t].employee_percent = rate;
                  })
                }
              />
              <PercentField
                label="At a rate of"
                rate={tier.match_percent}
                minPercent={0}
                onChange={(rate) =>
                  updatePlan((d) => {
                    const tiers = d.accounts[i].employer_match?.tiers;
                    if (tiers) tiers[t].match_percent = rate;
                  })
                }
              />
              {(match.tiers.length > 1 || match.nonelective_percent > 0) && (
                <button
                  type="button"
                  className="remove"
                  onClick={() =>
                    updatePlan((d) => {
                      d.accounts[i].employer_match?.tiers.splice(t, 1);
                    })
                  }
                >
                  Remove tier
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="add"
            onClick={() =>
              updatePlan((d) => {
                d.accounts[i].employer_match?.tiers.push({
                  employee_percent: 0.02,
                  match_percent: 0.5,
                });
              })
            }
          >
            Add match tier
          </button>
        </>
      )}
    </>
  );
}

/** The "Paid into" sentinel for `deposit_into: null`. Not a valid account
 * id, since ids are lowercase slugs. */
const AUTOMATIC = "Automatic";

function depositOptions(plan: Plan, account: Account, destination: MatchDestination) {
  const automatic = automaticDeposit(plan, account, destination);
  const kind = destination === "Roth" ? "Roth" : "pre-tax";
  return [
    {
      value: AUTOMATIC,
      label: automatic
        ? `Automatic (${automatic.name || "Untitled account"})`
        : `Automatic (no ${kind} employer plan to pay into)`,
    },
    ...depositCandidates(plan, account, destination).map((a) => ({
      value: a.id,
      label: a.name || "Untitled account",
    })),
  ];
}
