import { describe, expect, it } from "vitest";
import { diagnostics, pathGroup } from "../../test/fixtures";
import type { Account } from "../../types/generated/Account";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Person } from "../../types/generated/Person";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import { seriesDefs } from "./chartData";
import {
  firstDeath,
  headlineMetrics,
  milestones,
  successMargin,
  yearDetail,
} from "./planData";

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

function person(
  id: string,
  birth: number,
  retirement: number,
  retirementMonth = 1,
  lifeExpectancyAge = 95,
): Person {
  return {
    id,
    name: id,
    birth: { year: birth, month: 1 },
    retirement: { year: retirement, month: retirementMonth },
    life_expectancy_age: lifeExpectancyAge,
  } as Person;
}

function account(id: string): Account {
  return { id, name: id } as Account;
}

function plan(people: Person[], accounts: Account[]): Plan {
  return { people, accounts } as Plan;
}

function mc(overrides: Partial<MonteCarloResult>): MonteCarloResult {
  return {
    n_paths: 1000,
    success_rate: 1,
    percentiles: [],
    diagnostics: diagnostics(),
    ...overrides,
  };
}

/**
 * A two-person plan with the assumptions `yearDetail`'s survivor note reads.
 * `plan()` above deliberately casts a bare object; the survivor derivations
 * are the first that look past `people` and `accounts`.
 */
function household(people: Person[], overrides: Partial<Plan["assumptions"]> = {}): Plan {
  return {
    people,
    accounts: [],
    streams: [],
    social_security: [],
    assumptions: {
      filing_status: "Single",
      survivor_expense_factor: 1,
      ...overrides,
    },
  } as unknown as Plan;
}

describe("firstDeath", () => {
  it("is the earliest expectancy, with everyone who outlives it", () => {
    const p = household([
      person("elder", 1960, 2025, 1, 80), // dies 2040
      person("younger", 1970, 2035, 1, 85), // dies 2055
    ]);
    const death = firstDeath(p);
    expect(death?.decedent.id).toBe("elder");
    expect(death?.date).toEqual({ year: 2040, month: 1 });
    expect(death?.survivors.map((s) => s.id)).toEqual(["younger"]);
  });

  it("is null when nobody is left behind", () => {
    // One person cannot be survived; two who die in the same month leave no
    // survivor either, so neither household transitions.
    expect(firstDeath(household([person("solo", 1960, 2025, 1, 80)]))).toBeNull();
    expect(
      firstDeath(
        household([person("a", 1960, 2025, 1, 80), person("b", 1960, 2025, 1, 80)]),
      ),
    ).toBeNull();
  });
});

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

  it("skips the prorated stub year for a late-in-year retirement", () => {
    // Retiring in December: the retirement year itself is an 11/12-stub
    // where expenses are 1/12 of a full year, so dividing net worth by it
    // overstates coverage by ~12x. The metric should land on 2039 instead.
    const p = plan([person("a", 1980, 2038, 12)], []);
    const proj = projection([
      snapshot({
        period_start: { year: 2038, month: 1 },
        net_worth: 1429417,
        expenses: 5833.33,
      }),
      snapshot({
        period_start: { year: 2039, month: 1 },
        net_worth: 1429417,
        expenses: 70000,
      }),
    ]);

    const m = headlineMetrics(p, proj, null, null, false);
    expect(m.coverYear).toBe(2039);
    expect(m.coverYears).toBeCloseTo(20.4, 1);
  });

  it("falls back to null when no full retirement period is in the projection", () => {
    const p = plan([person("a", 1980, 2038, 12)], []);
    const proj = projection([
      snapshot({
        period_start: { year: 2038, month: 1 },
        net_worth: 1000,
        expenses: 100,
      }),
    ]);

    const m = headlineMetrics(p, proj, null, null, false);
    expect(m.coverYear).toBeNull();
    expect(m.coverYears).toBeNull();
  });

  it("takes the failed count and the median failure year off the diagnostics", () => {
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
      diagnostics: diagnostics({
        depletion_histogram: [200, 420],
        failed: pathGroup({ n: 620 }),
      }),
    });

    const m = headlineMetrics(p, proj, result, null, false);
    // The engine's exact count, not 1000 x (1 - 0.38) rounded back out.
    expect(m.failedPaths).toBe(620);
    // Half of 620 is 310, which the cumulative count first reaches in 2040 —
    // not "the year p50 hits zero", which this used to report.
    expect(m.medianFailureYear).toBe(2040);
    // p10 at the final period, nominal.
    expect(m.p10AtEnd).toBe(0);
  });

  it("reports zero failures rather than null when every path held", () => {
    const p = plan([person("a", 1980, 2030)], []);
    const m = headlineMetrics(p, projection([snapshot({})]), mc({}), null, false);
    expect(m.failedPaths).toBe(0);
    expect(m.medianFailureYear).toBeNull();
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
    expect(m.successMargin).toBeNull();
  });

  it("carries the sampling margin for the path count that produced the rate", () => {
    const p = plan([person("a", 1980, 2030)], []);
    const proj = projection([snapshot({})]);

    const coarse = headlineMetrics(
      p,
      proj,
      mc({ success_rate: 0.9, n_paths: 1000 }),
      null,
      false,
    );
    const fine = headlineMetrics(
      p,
      proj,
      mc({ success_rate: 0.9, n_paths: 25000 }),
      null,
      false,
    );

    // ~2 points at 1,000 paths — the whole reason the tile cannot print a
    // first decimal at that count.
    expect(coarse.successMargin).toBeCloseTo(0.0202, 3);
    // 25x the paths, so roughly a fifth the margin.
    expect(fine.successMargin).toBeCloseTo(0.0038, 3);
  });
});

