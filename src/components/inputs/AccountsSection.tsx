import type { AccountKind } from "../../types/generated/AccountKind";
import type { AllocationRef } from "../../types/generated/AllocationRef";
import { usePlanStore } from "../../store/planStore";
import { NumberField, SelectField, TextField } from "./fields";

const KIND_OPTIONS = [
  { value: "Taxable", label: "Taxable brokerage" },
  { value: "TraditionalPreTax", label: "Pre-tax (401k / Trad IRA)" },
  { value: "Roth", label: "Roth" },
] as const;

const ALLOCATION_OPTIONS = [
  { value: "Aggressive", label: "Aggressive (90/10)" },
  { value: "Moderate", label: "Moderate (70/30)" },
  { value: "Conservative", label: "Conservative (50/50)" },
] as const;

type PresetName = (typeof ALLOCATION_OPTIONS)[number]["value"];

function allocationName(allocation: AllocationRef): PresetName {
  return typeof allocation === "string" ? allocation : "Moderate";
}

export function AccountsSection() {
  const plan = usePlanStore((s) => s.plan);
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
        annual_contribution: 0,
        contribution_limit: null,
      });
    });

  return (
    <details className="drawer-section" open>
      <summary>Accounts</summary>
      {plan.accounts.map((account, i) => (
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
              })
            }
          />
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
          <NumberField
            label="Contribution / yr ($)"
            value={account.annual_contribution}
            onChange={(amount) =>
              updatePlan((d) => {
                d.accounts[i].annual_contribution = amount;
              })
            }
          />
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
      ))}
      <button type="button" className="add" onClick={addAccount}>
        Add account
      </button>
    </details>
  );
}
