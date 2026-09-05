import { describe, expect, it } from "vitest";
import { diagnostics, pathGroup, spread } from "../../test/fixtures";
import type { MonteCarloDiagnostics } from "../../types/generated/MonteCarloDiagnostics";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { PeriodPercentiles } from "../../types/generated/PeriodPercentiles";
import { annualise, failureFindings } from "./whyPathsFailData";

/** `n` annual percentile rows starting at `startYear`. Only the year matters
 * here: the card reads the histogram, and the percentiles carry its axis. */
function percentiles(startYear: number, n: number): PeriodPercentiles[] {
  return Array.from({ length: n }, (_, i) => ({
    period: i,
    period_start: { year: startYear + i, month: 1 },
    deflator: 1,
    p10: 0,
    p25: 0,
    p50: 0,
    p75: 0,
    p90: 0,
  }));
}

function mc(d: MonteCarloDiagnostics, startYear = 2030, years = 40): MonteCarloResult {
  return {
    n_paths: 1000,
    success_rate: 1 - (d.failed?.n ?? 0) / 1000,
    percentiles: percentiles(startYear, years),
    diagnostics: d,
  };
}

/** A histogram of `years` buckets with `count` failures in bucket `at`. */
function histogramAt(years: number, at: number, count: number): number[] {
  const h = new Array(years).fill(0);
  h[at] = count;
  return h;
}

