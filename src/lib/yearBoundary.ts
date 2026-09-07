import type { YearMonth } from "../types/generated/YearMonth";

/**
 * The two years a boundary month can be named by — see "Two words for the
 * year a boundary falls in" under Time conventions in `docs/ARCHITECTURE.md`.
 */
export interface YearBoundary {
  /**
   * The calendar year the boundary month falls in — a stub split between
   * the two states either side of it (working/retired, alive/dead), unless
   * the boundary is itself in January.
   */
  stubYear: number;
  /**
   * The first calendar year not split by the boundary: the stub year itself
   * when the boundary is in January, otherwise the year after.
   */
  firstFullYear: number;
}

/**
 * Mirrors the year arithmetic in `SimConfig::first_full_period_at_or_after`
 * (a January boundary's stub year *is* its first full year; any other month
 * pushes the first full year to the next January) without that helper's
 * plan-start edge case, which only matters for a boundary predating the
 * plan — callers needing that case (headline coverage, at a household's
 * first retirement) still search `projection.snapshots` directly via
 * `firstFullPeriodAtOrAfter`.
 */
export function yearBoundary(month: YearMonth): YearBoundary {
  return {
    stubYear: month.year,
    firstFullYear: month.month === 1 ? month.year : month.year + 1,
  };
}
