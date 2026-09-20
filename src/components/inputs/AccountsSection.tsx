import { useEffect, useRef, useState } from "react";
import { forgetAccount, penaltyFreeMonth, rule55 } from "../../lib/drawdown";
import { currency, ratePercent, yearMonth } from "../../lib/format";
import { usePlanStore } from "../../store/planStore";
import type { Account } from "../../types/generated/Account";
import type { AllocationRef } from "../../types/generated/AllocationRef";
import type { Plan } from "../../types/generated/Plan";
import type { StrategyRates } from "../../types/generated/StrategyRates";
import type { YearMonth } from "../../types/generated/YearMonth";
import { STRATEGIES, type StrategyVariant } from "./AssumptionsSection";
import {
  contributionSummary,
  defaultContribution,
  NO_CONTRIBUTION,
  newOneTimeContribution,
  takesOutsideMoney,
} from "./accountContribution";
import { ACCOUNT_TYPE_OPTIONS, accountTypeByValue, accountTypeFor } from "./accountTypes";
import { ContributionCard } from "./ContributionCard";
import { EmployerMatchFields } from "./EmployerMatchFields";
import {
  CheckboxField,
  NumberField,
  PercentField,
  SelectField,
  TextField,
} from "./fields";
import { OneTimeContributionCard } from "./OneTimeContributionCard";
import { FACT_VS_POLICY } from "./shared";

/** A sensible starting rate for a newly-typed Savings account. */
const DEFAULT_SAVINGS_RATE = 0.02;

/** The picker value standing for "a rate I type", rather than a strategy. */
const FIXED_RATE = "FixedRate";

type AllocationChoice = StrategyVariant | typeof FIXED_RATE;

/**
 * Which row of the picker an allocation is on. Total, unlike the version
 * before #129: with `Custom` gone, an allocation is either a strategy name
 * or a fixed rate, so a fixed-rate account no longer falls through to
 * reading "Moderate" in a select it never chose.
 */
function allocationChoice(allocation: AllocationRef): AllocationChoice {
  return typeof allocation === "string" ? allocation : FIXED_RATE;
}

/**
 * Labels name the rate, not an asset mix: "Aggressive (90/10)" described
 * weights that no longer exist, and the return is the thing picking a
 * strategy actually decides.
 */
function allocationOptions(returns: StrategyRates) {
  return [
    ...STRATEGIES.map(({ key, variant }) => ({
      value: variant,
      label: `${variant} (${ratePercent(returns[key])})`,
    })),
    { value: FIXED_RATE, label: "Fixed rate…" },
  ];
}

function allocationLabel(allocation: AllocationRef, returns: StrategyRates): string {
  if (typeof allocation === "object") {
    return `Fixed ${ratePercent(allocation.FixedRate)}`;
  }
  const strategy = STRATEGIES.find((s) => s.variant === allocation);
  return strategy ? `${allocation} (${ratePercent(returns[strategy.key])})` : allocation;
}

/**
 * What the Rule of 55 checkbox says under itself: whether the election would
 * hold, and from when — the same check the engine makes, so a date that
 * does not qualify is visible here before it is a warning on the Plan
 * screen.
 */
function rule55Hint(plan: Plan, account: Account): string {
  const owner = plan.people.find((p) => p.id === account.owner);
  const name = owner?.name || "The owner";
  const without = owner
    ? ` Without it, withdrawals before ${yearMonth(penaltyFreeMonth(owner))} (59½) pay a 10% penalty.`
    : "";
  const check = rule55(plan, account);
  if (check.eligible) {
    return `Leaving this employer in or after the year they turn 55 lets ${name} withdraw from its plan without the 10% penalty, if the plan allows it. This scenario's retirement date qualifies from ${yearMonth(check.from)}.${without}`;
  }
  return check.reason === "SeparatedBefore55"
    ? `Only applies when ${name} leaves this employer in or after the calendar year they turn 55, and this scenario retires them earlier — so the penalty still applies.${without}`
    : `Only a 401(k), 403(b) or similar employer plan qualifies.${without}`;
}

