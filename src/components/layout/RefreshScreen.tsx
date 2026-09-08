import { useState } from "react";
import type { AccountReading, BenefitReading, RateChange } from "../../lib/api";
import { currency, yearMonth } from "../../lib/format";
import { monthsAgoLabel, monthsSince } from "../../lib/staleness";
import { usePlanStore } from "../../store/planStore";
import type { Household } from "../../types/generated/Household";
import type { Plan } from "../../types/generated/Plan";
import type { YearMonth } from "../../types/generated/YearMonth";
import { AmountInput } from "../inputs/fields";
import {
  grownRate,
  listRates,
  monthsBetween,
  type RateEntry,
  refreshMonths,
} from "./refreshRates";

// The "I sat down and updated everything" screen (#111).
//
// One sitting, one date. The household's balances are re-read together and
// dated together, and the projection's start moves to that month — which is
// the only way the plan is about today rather than about whenever the
// household last looked.
//
// The screen is grouped the way the household is, and each group is treated
// according to what kind of number it holds:
//
// - **People** are shown and not edited. A birth month is not a reading, and
//   nothing about it goes stale.
// - **Balances** are readings. Type the new one; the old one and its date
//   stay beside it, and an account left alone keeps both. Nothing is rolled
//   forward for an account nobody re-read.
// - **Rates** — salary, spending, a flat contribution — are stated in the
//   dollars of the month the plan starts, so moving the start re-states them
//   without changing a digit. Every one is listed with what it would take to
//   hold its purchasing power, and the default is to keep it as typed.
//
// Structure, not numbers: an account is added, renamed or removed on the
// Inputs screen. A refresh is what the statements say.

export function RefreshScreen() {
  const plan = usePlanStore((s) => s.plan);
  const household = usePlanStore((s) => s.household);

  if (!plan) return null;
  if (!household) {
    return (
      <main className="charts">
        <section className="card">
          <p className="field-hint">Reading the household…</p>
        </section>
      </main>
    );
  }

  // Remounted whenever the household's as-of moves — i.e. after a refresh
  // lands — so the form re-reads every "previous figure" from the ledger it
  // just wrote instead of holding the sitting that is now history.
  return (
    <RefreshForm
      key={`${plan.id}:${household.as_of.year}-${household.as_of.month}`}
      plan={plan}
      household={household}
    />
  );
}

/** How the user answered one listed rate. `keep` is the default and sends
 * nothing; the other two send the figure shown beside them. */
type RateMode = "keep" | "grow" | "new";

interface RateAnswer {
  mode: RateMode;
  /** What "new" holds. Seeded from the stored figure so the field opens on
   * the number being replaced rather than on zero. */
  typed: number;
  siblings: boolean;
}

