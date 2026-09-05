import type { MonteCarloDiagnostics } from "../../types/generated/MonteCarloDiagnostics";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { Spread } from "../../types/generated/Spread";

// Reads `MonteCarloResult.diagnostics` into the three findings the "Why paths
// fail" card states. Everything here is descriptive: it reports what the
// failed paths had in common, never why they failed. The engine cannot
// support attribution (see the doc comment on `MonteCarloDiagnostics`), and a
// sentence that sounds like attribution will be read as one.

/** The conventional withdrawal-rate reference range, as fractions. */
export const REFERENCE_BAND = { low: 0.03, high: 0.04 };

/**
 * Share of the failures one side of the early/late split has to hold before
 * the card names a shape. Below it the timing sentence states both counts and
 * names nothing — a 55/45 split is not a shape.
 */
const DOMINANT_SHARE = 2 / 3;

/**
 * Gap between the two groups' median returns, below which the card says
 * returns barely separate them. One percentage point a year; scaled by the
 * window when the figures could not be annualised.
 */
const RETURN_GAP = 0.01;

/**
 * Shortest horizon on which "the plan's last decade" is worth saying. On a
 * plan barely longer than a decade the clause is true and vacuous.
 */
const MIN_YEARS_FOR_DECADE = 15;

/** One bar of the depletion histogram. */
export interface FailureBar {
  year: number;
  count: number;
}

/**
 * When the failures land. `shape` is the sentence the card writes; it names
 * the shape of the distribution, not a cause.
 *
 * `unanchored` is the degenerate case: with no retirement inside the horizon
 * there is nothing to measure "early" against, so the engine reports zero on
 * both sides of the split while the histogram still counts.
 */
export interface TimingFinding {
  failed: number;
  early: number;
  late: number;
  shape: "early" | "late" | "mixed" | "unanchored";
  windowYears: number;
  retirementYear: number | null;
  /** Last year of the early window, clamped into the horizon. */
  windowEndYear: number | null;
  /** Year the cumulative failure count first reaches half the total. */
  medianYear: number | null;
  /** True when `medianYear` falls in the final ten years of a long plan. */
  inLastDecade: boolean;
  bars: FailureBar[];
}

/**
 * How the two groups' returns over the early-retirement window compare.
 *
 * `basis` is `annual` whenever both spreads could be annualised, which is all
 * but a pathological case: `early_retirement_return` is cumulative over the
 * window, and a total at or below −100% has no real annual equivalent. The
 * two groups always share a basis, so the sentence compares like with like.
 */
export interface ReturnsFinding {
  basis: "annual" | "window";
  failed: Spread;
  succeeded: Spread;
  windowYears: number;
  /** True when the two medians sit within `RETURN_GAP` of each other. */
  overlapping: boolean;
}

/** What the plan withdraws at retirement, against a neutral reference range. */
export interface SpendingFinding {
  medianRate: number;
  failedRate: number | null;
  succeededRate: number | null;
  /** Right edge of the reference strip, so every marker lands inside it. */
  scaleMax: number;
}

export interface FailureFindings {
  nPaths: number;
  timing: TimingFinding;
  /** Null when the plan has no retirement inside its horizon, or when one of
   * the two groups is empty and there is nothing to compare against. */
  returns: ReturnsFinding | null;
  /** Null when the plan has no retirement inside its horizon. */
  spending: SpendingFinding | null;
}

/**
 * Cumulative return over `years` as a per-year rate. Null when the total is
 * at or below a complete loss, where no real root exists.
 */
export function annualise(total: number, years: number): number | null {
  if (years <= 0) return null;
  const growth = 1 + total;
  if (growth <= 0) return null;
  return growth ** (1 / years) - 1;
}

function annualiseSpread(s: Spread, years: number): Spread | null {
  const p10 = annualise(s.p10, years);
  const p50 = annualise(s.p50, years);
  const p90 = annualise(s.p90, years);
  if (p10 === null || p50 === null || p90 === null) return null;
  return { p10, p50, p90 };
}

/**
 * Year the cumulative count first reaches half the failures — the nearest-rank
 * median, so "half of them by this year" is exactly what it says.
 */
