import { describe, expect, it } from "vitest";
import {
  ratePercent,
  successMarginPercent,
  successPercent,
  successPointsDelta,
} from "./format";

// Every expected string here is typed by hand. None is built by calling
// another formatter: a test that derived its answer from the code under test
// would pass whatever the code did.

// A sampling margin of half a point is where the first decimal stops being
// information, so these tests straddle it: 0.004 and 0.0049 keep a decimal,
// 0.005 and above print whole points.

describe("successPercent", () => {
  it("keeps one decimal when the margin is under half a point, or unknown", () => {
    expect(successPercent(0.8734, 0.004)).toBe("87.3%");
    expect(successPercent(0.8734, 0.0049)).toBe("87.3%");
    expect(successPercent(0.8734, null)).toBe("87.3%");
  });

  it("prints whole points from a margin of half a point up", () => {
    expect(successPercent(0.8734, 0.005)).toBe("87%");
    expect(successPercent(0.8734, 0.01)).toBe("87%");
    expect(successPercent(0.8766, 0.02)).toBe("88%");
  });

  it("never reads 99.96% as 100%", () => {
    // One decimal: the nearest honest figure below 100 is 99.9.
    expect(successPercent(0.9996, 0.001)).toBe("99.9%");
    expect(successPercent(0.9996, null)).toBe("99.9%");
    // Whole points: it would round to 100, so it stops at 99.
    expect(successPercent(0.9996, 0.01)).toBe("99%");
  });

  it("leaves values the guard doesn't reach alone", () => {
    // 99.94 rounds to 99.9 on its own, and 99.4 to 99.
    expect(successPercent(0.9994, 0.001)).toBe("99.9%");
    expect(successPercent(0.994, 0.01)).toBe("99%");
  });

  it("does print 100% when every path succeeded", () => {
    expect(successPercent(1, 0.001)).toBe("100.0%");
    expect(successPercent(1, 0.01)).toBe("100%");
    expect(successPercent(1, null)).toBe("100.0%");
  });

  it("prints zero", () => {
    expect(successPercent(0, 0.01)).toBe("0%");
    expect(successPercent(0, 0.001)).toBe("0.0%");
  });
});

describe("successMarginPercent", () => {
  it("calls exactly one point singular", () => {
    expect(successMarginPercent(0.01)).toBe("±1 pt");
  });

  it("calls everything else plural", () => {
    expect(successMarginPercent(0.004)).toBe("±0.4 pts");
    expect(successMarginPercent(0.001)).toBe("±0.1 pts");
    expect(successMarginPercent(0.02)).toBe("±2 pts");
  });

  it("is singular when a whole-point margin rounds to one", () => {
    expect(successMarginPercent(0.0051)).toBe("±1 pt");
    expect(successMarginPercent(0.0099)).toBe("±1 pt");
    expect(successMarginPercent(0.0149)).toBe("±1 pt");
  });

  it("keeps a decimal just under half a point", () => {
    expect(successMarginPercent(0.0049)).toBe("±0.5 pts");
  });
});

describe("successPointsDelta", () => {
  it("signs a gain with a plus", () => {
    expect(successPointsDelta(0.032, 0.01)).toBe("+3 pts");
    expect(successPointsDelta(0.032, 0.002)).toBe("+3.2 pts");
  });

  it("signs a loss with a true minus, not a hyphen", () => {
    expect(successPointsDelta(-0.05, 0.01)).toBe("−5 pts");
    expect(successPointsDelta(-0.032, 0.002)).toBe("−3.2 pts");
    expect(successPointsDelta(-0.032, 0.002)).not.toContain("-");
  });

  it("drops the sign from a delta that rounds to zero", () => {
    expect(successPointsDelta(0.004, 0.01)).toBe("0 pts");
    expect(successPointsDelta(-0.004, 0.01)).toBe("0 pts");
    expect(successPointsDelta(0, 0.01)).toBe("0 pts");
    expect(successPointsDelta(-0.0004, 0.002)).toBe("0.0 pts");
  });

  it("calls exactly one point singular, either way", () => {
    expect(successPointsDelta(0.01, 0.01)).toBe("+1 pt");
    expect(successPointsDelta(-0.01, 0.01)).toBe("−1 pt");
  });

  it("borrows its precision from the margin without printing it", () => {
    expect(successPointsDelta(0.0312, null)).toBe("+3.1 pts");
    expect(successPointsDelta(0.0312, 0.005)).toBe("+3 pts");
  });
});

describe("ratePercent", () => {
  it("prints a stored rate as a percent", () => {
    expect(ratePercent(0.025)).toBe("2.5%");
    expect(ratePercent(0.025, 2)).toBe("2.50%");
    expect(ratePercent(0.07, 0)).toBe("7%");
  });

  it("uses a true minus sign for a negative rate", () => {
    expect(ratePercent(-0.123)).toBe("−12.3%");
    expect(ratePercent(-0.123)).not.toContain("-");
  });

  it("drops the sign from a rate that rounds to zero", () => {
    expect(ratePercent(0)).toBe("0.0%");
    expect(ratePercent(-0.00001)).toBe("0.0%");
    expect(ratePercent(-0.004, 0)).toBe("0%");
  });
});
