import { describe, expect, it } from "vitest";
import { medianCompoundedReturn, realReturn } from "./returns";

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
    ["aggressive", 0.075, 0.0436893203883495],
    ["moderate", 0.067, 0.0359223300970874],
    ["conservative", 0.059, 0.0281553398058252],
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

  // Same defaults, against each strategy's own volatility. Aggressive gives
  // up over a point a year; conservative barely half of one.
  it.each([
    ["aggressive", 0.075, 0.155, 0.06388345864875244],
    ["moderate", 0.067, 0.115, 0.06082068043903521],
    ["conservative", 0.059, 0.09, 0.05518253454166988],
  ])(
    "is %s's median compounded rate at the shipped defaults",
    (_name, mean, stddev, expected) => {
      expect(medianCompoundedReturn(mean, stddev)).toBeCloseTo(expected, 9);
    },
  );
});