function medianFailureYear(bars: FailureBar[], failed: number): number | null {
  if (failed <= 0) return null;
  let seen = 0;
  for (const bar of bars) {
    seen += bar.count;
    if (seen >= failed / 2) return bar.year;
  }
  return null;
}

/** Everything the card states, or null when there is nothing to explain. */
export function failureFindings(result: MonteCarloResult | null): FailureFindings | null {
  if (!result) return null;
  const d = result.diagnostics;
  // `failed` is null exactly when no path ran dry, which is also the "hide
  // the card" condition: at 100% success there is nothing to explain.
  if (!d.failed) return null;

  const bars: FailureBar[] = d.depletion_histogram.map((count, i) => ({
    year: result.percentiles[i]?.period_start.year ?? 0,
    count,
  }));
  const failed = d.failed.n;
  const period = d.retirement_period;
  const retirementYear = period !== null ? (bars[period]?.year ?? null) : null;
  // Clamp: a retirement inside the last few years of the plan has its window
  // cut short by the horizon, exactly as the engine cuts it short.
  const windowEndYear =
    period !== null
      ? (bars[Math.min(period + d.early_window_years, bars.length - 1)]?.year ?? null)
      : null;

  const medianYear = medianFailureYear(bars, failed);
  const lastYear = bars[bars.length - 1]?.year ?? null;
  const inLastDecade =
    medianYear !== null &&
    lastYear !== null &&
    bars.length >= MIN_YEARS_FOR_DECADE &&
    medianYear > lastYear - 10;

  const shape: TimingFinding["shape"] =
    period === null
      ? "unanchored"
      : d.early_failures >= failed * DOMINANT_SHARE
        ? "early"
        : d.late_failures >= failed * DOMINANT_SHARE
          ? "late"
          : "mixed";

  const timing: TimingFinding = {
    failed,
    early: d.early_failures,
    late: d.late_failures,
    shape,
    windowYears: d.early_window_years,
    retirementYear,
    windowEndYear,
    medianYear,
    inLastDecade,
    bars,
  };

  return {
    nPaths: result.n_paths,
    timing,
    returns: returnsFinding(d),
    spending: spendingFinding(d),
  };
}

function returnsFinding(d: MonteCarloDiagnostics): ReturnsFinding | null {
  const failedReturn = d.failed?.early_retirement_return ?? null;
  const succeededReturn = d.succeeded?.early_retirement_return ?? null;
  // Both groups or neither: the finding is a comparison, and one group's
  // distribution on its own says nothing about what sets the two apart.
  if (!failedReturn || !succeededReturn) return null;

  const years = d.early_window_years;
  const failedAnnual = annualiseSpread(failedReturn, years);
  const succeededAnnual = annualiseSpread(succeededReturn, years);

  // All or nothing: annualising one group and not the other would put a
  // per-year rate beside a five-year total in the same sentence.
  if (failedAnnual !== null && succeededAnnual !== null) {
    return {
      basis: "annual",
      failed: failedAnnual,
      succeeded: succeededAnnual,
      windowYears: years,
      overlapping: Math.abs(succeededAnnual.p50 - failedAnnual.p50) < RETURN_GAP,
    };
  }
  return {
    basis: "window",
    failed: failedReturn,
    succeeded: succeededReturn,
    windowYears: years,
    overlapping: Math.abs(succeededReturn.p50 - failedReturn.p50) < RETURN_GAP * years,
  };
}

function spendingFinding(d: MonteCarloDiagnostics): SpendingFinding | null {
  const medianRate = d.median_withdrawal_rate_at_retirement;
  if (medianRate === null) return null;
  const failedRate = d.failed?.withdrawal_rate_at_retirement?.p50 ?? null;
  const succeededRate = d.succeeded?.withdrawal_rate_at_retirement?.p50 ?? null;

  // Round the scale up past the largest marker, so the reference band keeps a
  // steady width and no marker sits on the edge of the strip.
  const largest = Math.max(
    REFERENCE_BAND.high,
    medianRate,
    failedRate ?? 0,
    succeededRate ?? 0,
  );
  const scaleMax = Math.max(0.06, Math.ceil(largest * 1.15 * 100) / 100);

  return { medianRate, failedRate, succeededRate, scaleMax };
}