/**
 * The balance sheet as a table — the task here is comparing accounts to each
 * other, which a masonry card grid could not do. Selecting a row opens an
 * editor below for everything that belongs to the account: type, owner,
 * allocation, balance, what goes into it, and any employer match.
 *
 * Contributions lived on the owner's card in the People pane for a while,
 * on the argument that saving is part of the paycheck story and stops at
 * retirement. Dated entries ended that: an entry now carries its own window
 * and can outlive a retirement, so the 3% on a savings account and the
 * match on a 401(k) read as facts about the account — which is where the
 * data model always kept them.
 */
export function AccountsSection() {
  const plan = usePlanStore((s) => s.plan);
  const presets = usePlanStore((s) => s.presets);
  const household = usePlanStore((s) => s.household);
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

  // The household's own reading of this account's last balance, not the
  // plan's start date — a partially refreshed household can have accounts
  // at different ages (#111). Falls back to the plan's start for an account
  // the household hasn't fetched yet (still loading, or added this session
  // and not yet saved).
  const accountAsOf = (accountId: string): YearMonth => {
    const observations = household?.accounts.find(
      (a) => a.id === accountId,
    )?.observations;
    return observations?.[observations.length - 1]?.as_of ?? plan.sim_config.start;
  };

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
        one_time_contributions: [],
        employer_match: null,
        rule_of_55: false,
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
                  <th>Contributing</th>
                  <th className="num">Balance</th>
                  <th>As of</th>
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
                    <td>
                      {allocationLabel(
                        account.allocation,
                        plan.assumptions.strategy_returns,
                      )}
                    </td>
                    <td>{contributionSummary(account)}</td>
                    <td className="num">{currency(account.balance)}</td>
                    <td>{yearMonth(accountAsOf(account.id))}</td>
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
          <p className="field-hint">{FACT_VS_POLICY.account}</p>
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
                const wasRoth = account.kind === "Roth";
                account.kind = type.kind;
                account.plan_type = type.planType;
                // A taxable account's basis, or a Roth's contributions — the
                // after-tax dollars in it. A Roth moving between an IRA and
                // an employer plan keeps what was entered; anything else
                // starts blank, which reads as all earnings.
                if (type.kind === "Taxable") {
                  account.cost_basis ??= account.balance;
                } else if (type.kind !== "Roth" || !wasRoth) {
                  account.cost_basis = null;
                }
                if (type.planType !== "EmployerPlan") {
                  account.rule_of_55 = false;
                }
                // A newly-typed Savings account starts on a savings rate
                // rather than a market strategy. Leaving the Savings type no
                // longer rewrites it: since #129 a fixed rate is legal on
                // any kind, so replacing a rate the user typed with a preset
                // nobody chose would be the wrong move.
                if (type.kind === "Savings" && !wasSavings) {
                  account.allocation = { FixedRate: DEFAULT_SAVINGS_RATE };
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
                      entry.rule = NO_CONTRIBUTION;
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
                const account = d.accounts[selectedIndex];
                // "Until the owner retires" means *this* account's owner —
                // handing the account to someone else has to carry those
                // boundaries with it, or the entries silently keep running
                // to a date that no longer has anything to do with them.
                for (const entry of account.contributions) {
                  for (const edge of ["start", "end"] as const) {
                    const boundary = entry[edge];
                    if (
                      typeof boundary === "object" &&
                      "AtRetirement" in boundary &&
                      boundary.AtRetirement === account.owner
                    ) {
                      entry[edge] = { AtRetirement: owner };
                    }
                  }
                }
                account.owner = owner;
              })
            }
          />
          <SelectField
            label="Allocation"
            value={allocationChoice(selected.allocation)}
            options={allocationOptions(plan.assumptions.strategy_returns)}
            onChange={(choice) =>
              updatePlan((d) => {
                d.accounts[selectedIndex].allocation =
                  choice === FIXED_RATE
                    ? { FixedRate: DEFAULT_SAVINGS_RATE }
                    : (choice as StrategyVariant);
              })
            }
          />
          {typeof selected.allocation === "object" && (
            <PercentField
              label="Fixed rate"
              rate={selected.allocation.FixedRate}
              minPercent={0}
              maxPercent={30}
              hint="A rate this account grows at every year, instead of one of the plan's investment strategies — a bank savings or money-market rate, a CD ladder, or a mix the three strategies don't describe."
              onChange={(rate) =>
                updatePlan((d) => {
                  d.accounts[selectedIndex].allocation = { FixedRate: rate };
                })
              }
            />
          )}
          <NumberField
            label={`Balance as of ${yearMonth(accountAsOf(selected.id))} ($)`}
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
          {selected.kind === "Roth" && (
            <NumberField
              label="Contributions to date ($)"
              value={selected.cost_basis ?? 0}
              hint="What you've put in, not what it has grown to. Before 59½ contributions come back tax- and penalty-free while earnings pay income tax and the 10% penalty, so this decides what the account can bridge. Left at 0, the whole balance counts as earnings."
              onChange={(contributions) =>
                updatePlan((d) => {
                  d.accounts[selectedIndex].cost_basis = contributions;
                })
              }
            />
          )}
          {selected.plan_type === "EmployerPlan" &&
            (selected.kind === "TraditionalPreTax" || selected.kind === "Roth") && (
              <CheckboxField
                label="Withdraw under the Rule of 55"
                checked={selected.rule_of_55}
                hint={rule55Hint(plan, selected)}
                onChange={(checked) =>
                  updatePlan((d) => {
                    d.accounts[selectedIndex].rule_of_55 = checked;
                  })
                }
              />
            )}
          <div className="band">
            <p className="band-label">Contributions</p>
            {selected.contributions.length === 0 &&
              selected.one_time_contributions.length === 0 && (
                <p className="field-hint">Nothing goes into this account yet.</p>
              )}
            {selected.contributions.map((entry, entryIndex) => (
              <ContributionCard
                key={entry.id}
                plan={plan}
                accountIndex={selectedIndex}
                entryIndex={entryIndex}
                presets={presets}
                updatePlan={updatePlan}
              />
            ))}
            <button
              type="button"
              className="add"
              onClick={() =>
                updatePlan((d) => {
                  const account = d.accounts[selectedIndex];
                  account.contributions.push({
                    id: `contribution-${Date.now()}`,
                    name: "",
                    rule: NO_CONTRIBUTION,
                    start: "PlanStart",
                    end: { AtRetirement: account.owner },
                  });
                })
              }
            >
              Add contribution
            </button>
            {/* Shown wherever there are entries — even on an account retyped to
                one that can't take them, so validation's complaint has a card
                to point at and the entry stays removable. Only an account that
                can take money from outside the plan offers to add one. */}
            {selected.one_time_contributions.map((entry, entryIndex) => (
              <OneTimeContributionCard
                key={`one-time:${entry.id}`}
                plan={plan}
                accountIndex={selectedIndex}
                entryIndex={entryIndex}
                updatePlan={updatePlan}
              />
            ))}
            {takesOutsideMoney(selected) && (
              <button
                type="button"
                className="add"
                onClick={() =>
                  updatePlan((d) => {
                    d.accounts[selectedIndex].one_time_contributions.push(
                      newOneTimeContribution(d),
                    );
                  })
                }
              >
                Add one-time contribution
              </button>
            )}
          </div>
          {selected.plan_type === "EmployerPlan" && (
            <div className="band">
              <p className="band-label">Employer match</p>
              <EmployerMatchFields
                account={selected}
                accountIndex={selectedIndex}
                updatePlan={updatePlan}
              />
            </div>
          )}
          <button
            type="button"
            className="remove"
            onClick={() =>
              updatePlan((d) => {
                forgetAccount(d, d.accounts[selectedIndex].id);
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
