import { describe, expect, it } from "vitest";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { PeriodPercentiles } from "../../types/generated/PeriodPercentiles";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Projection } from "../../types/generated/Projection";
import { compareRows, comparisonSummary, mergeActiveBand } from "./compareData";

function snapshot(overrides: Partial<PeriodSnapshot>): PeriodSnapshot {
  return {
    period: 0,
    period_start: { year: 2025, month: 1 },
    balances: {},
    income: 0,
    expenses: 0,
    taxes: 0,
    contributions: 0,
    employer_match: 0,
    required_distributions: 0,
    surplus: 0,
    withdrawals: {},
    growth: 0,
    net_worth: 0,
    income_by_stream: {},
    expenses_by_stream: {},
    withdrawal_taxes: 0,
    contributions_by_account: {},
    deflator: 1,
    ...overrides,
  };
}

function projection(
  snapshots: PeriodSnapshot[],
  warnings: Projection["warnings"] = [],
): Projection {
  return { snapshots, warnings, streams: [] };
}

describe("compareRows", () => {
  it("outer-joins by year, leaving a gap where a scenario has already ended", () => {
    // Base runs 2025-2027; a shorter variant (e.g. an earlier plan_end_age)
    // only runs 2025-2026 — its line should stop, not drop to zero.
    const base = projection([
      snapshot({ period_start: { year: 2025, month: 1 }, net_worth: 100 }),
      snapshot({ period_start: { year: 2026, month: 1 }, net_worth: 110 }),
      snapshot({ period_start: { year: 2027, month: 1 }, net_worth: 120 }),
    ]);
    const shorter = projection([
      snapshot({ period_start: { year: 2025, month: 1 }, net_worth: 50 }),
      snapshot({ period_start: { year: 2026, month: 1 }, net_worth: 55 }),
    ]);

    const rows = compareRows(
      [
        { id: "base", projection: base },
        { id: "shorter", projection: shorter },
      ],
      false,
    );

    expect(rows).toEqual([
      { year: 2025, base: 100, shorter: 50 },
      { year: 2026, base: 110, shorter: 55 },
      { year: 2027, base: 120, shorter: null },
    ]);
  });

  it("handles scenarios with different start years", () => {
    const early = projection([
      snapshot({ period_start: { year: 2020, month: 1 }, net_worth: 10 }),
    ]);
    const late = projection([
      snapshot({ period_start: { year: 2022, month: 1 }, net_worth: 30 }),
    ]);

    const rows = compareRows(
      [
        { id: "early", projection: early },
        { id: "late", projection: late },
      ],
      false,
    );

    expect(rows).toEqual([
      { year: 2020, early: 10, late: null },
      { year: 2022, early: null, late: 30 },
    ]);
  });

  it("deflates each scenario by its own per-period deflator", () => {
    // Two scenarios can carry different inflation assumptions, so the
    // deflator that converts a given year to today's dollars differs too.
    const highInflation = projection([
      snapshot({ period_start: { year: 2025, month: 1 }, net_worth: 200, deflator: 2 }),
    ]);
    const lowInflation = projection([
      snapshot({ period_start: { year: 2025, month: 1 }, net_worth: 150, deflator: 1.5 }),
    ]);

    const rows = compareRows(
      [
        { id: "hi", projection: highInflation },
        { id: "lo", projection: lowInflation },
      ],
      true,
    );

    expect(rows).toEqual([{ year: 2025, hi: 100, lo: 100 }]);
  });
});

function percentiles(overrides: Partial<PeriodPercentiles>): PeriodPercentiles {
  return {
    period: 0,
    period_start: { year: 2025, month: 1 },
    deflator: 1,
    p10: 0,
    p25: 0,
    p50: 0,
    p75: 0,
    p90: 0,
    ...overrides,
  };
}

function monteCarlo(
  successRate: number,
  nPaths: number,
  bands: PeriodPercentiles[] = [],
): MonteCarloResult {
  return {
    n_paths: nPaths,
    success_rate: successRate,
    percentiles: bands,
    diagnostics: {
      early_window_years: 10,
      retirement_period: null,
      depletion_histogram: [],
      early_failures: 0,
      late_failures: 0,
      failed: null,
      succeeded: null,
      median_withdrawal_rate_at_retirement: null,
    },
  };
}

describe("comparisonSummary", () => {
  it("computes delta vs. the named base, not the first or largest scenario", () => {
    const base = projection([
      snapshot({ period_start: { year: 2025, month: 1 }, net_worth: 100, taxes: 10 }),
      snapshot({ period_start: { year: 2026, month: 1 }, net_worth: 200, taxes: 20 }),
    ]);
    const variant = projection([
      snapshot({ period_start: { year: 2025, month: 1 }, net_worth: 300, taxes: 5 }),
      snapshot({ period_start: { year: 2026, month: 1 }, net_worth: 350, taxes: 8 }),
    ]);

    const summary = comparisonSummary(
      [
        { id: "variant", name: "Variant", projection: variant, monteCarlo: null },
        { id: "base", name: "Base", projection: base, monteCarlo: null },
      ],
      "base",
      false,
    );

    const baseRow = summary.find((s) => s.id === "base")!;
    const variantRow = summary.find((s) => s.id === "variant")!;

    expect(baseRow.isBase).toBe(true);
    expect(baseRow.finalNetWorth).toBe(200);
    expect(baseRow.deltaVsBase).toBe(0);
    expect(baseRow.lifetimeTaxes).toBe(30);

    expect(variantRow.isBase).toBe(false);
    expect(variantRow.finalNetWorth).toBe(350);
    expect(variantRow.deltaVsBase).toBe(150);
    expect(variantRow.lifetimeTaxes).toBe(13);
  });

  it("reports depletion year when funds run out, null otherwise", () => {
    const solvent = projection([
      snapshot({ period_start: { year: 2025, month: 1 }, net_worth: 100 }),
    ]);
    const depleted = projection(
      [
        snapshot({ period_start: { year: 2025, month: 1 }, net_worth: 100 }),
        snapshot({ period_start: { year: 2026, month: 1 }, net_worth: 0 }),
      ],
      [{ DepletedFunds: { period: 1 } }],
    );

    const summary = comparisonSummary(
      [
        { id: "solvent", name: "Solvent", projection: solvent, monteCarlo: null },
        { id: "depleted", name: "Depleted", projection: depleted, monteCarlo: null },
      ],
      "solvent",
      false,
    );

    expect(summary.find((s) => s.id === "solvent")!.depletionYear).toBeNull();
    expect(summary.find((s) => s.id === "depleted")!.depletionYear).toBe(2026);
  });
});

