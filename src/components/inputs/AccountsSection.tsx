import { currency } from "../../lib/format";
import { usePlanStore } from "../../store/planStore";
import type { AccountKind } from "../../types/generated/AccountKind";
import type { AllocationRef } from "../../types/generated/AllocationRef";
import type { ContributionRule } from "../../types/generated/ContributionRule";
import type { EmployerMatch } from "../../types/generated/EmployerMatch";
import type { MatchDestination } from "../../types/generated/MatchDestination";
import type { PlanType } from "../../types/generated/PlanType";
import type { Presets } from "../../types/generated/Presets";
import {
  CheckboxField,
  NumberField,
  PercentField,
  SelectField,
  TextField,
} from "./fields";

const KIND_OPTIONS = [
  { value: "Taxable", label: "Taxable brokerage" },
  { value: "TraditionalPreTax", label: "Pre-tax (401k / Trad IRA)" },
  { value: "Roth", label: "Roth" },
] as const;

// Only the two capped buckets are offered: `None` is not a choice a user
// makes, it is what a taxable brokerage is, so the control is hidden there
// entirely rather than offering an option that validation would reject.
const PLAN_TYPE_OPTIONS = [
  // Kept short: the select is 150px, and "Employer plan (401k / 403b)"
  // truncated mid-word to "Employer plan (401".
  { value: "EmployerPlan", label: "401(k) / 403(b)" },
  { value: "Ira", label: "IRA" },
] as const;

const MATCH_DESTINATIONS = [
  { value: "PreTax", label: "Pre-tax" },
  { value: "Roth", label: "Roth" },
] as const;

/**
 * A new match starts as the single most common formula — 100% of the first
 * 3% — rather than empty, so switching it on produces a working plan and the
 * one-tier case needs no assembly. More tiers are added below it.
 */
const DEFAULT_MATCH: EmployerMatch = {
  tiers: [{ employee_percent: 0.03, match_percent: 1.0 }],
  destination: "PreTax",
};

const CONTRIBUTION_MODES = [
  { value: "PercentOfSalary", label: "Percent of salary" },
  { value: "FlatAmount", label: "Flat amount" },
  { value: "FederalMaximum", label: "Federal maximum" },
] as const;

type ContributionMode = (typeof CONTRIBUTION_MODES)[number]["value"];

const ALLOCATION_OPTIONS = [
  { value: "Aggressive", label: "Aggressive (90/10)" },
  { value: "Moderate", label: "Moderate (70/30)" },
  { value: "Conservative", label: "Conservative (50/50)" },
] as const;

type PresetName = (typeof ALLOCATION_OPTIONS)[number]["value"];

function allocationName(allocation: AllocationRef): PresetName {
  return typeof allocation === "string" ? allocation : "Moderate";
}

/**
 * Statutory bucket a new (or retyped) account starts in. Mirrors
 * `PlanType::default_for` in Rust — a UI default, not a statutory figure,
 * so it is safe to state here; the limits themselves are never hardcoded.
 */
function defaultPlanType(kind: AccountKind): PlanType {
  if (kind === "Taxable") return "None";
  return kind === "Roth" ? "Ira" : "EmployerPlan";
}

function contributionMode(rule: ContributionRule): ContributionMode {
  if (rule === "FederalMaximum") return "FederalMaximum";
  return "PercentOfSalary" in rule ? "PercentOfSalary" : "FlatAmount";
}

/**
 * The mode's own default when the user switches to it. Switching starts each
 * mode from zero rather than trying to convert — a percentage and a dollar
 * figure are not the same input, and a silently converted number would look
 * like a value the user had entered.
 */
function ruleForMode(mode: ContributionMode): ContributionRule {
  if (mode === "FederalMaximum") return "FederalMaximum";
  return mode === "PercentOfSalary" ? { PercentOfSalary: 0 } : { FlatAmount: 0 };
}

/**
 * What "federal maximum" resolves to today, so the number is visible before
 * a projection runs — with the tax year it is published for. The app is
 * local-first with no network, so the figures are as current as the release
 * and the basis year says which one that is.
 */
