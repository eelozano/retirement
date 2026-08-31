import { useEffect, useRef, useState } from "react";
import { currency } from "../../lib/format";
import { usePlanStore } from "../../store/planStore";
import type { AccountKind } from "../../types/generated/AccountKind";
import type { AllocationRef } from "../../types/generated/AllocationRef";
import type { PlanType } from "../../types/generated/PlanType";
import { NumberField, SelectField, TextField } from "./fields";

const KIND_OPTIONS = [
  { value: "Taxable", label: "Taxable brokerage" },
  { value: "TraditionalPreTax", label: "Pre-tax (401k / Trad IRA)" },
  { value: "Roth", label: "Roth" },
] as const;

const KIND_LABELS: Record<AccountKind, string> = {
  Taxable: "Taxable",
  TraditionalPreTax: "Pre-tax",
  Roth: "Roth",
};

// Only the two capped buckets are offered: `None` is not a choice a user
// makes, it is what a taxable brokerage is, so the control is hidden there
// entirely rather than offering an option that validation would reject.
const PLAN_TYPE_OPTIONS = [
  // Kept short: the select is 150px, and "Employer plan (401k / 403b)"
  // truncated mid-word to "Employer plan (401".
  { value: "EmployerPlan", label: "401(k) / 403(b)" },
  { value: "Ira", label: "IRA" },
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

function allocationLabel(allocation: AllocationRef): string {
  const name = allocationName(allocation);
  return ALLOCATION_OPTIONS.find((o) => o.value === name)?.label ?? name;
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

/**
 * The balance sheet as a table — the task here is comparing accounts to each
 * other, which a masonry card grid could not do. Selecting a row opens an
 * editor below for the fields that belong to the account itself: type,
 * owner, allocation, balance. Contribution and employer match moved to the
 * owner's card in the People pane — what you put in is part of the paycheck
 * story and stops at retirement, unlike the account's balance sheet facts.
 */
export function AccountsSection() {
  const plan = usePlanStore((s) => s.plan);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const editorRef = useRef<HTMLFieldSetElement>(null);
  // The editor sits below a table that can run long, so selecting a row (or
  // adding one) can leave it below the fold with no visible cue that it
  // exists — scroll it into view whenever the selection changes.
  useEffect(() => {
    if (selectedId) {
      editorRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
  }, [selectedId]);
  if (!plan) return null;

  const accounts = plan.accounts;
  // Falls back to the first account whenever `selectedId` is unset or no
  // longer exists (nothing selected yet, or the selected account was just
  // removed) rather than leaving the editor empty.
  const selected = accounts.find((a) => a.id === selectedId) ?? accounts[0] ?? null;
  const selectedIndex = selected ? accounts.findIndex((a) => a.id === selected.id) : -1;

  const addAccount = () => {
    const id = `account-${Date.now()}`;
    updatePlan((d) => {
      d.accounts.push({
        id,
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
    setSelectedId(id);
  };

  return (
    <div className="pane-section">
      <div className="pane-head">
        <h3>Accounts</h3>
        <p>
          The balance sheet, as a table for comparing accounts to each other. Select a row
          to edit it below.
        </p>
      </div>

      <div className="input-card">
        {accounts.length === 0 ? (
          <p className="field-hint">No accounts yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="input-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th>Owner</th>
                  <th>Allocation</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr
                    key={account.id}
                    data-selected={account.id === selected?.id}
                    // The button in the first cell is the accessible control
                    // (keyboard-reachable, has a clear name); this handler is
                    // a mouse-only convenience so the *whole* row responds,
                    // not just the account name's text.
                    onClick={() => setSelectedId(account.id)}
                  >
                    <td>
                      <button
                        type="button"
                        className="row-select"
                        aria-current={account.id === selected?.id ? "true" : undefined}
                        onClick={() => setSelectedId(account.id)}
                      >
                        {account.name || "Untitled account"}
                      </button>
                    </td>
                    <td>{KIND_LABELS[account.kind]}</td>
                    <td>
                      {plan.people.find((p) => p.id === account.owner)?.name ?? "—"}
                    </td>
                    <td>{allocationLabel(account.allocation)}</td>
                    <td className="num">{currency(account.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button type="button" className="add" onClick={addAccount}>
          Add account
        </button>
      </div>

      {selected && (
        <fieldset className="input-card" key={selected.id} ref={editorRef}>
          <legend>Editing: {selected.name || "Untitled account"}</legend>
          <TextField
            label="Name"
            value={selected.name}
            onChange={(name) =>
              updatePlan((d) => {
                d.accounts[selectedIndex].name = name;
              })
            }
          />
          <SelectField
            label="Type"
            value={selected.kind}
            options={KIND_OPTIONS}
            onChange={(kind: AccountKind) =>
              updatePlan((d) => {
                d.accounts[selectedIndex].kind = kind;
                if (kind !== "Taxable") d.accounts[selectedIndex].cost_basis = null;
                else
                  d.accounts[selectedIndex].cost_basis ??=
                    d.accounts[selectedIndex].balance;
                // Retyping an account re-picks its statutory bucket: the old
                // kind's bucket is meaningless under the new one, and a
                // taxable brokerage has no federal maximum to resolve.
                d.accounts[selectedIndex].plan_type = defaultPlanType(kind);
                if (
                  kind === "Taxable" &&
                  d.accounts[selectedIndex].contribution === "FederalMaximum"
                ) {
                  d.accounts[selectedIndex].contribution = { FlatAmount: 0 };
                }
              })
            }
          />
          {selected.plan_type !== "None" && (
            <SelectField
              label="Plan type"
              value={selected.plan_type}
              options={PLAN_TYPE_OPTIONS}
              hint="Which statutory limit this account shares. A 401(k) and an IRA are capped separately even when they are taxed the same way."
              onChange={(planType: PlanType) =>
                updatePlan((d) => {
                  d.accounts[selectedIndex].plan_type = planType;
                  if (planType !== "EmployerPlan") {
                    d.accounts[selectedIndex].employer_match = null;
                  }
                })
              }
            />
          )}
          <SelectField
            label="Owner"
            value={selected.owner}
            options={plan.people.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(owner) =>
              updatePlan((d) => {
                d.accounts[selectedIndex].owner = owner;
              })
            }
          />
          <SelectField
            label="Allocation"
            value={allocationName(selected.allocation)}
            options={ALLOCATION_OPTIONS}
            onChange={(preset) =>
              updatePlan((d) => {
                d.accounts[selectedIndex].allocation = preset;
              })
            }
          />
          <NumberField
            label="Balance today ($)"
            value={selected.balance}
            onChange={(balance) =>
              updatePlan((d) => {
                d.accounts[selectedIndex].balance = balance;
              })
            }
          />
          {selected.kind === "Taxable" && (
            <NumberField
              label="Cost basis ($)"
              value={selected.cost_basis ?? 0}
              onChange={(basis) =>
                updatePlan((d) => {
                  d.accounts[selectedIndex].cost_basis = basis;
                })
              }
            />
          )}
          <p className="field-hint">
            What this account's owner puts into it lives on their card in the People pane.
          </p>
          <button
            type="button"
            className="remove"
            onClick={() =>
              updatePlan((d) => {
                d.accounts.splice(selectedIndex, 1);
              })
            }
          >
            Remove account
          </button>
        </fieldset>
      )}
    </div>
  );
}
