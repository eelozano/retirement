import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";

// Growth: how much of the money in the accounts the household put there, and
// how much the market made on its own. Four figures per year, on two scales —
// what went in and what grew *this* year, and the running totals of both.
//
// `PeriodSnapshot.growth` is the engine's own dollar figure for what `grow()`
// added each period (#61) — nominal, and already reflecting every account's
// compounding, so summing it needs no reconstruction. What went in is
// `contributions + employer_match`: the household's own deposits plus the
// employer's, which is what "money that arrived in the accounts" means even
// though only the first half passes through household cash.
//
// The running totals open at the starting balance rather than at zero.
// Without it the first year already shows growth outrunning contributions,
// because the balance the household arrived with is doing the work — true,
// and useless as a headline.
//
// Neither total is net of withdrawals, so after retirement they keep climbing
// while the accounts are being spent down. `netWorth` is carried alongside for
// exactly that reason: the gap that opens between it and the two totals is the
// money that has left.

export interface GrowthRow {
  year: number;
  /** Contributions plus employer match this year, in the displayed basis. */
  added: number;
  /** Market growth this year, in the displayed basis. */
  growth: number;
  /** Running total of `added`, opened at the starting balance. */
  totalAdded: number;
  /** Running total of `growth`. */
  totalGrowth: number;
  /** End-of-year net worth, in the displayed basis. */
  netWorth: number;
}

/**
 * What the household started with: every account's balance as of the
 * simulation start. Nominal at the start month, which is also today's
 * dollars, so it needs no deflating in either basis.
 */
export function startingBalance(plan: Plan): number {
  return plan.accounts.reduce((sum, account) => sum + account.balance, 0);
}

export function growthRows(
  projection: Projection,
  plan: Plan,
  realDollars: boolean,
): GrowthRow[] {
  // Each year's flows are deflated by that year's own deflator and *then*
  // accumulated, so a running total is the running sum of the bars above it
  // and never falls in a year nothing went in. Deflating the nominal running
  // total instead — the stacked chart's convention, which needed the two
  // series to add back to net worth — would do both.
  let totalAdded = startingBalance(plan);
  let totalGrowth = 0;
  return projection.snapshots.map((s) => {
    const d = realDollars ? s.deflator : 1;
    const added = (s.contributions + s.employer_match) / d;
    const growth = s.growth / d;
    totalAdded += added;
    totalGrowth += growth;
    return {
      year: s.period_start.year,
      added,
      growth,
      totalAdded,
      totalGrowth,
      netWorth: s.net_worth / d,
    };
  });
}

export interface GrowthSummary {
  /** Cumulative growth at the end of the projection, in the displayed basis. */
  totalGrowth: number;
  /** Starting balance plus everything added, at the end of the projection. */
  totalAdded: number;
  /** Dollars grown per dollar in, or null when nothing has gone in. */
  perDollar: number | null;
  /** First year the running growth total overtakes what went in, or null. */
  crossoverYear: number | null;
}

export function growthSummary(rows: GrowthRow[]): GrowthSummary {
  const last = rows[rows.length - 1];
  const crossover = rows.find((r) => r.totalGrowth > r.totalAdded);
  const totalAdded = last?.totalAdded ?? 0;
  return {
    totalGrowth: last?.totalGrowth ?? 0,
    totalAdded,
    perDollar: totalAdded > 0 ? (last?.totalGrowth ?? 0) / totalAdded : null,
    crossoverYear: crossover?.year ?? null,
  };
}
