import type { RateTarget } from "../../lib/api";
import type { GrowthRule } from "../../types/generated/GrowthRule";
import type { Plan } from "../../types/generated/Plan";
import type { YearMonth } from "../../types/generated/YearMonth";
import { boundaryPhrase } from "../inputs/streamBoundary";

// Which figures in a scenario are **rates**, and what an untouched one means
// once the projection's start has moved (#111).
//
// A rate is a figure stated in start dollars: a salary, a spending figure, a
// flat contribution amount. Nothing about it changes when the household
// refreshes, and that is exactly the problem — $150,000 that meant January
// dollars now means December dollars, which is about 2% less at the default
// inflation. So the Refresh screen lists every one of them and the user
// keeps, grows, or retypes it. Keep is the default: raises are discrete, and
// typing the new figure is the honest act.
//
// What is *not* listed is intent, which is not denominated in dollars of any
// month and so cannot go stale: a percent of salary, a federal maximum, a
// step-up, a claiming age, an allocation.

/** One start-dollar figure the Refresh screen lists. */
export interface RateEntry {
  /** Stable across renders and unique within a plan — React key and the id
   * the screen's per-row state is held under. */
  key: string;
  /** What the backend is told to change. */
  target: RateTarget;
  label: string;
  /** Where the figure lives, for the reader who has two "Salary" rows. */
  detail: string;
  /** The figure as stored, in the *old* start's dollars. */
  amount: number;
  growth: GrowthRule;
}

/** Person's name, or the household, for a row's `detail` line. */
function ownerName(plan: Plan, owner: string | null): string {
  if (owner === null) return "Household";
  return plan.people.find((p) => p.id === owner)?.name ?? owner;
}

/**
 * Every start-dollar figure in `plan`, in the order the screen shows them:
 * income and expense streams first — the salary and the spending figure are
 * what a household actually re-reads — then flat contributions.
 *
 * Percent-of-salary and federal-maximum entries are deliberately absent.
 * They have no dollar figure to re-affirm: a percentage rides the salary it
 * is a percentage of, and the statutory maximum is the engine's to index.
 */
export function listRates(plan: Plan): RateEntry[] {
  const rates: RateEntry[] = plan.streams.map((stream) => ({
    key: `stream:${stream.id}`,
    target: { Stream: { id: stream.id } },
    label: stream.name,
    detail: `${stream.direction === "Income" ? "Income" : "Spending"} · ${ownerName(
      plan,
      stream.owner,
    )}`,
    amount: stream.annual_amount,
    growth: stream.growth,
  }));

  for (const account of plan.accounts) {
    for (const entry of account.contributions) {
      // A tagged union whose other arms are bare strings, so narrow on the
      // shape before reaching for the tag.
      if (typeof entry.rule === "string" || !("FlatAmount" in entry.rule)) continue;
      rates.push({
        key: `contribution:${account.id}:${entry.id}`,
        target: { Contribution: { account: account.id, id: entry.id } },
        label: `Into ${account.name}`,
        // An entry has no name of its own, and an account can hold several.
        // Its window is what tells them apart, so the row says it.
        detail: `${ownerName(plan, account.owner)} · ${boundaryPhrase(
          entry.start,
          plan,
        )} to ${boundaryPhrase(entry.end, plan)}`,
        amount: entry.rule.FlatAmount.amount,
        growth: entry.rule.FlatAmount.growth,
      });
    }
  }
  return rates;
}

/** Whole months from `from` to `to`, clamped at zero. */
export function monthsBetween(from: YearMonth, to: YearMonth): number {
  return Math.max(0, (to.year - from.year) * 12 + (to.month - from.month));
}

/**
 * What a figure would have to be, in the new start's dollars, to buy what it
 * bought in the old start's: `amount × (1 + inflation)^(months / 12)`.
 *
 * Inflation, not the figure's own growth rule, because this answers a
 * question about purchasing power rather than about how the engine will grow
 * the figure from here. It is **offered, never applied** — the screen shows
 * it beside the figure and the user decides.
 *
 * Rounded to the dollar: this is a number a person is choosing to write
 * down, and the cents of a compounding calculation are noise in it.
 */
export function grownRate(amount: number, inflation: number, months: number): number {
  return Math.round(amount * (1 + inflation) ** (months / 12));
}

/**
 * The months a refresh may be dated: from the household's current `as_of`
 * (a refresh never moves the start backwards) through `now` (balances cannot
 * be read for a month that has not happened), newest first so the default —
 * this month — is the first option.
 *
 * A clock behind the stored `as_of` still yields one option, the `as_of`
 * itself, rather than an empty picker.
 */
export function refreshMonths(asOf: YearMonth, now: Date): YearMonth[] {
  const current: YearMonth = { year: now.getFullYear(), month: now.getMonth() + 1 };
  const months: YearMonth[] = [];
  for (let i = 0; i <= monthsBetween(asOf, current); i++) {
    const index = asOf.year * 12 + (asOf.month - 1) + i;
    months.push({ year: Math.floor(index / 12), month: (index % 12) + 1 });
  }
  return months.reverse();
}
