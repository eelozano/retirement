import { describe, expect, it } from "vitest";
import { monthsAgoLabel, monthsSince, stalenessTone } from "./staleness";

// `new Date(year, monthIndex, day)` — monthIndex is zero-based, as in `Date`;
// `YearMonth.month` is one-based.

describe("monthsSince", () => {
  it("is zero in the as-of month itself", () => {
    expect(monthsSince({ year: 2026, month: 9 }, new Date(2026, 8, 15))).toBe(0);
  });

  it("counts calendar months, not days", () => {
    // The last day of one month to the first of the next is already a month.
    expect(monthsSince({ year: 2026, month: 8 }, new Date(2026, 8, 1))).toBe(1);
    expect(monthsSince({ year: 2026, month: 3 }, new Date(2026, 8, 30))).toBe(6);
  });

  it("carries across a year boundary", () => {
    expect(monthsSince({ year: 2025, month: 12 }, new Date(2026, 0, 10))).toBe(1);
    expect(monthsSince({ year: 2025, month: 11 }, new Date(2026, 1, 10))).toBe(3);
    expect(monthsSince({ year: 2024, month: 10 }, new Date(2026, 3, 10))).toBe(18);
  });

  it("clamps an as-of in the future to zero", () => {
    expect(monthsSince({ year: 2026, month: 10 }, new Date(2026, 8, 30))).toBe(0);
    expect(monthsSince({ year: 2027, month: 1 }, new Date(2026, 8, 30))).toBe(0);
  });
});

describe("stalenessTone", () => {
  it("is plain under three months", () => {
    expect(stalenessTone(0)).toBe("plain");
    expect(stalenessTone(1)).toBe("plain");
    expect(stalenessTone(2)).toBe("plain");
  });

  it("warns from three months", () => {
    expect(stalenessTone(3)).toBe("warning");
    expect(stalenessTone(4)).toBe("warning");
    expect(stalenessTone(5)).toBe("warning");
  });

  it("is stale from six months", () => {
    expect(stalenessTone(6)).toBe("stale");
    expect(stalenessTone(7)).toBe("stale");
    expect(stalenessTone(60)).toBe("stale");
  });
});

describe("monthsAgoLabel", () => {
  it("reads zero, one and many", () => {
    expect(monthsAgoLabel(0)).toBe("this month");
    expect(monthsAgoLabel(1)).toBe("1 month ago");
    expect(monthsAgoLabel(2)).toBe("2 months ago");
    expect(monthsAgoLabel(18)).toBe("18 months ago");
  });
});
