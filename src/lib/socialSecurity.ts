import type { FullRetirementAge } from "../types/generated/FullRetirementAge";

/**
 * SSA's graduated early/delayed-claiming adjustment relative to full
 * retirement age, taken in **months** so a mid-year FRA is exact. Mirrors
 * `crates/engine/src/model/social_security.rs::adjustment_factor` — kept in
 * sync via the shared test fixtures in both files so the live UI readout
 * matches what the engine actually simulates. Duplicated here (rather than
 * round-tripping through `run_projection`) so it can update on every
 * keystroke.
 */
export function adjustmentFactor(
  fullRetirementAgeMonths: number,
  claimingAge: number,
): number {
  const months = 12 * claimingAge - fullRetirementAgeMonths;
  if (months >= 0) {
    return 1.0 + months * (2.0 / 3.0 / 100.0);
  }
  const monthsEarly = -months;
  const first36 = Math.min(monthsEarly, 36);
  const extra = monthsEarly - first36;
  return 1.0 - (first36 * (5.0 / 9.0 / 100.0) + extra * (5.0 / 12.0 / 100.0));
}

export function totalMonths(fra: FullRetirementAge): number {
  return fra.years * 12 + fra.months;
}

/**
 * SSA's published full-retirement-age table (Social Security Act §216(l), as
 * amended in 1983). Mirrors `FullRetirementAge::for_birth_year` so the pane
 * can show the derived age without a round trip.
 */
export function fullRetirementAgeForBirthYear(birthYear: number): FullRetirementAge {
  if (birthYear <= 1937) return { years: 65, months: 0 };
  if (birthYear <= 1942) return { years: 65, months: (birthYear - 1937) * 2 };
  if (birthYear <= 1954) return { years: 66, months: 0 };
  if (birthYear <= 1959) return { years: 66, months: (birthYear - 1954) * 2 };
  return { years: 67, months: 0 };
}

/** "67" or "66 years 6 months", for a label rather than a field. */
export function formatFullRetirementAge(fra: FullRetirementAge): string {
  if (fra.months === 0) return `${fra.years}`;
  return `${fra.years} years ${fra.months} month${fra.months === 1 ? "" : "s"}`;
}

/**
 * When, and how far, the Social Security Trustees project benefits to be cut
 * if Congress does nothing: the combined OASDI trust funds run dry in 2034,
 * after which incoming payroll tax covers about 81% of scheduled benefits
 * (2025 Trustees Report). A projection, not law, and republished every year
 * — so it lives here as the prefill for "assume a cut" and the start of the
 * What-if knob's cut, never as something a plan silently assumes.
 */
export const SS_TRUST_FUND_DEPLETION_YEAR = 2034;
export const SS_TRUSTEES_PAYABLE_FRACTION = 0.81;