describe("failureFindings", () => {
  it("is null before a run and at full success", () => {
    expect(failureFindings(null)).toBeNull();
    // `failed` null is exactly "no path ran dry", and also the hide condition.
    expect(failureFindings(mc(diagnostics()))).toBeNull();
  });

  it("zips the histogram onto the percentile years index for index", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          depletion_histogram: [0, 3, 7],
          failed: pathGroup({ n: 10 }),
        }),
        2030,
        3,
      ),
    );
    expect(f?.timing.bars).toEqual([
      { year: 2030, count: 0 },
      { year: 2031, count: 3 },
      { year: 2032, count: 7 },
    ]);
    expect(f?.timing.failed).toBe(10);
  });

  it("takes the median failure year at the nearest rank, not the midpoint", () => {
    // 6 of 10 land in the first year, so half the failures are in by then.
    const f = failureFindings(
      mc(
        diagnostics({ depletion_histogram: [6, 4], failed: pathGroup({ n: 10 }) }),
        2030,
        2,
      ),
    );
    expect(f?.timing.medianYear).toBe(2030);
  });

  it("names the early shape when two thirds of the failures are in the window", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          retirement_period: 10,
          depletion_histogram: histogramAt(40, 12, 90),
          early_failures: 90,
          late_failures: 10,
          failed: pathGroup({ n: 100 }),
        }),
      ),
    );
    expect(f?.timing.shape).toBe("early");
    expect(f?.timing.retirementYear).toBe(2040);
    // The window's far edge, so the shaded span matches the counted split.
    expect(f?.timing.windowEndYear).toBe(2045);
  });

  it("names the late shape, and flags a median inside the plan's last decade", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          retirement_period: 10,
          depletion_histogram: histogramAt(40, 35, 100),
          early_failures: 0,
          late_failures: 100,
          failed: pathGroup({ n: 100 }),
        }),
      ),
    );
    expect(f?.timing.shape).toBe("late");
    expect(f?.timing.medianYear).toBe(2065);
    expect(f?.timing.inLastDecade).toBe(true);
  });

  it("names no shape when neither side of the split dominates", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          retirement_period: 10,
          depletion_histogram: histogramAt(40, 12, 100),
          early_failures: 55,
          late_failures: 45,
          failed: pathGroup({ n: 100 }),
        }),
      ),
    );
    expect(f?.timing.shape).toBe("mixed");
    // A 55/45 split sits in the middle of the plan, not its last decade.
    expect(f?.timing.inLastDecade).toBe(false);
  });

  it("degrades to the histogram alone when nobody retires inside the plan", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          depletion_histogram: histogramAt(40, 20, 100),
          failed: pathGroup({ n: 100 }),
          succeeded: pathGroup({ n: 900 }),
        }),
      ),
    );
    expect(f?.timing.shape).toBe("unanchored");
    expect(f?.timing.retirementYear).toBeNull();
    expect(f?.timing.windowEndYear).toBeNull();
    // Both retirement-anchored findings have nothing to stand on.
    expect(f?.returns).toBeNull();
    expect(f?.spending).toBeNull();
  });

  it("clamps the early window to the horizon when retirement lands near the end", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          retirement_period: 8,
          depletion_histogram: histogramAt(10, 9, 5),
          late_failures: 5,
          failed: pathGroup({ n: 5 }),
        }),
        2030,
        10,
      ),
    );
    // Retirement in 2038 plus a 5-year window runs past 2039, the last year.
    expect(f?.timing.windowEndYear).toBe(2039);
  });

  it("annualises the window returns and keeps both groups on one basis", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          retirement_period: 10,
          depletion_histogram: histogramAt(40, 20, 100),
          late_failures: 100,
          failed: pathGroup({ n: 100, early_retirement_return: spread(0.1, -0.2, 0.3) }),
          succeeded: pathGroup({
            n: 900,
            early_retirement_return: spread(0.4, 0.2, 0.7),
          }),
        }),
      ),
    );
    expect(f?.returns?.basis).toBe("annual");
    // 1.1 ^ (1/5) - 1, the per-year rate behind a 10% total over five years.
    expect(f?.returns?.failed.p50).toBeCloseTo(1.1 ** (1 / 5) - 1, 10);
    expect(f?.returns?.succeeded.p50).toBeCloseTo(1.4 ** (1 / 5) - 1, 10);
    expect(f?.returns?.overlapping).toBe(false);
  });

  it("falls back to window totals when a total loss has no annual equivalent", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          retirement_period: 10,
          depletion_histogram: histogramAt(40, 20, 100),
          late_failures: 100,
          failed: pathGroup({ n: 100, early_retirement_return: spread(-1.2) }),
          succeeded: pathGroup({ n: 900, early_retirement_return: spread(0.4) }),
        }),
      ),
    );
    expect(f?.returns?.basis).toBe("window");
    // Both groups stay in the same basis, so the sentence compares like
    // with like even though only one of them was the problem.
    expect(f?.returns?.failed.p50).toBe(-1.2);
    expect(f?.returns?.succeeded.p50).toBe(0.4);
  });

  it("says returns barely separate the groups when the medians nearly meet", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          retirement_period: 10,
          depletion_histogram: histogramAt(40, 20, 100),
          late_failures: 100,
          failed: pathGroup({ n: 100, early_retirement_return: spread(0.4) }),
          succeeded: pathGroup({ n: 900, early_retirement_return: spread(0.42) }),
        }),
      ),
    );
    // A two-point gap over five years is well under a point a year.
    expect(f?.returns?.overlapping).toBe(true);
  });

  it("drops the returns comparison when one of the two groups is empty", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          retirement_period: 10,
          depletion_histogram: histogramAt(40, 20, 1000),
          late_failures: 1000,
          failed: pathGroup({ n: 1000, early_retirement_return: spread(-0.3) }),
          median_withdrawal_rate_at_retirement: 0.055,
        }),
      ),
    );
    expect(f?.returns).toBeNull();
    // The spending finding does not need a contrast, so it survives.
    expect(f?.spending?.medianRate).toBe(0.055);
  });

  it("scales the reference strip past the largest marker on it", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          retirement_period: 10,
          depletion_histogram: histogramAt(40, 20, 100),
          late_failures: 100,
          failed: pathGroup({
            n: 100,
            withdrawal_rate_at_retirement: spread(0.082),
          }),
          succeeded: pathGroup({
            n: 900,
            withdrawal_rate_at_retirement: spread(0.031),
          }),
          median_withdrawal_rate_at_retirement: 0.04,
        }),
      ),
    );
    expect(f?.spending?.failedRate).toBe(0.082);
    expect(f?.spending?.succeededRate).toBe(0.031);
    // Comfortably past 8.2%, so the marker never sits on the edge.
    expect(f?.spending?.scaleMax).toBeGreaterThan(0.082);
  });

  it("keeps a floor under the strip's scale on a frugal plan", () => {
    const f = failureFindings(
      mc(
        diagnostics({
          retirement_period: 10,
          depletion_histogram: histogramAt(40, 20, 100),
          late_failures: 100,
          failed: pathGroup({ n: 100 }),
          succeeded: pathGroup({ n: 900 }),
          median_withdrawal_rate_at_retirement: 0.012,
        }),
      ),
    );
    // The 3-4% band has to stay on the strip even when the plan is below it.
    expect(f?.spending?.scaleMax).toBe(0.06);
  });
});

describe("annualise", () => {
  it("turns a cumulative window return into a per-year rate", () => {
    expect(annualise(0.31, 5)).toBeCloseTo(1.31 ** 0.2 - 1, 10);
    expect(annualise(0, 5)).toBe(0);
  });

  it("is null where no real root exists", () => {
    // A total at or past a complete loss: (1 + r) is not positive.
    expect(annualise(-1, 5)).toBeNull();
    expect(annualise(-1.4, 5)).toBeNull();
    expect(annualise(0.2, 0)).toBeNull();
  });
});
