import type { Projection } from "../../types/generated/Projection";

// Cash flow: where money comes from and where it goes, and how that inverts
// at retirement.
//
// Every field here has been computed by the engine since M1 and displayed
// nowhere. Outflows are carried as negative numbers so the chart can stack
// inflows above the axis and outflows below it, which is what makes the
// crossover legible.

export interface CashFlowRow {
  year: number;
  income: number;
  withdrawals: number;
  /**
   * The part of `withdrawals` the IRS forced out of a pre-tax account
   * rather than the household choosing to sell (#49). Included in
   * `withdrawals`, not additional to it.
   */
  requiredDistributions: number;
  /** Negative. */
  expenses: number;
  /** Negative. */
  taxes: number;
  /** Negative. */
  contributions: number;
  surplus: number;
}

export function cashFlowRows(
  projection: Projection,
  realDollars: boolean,
): CashFlowRow[] {
  return projection.snapshots.map((s) => {
    const d = realDollars ? s.deflator : 1;
    const withdrawals = Object.values(s.withdrawals).reduce<number>(
      (sum, v) => sum + (v ?? 0),
      0,
    );
    return {
      year: s.period_start.year,
      income: s.income / d,
      withdrawals: withdrawals / d,
      requiredDistributions: s.required_distributions / d,
      expenses: -s.expenses / d,
      taxes: -s.taxes / d,
      contributions: -s.contributions / d,
      surplus: s.surplus / d,
    };
  });
}

export interface CashFlowSummary {
  /**
   * First year the household's *chosen* withdrawals exceed income — the
   * retirement crossover. Null if it never happens inside the projection.
   *
   * Required minimum distributions are excluded. They are withdrawals the
   * household did not decide to make, and folding them in would move the
   * reported crossover for a household that changed nothing about its
   * behaviour — the year someone turns 73 or 75 would read as the year they
   * started living off their portfolio.
   */
  crossoverYear: number | null;
  /** Year of the largest single withdrawal, and its size. */
  peakWithdrawalYear: number | null;
  peakWithdrawal: number;
  /**
   * Total tax paid across the projection.
   *
   * Summed in the displayed basis: in today's dollars each year is deflated
   * before adding, so this is a real-terms total rather than a meaningless
   * sum of dollars from different years.
   */
  lifetimeTaxes: number;
}

export function cashFlowSummary(rows: CashFlowRow[]): CashFlowSummary {
  let crossoverYear: number | null = null;
  let peakWithdrawalYear: number | null = null;
  let peakWithdrawal = 0;
  let lifetimeTaxes = 0;

  for (const row of rows) {
    if (
      crossoverYear === null &&
      row.withdrawals - row.requiredDistributions > row.income
    ) {
      crossoverYear = row.year;
    }
    if (row.withdrawals > peakWithdrawal) {
      peakWithdrawal = row.withdrawals;
      peakWithdrawalYear = row.year;
    }
    // taxes are stored negative for the chart; the total reads positive.
    lifetimeTaxes += -row.taxes;
  }

  return { crossoverYear, peakWithdrawalYear, peakWithdrawal, lifetimeTaxes };
}
