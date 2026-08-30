import { currency } from "../../lib/format";
import { usePlanStore } from "../../store/planStore";
import type { AccountKind } from "../../types/generated/AccountKind";
import type { AllocationRef } from "../../types/generated/AllocationRef";
import type { ContributionRule } from "../../types/generated/ContributionRule";
import type { PlanType } from "../../types/generated/PlanType";
import type { Presets } from "../../types/generated/Presets";
import { NumberField, PercentField, SelectField, TextField } from "./fields";

const KIND_OPTIONS = [
  { value: "Taxable", label: "Taxable brokerage" },
  { value: "TraditionalPreTax", label: "Pre-tax (401k / Trad IRA)" },
  { value: "Roth", label: "Roth" },
] as const;

// Only the two capped buckets are offered: `None` is not a choice a user
// makes, it is what a taxable brokerage is, so the control is hidden there
// entirely rather than offering an option that validation would reject.
const PLAN_TYPE_OPTIONS = [
  { value: "EmployerPlan", label: "Employer plan (401k / 403b)" },
  { value: "Ira", label: "IRA" },
] as const;

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