describe("successMargin", () => {
  it("narrows as the square root of the path count", () => {
    // Four times the paths roughly halves the margin (Wilson's correction
    // term makes this approximate rather than exact at small n).
    expect(successMargin(0.9, 4000)).toBeCloseTo(successMargin(0.9, 1000) / 2, 3);
  });

  it("stays finite at a 100% success rate", () => {
    // The textbook z*sqrt(p(1-p)/n) collapses to exactly zero here, which
    // would render "100% ± 0" — a certainty 5,000 paths cannot support.
    const margin = successMargin(1, 5000);
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeLessThan(0.01);
  });

  it("stays finite at a 0% success rate", () => {
    const margin = successMargin(0, 5000);
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeLessThan(0.01);
  });

  it("is widest in the middle, where a proportion is least certain", () => {
    expect(successMargin(0.5, 5000)).toBeGreaterThan(successMargin(0.9, 5000));
    expect(successMargin(0.9, 5000)).toBeGreaterThan(successMargin(1, 5000));
  });

  it("does not divide by zero when no paths ran", () => {
    expect(successMargin(0.9, 0)).toBe(0);
  });

  it("reports the plan's final year and the age that determines it", () => {
    const p = plan([person("a", 1980, 2030, 1, 90)], []);
    const proj = projection([
      snapshot({ period_start: { year: 2030, month: 1 } }),
      snapshot({ period_start: { year: 2070, month: 1 } }),
    ]);

    const m = headlineMetrics(p, proj, null, null, false);
    expect(m.planEndYear).toBe(2070);
    expect(m.planEndAge).toBe(90);
  });

  it("reports a null plan end year with no snapshots", () => {
    const p = plan([person("a", 1980, 2030)], []);
    const m = headlineMetrics(p, projection([]), null, null, false);
    expect(m.planEndYear).toBeNull();
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

  it("names the plan-end age in the plan-end milestone's sub-text", () => {
    const p = plan([person("a", 1980, 2030, 1, 90)], []);
    const proj = projection([
      snapshot({ period_start: { year: 2030, month: 1 }, net_worth: 900 }),
      snapshot({ period_start: { year: 2070, month: 1 }, net_worth: 1200 }),
    ]);

    const [, end] = milestones(p, proj, null, false);
    expect(end.label).toBe("At plan end");
    expect(end.sub).toBe("2070 · age 90 · nominal");
  });
});

describe("milestones (survivor transition)", () => {
  it("reports net worth at the first death and names who is left", () => {
    const p = household([
      person("elder", 1960, 2025, 1, 80), // dies 2040
      person("younger", 1970, 2035, 1, 85),
    ]);
    const proj = projection([
      snapshot({ period_start: { year: 2040, month: 1 }, net_worth: 700 }),
      snapshot({ period_start: { year: 2054, month: 1 }, net_worth: 300 }),
    ]);

    const death = milestones(p, proj, null, false).find(
      (m) => m.key === "__first-death__",
    );
    expect(death?.label).toBe("At elder's death");
    expect(death?.value).toBe(700);
    expect(death?.sub).toBe("2040 · younger alone");
  });

  it("has no such milestone for a one-person plan", () => {
    const p = household([person("solo", 1960, 2025, 1, 80)]);
    const proj = projection([
      snapshot({ period_start: { year: 2040, month: 1 }, net_worth: 700 }),
    ]);
    expect(
      milestones(p, proj, null, false).some((m) => m.key === "__first-death__"),
    ).toBe(false);
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
        growth: -20,
      }),
    ]);

    const detail = yearDetail(p, proj, 2030, seriesDefs(p), false);
    const flows = new Map(detail?.flows.map((f) => [f.key, f]));
    expect(flows.get("withdrawals")?.value).toBe(42);
    // Growth is no longer a flow row — it explains net worth, not cash.
    expect(flows.has("growth")).toBe(false);
    expect(detail?.growth.value).toBe(-20);
    expect(detail?.growth.critical).toBe(true);
    expect(detail?.balances.map((b) => b.value)).toEqual([600, 400]);
  });

  it("splits the flows into the two sides of the engine's cash identity", () => {
    const p = plan([person("a", 1980, 2030)], [account("x")]);
    const proj = projection([
      snapshot({
        period_start: { year: 2030, month: 1 },
        income: 76_880,
        withdrawals: { x: 106_715 },
        required_distributions: 106_715,
        expenses: 70_000,
        taxes: 39_036,
        contributions: 0,
        surplus: 74_559,
        growth: 184_200,
      }),
    ]);

    const detail = yearDetail(p, proj, 2030, seriesDefs(p), false);
    expect(detail?.moneyIn).toBe(183_595);
    // Derived from the rows on screen, and equal to the surplus the engine
    // reported — the panel adds up to the same answer the simulation did.
    expect(detail?.leftOver).toBe(74_559);
    expect(detail?.leftOver).toBe(proj.snapshots[0].surplus);
    expect(detail?.shortfall).toBe(false);
    expect(detail?.leftOverLabel).toBe("Left over");

    const groups = Object.fromEntries(detail?.flows.map((f) => [f.key, f.group]) ?? []);
    expect(groups).toEqual({
      income: "in",
      withdrawals: "in",
      required_distributions: "in",
      expenses: "out",
      taxes: "out",
      contributions: "out",
    });
  });

  it("keeps annotation rows out of the totals they sit under", () => {
    const p = plan([person("a", 1980, 2030)], [account("x")]);
    const proj = projection([
      snapshot({
        period_start: { year: 2029, month: 1 },
        income: 100_000,
        withdrawals: { x: 20_000 },
        // Already inside withdrawals; counting it again would inflate money in.
        required_distributions: 20_000,
        expenses: 40_000,
        taxes: 25_000,
        contributions: 10_000,
        // Never passed through household cash, so not an outflow.
        employer_match: 5_000,
      }),
    ]);

    const detail = yearDetail(p, proj, 2029, seriesDefs(p), false);
    const subsets = detail?.flows.filter((f) => f.subset).map((f) => f.key);
    expect(subsets).toEqual(["required_distributions", "employer_match"]);
    expect(detail?.moneyIn).toBe(120_000);
    expect(detail?.leftOver).toBe(45_000);
  });

  it("reports a shortfall rather than a reassuring zero when funds run out", () => {
    const p = plan([person("a", 1980, 2030)], [account("x")]);
    const proj = projection([
      snapshot({
        period_start: { year: 2030, month: 1 },
        income: 42_230,
        // Depleted: the drawdown could not cover the gap, so the engine
        // clamps surplus to zero even though the year did not fund itself.
        withdrawals: { x: 0 },
        expenses: 70_000,
        taxes: 4_110,
        surplus: 0,
      }),
    ]);

    const detail = yearDetail(p, proj, 2030, seriesDefs(p), false);
    expect(detail?.shortfall).toBe(true);
    expect(detail?.leftOver).toBe(-31_880);
    expect(detail?.leftOverLabel).toBe("Shortfall");
  });

  it("calls the leftover current spending while anyone is still working", () => {
    const p = plan([person("a", 1980, 2030)], [account("x")]);
    const proj = projection([
      snapshot({ period_start: { year: 2029, month: 1 }, surplus: 65_000 }),
      snapshot({ period_start: { year: 2030, month: 1 }, surplus: 5_000 }),
    ]);

    const working = yearDetail(p, proj, 2029, seriesDefs(p), false);
    expect(working?.leftOverLabel).toBe("Current spending");
    expect(working?.spendingNote).toContain("every dollar you save is in this plan");

    // Retired: the same arithmetic really is a leftover, and needs no caveat.
    const retired = yearDetail(p, proj, 2030, seriesDefs(p), false);
    expect(retired?.leftOverLabel).toBe("Left over");
    expect(retired?.spendingNote).toBeNull();
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

  it("marks a person dead rather than showing them present past their expectancy", () => {
    const p = household([
      person("elder", 1960, 2025, 1, 80), // dies 2040
      person("younger", 1970, 2035, 1, 85),
    ]);
    const proj = projection([
      snapshot({ period_start: { year: 2040, month: 1 } }),
      snapshot({ period_start: { year: 2041, month: 1 } }),
    ]);

    expect(yearDetail(p, proj, 2040, [], false)?.ages).toEqual([
      { name: "elder", age: 80, status: "dies" },
      { name: "younger", age: 70, status: "retired" },
    ]);
    expect(yearDetail(p, proj, 2041, [], false)?.ages[0].status).toBe("died");
  });

  it("explains the survivor transition with only the consequences the plan carries", () => {
    const people = [
      person("elder", 1960, 2025, 1, 80), // dies 2040
      person("younger", 1970, 2035, 1, 85),
    ];
    const proj = projection([
      snapshot({ period_start: { year: 2039, month: 1 } }),
      snapshot({ period_start: { year: 2040, month: 1 } }),
      snapshot({ period_start: { year: 2041, month: 1 } }),
    ]);

    const bare = household(people);
    expect(yearDetail(bare, proj, 2039, [], false)?.transition).toBeNull();
    expect(yearDetail(bare, proj, 2040, [], false)?.transition).toBe(
      "elder dies in 2040.",
    );
    expect(yearDetail(bare, proj, 2041, [], false)?.transition).toBe(
      "A household of 1 since elder's death in 2040.",
    );

    const full = household(people, {
      filing_status: "MarriedFilingJointly",
      survivor_expense_factor: 0.75,
    });
    expect(yearDetail(full, proj, 2040, [], false)?.transition).toBe(
      "elder dies in 2040: filing status is Single from next year; household spending steps to 75%.",
    );
  });

  it("returns null for a year outside the projection", () => {
    const p = plan([person("a", 1980, 2030)], []);
    const proj = projection([snapshot({ period_start: { year: 2030, month: 1 } })]);
    expect(yearDetail(p, proj, 2099, seriesDefs(p), false)).toBeNull();
  });
});
