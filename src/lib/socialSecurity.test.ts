import { describe, expect, it } from "vitest";
import { adjustmentFactor } from "./socialSecurity";

// Same fixtures as crates/engine/src/model/social_security.rs's unit tests,
// verified against published SSA early/delayed retirement adjustment
// tables — kept identical across both implementations on purpose.
describe("adjustmentFactor", () => {
  it("is 1.0 when claiming at full retirement age", () => {
    expect(adjustmentFactor(67, 67)).toBeCloseTo(1.0, 9);
  });

  it("is 0.70 for FRA 67 claimed at 62", () => {
    expect(adjustmentFactor(67, 62)).toBeCloseTo(0.7, 9);
  });

  it("is 0.75 for FRA 66 claimed at 62", () => {
    expect(adjustmentFactor(66, 62)).toBeCloseTo(0.75, 9);
  });

  it("is 0.80 for FRA 65 claimed at 62 (exactly 36 months early)", () => {
    expect(adjustmentFactor(65, 62)).toBeCloseTo(0.8, 9);
  });

  it("is 1.32 for FRA 66 delayed to 70", () => {
    expect(adjustmentFactor(66, 70)).toBeCloseTo(1.32, 9);
  });

  it("is 1.24 for FRA 67 delayed to 70", () => {
    expect(adjustmentFactor(67, 70)).toBeCloseTo(1.24, 9);
  });
});
