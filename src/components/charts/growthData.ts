import type { Projection } from "../../types/generated/Projection";

// Growth: how much of net worth is money the household put in versus money
// the market made on its own. `PeriodSnapshot.growth` is the engine's own
// dollar figure for what `grow()` added each period (#61) — nominal, and
// already reflecting every account's compounding, so summing it across
// periods needs no reconstruction of contributions, withdrawals, or
// reinvested surplus.
//
// `principal` is derived, not summed independently: `net_worth - growth` at
// every period, in whichever basis is displayed. That keeps the two series
// exactly additive back to net worth — the whole point of a stacked chart —
// without having to re-derive "money put in" from contributions,
// employer match, reinvested surplus, and withdrawals separately.

export interface GrowthRow {
  year: number;
  netWorth: number;
  /** Cumulative market growth to date, in the displayed basis. */
  growth: number;
  /** `netWorth - growth`: net contributions in, net of what was drawn out. */
  principal: number;
}

export function growthRows(projection: Projection, realDollars: boolean): GrowthRow[] {
  let cumulativeGrowth = 0;
  return projection.snapshots.map((s) => {
    // Accumulate in nominal dollars, then apply this period's own basis to
    // the running total and to net worth together — dividing both by the
    // same divisor preserves `principal + growth === netWorth` exactly,
    // which summing already-deflated per-period amounts would not.
    cumulativeGrowth += s.growth;
    const d = realDollars ? s.deflator : 1;
    const netWorth = s.net_worth / d;
    const growth = cumulativeGrowth / d;
    return { year: s.period_start.year, netWorth, growth, principal: netWorth - growth };
  });
}

export interface GrowthSummary {
  /** Cumulative growth at the end of the projection, in the displayed basis. */
  totalGrowth: number;
  /** `totalGrowth / netWorth` at the last snapshot, or null with no snapshots. */
  growthShare: number | null;
  /** First year cumulative growth overtakes net contributions in, or null. */
  crossoverYear: number | null;
}

export function growthSummary(rows: GrowthRow[]): GrowthSummary {
  const last = rows[rows.length - 1];
  const crossover = rows.find((r) => r.growth > r.principal);
  return {
    totalGrowth: last?.growth ?? 0,
    growthShare: last && last.netWorth !== 0 ? last.growth / last.netWorth : null,
    crossoverYear: crossover?.year ?? null,
  };
}
