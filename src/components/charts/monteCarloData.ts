import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";

// Recharts draws a band as a stacked area pair: a transparent base at the
// lower bound plus a visible area of the band's *height*. So each row
// carries the offsets and heights, not the raw upper bounds.
export interface FanRow {
  year: number;
  p10: number;
  p50: number;
  p90: number;
  /** Base of the p10-p90 band (= p10). */
  outerBase: number;
  /** Height of the p10-p90 band. */
  outerBand: number;
  /** Base of the p25-p75 band (= p25). */
  innerBase: number;
  /** Height of the p25-p75 band. */
  innerBand: number;
}

export function fanRows(
  result: MonteCarloResult,
  realDollars: boolean,
): FanRow[] {
  return result.percentiles.map((p) => {
    const d = realDollars ? p.deflator : 1;
    const [p10, p25, p50, p75, p90] = [p.p10, p.p25, p.p50, p.p75, p.p90].map(
      (v) => v / d,
    );
    return {
      year: p.period_start.year,
      p10,
      p50,
      p90,
      outerBase: p10,
      outerBand: p90 - p10,
      innerBase: p25,
      innerBand: p75 - p25,
    };
  });
}

/** Bands for the success rate, matching the reserved status colors used
 * elsewhere for depletion warnings. */
export function successTone(rate: number): "good" | "warn" | "critical" {
  if (rate >= 0.85) return "good";
  if (rate >= 0.7) return "warn";
  return "critical";
}