function RefreshForm(props: { plan: Plan; household: Household }) {
  const { plan, household } = props;
  const refreshHousehold = usePlanStore((s) => s.refreshHousehold);
  const scenarios = usePlanStore((s) => s.scenarios);

  const months = refreshMonths(household.as_of, new Date());
  const [asOf, setAsOf] = useState<YearMonth>(months[0]);
  const [balances, setBalances] = useState<Record<string, number>>(() =>
    Object.fromEntries(plan.accounts.map((a) => [a.id, a.balance])),
  );
  const [bases, setBases] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      plan.accounts
        .filter((a) => a.cost_basis !== null)
        .map((a) => [a.id, a.cost_basis ?? 0]),
    ),
  );
  const [benefits, setBenefits] = useState<Record<string, number>>(() =>
    Object.fromEntries(plan.social_security.map((b) => [b.id, b.benefit_at_fra])),
  );
  const rates = listRates(plan);
  const [answers, setAnswers] = useState<Record<string, RateAnswer>>(() =>
    Object.fromEntries(
      rates.map((r) => [
        r.key,
        { mode: "keep" as RateMode, typed: r.amount, siblings: false },
      ]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  // Scenarios of *this* household. The sibling rule has nothing to offer
  // when a household has only the one branch, so the checkbox is not shown.
  const siblingCount = scenarios.filter(
    (s) => s.household_id === household.id && s.id !== plan.id,
  ).length;

  const elapsed = monthsBetween(household.as_of, asOf);
  const inflation = plan.assumptions.inflation;
  // What a dollar of the old start's money is worth in the new start's —
  // the sentence the rates section has to make understandable.
  const erosion = 1 - 1 / (1 + inflation) ** (elapsed / 12);

  const answerFor = (rate: RateEntry): RateAnswer =>
    answers[rate.key] ?? { mode: "keep", typed: rate.amount, siblings: false };

  const setAnswer = (key: string, patch: Partial<RateAnswer>) =>
    setAnswers((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? { mode: "keep", typed: 0, siblings: false }), ...patch },
    }));

  const submit = async () => {
    setSaving(true);
    setRefused(null);
    const accounts: AccountReading[] = plan.accounts.map((a) => ({
      id: a.id,
      balance: balances[a.id] ?? a.balance,
      cost_basis: a.cost_basis === null ? null : (bases[a.id] ?? a.cost_basis),
    }));
    const benefitReadings: BenefitReading[] = plan.social_security.map((b) => ({
      id: b.id,
      benefit_at_fra: benefits[b.id] ?? b.benefit_at_fra,
    }));
    // Keep sends nothing at all: an untouched figure is kept as typed, and
    // the backend grows nothing on its own.
    const rateChanges: RateChange[] = rates.flatMap((rate) => {
      const answer = answerFor(rate);
      if (answer.mode === "keep") return [];
      return [
        {
          target: rate.target,
          amount:
            answer.mode === "grow"
              ? grownRate(rate.amount, inflation, elapsed)
              : answer.typed,
          apply_to_siblings: answer.siblings,
        },
      ];
    });

    try {
      await refreshHousehold({
        as_of: asOf,
        accounts,
        benefits: benefitReadings,
        rates: rateChanges,
      });
    } catch (e) {
      // Kept on this screen rather than in the global banner: everything the
      // user typed is still here, and this is where the fix is.
      setRefused(String(e));
    } finally {
      setSaving(false);
    }
  };

  const lastRead = (accountId: string) =>
    household.accounts.find((a) => a.id === accountId)?.observations.slice(-1)[0] ?? null;

  return (
    <main className="charts">
      <section className="card refresh-card" aria-label="Update balances">
        <div className="pane-head">
          <h3>Update balances</h3>
          <p>
            Read every figure off today's statements in one sitting. The balances are
            dated to the month you pick, and the projection starts from there — every
            scenario of {household.name} with it.
          </p>
        </div>

        <div className="refresh-when">
          <label className="field">
            <span>These balances are as of</span>
            <select
              aria-label="Balances as of"
              value={`${asOf.year}-${asOf.month}`}
              onChange={(e) => {
                const [year, month] = e.currentTarget.value.split("-").map(Number);
                setAsOf({ year, month });
              }}
            >
              {months.map((m) => (
                <option key={`${m.year}-${m.month}`} value={`${m.year}-${m.month}`}>
                  {yearMonth(m)}
                </option>
              ))}
            </select>
          </label>
          <p className="field-hint">
            On file: {yearMonth(household.as_of)} ·{" "}
            {monthsAgoLabel(monthsSince(household.as_of, new Date()))}. A sitting can only
            move forwards, and only as far as this month.
          </p>
        </div>

        <div className="band">
          <p className="band-label">People</p>
          <p className="field-hint">
            Shown, not edited — a birth month is not a reading. Retirement dates belong to
            a scenario and live on the Inputs screen.
          </p>
          <ul className="refresh-people">
            {household.people.map((p) => (
              <li key={p.id}>
                <strong>{p.name}</strong>{" "}
                <span className="refresh-person-birth">born {yearMonth(p.birth)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="band">
          <p className="band-label">Accounts</p>
          <p className="field-hint">
            Leave an account alone and it keeps the figure it has, and the date it was
            read — nothing is estimated forward for it. Adding, renaming or removing an
            account is the Inputs screen's job.
          </p>
          <div className="table-scroll">
            <table className="input-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Last read</th>
                  <th className="num">Balance</th>
                  <th className="num">Cost basis</th>
                </tr>
              </thead>
              <tbody>
                {plan.accounts.map((account) => {
                  const previous = lastRead(account.id);
                  return (
                    <tr key={account.id}>
                      <td>{account.name}</td>
                      <td className="refresh-previous">
                        {previous ? (
                          <>
                            {currency(previous.balance)}
                            <span> · {yearMonth(previous.as_of)}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="num">
                        <AmountInput
                          ariaLabel={`${account.name} balance`}
                          value={balances[account.id] ?? account.balance}
                          onChange={(v) =>
                            setBalances((prev) => ({ ...prev, [account.id]: v }))
                          }
                        />
                      </td>
                      <td className="num">
                        {account.cost_basis === null ? (
                          <span className="field-hint">n/a</span>
                        ) : (
                          <AmountInput
                            ariaLabel={`${account.name} cost basis`}
                            value={bases[account.id] ?? account.cost_basis}
                            onChange={(v) =>
                              setBases((prev) => ({ ...prev, [account.id]: v }))
                            }
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {plan.social_security.length > 0 && (
          <div className="band band-social-security">
            <p className="band-label">Social Security</p>
            <p className="field-hint">
              The benefit at full retirement age, as this year's statement estimates it.
              Full retirement age is fixed by birth year, and when to claim is a
              scenario's choice.
            </p>
            <div className="table-scroll">
              <table className="input-table">
                <thead>
                  <tr>
                    <th>Benefit</th>
                    <th>On file</th>
                    <th className="num">At full retirement age</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.social_security.map((benefit) => (
                    <tr key={benefit.id}>
                      <td>
                        {plan.people.find((p) => p.id === benefit.owner)?.name ??
                          benefit.owner}
                      </td>
                      <td className="refresh-previous">
                        {currency(benefit.benefit_at_fra)}
                      </td>
                      <td className="num">
                        <AmountInput
                          ariaLabel={`Benefit at full retirement age for ${benefit.owner}`}
                          value={benefits[benefit.id] ?? benefit.benefit_at_fra}
                          onChange={(v) =>
                            setBenefits((prev) => ({ ...prev, [benefit.id]: v }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {rates.length > 0 && (
          <div className="band band-income">
            <p className="band-label">Rates — {plan.name}</p>
            {/* The sentence this whole section exists for. Said in the
                dollars the user is actually moving between, with the real
                figure, rather than as a note about denomination. */}
            <p className="field-hint">
              {elapsed === 0 ? (
                <>
                  These figures are stated in {yearMonth(asOf)} dollars, which is where
                  the plan already starts — nothing needs re-stating unless a figure has
                  actually changed.
                </>
              ) : (
                <>
                  These figures are stated in the dollars of the month the plan starts.
                  Moving that start to {yearMonth(asOf)} re-states each of them without
                  changing a digit: kept as typed, they buy about{" "}
                  {(erosion * 100).toFixed(1)}% less than they did in{" "}
                  {yearMonth(household.as_of)}. Keep a figure if that is what you meant,
                  grow it to hold what it buys, or type what it actually is now.
                </>
              )}
            </p>
            <ul className="refresh-rates">
              {rates.map((rate) => {
                const answer = answerFor(rate);
                const grown = grownRate(rate.amount, inflation, elapsed);
                const name = `rate-${rate.key}`;
                return (
                  <li key={rate.key}>
                    <div className="refresh-rate-head">
                      <strong>{rate.label}</strong>
                      <span className="field-hint">{rate.detail}</span>
                    </div>
                    <fieldset className="refresh-rate-choice">
                      <legend className="visually-hidden">{rate.label}</legend>
                      <label>
                        <input
                          type="radio"
                          name={name}
                          checked={answer.mode === "keep"}
                          onChange={() => setAnswer(rate.key, { mode: "keep" })}
                        />
                        <span>Keep {currency(rate.amount)}</span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={name}
                          checked={answer.mode === "grow"}
                          disabled={grown === rate.amount}
                          onChange={() => setAnswer(rate.key, { mode: "grow" })}
                        />
                        <span>Grow to {currency(grown)}</span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={name}
                          checked={answer.mode === "new"}
                          onChange={() => setAnswer(rate.key, { mode: "new" })}
                        />
                        <span>It is now</span>
                      </label>
                      <AmountInput
                        ariaLabel={`${rate.label} new amount`}
                        value={answer.typed}
                        onChange={(v) => setAnswer(rate.key, { mode: "new", typed: v })}
                      />
                    </fieldset>
                    {siblingCount > 0 && answer.mode !== "keep" && (
                      <label className="refresh-rate-siblings">
                        <input
                          type="checkbox"
                          checked={answer.siblings}
                          onChange={(e) =>
                            setAnswer(rate.key, { siblings: e.currentTarget.checked })
                          }
                        />
                        <span>
                          Apply to the {siblingCount} other scenario
                          {siblingCount === 1 ? "" : "s"} whose figure is the same
                        </span>
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {refused && (
          <p role="alert" className="banner critical">
            {refused}
          </p>
        )}

        <div className="refresh-actions">
          <button type="button" disabled={saving} onClick={() => void submit()}>
            {saving ? "Recording…" : `Record balances as of ${yearMonth(asOf)}`}
          </button>
          <span className="field-hint">
            The household as it stands is kept, whole, before anything is written.
          </span>
        </div>
      </section>
    </main>
  );
}
