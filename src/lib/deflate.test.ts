import { describe, expect, it } from "vitest";
import { balanceDivisor, flowDivisor } from "./deflate";

const snapshot = { deflator: 1.03, deflator_end: 1.0609 };

describe("flowDivisor", () => {
  it("is the period-start factor, so a flow's real figure is what it was before #146", () => {
    expect(flowDivisor(snapshot, true)).toBe(1.03);
  });

  it("is 1 in nominal dollars", () => {
    expect(flowDivisor(snapshot, false)).toBe(1);
  });
});

describe("balanceDivisor", () => {
  it("is the period-end factor, since a balance is an end-of-period figure", () => {
    expect(balanceDivisor(snapshot, true)).toBe(1.0609);
  });

  it("is 1 in nominal dollars", () => {
    expect(balanceDivisor(snapshot, false)).toBe(1);
  });
});
