import { describe, expect, it } from "vitest";
import type { PeriodSnapshot } from "../types/generated/PeriodSnapshot";
import type { Person } from "../types/generated/Person";
import type { Plan } from "../types/generated/Plan";
import type { Projection } from "../types/generated/Projection";
import { currentSpendingEstimate, isWorkingPeriod, lastToRetire } from "./currentSpending";

function snapshot(year: number, overrides: Partial<PeriodSnapshot> = {}): PeriodSnapshot {
  return {
    period: 0,
    period_start: { year, month: 1 },
    balances: {},
    income: 0,
    expenses: 0,
    taxes: 0,
    contributions: 0,
    employer_match: 0,
    required_distributions: 0,
    surplus: 0,
    withdrawals: {},
    net_worth: 0,
    deflator: 1,
    ...overrides,
  };
}

function person(id: string, retirement: { year: number; month: number }): Person {
  return {
    id,
    name: id,
    birth: { year: 1970, month: 1 },
    retirement,
    life_expectancy_age: 95,
  } as Person;
}

function plan(people: Person[]): Plan {
  return { people, streams: [] } as unknown as Plan;
}

function projection(snapshots: PeriodSnapshot[]): Projection {
  return { snapshots, warnings: [] };
}

/** A working year: 100k of pay, 15k saved, 20k of tax — 65k lived on. */
function workingYear(year: number, overrides: Partial<PeriodSnapshot> = {}) {
  return snapshot(year, {
    income: 100_000,
    contributions: 15_000,
    taxes: 20_000,
    surplus: 65_000,
    ...overrides,
  });
}

describe("isWorkingPeriod", () => {
  it("holds while anyone is still earning, and stops when the last one retires", () => {
    const household = plan([
      person("early", { year: 2030, month: 1 }),
      person("later", { year: 2034, month: 1 }),
    ]);

    expect(isWorkingPeriod(household, snapshot(2031))).toBe(true);
    expect(isWorkingPeriod(household, snapshot(2033))).toBe(true);
    expect(isWorkingPeriod(household, snapshot(2034))).toBe(false);
  });

  it("is false for a household with nobody in it", () => {
    expect(isWorkingPeriod(plan([]), snapshot(2030))).toBe(false);
    expect(lastToRetire(plan([]))).toBeNull();
  });
});

describe("currentSpendingEstimate", () => {
  it("is income less contributions and taxes in a year with no expense streams", () => {
    const household = plan([person("solo", { year: 2028, month: 1 })]);

    const estimate = currentSpendingEstimate(
      household,
      projection([workingYear(2026), workingYear(2027), snapshot(2028)]),
    );

    expect(estimate).toEqual({ annualAmount: 65_000, year: 2027 });
  });

  it("adds back spending that is modelled, so a partial budget still totals", () => {
    const household = plan([person("solo", { year: 2027, month: 1 })]);

    const estimate = currentSpendingEstimate(
      household,
      projection([
        workingYear(2026, { expenses: 24_000, surplus: 41_000 }),
        snapshot(2027),
      ]),
    );

    expect(estimate?.annualAmount).toBe(65_000);
  });

  it("reads in today's dollars, not the nominal dollars of the year it came from", () => {
    const household = plan([person("solo", { year: 2028, month: 1 })]);
    // Twenty years of inflation would otherwise seed a retirement estimate
    // roughly twice too high.
    const estimate = currentSpendingEstimate(
      household,
      projection([
        workingYear(2026),
        workingYear(2027, { surplus: 130_000, deflator: 2 }),
        snapshot(2028),
      ]),
    );

    expect(estimate).toEqual({ annualAmount: 65_000, year: 2027 });
  });

  it("backs out required distributions — portfolio cash is not what a paycheck left", () => {
    const household = plan([person("solo", { year: 2028, month: 1 })]);

    const estimate = currentSpendingEstimate(
      household,
      projection([
        workingYear(2027, { required_distributions: 10_000, surplus: 75_000 }),
        snapshot(2028),
      ]),
    );

    expect(estimate?.annualAmount).toBe(65_000);
  });

  it("ignores the year of the retirement itself, which is only part salary", () => {
    const household = plan([
      person("early", { year: 2027, month: 6 }),
      person("later", { year: 2031, month: 1 }),
    ]);

    // 2027 straddles the first retirement and reads low; 2026 is the last
    // year everyone works right through.
    const estimate = currentSpendingEstimate(
      household,
      projection([
        workingYear(2026),
        workingYear(2027, { surplus: 30_000 }),
        workingYear(2028, { surplus: 40_000 }),
      ]),
    );

    expect(estimate).toEqual({ annualAmount: 65_000, year: 2026 });
  });

  it("has nothing to offer when the projection starts after retirement", () => {
    const household = plan([person("solo", { year: 2020, month: 1 })]);

    expect(
      currentSpendingEstimate(household, projection([snapshot(2026), snapshot(2027)])),
    ).toBeNull();
  });
});