function federalMaximumHint(presets: Presets | null, planType: PlanType): string {
  const limits = presets?.contribution_limits;
  if (!limits || planType === "None") return "";
  const base = planType === "Ira" ? limits.ira : limits.employer_plan;
  return `${currency(base)}/yr in ${limits.basis_year}, indexed for inflation and stepped up from age 50.`;
}

export function AccountsSection() {
  const plan = usePlanStore((s) => s.plan);
  const presets = usePlanStore((s) => s.presets);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  if (!plan) return null;

  const addAccount = () =>
    updatePlan((d) => {
      d.accounts.push({
        id: `account-${Date.now()}`,
        owner: d.people[0]?.id ?? "",
        kind: "Taxable",
        name: "New account",
        balance: 0,
        cost_basis: 0,
        allocation: "Moderate",
        plan_type: defaultPlanType("Taxable"),
        contribution: { FlatAmount: 0 },
        employer_match: null,
      });
    });

  return (
    <details className="input-section" open>
      <summary>Accounts</summary>
      {plan.accounts.map((account, i) => {
        const mode = contributionMode(account.contribution);
        return (
          <fieldset key={account.id}>
            <legend>{account.name || `Account ${i + 1}`}</legend>
            <TextField
              label="Name"
              value={account.name}
              onChange={(name) =>
                updatePlan((d) => {
                  d.accounts[i].name = name;
                })
              }
            />
            <SelectField
              label="Type"
              value={account.kind}
              options={KIND_OPTIONS}
              onChange={(kind: AccountKind) =>
                updatePlan((d) => {
                  d.accounts[i].kind = kind;
                  if (kind !== "Taxable") d.accounts[i].cost_basis = null;
                  else d.accounts[i].cost_basis ??= d.accounts[i].balance;
                  // Retyping an account re-picks its statutory bucket: the
                  // old kind's bucket is meaningless under the new one, and
                  // a taxable brokerage has no federal maximum to resolve.
                  d.accounts[i].plan_type = defaultPlanType(kind);
                  if (
                    kind === "Taxable" &&
                    d.accounts[i].contribution === "FederalMaximum"
                  ) {
                    d.accounts[i].contribution = { FlatAmount: 0 };
                  }
                })
              }
            />
            {account.plan_type !== "None" && (
              <SelectField
                label="Plan type"
                value={account.plan_type}
                options={PLAN_TYPE_OPTIONS}
                hint="Which statutory limit this account shares. A 401(k) and an IRA are capped separately even when they are taxed the same way."
                onChange={(planType: PlanType) =>
                  updatePlan((d) => {
                    d.accounts[i].plan_type = planType;
                    if (planType !== "EmployerPlan") {
                      d.accounts[i].employer_match = null;
                    }
                  })
                }
              />
            )}
            <SelectField
              label="Owner"
              value={account.owner}
              options={plan.people.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(owner) =>
                updatePlan((d) => {
                  d.accounts[i].owner = owner;
                })
              }
            />
            <SelectField
              label="Allocation"
              value={allocationName(account.allocation)}
              options={ALLOCATION_OPTIONS}
              onChange={(preset) =>
                updatePlan((d) => {
                  d.accounts[i].allocation = preset;
                })
              }
            />
            <NumberField
              label="Balance today ($)"
              value={account.balance}
              onChange={(balance) =>
                updatePlan((d) => {
                  d.accounts[i].balance = balance;
                })
              }
            />
            {account.kind === "Taxable" && (
              <NumberField
                label="Cost basis ($)"
                value={account.cost_basis ?? 0}
                onChange={(basis) =>
                  updatePlan((d) => {
                    d.accounts[i].cost_basis = basis;
                  })
                }
              />
            )}
            <SelectField
              label="Contribution"
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
              onChange={(next: ContributionMode) =>
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
                    d.accounts[i].employer_match = on
                      ? structuredClone(DEFAULT_MATCH)
                      : null;
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
                  // Tiers are an ordered list with no identity of their own,
                  // so position is the key. Reordering is not offered —
                  // "the first 3%, then the next 2%" is what the order means.
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
            <button
              type="button"
              className="remove"
              onClick={() =>
                updatePlan((d) => {
                  d.accounts.splice(i, 1);
                })
              }
            >
              Remove account
            </button>
          </fieldset>
        );
      })}
      <button type="button" className="add" onClick={addAccount}>
        Add account
      </button>
    </details>
  );
}
