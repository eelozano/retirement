/**
 * SSA's graduated early/delayed-claiming adjustment relative to full
 * retirement age, applied to whole-year ages. Mirrors
 * `crates/engine/src/model/social_security.rs::adjustment_factor` — kept in
 * sync via the shared test fixtures in both files so the live UI readout
 * matches what the engine actually simulates. Duplicated here (rather than
 * round-tripping through `run_projection`) so it can update on every
 * keystroke.
 */
export function adjustmentFactor(fullRetirementAge: number, claimingAge: number): number {
  const months = 12 * (claimingAge - fullRetirementAge);
  if (months >= 0) {
    return 1.0 + months * (2.0 / 3.0 / 100.0);
  }
  const monthsEarly = -months;
  const first36 = Math.min(monthsEarly, 36);
  const extra = monthsEarly - first36;
  return 1.0 - (first36 * (5.0 / 9.0 / 100.0) + extra * (5.0 / 12.0 / 100.0));
}
