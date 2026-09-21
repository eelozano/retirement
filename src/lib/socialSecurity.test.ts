import { describe, expect, it } from "vitest";
import {
  adjustmentFactor,
  formatFullRetirementAge,
  fullRetirementAgeForBirthYear,
  totalMonths,
} from "./socialSecurity";

/** Whole-year FRAs in months, so the fixtures below read as ages. */
const years = (n: number) => n * 12;

describe("adjustmentFactor", () => {
  it("is 1.0 when claimed at full retirement age", () => {
    expect(adjustmentFactor(years(67), 67)).toBeCloseTo(1.0, 9);
  });

  it("reduces a benefit claimed five years early", () => {
    expect(adjustmentFactor(years(67), 62)).toBeCloseTo(0.7, 9);
  });

  it("reduces a benefit claimed four years early", () => {
    expect(adjustmentFactor(years(66), 62)).toBeCloseTo(0.75, 9);
  });

  it("reduces a benefit claimed exactly 36 months early", () => {
    expect(adjustmentFactor(years(65), 62)).toBeCloseTo(0.8, 9);
  });

  it("credits a benefit delayed four years", () => {
    expect(adjustmentFactor(years(66), 70)).toBeCloseTo(1.32, 9);
  });

  it("credits a benefit delayed three years", () => {
    expect(adjustmentFactor(years(67), 70)).toBeCloseTo(1.24, 9);
  });

  // The case a whole-year FRA could not express: 66y6m claimed at 62 is 54
  // months early — 36 at 5/9 of 1% (20.0%) plus 18 at 5/12 of 1% (7.5%).
  it("handles a mid-year full retirement age exactly", () => {
    expect(adjustmentFactor(totalMonths({ years: 66, months: 6 }), 62)).toBeCloseTo(
      0.725,
      9,
    );
  });
});

describe("fullRetirementAgeForBirthYear", () => {
  // SSA's published table (Social Security Act §216(l)). Must stay identical
  // to `FullRetirementAge::for_birth_year` in the engine.
  it.each([
    [1930, 65, 0],
    [1937, 65, 0],
    [1938, 65, 2],
    [1939, 65, 4],
    [1940, 65, 6],
    [1941, 65, 8],
    [1942, 65, 10],
    [1943, 66, 0],
    [1950, 66, 0],
    [1954, 66, 0],
    [1955, 66, 2],
    [1956, 66, 4],
    [1957, 66, 6],
    [1958, 66, 8],
    [1959, 66, 10],
    [1960, 67, 0],
    [1985, 67, 0],
    [2005, 67, 0],
  ])("born %i reaches FRA at %iy%im", (birthYear, expectedYears, expectedMonths) => {
    expect(fullRetirementAgeForBirthYear(birthYear)).toEqual({
      years: expectedYears,
      months: expectedMonths,
    });
  });
});

describe("formatFullRetirementAge", () => {
  it("prints a whole-year age as a bare number", () => {
    expect(formatFullRetirementAge({ years: 67, months: 0 })).toBe("67");
  });

  it("spells out the months when there are any", () => {
    expect(formatFullRetirementAge({ years: 66, months: 6 })).toBe("66 years 6 months");
  });

  it("uses the singular for one month", () => {
    expect(formatFullRetirementAge({ years: 66, months: 1 })).toBe("66 years 1 month");
  });
});
