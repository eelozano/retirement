import { describe, expect, it } from "vitest";
import { diagnostics } from "../../test/fixtures";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import { fanRows, successTone } from "./monteCarloData";

function result(): MonteCarloResult {
  return {
    n_paths: 100,
    success_rate: 0.9,
    diagnostics: diagnostics(),
    percentiles: [
      {
        period: 0,
        period_start: { year: 2026, month: 1 },
        deflator: 1,
        p10: 100,
        p25: 200,
        p50: 300,
        p75: 400,
        p90: 500,
      },
      {
        period: 1,
        period_start: { year: 2027, month: 1 },
        deflator: 2,
        p10: 200,
        p25: 400,
        p50: 600,
        p75: 800,
        p90: 1000,
      },
    ],
  };
}

describe("fanRows", () => {
  it("expresses bands as base plus height", () => {
    const [first] = fanRows(result(), false);
    expect(first.year).toBe(2026);
    expect(first.outerBase).toBe(100);
    expect(first.outerBand).toBe(400);
    expect(first.innerBase).toBe(200);
    expect(first.innerBand).toBe(200);
    // Stacking each pair must land on that band's true upper bound.
    expect(first.outerBase + first.outerBand).toBe(first.p90);
    expect(first.innerBase + first.innerBand).toBe(400); // p75
  });

  it("divides by the deflator in real dollars only", () => {
    const nominal = fanRows(result(), false)[1];
    const real = fanRows(result(), true)[1];
    expect(nominal.p50).toBe(600);
    expect(real.p50).toBe(300);
    expect(real.outerBand).toBe(400);
  });
});

describe("successTone", () => {
  it("bands the rate", () => {
    expect(successTone(0.95)).toBe("good");
    expect(successTone(0.85)).toBe("good");
    expect(successTone(0.75)).toBe("warn");
    expect(successTone(0.5)).toBe("critical");
  });
});
