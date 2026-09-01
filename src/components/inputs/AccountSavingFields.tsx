import type { Account } from "../../types/generated/Account";
import type { MatchDestination } from "../../types/generated/MatchDestination";
import type { Presets } from "../../types/generated/Presets";
import {
  CONTRIBUTION_MODES,
  contributionMode,
  DEFAULT_MATCH,
  federalMaximumHint,
  MATCH_DESTINATIONS,
  ruleForMode,
} from "./accountContribution";
import { CheckboxField, NumberField, PercentField, SelectField } from "./fields";
import type { UpdatePlan } from "./shared";

/**
 * What an account's owner puts into it, plus any employer match — moved off
 * the account (AccountsSection) and onto the person, since it's part of the
 * paycheck story and stops at retirement, unlike balance/type/allocation.
 */
export function AccountSavingFields(props: {
  account: Account;
  accountIndex: number;
  presets: Presets | null;
  updatePlan: UpdatePlan;
}) {
  const { account, accountIndex: i, presets, updatePlan } = props;
  const mode = contributionMode(account.contribution);

  return (
    <fieldset>
      <legend>Into {account.name || "this account"}</legend>
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
            d.accounts[i].contribution = ruleForMode(next);
          })
        }
      />
      {typeof account.contribution === "object" &&
        "PercentOfSalary" in account.contribution && (
          <PercentField
            label="Of salary"
            rate={account.contribution.PercentOfSalary}
            minPercent={0}
            maxPercent={100}
            onChange={(rate) =>
              updatePlan((d) => {
                d.accounts[i].contribution = { PercentOfSalary: rate };
              })
            }
          />
        )}
      {typeof account.contribution === "object" &&
        "FlatAmount" in account.contribution && (
          <NumberField
            label="Amount / yr ($)"
            value={account.contribution.FlatAmount}
            onChange={(amount) =>
              updatePlan((d) => {
                d.accounts[i].contribution = { FlatAmount: amount };
              })
            }
          />
        )}
      {account.plan_type === "EmployerPlan" && (
        <CheckboxField
          label="Employer match"
          checked={account.employer_match !== null}
          hint={
            account.employer_match !== null
              ? "Employer money: it does not count against your own contribution limit, only against the much higher cap on everything going into the plan."
              : undefined
          }
          onChange={(on) =>
            updatePlan((d) => {
              d.accounts[i].employer_match = on ? structuredClone(DEFAULT_MATCH) : null;
            })
          }
        />
      )}
      {account.employer_match !== null && account.plan_type === "EmployerPlan" && (
        <>
          <SelectField
            label="Match goes in as"
            value={account.employer_match.destination}
            options={MATCH_DESTINATIONS}
            hint="A pre-tax match reduces this year's taxable income; a Roth match does not. It lands in an employer-plan account of that kind."
            onChange={(destination: MatchDestination) =>
              updatePlan((d) => {
                const match = d.accounts[i].employer_match;
                if (match) match.destination = destination;
              })
            }
          />
          {account.employer_match.tiers.map((tier, t) => (
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
              {account.employer_match !== null &&
                account.employer_match.tiers.length > 1 && (
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
    </fieldset>
  );
}
