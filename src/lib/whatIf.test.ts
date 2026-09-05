import { describe, expect, it } from "vitest";
import type { Plan } from "../types/generated/Plan";
import {
  applyOverrides,
  BASELINE,
  isBaseline,
  lifeExpectancyShiftBounds,
  overrideLabels,
  retirementShiftBounds,
  suggestScenarioName,
  type WhatIfOverrides,
} from "./whatIf";

// Alex retires 2038-12 and holds a 403(b) whose contributions end at their own
// retirement; Sam retires 2042-06 and holds an IRA, which is not an employer
// plan and so never constrains a shift.
const plan = {
  id: "base",
  name: "Base",
  people: [
    {
      id: "p1",
      name: "Alex",
      birth: { year: 1983, month: 8 },
      retirement: { year: 2038, month: 12 },
      life_expectancy_age: 90,
    },
    {
      id: "p2",
      name: "Sam",
      birth: { year: 1987, month: 6 },
      retirement: { year: 2042, month: 6 },
      life_expectancy_age: 92,
    },
  ],
  accounts: [
    {
      id: "a1",
      owner: "p1",
      name: "403(b)",
      plan_type: "EmployerPlan",
      contributions: [
        {
          id: "c1",
          rule: { FlatAmount: { amount: 1000 } },
          start: "PlanStart",
          end: { AtRetirement: "p1" },
        },
      ],
    },
    {
      id: "a2",
      owner: "p2",
      name: "IRA",
      plan_type: "Ira",
      contributions: [
        {
          id: "c2",
          rule: { FlatAmount: { amount: 500 } },
          start: "PlanStart",
          end: "PlanEnd",
        },
      ],
    },
  ],
  streams: [
    {
      id: "s1",
      name: "Salary",
      owner: "p1",
      direction: "Income",
      annual_amount: 120_000,
    },
    {
      id: "s2",
      name: "Spending",
      owner: null,
      direction: "Expense",
      annual_amount: 80_000,
    },
    {
      id: "s3",
      name: "Travel",
      owner: null,
      direction: "Expense",
      annual_amount: 10_000,
    },
  ],
  assumptions: {
    inflation: 0.025,
    asset_returns: { UsEquity: 0.07, UsBonds: 0.03 },
    asset_volatility: { UsEquity: 0.16, UsBonds: 0.06 },
  },
  sim_config: { start: { year: 2026, month: 1 } },
} as unknown as Plan;

function overrides(patch: Partial<WhatIfOverrides> = {}): WhatIfOverrides {
  return { ...BASELINE, ...patch };
}

describe("applyOverrides", () => {
  it("leaves the plan it was given untouched", () => {
    const before = structuredClone(plan);
    applyOverrides(plan, overrides({ spendingMultiplier: 0.5, returnShiftBp: -300 }));
    expect(plan).toEqual(before);
  });

  it("is the identity at rest", () => {
    expect(applyOverrides(plan, BASELINE)).toEqual(plan);
  });

  it("shifts one person's retirement without moving the other's", () => {
    const draft = applyOverrides(plan, overrides({ retirementShiftYears: { p1: -3 } }));
    expect(draft.people[0]?.retirement).toEqual({ year: 2035, month: 12 });
    expect(draft.people[1]?.retirement).toEqual({ year: 2042, month: 6 });
  });

  it("scales expense streams and leaves income alone", () => {
    const draft = applyOverrides(plan, overrides({ spendingMultiplier: 0.9 }));
    expect(draft.streams.map((s) => s.annual_amount)).toEqual([120_000, 72_000, 9_000]);
  });

  it("shifts every priced asset class's return, and prices no new ones", () => {
    const draft = applyOverrides(plan, overrides({ returnShiftBp: -150 }));
    expect(Object.keys(draft.assumptions.asset_returns)).toEqual(["UsEquity", "UsBonds"]);
    expect(draft.assumptions.asset_returns.UsEquity).toBeCloseTo(0.055, 10);
    expect(draft.assumptions.asset_returns.UsBonds).toBeCloseTo(0.015, 10);
  });

  it("scales volatility without touching returns", () => {
    const draft = applyOverrides(plan, overrides({ volatilityMultiplier: 1.5 }));
    expect(draft.assumptions.asset_volatility).toEqual({ UsEquity: 0.24, UsBonds: 0.09 });
    expect(draft.assumptions.asset_returns).toEqual(plan.assumptions.asset_returns);
  });

  it("shifts inflation", () => {
    const draft = applyOverrides(plan, overrides({ inflationShiftBp: 100 }));
    expect(draft.assumptions.inflation).toBeCloseTo(0.035, 10);
  });

  it("moves everyone's life expectancy together", () => {
    const draft = applyOverrides(plan, overrides({ lifeExpectancyShiftYears: 8 }));
    expect(draft.people.map((p) => p.life_expectancy_age)).toEqual([98, 100]);
  });

  it("keeps life expectancy a serializable age however far the knob is pushed", () => {
    const draft = applyOverrides(plan, overrides({ lifeExpectancyShiftYears: -200 }));
    expect(draft.people.every((p) => p.life_expectancy_age >= 1)).toBe(true);
  });
});

