import { describe, expect, it } from "vitest";
import type { Account } from "../../types/generated/Account";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Person } from "../../types/generated/Person";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import { seriesDefs } from "./chartData";
import { headlineMetrics, milestones, yearDetail } from "./planData";

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

function person(id: string, birth: number, retirement: number): Person {
  return {
    id,
    name: id,
    birth: { year: birth, month: 1 },
    retirement: { year: retirement, month: 1 },
  } as Person;
}

function account(id: string): Account {
  return { id, name: id } as Account;
}

function plan(people: Person[], accounts: Account[]): Plan {
  return { people, accounts } as Plan;
}

function mc(overrides: Partial<MonteCarloResult>): MonteCarloResult {
  return { n_paths: 1000, success_rate: 1, percentiles: [], ...overrides };
}

describe("headlineMetrics", () => {
  it("measures expenses covered at the earliest retirement, not the latest", () => {
    const p = plan([person("late", 1980, 2030), person("early", 1985, 2027)], []);
    const proj = projection([
      snapshot({
        period_start: { year: 2027, month: 1 },
        net_worth: 1000,
        expenses: 100,
      }),
      snapshot({
        period_start: { year: 2030, month: 1 },
        net_worth: 4000,
        expenses: 100,
      }),
    ]);

    const m = headlineMetrics(p, proj, null, null, false);
    expect(m.coverYear).toBe(2027);
    expect(m.coverYears).toBe(10);
  });

  it("reports coverage identically in both dollar bases", () => {
    // Net worth and expenses come from the same snapshot, so the deflator
    // cancels — the ratio must not move when the basis toggles.
    const p = plan([person("a", 1980, 2030)], []);
    const proj = projection([
      snapshot({
        period_start: { year: 2030, month: 1 },
        net_worth: 2400,
        expenses: 100,
        deflator: 1.8,
      }),
    ]);

    const nominal = headlineMetrics(p, proj, null, null, false);
    const real = headlineMetrics(p, proj, null, null, true);
    expect(nominal.coverYears).toBe(24);
    expect(real.coverYears).toBe(24);
  });

  it("derives failed paths and the year the median path reaches zero", () => {
    const p = plan([person("a", 1980, 2030)], []);
    const proj = projection([snapshot({})]);
    const result = mc({
      success_rate: 0.38,
      percentiles: [
        {
          period: 0,
          period_start: { year: 2030, month: 1 },
          deflator: 1,
          p10: 500,
          p25: 700,
          p50: 900,
          p75: 1100,
          p90: 1300,
        },
        {
          period: 1,
          period_start: { year: 2040, month: 1 },
          deflator: 2,
          p10: 0,
          p25: 0,
          p50: 0,
          p75: 400,
          p90: 800,
        },
      ],
    });

    const m = headlineMetrics(p, proj, result, null, false);
    expect(m.failedPaths).toBe(620);
    expect(m.medianZeroYear).toBe(2040);
    // p10 at the final period, nominal.
    expect(m.p10AtEnd).toBe(0);
  });

  it("deflates the closing p10 when showing today's dollars", () => {
    const p = plan([person("a", 1980, 2030)], []);
    const result = mc({
      percentiles: [
        {
          period: 0,
          period_start: { year: 2040, month: 1 },
          deflator: 2,
          p10: 1000,
          p25: 1200,
          p50: 1400,
          p75: 1600,
          p90: 1800,
        },
      ],
    });

    expect(headlineMetrics(p, projection([]), result, null, true).p10AtEnd).toBe(500);
    expect(headlineMetrics(p, projection([]), result, null, false).p10AtEnd).toBe(1000);
  });

  it("returns nulls rather than zeros before Monte Carlo has run", () => {
    const p = plan([person("a", 1980, 2030)], []);
    const m = headlineMetrics(p, projection([snapshot({})]), null, null, false);
    expect(m.successRate).toBeNull();
    expect(m.failedPaths).toBeNull();
    expect(m.p10AtEnd).toBeNull();
  });
});

describe("milestones", () => {
  it("ends at depletion with zero rather than reporting a plan-end figure", () => {
    const p = plan([person("a", 1980, 2030)], []);
    const proj = projection([
      snapshot({ period_start: { year: 2030, month: 1 }, net_worth: 900 }),
      snapshot({ period_start: { year: 2050, month: 1 }, net_worth: 0 }),
    ]);

    const [retirement, end] = milestones(p, proj, 2045, false);
    expect(retirement.value).toBe(900);
    expect(end.label).toBe("At depletion");
    expect(end.value).toBe(0);
    expect(end.critical).toBe(true);
  });
});

describe("yearDetail", () => {
  it("totals withdrawals across accounts and flags a negative surplus", () => {
    const p = plan([person("a", 1980, 2030)], [account("x"), account("y")]);
    const proj = projection([
      snapshot({
        period_start: { year: 2030, month: 1 },
        balances: { x: 600, y: 400 },
        withdrawals: { x: 30, y: 12 },
        net_worth: 1000,
        surplus: -50,
      }),
    ]);

    const detail = yearDetail(p, proj, 2030, seriesDefs(p), false);
    const flows = new Map(detail?.flows.map((f) => [f.key, f]));
    expect(flows.get("withdrawals")?.value).toBe(42);
    expect(flows.get("surplus")?.critical).toBe(true);
    expect(detail?.balances.map((b) => b.value)).toEqual([600, 400]);
  });

  it("buckets accounts past the palette into Other, matching the chart stack", () => {
    const accounts = Array.from({ length: 10 }, (_, i) => account(`a${i}`));
    const p = plan([person("a", 1980, 2030)], accounts);
    const balances = Object.fromEntries(accounts.map((a, i) => [a.id, (i + 1) * 10]));
    const proj = projection([
      snapshot({ period_start: { year: 2030, month: 1 }, balances, net_worth: 550 }),
    ]);

    const detail = yearDetail(p, proj, 2030, seriesDefs(p), false);
    // 8 named series plus one "Other" holding the 9th and 10th (90 + 100).
    expect(detail?.balances).toHaveLength(9);
    expect(detail?.balances[8].label).toBe("Other");
    expect(detail?.balances[8].value).toBe(190);
  });

  it("returns null for a year outside the projection", () => {
    const p = plan([person("a", 1980, 2030)], []);
    const proj = projection([snapshot({ period_start: { year: 2030, month: 1 } })]);
    expect(yearDetail(p, proj, 2099, seriesDefs(p), false)).toBeNull();
  });
});
