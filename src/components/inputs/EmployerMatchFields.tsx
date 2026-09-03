import type { Account } from "../../types/generated/Account";
import type { MatchDestination } from "../../types/generated/MatchDestination";
import { DEFAULT_MATCH, MATCH_DESTINATIONS } from "./accountContribution";
import { CheckboxField, PercentField, SelectField } from "./fields";
import type { UpdatePlan } from "./shared";

/**
 * The employer's side of an employer plan: whether there is a match, what
 * it goes in as, and the tiered formula. Only an `EmployerPlan` has one, so
 * the caller renders this band only for that bucket.
 */
export function EmployerMatchFields(props: {
  account: Account;
  accountIndex: number;
  updatePlan: UpdatePlan;
}) {
  const { account, accountIndex: i, updatePlan } = props;
  const match = account.employer_match;

  return (
    <>
      <CheckboxField
        label="Employer match"
        checked={match !== null}
        hint={
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
            label="Match goes in as"
            value={match.destination}
            options={MATCH_DESTINATIONS}
            hint="A pre-tax match reduces this year's taxable income; a Roth match does not. It lands in an employer-plan account of that kind."
            onChange={(destination: MatchDestination) =>
              updatePlan((d) => {
                const draft = d.accounts[i].employer_match;
                if (draft) draft.destination = destination;
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
              {match.tiers.length > 1 && (
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
