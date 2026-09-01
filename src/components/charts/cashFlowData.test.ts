import { describe, expect, it } from "vitest";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Projection } from "../../types/generated/Projection";
import { cashFlowRows, cashFlowSummary } from "./cashFlowData";

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
    deflator: 1,
    ...overrides,
  };
}

const projection = (snapshots: PeriodSnapshot[]): Projection => ({
  snapshots,
  warnings: [],
});

describe("cashFlowRows", () => {
  it("carries outflows negative so the stack can diverge around zero", () => {
    const rows = cashFlowRows(
      projection([
        snapshot({
          period_start: { year: 2030, month: 1 },
          income: 100,
          expenses: 60,
          taxes: 20,
          contributions: 10,
          withdrawals: { a: 5, b: 3 },
          surplus: 10,
        }),
      ]),
      false,
    );

    expect(rows[0]).toEqual({
      year: 2030,
      income: 100,
      withdrawals: 8,
      requiredDistributions: 0,
      expenses: -60,
      taxes: -20,
      contributions: -10,
      surplus: 10,
    });
  });

  it("deflates every flow when showing today's dollars", () => {
    const rows = cashFlowRows(
      projection([snapshot({ income: 200, expenses: 100, deflator: 2 })]),
      true,
    );
    expect(rows[0].income).toBe(100);
    expect(rows[0].expenses).toBe(-50);
  });
});

describe("cashFlowSummary", () => {
  it("finds the first year withdrawals exceed income, not merely appear", () => {
    const rows = cashFlowRows(
      projection([
        // Withdrawals start here but are still below income.
        snapshot({
          period_start: { year: 2038, month: 1 },
          income: 100,
          withdrawals: { a: 20 },
        }),
        snapshot({
          period_start: { year: 2039, month: 1 },
          income: 40,
          withdrawals: { a: 60 },
        }),
        snapshot({
          period_start: { year: 2040, month: 1 },
          income: 0,
          withdrawals: { a: 90 },
        }),
      ]),
      false,
    );
    const s = cashFlowSummary(rows);
    expect(s.crossoverYear).toBe(2039);
    expect(s.peakWithdrawalYear).toBe(2040);
    expect(s.peakWithdrawal).toBe(90);
  });

  it("does not let a forced withdrawal move the crossover", () => {
    // The household's behaviour is identical in both years — a pension that
    // covers everything. All that changed in 2059 is that an owner reached
    // their RMD age, and that must not read as the year they started living
    // off the portfolio.
    const rows = cashFlowRows(
      projection([
        snapshot({
          period_start: { year: 2058, month: 1 },
          income: 100,
          withdrawals: {},
        }),
        snapshot({
          period_start: { year: 2059, month: 1 },
          income: 100,
          withdrawals: { a: 150 },
          required_distributions: 150,
        }),
        snapshot({
          period_start: { year: 2060, month: 1 },
          income: 100,
          withdrawals: { a: 240 },
          required_distributions: 150,
        }),
      ]),
      false,
    );
    // 2059 is entirely forced; 2060 adds $90 of chosen withdrawals, still
    // under the $100 of income. Neither year is a crossover, though the raw
    // withdrawal total clears income in both.
    expect(cashFlowSummary(rows).crossoverYear).toBeNull();
  });

  it("still crosses over on the household's own withdrawals", () => {
    const rows = cashFlowRows(
      projection([
        snapshot({
          period_start: { year: 2061, month: 1 },
          income: 100,
          withdrawals: { a: 260 },
          required_distributions: 150,
        }),
      ]),
      false,
    );
    expect(cashFlowSummary(rows).crossoverYear).toBe(2061);
  });

  it("reports no crossover when earnings always cover the household", () => {
    const rows = cashFlowRows(
      projection([snapshot({ income: 100, withdrawals: { a: 1 } })]),
      false,
    );
    expect(cashFlowSummary(rows).crossoverYear).toBeNull();
  });

  it("totals lifetime taxes as a positive figure", () => {
    const rows = cashFlowRows(
      projection([
        snapshot({ period_start: { year: 2030, month: 1 }, taxes: 30 }),
        snapshot({ period_start: { year: 2031, month: 1 }, taxes: 45 }),
      ]),
      false,
    );
    expect(cashFlowSummary(rows).lifetimeTaxes).toBe(75);
  });
});
