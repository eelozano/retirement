import { describe, expect, it } from "vitest";
import type { Plan } from "../../types/generated/Plan";
import { ageAt } from "./age";
import {
  boundaryOptions,
  boundaryPhrase,
  boundaryResolvedDate,
  boundaryToChoice,
  choiceToBoundary,
} from "./streamBoundary";

const plan = {
  people: [
    {
      id: "alex",
      name: "Alex",
      birth: { year: 1983, month: 8 },
      retirement: { year: 2038, month: 12 },
      life_expectancy_age: 90,
    },
    {
      id: "jordan",
      name: "Jordan",
      birth: { year: 1981, month: 9 },
      retirement: { year: 2044, month: 9 },
      life_expectancy_age: 91,
    },
  ],
} as unknown as Plan;

describe("age boundaries", () => {
  it("offers an age for each person, on both edges", () => {
    for (const edge of ["start", "end"] as const) {
      const options = boundaryOptions(plan, edge).map((o) => o.value);
      expect(options).toContain("Age:alex");
      expect(options).toContain("Age:jordan");
    }
  });

  it("starts a fresh age boundary at 65 and keeps the age when the person changes", () => {
    const fresh = choiceToBoundary("Age:jordan", "PlanStart");
    expect(fresh).toEqual({ AtAge: ["jordan", 65] });
    expect(choiceToBoundary("Age:alex", fresh)).toEqual({ AtAge: ["alex", 65] });
    expect(choiceToBoundary("Age:alex", { AtAge: ["jordan", 62] })).toEqual({
      AtAge: ["alex", 62],
    });
  });

  it("round-trips to its own select option", () => {
    expect(boundaryToChoice({ AtAge: ["jordan", 65] })).toBe("Age:jordan");
  });

  it("resolves to the month that person turns the age, and says so", () => {
    // Jordan was born in September 1981, so 65 is September 2046.
    expect(boundaryResolvedDate({ AtAge: ["jordan", 65] }, plan)).toEqual({
      year: 2046,
      month: 9,
    });
    expect(boundaryPhrase({ AtAge: ["jordan", 65] }, plan)).toBe(
      "Jordan turns 65 (Sep 2046)",
    );
  });

  it("has no date for an age pinned to someone who is gone", () => {
    expect(boundaryResolvedDate({ AtAge: ["ghost", 65] }, plan)).toBeUndefined();
  });
});

describe("ageAt", () => {
  it("reads a month as an age in years and months", () => {
    expect(ageAt({ year: 1983, month: 8 }, { year: 2038, month: 12 })).toBe(
      "That's age 55 and 4 months.",
    );
    expect(ageAt({ year: 1981, month: 9 }, { year: 2044, month: 9 })).toBe(
      "That's age 63.",
    );
    expect(ageAt({ year: 1981, month: 9 }, { year: 1982, month: 10 })).toBe(
      "That's age 1 and 1 month.",
    );
  });

  it("says nothing for a month before the birth", () => {
    expect(ageAt({ year: 1983, month: 8 }, { year: 1980, month: 1 })).toBeUndefined();
  });
});