describe("comparisonSummary — Monte Carlo columns", () => {
  const flat = projection([
    snapshot({ period_start: { year: 2025, month: 1 }, net_worth: 100 }),
  ]);

  it("carries success rate, its margin, and p10 at end", () => {
    const summary = comparisonSummary(
      [
        {
          id: "base",
          name: "Base",
          projection: flat,
          monteCarlo: monteCarlo(0.9, 1000, [
            percentiles({ period_start: { year: 2025, month: 1 }, p10: 40 }),
            percentiles({ period_start: { year: 2026, month: 1 }, p10: 55 }),
          ]),
        },
      ],
      "base",
      false,
    );

    const row = summary[0];
    expect(row.successRate).toBe(0.9);
    // The Wilson margin at 1,000 paths near 90% — the same number the
    // headline tile prints, from the same function.
    expect(row.successMargin).toBeCloseTo(0.0202, 3);
    // The *last* period's p10, not the first: "at end" means plan end.
    expect(row.p10AtEnd).toBe(55);
  });

  it("deflates p10 at end by its own period's deflator when real", () => {
    const withInflation = monteCarlo(0.8, 1000, [
      percentiles({ period_start: { year: 2026, month: 1 }, p10: 200, deflator: 2 }),
    ]);
    const [row] = comparisonSummary(
      [{ id: "base", name: "Base", projection: flat, monteCarlo: withInflation }],
      "base",
      true,
    );
    expect(row.p10AtEnd).toBe(100);
  });

  it("gives the success delta against the named base, and none for the base row", () => {
    const summary = comparisonSummary(
      [
        {
          id: "variant",
          name: "Variant",
          projection: flat,
          monteCarlo: monteCarlo(0.94, 1000),
        },
        { id: "base", name: "Base", projection: flat, monteCarlo: monteCarlo(0.9, 1000) },
      ],
      "base",
      false,
    );

    expect(summary.find((s) => s.id === "base")!.successDeltaVsBase).toBeNull();
    expect(summary.find((s) => s.id === "variant")!.successDeltaVsBase).toBeCloseTo(
      0.04,
      6,
    );
  });

  it("leaves every Monte Carlo field null when a scenario has no result", () => {
    const [row] = comparisonSummary(
      [{ id: "base", name: "Base", projection: flat, monteCarlo: null }],
      "base",
      false,
    );
    expect(row.successRate).toBeNull();
    expect(row.successMargin).toBeNull();
    expect(row.successDeltaVsBase).toBeNull();
    expect(row.p10AtEnd).toBeNull();
    // The deterministic columns are unaffected — that is the point of running
    // them first.
    expect(row.finalNetWorth).toBe(100);
  });

  it("has no delta when the base itself has no result to compare against", () => {
    const summary = comparisonSummary(
      [
        {
          id: "variant",
          name: "Variant",
          projection: flat,
          monteCarlo: monteCarlo(0.94, 1000),
        },
        { id: "base", name: "Base", projection: flat, monteCarlo: null },
      ],
      "base",
      false,
    );
    expect(summary.find((s) => s.id === "variant")!.successDeltaVsBase).toBeNull();
    expect(summary.find((s) => s.id === "variant")!.successRate).toBe(0.94);
  });
});

describe("mergeActiveBand", () => {
  it("merges the band by year, leaving uncovered years null", () => {
    const rows = compareRows(
      [
        {
          id: "a",
          projection: projection([
            snapshot({ period_start: { year: 2025, month: 1 }, net_worth: 100 }),
            snapshot({ period_start: { year: 2026, month: 1 }, net_worth: 120 }),
          ]),
        },
      ],
      false,
    );

    // The band covers 2026 only — its scenario need not span the widest
    // range in the comparison.
    const merged = mergeActiveBand(
      rows,
      monteCarlo(0.9, 1000, [
        percentiles({ period_start: { year: 2026, month: 1 }, p10: 80, p90: 160 }),
      ]),
      false,
    );

    expect(merged[0]).toMatchObject({ year: 2025, bandBase: null, bandHeight: null });
    expect(merged[1]).toMatchObject({ year: 2026, bandBase: 80, bandHeight: 80 });
  });

  it("deflates the band when real dollars are on", () => {
    const rows = compareRows(
      [
        {
          id: "a",
          projection: projection([
            snapshot({ period_start: { year: 2025, month: 1 }, net_worth: 100 }),
          ]),
        },
      ],
      true,
    );
    const merged = mergeActiveBand(
      rows,
      monteCarlo(0.9, 1000, [
        percentiles({
          period_start: { year: 2025, month: 1 },
          p10: 80,
          p90: 160,
          deflator: 2,
        }),
      ]),
      true,
    );
    expect(merged[0]).toMatchObject({ bandBase: 40, bandHeight: 40 });
  });
});
