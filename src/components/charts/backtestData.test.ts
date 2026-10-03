import { describe, expect, it } from "vitest";
import type { BacktestResult } from "../../types/generated/BacktestResult";
import type { CohortDetail } from "../../types/generated/CohortDetail";
import type { CohortSummary } from "../../types/generated/CohortSummary";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Plan } from "../../types/generated/Plan";
import {
  cohortBars,
  cohortLedgerRows,
  cohortVerdict,
  dominantStrategy,
  extremes,
  forecastGap,
  historyHeadline,
  ledgerCsv,
  outcomePhrase,
  rankedCohorts,
  yearsLasted,
} from "./backtestData";

function cohort(overrides: Partial<CohortSummary>): CohortSummary {
  return {
    start_year: 1900,
    status: "Succeeded",
    periods_covered: 30,
    depleted_period: null,
    net_worth_real: [],
    end_net_worth_real: 1_000_000,
    min_net_worth_real: 0,
    ...overrides,
  };
}

const rates = (r: number) => ({
  very_aggressive: r,
  aggressive: r,
  moderate: r,
  conservative: r,
  very_conservative: r,
});

function result(cohorts: CohortSummary[]): BacktestResult {
  const count = (s: string) => cohorts.filter((c) => c.status === s).length;
  const succeeded = count("Succeeded");
  const depleted = count("Depleted");
  return {
    data_first_year: cohorts[0]?.start_year ?? 0,
    data_last_year: cohorts[cohorts.length - 1]?.start_year ?? 0,
    n_periods: 30,
    cohorts,
    succeeded,
    depleted,
    in_progress: count("InProgress"),
    success_rate: succeeded + depleted > 0 ? succeeded / (succeeded + depleted) : null,
    historical_real_return: { ...rates(0.05), aggressive: 0.064 },
  };
}

