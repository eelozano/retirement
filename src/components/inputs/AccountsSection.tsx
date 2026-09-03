import { useEffect, useRef, useState } from "react";
import { currency } from "../../lib/format";
import { usePlanStore } from "../../store/planStore";
import type { AllocationRef } from "../../types/generated/AllocationRef";
import { defaultContribution } from "./accountContribution";
import { ACCOUNT_TYPE_OPTIONS, accountTypeByValue, accountTypeFor } from "./accountTypes";
import { NumberField, PercentField, SelectField, TextField } from "./fields";

/** A sensible starting rate for a newly-typed Savings account. */
const DEFAULT_SAVINGS_RATE = 0.02;

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
  if (typeof allocation === "object" && "Cash" in allocation) {
    return `Cash (${(allocation.Cash * 100).toFixed(1)}%)`;
  }
  const name = allocationName(allocation);
  return ALLOCATION_OPTIONS.find((o) => o.value === name)?.label ?? name;
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
      const owner = d.people[0]?.id ?? "";
      d.accounts.push({
        id,
        owner,
        kind: "Taxable",
        name: "New account",
        balance: 0,
        cost_basis: 0,
        allocation: "Moderate",
        plan_type: "None",
        contributions: [defaultContribution({ id, owner })],
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
                    <td>
                      {accountTypeFor(account.kind, account.plan_type)?.label ??
                        account.kind}
                    </td>
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
            value={accountTypeFor(selected.kind, selected.plan_type)?.value ?? "taxable"}
            options={ACCOUNT_TYPE_OPTIONS}
            hint={accountTypeFor(selected.kind, selected.plan_type)?.description}
            onChange={(value) =>
              updatePlan((d) => {
                const type = accountTypeByValue(value);
                if (!type) return;
                const account = d.accounts[selectedIndex];
                const wasSavings = account.kind === "Savings";
                account.kind = type.kind;
                account.plan_type = type.planType;
                if (type.kind === "Taxable") {
                  account.cost_basis ??= account.balance;
                } else {
                  account.cost_basis = null;
                }
                // A Savings account grows at its own rate instead of a
                // market allocation; leaving a Savings type returns it to a
                // market preset, since "Cash" is otherwise not offered.
                if (type.kind === "Savings" && !wasSavings) {
                  account.allocation = { Cash: DEFAULT_SAVINGS_RATE };
                } else if (
                  type.kind !== "Savings" &&
                  typeof account.allocation === "object"
                ) {
                  account.allocation = "Moderate";
                }
                // Retyping an account re-picks its statutory bucket: the old
                // bucket may be meaningless under the new one, and an
                // uncapped account has no federal maximum to resolve.
                if (type.planType !== "EmployerPlan") {
                  account.employer_match = null;
                }
                if (type.planType === "None") {
                  for (const entry of account.contributions) {
                    if (entry.rule === "FederalMaximum") {
                      entry.rule = { FlatAmount: { amount: 0 } };
                    }
                  }
                }
              })
            }
          />
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
          {typeof selected.allocation === "object" && "Cash" in selected.allocation ? (
            <PercentField
              label="Interest rate"
              rate={selected.allocation.Cash}
              minPercent={0}
              maxPercent={20}
              hint="A fixed rate this account grows at every year, instead of a market-return allocation — a bank savings or money-market rate."
              onChange={(rate) =>
                updatePlan((d) => {
                  d.accounts[selectedIndex].allocation = { Cash: rate };
                })
              }
            />
          ) : (
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
          )}
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
