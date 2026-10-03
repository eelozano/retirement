import { describe, expect, it } from "vitest";
import { medianCompoundedReturn, realReturn, stockBondMix } from "./returns";

describe("realReturn", () => {
  // Not `toBe`: (1 + r) / 1 - 1 does not round-trip exactly in binary float.
  it("is the nominal rate itself when there is no inflation", () => {
    expect(realReturn(0.075, 0)).toBeCloseTo(0.075, 12);
  });

  it("is smaller than plain subtraction — the reason this is not `a - b`", () => {
    expect(realReturn(0.075, 0.03)).toBeLessThan(0.075 - 0.03);
  });

  it("is negative when inflation outruns the return", () => {
    expect(realReturn(0.02, 0.03)).toBeLessThan(0);
  });

  // The figures the Assumptions pane prints beside each strategy, at the
  // shipped defaults and the default 3% inflation. Pinned so the hint copy
  // cannot drift from what these render.
  it.each([
    ["very aggressive", 0.0692, 0.038058252427184414],
    ["aggressive", 0.0635, 0.03252427184466011],
    ["moderate", 0.0573, 0.026504854368931907],
    ["conservative", 0.0506, 0.020000000000000018],
    ["very conservative", 0.0435, 0.013106796116505004],
  ])("is %s's real return at the shipped defaults", (_name, nominal, expected) => {
    expect(realReturn(nominal, 0.03)).toBeCloseTo(expected, 9);
  });
});

describe("medianCompoundedReturn", () => {
  it("is the mean itself at zero volatility, where every path is the deterministic one", () => {
    expect(medianCompoundedReturn(0.075, 0)).toBeCloseTo(0.075, 12);
  });

  it("falls as volatility widens — the drag this function exists to show", () => {
    expect(medianCompoundedReturn(0.067, 0.3)).toBeLessThan(
      medianCompoundedReturn(0.067, 0.1),
    );
  });

  it("is always at or below the arithmetic mean it is given", () => {
    expect(medianCompoundedReturn(0.075, 0.155)).toBeLessThan(0.075);
  });

  // Same defaults, against each strategy's own volatility. Very aggressive
  // gives up about eight tenths of a point a year; very conservative under
  // two tenths.
  it.each([
    ["very aggressive", 0.0692, 0.1303, 0.06128978295447873],
    ["aggressive", 0.0635, 0.1102, 0.05780582970219261],
    ["moderate", 0.0573, 0.0912, 0.05337396765033953],
    ["conservative", 0.0506, 0.0742, 0.04798302871350879],
    ["very conservative", 0.0435, 0.0609, 0.04172441125842252],
  ])(
    "is %s's median compounded rate at the shipped defaults",
    (_name, mean, stddev, expected) => {
      expect(medianCompoundedReturn(mean, stddev)).toBeCloseTo(expected, 9);
    },
  );
});

describe("stockBondMix", () => {
  it("says a stock share as stocks/bonds", () => {
    expect(stockBondMix(1)).toBe("100/0");
    expect(stockBondMix(0.6)).toBe("60/40");
    expect(stockBondMix(0.2)).toBe("20/80");
  });
});