// The decided rule from #178, worked: 100 complete windows with 10 failures
// and 20 recent ones with 2 already failed is 12 failures out of 102.
describe("historyHeadline", () => {
  it("counts recent failures and leaves recent survivors out", () => {
    const cohorts = [
      ...Array.from({ length: 90 }, (_, i) => cohort({ start_year: 1871 + i })),
      ...Array.from({ length: 10 }, (_, i) =>
        cohort({ start_year: 1961 + i, status: "Depleted", depleted_period: 20 }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        cohort({
          start_year: 1971 + i,
          status: "Depleted",
          depleted_period: 10,
          periods_covered: 20,
        }),
      ),
      ...Array.from({ length: 18 }, (_, i) =>
        cohort({ start_year: 1973 + i, status: "InProgress", periods_covered: 10 }),
      ),
    ];
    const headline = historyHeadline(result(cohorts));
    expect(headline.failed).toBe(12);
    expect(headline.decided).toBe(102);
    expect(headline.inProgress).toBe(18);
    expect(headline.rate).toBeCloseTo(90 / 102);
  });
});

describe("ranking start years", () => {
  const cohorts = [
    cohort({ start_year: 1901, end_net_worth_real: 3_000_000 }),
    cohort({ start_year: 1902, status: "Depleted", depleted_period: 25 }),
    cohort({ start_year: 1903, status: "Depleted", depleted_period: 12 }),
    cohort({ start_year: 1904, end_net_worth_real: 500_000 }),
    cohort({ start_year: 1905, status: "InProgress", end_net_worth_real: 9e9 }),
  ];

  it("puts the soonest failure first and the richest survivor last, without in-progress years", () => {
    expect(rankedCohorts(result(cohorts)).map((c) => c.start_year)).toEqual([
      1903, 1902, 1904, 1901,
    ]);
  });

  it("names worst, median and best from that order", () => {
    const e = extremes(result(cohorts));
    expect(e?.worst.start_year).toBe(1903);
    expect(e?.median.start_year).toBe(1902);
    expect(e?.best.start_year).toBe(1901);
  });

  it("has no extremes with no outcomes", () => {
    expect(extremes(result([cohort({ status: "InProgress" })]))).toBeNull();
  });

  it("says how long the money lasted", () => {
    expect(yearsLasted(cohorts[2])).toBe(12);
    expect(yearsLasted(cohort({ status: "InProgress", periods_covered: 7 }))).toBe(7);
    expect(outcomePhrase(cohorts[2], 30)).toBe("Ran out after 12 years");
    expect(outcomePhrase(cohorts[0], 30)).toBe("Lasted all 30 years · ends $3M");
  });

  it("draws a failure at zero and never below", () => {
    const bars = cohortBars(result(cohorts));
    expect(bars[1]).toEqual({ startYear: 1902, status: "Depleted", value: 0 });
  });
});

function snapshot(overrides: Partial<PeriodSnapshot>): PeriodSnapshot {
  return {
    period: 0,
    period_start: { year: 2026, month: 1 },
    balances: {},
    income: 0,
    expenses: 0,
    taxes: 0,
    contributions: 0,
    employer_match: 0,
    one_time_contributions: 0,
    required_distributions: 0,
    surplus: 0,
    withdrawals: {},
    growth: 0,
    net_worth: 0,
    income_by_stream: {},
    expenses_by_stream: {},
    withdrawal_taxes: 0,
    early_withdrawal_penalty: 0,
    drawdown_phase: null,
    contributions_by_account: {},
    deflator: 1,
    deflator_end: 1,
    ...overrides,
  };
}

const plan = {
  name: "Test plan",
  people: [{ id: "p1", name: "Alex", birth: { year: 1960, month: 1 } }],
  accounts: [
    { id: "a", allocation: "Aggressive", balance: 800_000 },
    { id: "b", allocation: "Conservative", balance: 200_000 },
    { id: "c", allocation: { FixedRate: 0.04 }, balance: 900_000 },
  ],
  assumptions: {
    inflation: 0.03,
    strategy_returns: { ...rates(0.05), aggressive: 0.0635 },
  },
  sim_config: { start: { year: 2026, month: 1 } },
} as unknown as Plan;

const market = (year: number, inflation: number) => ({
  historical_year: year,
  stocks: 0.1,
  bonds: 0.02,
  inflation,
  strategy_returns: rates(0.08),
});

const detail: CohortDetail = {
  start_year: 1973,
  status: "Depleted",
  periods_covered: 2,
  depleted_period: 1,
  projection: {
    snapshots: [
      snapshot({
        net_worth: 110_000,
        growth: 10_000,
        expenses: 50_000,
        withdrawals: { a: 30_000, b: 20_000 },
        deflator: 1,
        deflator_end: 1.1,
      }),
      snapshot({
        period: 1,
        period_start: { year: 2027, month: 1 },
        net_worth: 0,
        deflator: 1.1,
        deflator_end: 1.21,
      }),
    ],
    warnings: [{ DepletedFunds: { period: 1 } }],
    streams: [],
    one_time: [],
  },
  market: [market(1973, 0.1), market(1974, 0.1)],
};

describe("cohortLedgerRows", () => {
  const rows = cohortLedgerRows(plan, detail, true);

  it("names the market year, the plan year and the ages", () => {
    expect(rows[0]).toMatchObject({
      historicalYear: 1973,
      planYear: 2026,
      ages: "Alex 66",
    });
    expect(rows[1]).toMatchObject({
      historicalYear: 1974,
      planYear: 2027,
      ages: "Alex 67",
    });
  });

  it("measures the portfolio's return on what was invested, and after this period's inflation", () => {
    expect(rows[0].portfolioReturn).toBeCloseTo(0.1);
    expect(rows[0].portfolioRealReturn).toBeCloseTo(0);
    // Nothing invested, nothing earned: no return rather than a division by zero.
    expect(rows[1].portfolioReturn).toBeNull();
  });

  it("deflates flows by the start factor and balances by the end factor", () => {
    expect(rows[0].withdrawals).toBe(50_000);
    expect(rows[0].netWorth).toBeCloseTo(100_000);
  });

  it("marks the year it ran short and every year after", () => {
    expect(rows.map((r) => r.shortfall)).toEqual([false, true]);
  });

  it("says when the money ran out, in the plan's own years", () => {
    expect(cohortVerdict(plan, detail, 30, true)).toBe(
      "Starting in 1973, the money runs out in 2027 (Alex 67), 1 year in.",
    );
  });

  it("exports the same rows", () => {
    const csv = ledgerCsv(plan, detail, true).split("\n");
    expect(csv[4]).toMatch(/^Historical year,Plan year/);
    expect(csv[5]).toMatch(/^1973,2026,Alex 66,0\.1,0\.1,0\.02,/);
    expect(csv[6]).toMatch(/,yes$/);
  });
});

describe("forecastGap", () => {
  it("compares history with the typed return of the strategy holding the most money", () => {
    expect(dominantStrategy(plan)).toBe("aggressive");
    const gap = forecastGap(plan, result([cohort({})]));
    expect(gap?.strategyLabel).toBe("Aggressive");
    expect(gap?.historicalReal).toBe(0.064);
    expect(gap?.typedReal).toBeCloseTo(1.0635 / 1.03 - 1);
  });

  it("has nothing to compare when every account is on a fixed rate", () => {
    const fixed = { ...plan, accounts: [plan.accounts[2]] } as Plan;
    expect(forecastGap(fixed, result([cohort({})]))).toBeNull();
  });
});
