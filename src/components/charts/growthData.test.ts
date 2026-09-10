import { describe, expect, it } from "vitest";
import type { Account } from "../../types/generated/Account";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import { growthRows, growthSummary, startingBalance } from "./growthData";

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

function account(id: string, balance: number): Account {
  return {
    id,
    owner: "alex",
    kind: "Taxable",
    name: id,
    balance,
    cost_basis: null,
    allocation: "Moderate",
    plan_type: "None",
    contributions: [],
    employer_match: null,
  };
}

/** Only the two fields these rows read; the rest of a `Plan` is irrelevant. */
const plan = (...accounts: Account[]) => ({ accounts, people: [] }) as unknown as Plan;

describe("startingBalance", () => {
  it("sums every account's opening balance", () => {
    expect(startingBalance(plan(account("a", 400), account("b", 600)))).toBe(1000);
  });

  it("is zero with no accounts", () => {
    expect(startingBalance(plan())).toBe(0);
  });
});

describe("growthRows", () => {
  it("counts employer match as money in, alongside contributions", () => {
    const rows = growthRows(
      projection([snapshot({ contributions: 300, employer_match: 100 })]),
      plan(),
      false,
    );
    expect(rows[0].added).toBe(400);
  });

  it("opens the running total at the starting balance, not at zero", () => {
    const rows = growthRows(
      projection([
        snapshot({
          period_start: { year: 2030, month: 1 },
          contributions: 100,
          growth: 50,
        }),
        snapshot({
          period_start: { year: 2031, month: 1 },
          contributions: 200,
          growth: 70,
        }),
      ]),
      plan(account("a", 1000)),
      false,
    );
    expect(rows.map((r) => r.totalAdded)).toEqual([1100, 1300]);
    expect(rows.map((r) => r.totalGrowth)).toEqual([50, 120]);
  });

  it("never lets a running total fall in a year nothing went in", () => {
    const rows = growthRows(
      projection([
        snapshot({ contributions: 100, growth: 40, deflator: 1 }),
        snapshot({ contributions: 0, growth: 40, deflator: 2 }),
      ]),
      plan(account("a", 500)),
      true,
    );
    expect(rows[1].totalAdded).toBe(rows[0].totalAdded);
  });

  it("deflates each year's flows by that year's own deflator before summing", () => {
    const rows = growthRows(
      projection([
        snapshot({ contributions: 100, growth: 100, net_worth: 1000, deflator: 1 }),
        snapshot({
          contributions: 200,
          employer_match: 200,
          growth: 400,
          net_worth: 3000,
          deflator: 2,
        }),
      ]),
      plan(),
      true,
    );
    expect(rows[1]).toEqual({
      year: 2025,
      added: 200,
      growth: 200,
      totalAdded: 300,
      totalGrowth: 300,
      netWorth: 1500,
    });
  });

  it("leaves nominal rows undeflated", () => {
    const rows = growthRows(
      projection([
        snapshot({ contributions: 100, growth: 100, net_worth: 900, deflator: 2 }),
      ]),
      plan(account("a", 700)),
      false,
    );
    expect(rows[0]).toEqual({
      year: 2025,
      added: 100,
      growth: 100,
      totalAdded: 800,
      totalGrowth: 100,
      netWorth: 900,
    });
  });

  it("carries net worth, which the totals do not reconstruct once money is drawn", () => {
    // 500 in, 100 grown, 900 net worth: 300 has left the accounts, and only
    // the net worth line shows it.
    const rows = growthRows(
      projection([snapshot({ contributions: 200, growth: 100, net_worth: 900 })]),
      plan(account("a", 300)),
      false,
    );
    expect(rows[0].totalAdded + rows[0].totalGrowth - rows[0].netWorth).toBe(-300);
  });
});

describe("growthSummary", () => {
  it("reports cumulative growth and dollars grown per dollar in", () => {
    const rows = growthRows(
      projection([
        snapshot({ period_start: { year: 2030, month: 1 }, growth: 100 }),
        snapshot({ period_start: { year: 2031, month: 1 }, growth: 400 }),
      ]),
      plan(account("a", 250)),
      false,
    );
    const s = growthSummary(rows);
    expect(s.totalGrowth).toBe(500);
    expect(s.totalAdded).toBe(250);
    expect(s.perDollar).toBe(2);
  });

  it("finds the first year growth overtakes what went in", () => {
    const rows = growthRows(
      projection([
        // 100 grown against 1000 in — contributions still lead.
        snapshot({ period_start: { year: 2030, month: 1 }, growth: 100 }),
        // 1000 grown against 1000 in — a tie, not yet an overtake.
        snapshot({ period_start: { year: 2031, month: 1 }, growth: 900 }),
        // 1200 grown against 1000 in — growth is now ahead.
        snapshot({ period_start: { year: 2032, month: 1 }, growth: 200 }),
      ]),
      plan(account("a", 1000)),
      false,
    );
    expect(growthSummary(rows).crossoverYear).toBe(2032);
  });

  it("has no crossover and no ratio when there are no snapshots", () => {
    const s = growthSummary([]);
    expect(s.crossoverYear).toBeNull();
    expect(s.perDollar).toBeNull();
    expect(s.totalGrowth).toBe(0);
    expect(s.totalAdded).toBe(0);
  });
});