describe("isBaseline", () => {
  it("is true at rest, and for a shift recorded as zero", () => {
    expect(isBaseline(BASELINE)).toBe(true);
    expect(isBaseline(overrides({ retirementShiftYears: { p1: 0 } }))).toBe(true);
  });

  it("is false once any knob moves", () => {
    expect(isBaseline(overrides({ retirementShiftYears: { p1: 1 } }))).toBe(false);
    expect(isBaseline(overrides({ volatilityMultiplier: 1.01 }))).toBe(false);
  });
});

describe("retirementShiftBounds", () => {
  it("always contains zero", () => {
    for (const id of ["p1", "p2"]) {
      const bounds = retirementShiftBounds(plan, id);
      expect(bounds.min).toBeLessThanOrEqual(0);
      expect(bounds.max).toBeGreaterThanOrEqual(0);
    }
  });

  it("stops short of a retirement date on or before the person's birth", () => {
    const infant = structuredClone(plan);
    infant.people[0]!.birth = { year: 2030, month: 1 };
    // Retirement 2038-12, birth 2030-01: eight years and eleven months of
    // room, so eight whole years back is the last legal step.
    expect(retirementShiftBounds(infant, "p1").min).toBe(-8);
  });

  it("stops where an employer-plan contribution would outlive the retirement", () => {
    const dated = structuredClone(plan);
    dated.accounts[0]!.contributions[0]!.end = { Date: { year: 2036, month: 6 } };
    expect(retirementShiftBounds(dated, "p1").min).toBe(-2);
  });

  it("ignores a contribution to an account that is not an employer plan", () => {
    const ira = structuredClone(plan);
    ira.accounts[0]!.plan_type = "Ira";
    ira.accounts[0]!.contributions[0]!.end = { Date: { year: 2036, month: 6 } };
    expect(retirementShiftBounds(ira, "p1").min).toBe(-10);
  });

  it("caps a shift that would push this retirement past an account owner's", () => {
    // Sam's employer plan stops contributing when *Alex* retires — so Alex
    // cannot be moved past Sam's own retirement in 2042-06.
    const linked = structuredClone(plan);
    linked.accounts[1]!.plan_type = "EmployerPlan";
    linked.accounts[1]!.contributions[0]!.end = { AtRetirement: "p1" };
    expect(retirementShiftBounds(linked, "p1").max).toBe(3);
  });

  it("is inert for a person who is not on the plan", () => {
    expect(retirementShiftBounds(plan, "nobody")).toEqual({ min: 0, max: 0 });
  });
});

describe("lifeExpectancyShiftBounds", () => {
  it("keeps at least a year of plan on the shortest life", () => {
    // Alex is 90 in 2073, Sam 92 in 2079; the plan starts in 2026, so the
    // binding constraint is Alex's, at 46 years of room.
    expect(lifeExpectancyShiftBounds(plan)).toEqual({ min: -15, max: 15 });

    const old = structuredClone(plan);
    old.sim_config.start = { year: 2070, month: 1 };
    // Alex dies 2073-08; one year of plan from 2070-01 needs 2071-01, so the
    // knob can give back two whole years and no more.
    expect(lifeExpectancyShiftBounds(old).min).toBe(-2);
  });
});

describe("labels", () => {
  it("names only the knobs that moved", () => {
    expect(
      overrideLabels(
        plan,
        overrides({ retirementShiftYears: { p1: -2, p2: 0 }, spendingMultiplier: 0.9 }),
      ),
    ).toEqual(["Alex retires 2 years earlier", "Spending −10%"]);
  });

  it("says nothing when nothing moved", () => {
    expect(overrideLabels(plan, BASELINE)).toEqual([]);
  });

  it("suggests a name that says what the scenario is", () => {
    expect(
      suggestScenarioName(
        plan,
        overrides({ retirementShiftYears: { p1: -2 }, returnShiftBp: 100 }),
      ),
    ).toBe("Base — Alex retires −2y, returns +100 bp");
  });

  it("falls back to a copy name when nothing moved", () => {
    expect(suggestScenarioName(plan, BASELINE)).toBe("Base copy");
  });
});
