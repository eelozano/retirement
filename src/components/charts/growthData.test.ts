import { describe, expect, it } from "vitest";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Projection } from "../../types/generated/Projection";
import { growthRows, growthSummary } from "./growthData";

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

const projection = (snapshots: PeriodSnapshot[]): Projection => ({
  snapshots,
  warnings: [],
  streams: [],
});

describe("growthRows", () => {
  it("accumulates growth across periods and derives principal from net worth", () => {
    const rows = growthRows(
      projection([
        snapshot({
          period_start: { year: 2030, month: 1 },
          growth: 100,
          net_worth: 1100,
        }),
        snapshot({ period_start: { year: 2031, month: 1 }, growth: 50, net_worth: 1250 }),
      ]),
      false,
    );

    expect(rows).toEqual([
      { year: 2030, netWorth: 1100, growth: 100, principal: 1000 },
      { year: 2031, netWorth: 1250, growth: 150, principal: 1100 },
    ]);
  });

  it("principal and growth always sum back to net worth, in either basis", () => {
    const rows = growthRows(
      projection([
        snapshot({ growth: 100, net_worth: 1100, deflator: 1 }),
        snapshot({ growth: -30, net_worth: 1000, deflator: 1.1 }),
      ]),
      true,
    );
    for (const row of rows) {
      expect(row.principal + row.growth).toBeCloseTo(row.netWorth);
    }
  });

  it("deflates the running total and net worth by each period's own deflator", () => {
    const rows = growthRows(
      projection([snapshot({ growth: 200, net_worth: 1200, deflator: 2 })]),
      true,
    );
    expect(rows[0]).toEqual({ year: 2025, netWorth: 600, growth: 100, principal: 500 });
  });
});

describe("growthSummary", () => {
  it("reports cumulative growth and its share of net worth at plan end", () => {
    const rows = growthRows(
      projection([
        snapshot({
          period_start: { year: 2030, month: 1 },
          growth: 100,
          net_worth: 1000,
        }),
        snapshot({
          period_start: { year: 2031, month: 1 },
          growth: 400,
          net_worth: 1500,
        }),
      ]),
      false,
    );
    const s = growthSummary(rows);
    expect(s.totalGrowth).toBe(500);
    expect(s.growthShare).toBeCloseTo(500 / 1500);
  });

  it("finds the first year growth overtakes net contributions", () => {
    const rows = growthRows(
      projection([
        // cumulative growth 100, principal 900 — contributions still lead.
        snapshot({
          period_start: { year: 2030, month: 1 },
          growth: 100,
          net_worth: 1000,
        }),
        // cumulative growth 600, principal 600 — a tie, not yet an overtake.
        snapshot({
          period_start: { year: 2031, month: 1 },
          growth: 500,
          net_worth: 1200,
        }),
        // cumulative growth 800, principal 400 — growth is now ahead.
        snapshot({
          period_start: { year: 2032, month: 1 },
          growth: 200,
          net_worth: 1200,
        }),
      ]),
      false,
    );
    expect(growthSummary(rows).crossoverYear).toBe(2032);
  });

  it("has no crossover when there are no snapshots", () => {
    expect(growthSummary([]).crossoverYear).toBeNull();
    expect(growthSummary([]).totalGrowth).toBe(0);
    expect(growthSummary([]).growthShare).toBeNull();
  });
});
