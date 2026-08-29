import { describe, expect, it } from "vitest";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Projection } from "../../types/generated/Projection";
import { compareRows, comparisonSummary } from "./compareData";

function snapshot(overrides: Partial<PeriodSnapshot>): PeriodSnapshot {
  return {
    period: 0,
    period_start: { year: 2025, month: 1 },
    balances: {},
    income: 0,
    expenses: 0,
    taxes: 0,
    contributions: 0,
    surplus: 0,
    withdrawals: {},
    net_worth: 0,
    deflator: 1,
    ...overrides,
  };
}

function projection(
  snapshots: PeriodSnapshot[],
  warnings: Projection["warnings"] = [],
): Projection {
  return { snapshots, warnings };
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
        { id: "variant", name: "Variant", projection: variant },
        { id: "base", name: "Base", projection: base },
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
        { id: "solvent", name: "Solvent", projection: solvent },
        { id: "depleted", name: "Depleted", projection: depleted },
      ],
      "solvent",
      false,
    );

    expect(summary.find((s) => s.id === "solvent")!.depletionYear).toBeNull();
    expect(summary.find((s) => s.id === "depleted")!.depletionYear).toBe(2026);
  });
});
