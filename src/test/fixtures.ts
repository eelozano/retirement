import type { PlanSummary } from "../lib/api";
import type { MonteCarloDiagnostics } from "../types/generated/MonteCarloDiagnostics";
import type { PathGroupStats } from "../types/generated/PathGroupStats";
import type { Spread } from "../types/generated/Spread";
import type { TaxFigures } from "../types/generated/TaxFigures";

/** p10/p50/p90 that collapse to one value unless a test cares about the tails. */
export function spread(p50: number, p10 = p50, p90 = p50): Spread {
  return { p10, p50, p90 };
}

/** A path group with no returns or withdrawal rate — the shape the engine
 * reports when the plan has no retirement inside its horizon. */
export function pathGroup(overrides: Partial<PathGroupStats> = {}): PathGroupStats {
  return {
    n: 1,
    end_net_worth: spread(0),
    min_net_worth: spread(0),
    early_retirement_return: null,
    withdrawal_rate_at_retirement: null,
    ...overrides,
  };
}

/**
 * Diagnostics for a run with nothing to diagnose: no failures and no
 * retirement to anchor on. What a test that only cares about the success rate
 * or the percentiles puts on its `MonteCarloResult`; override the fields the
 * test is actually about.
 */
export function diagnostics(
  overrides: Partial<MonteCarloDiagnostics> = {},
): MonteCarloDiagnostics {
  return {
    early_window_years: 5,
    retirement_period: null,
    depletion_histogram: [],
    early_failures: 0,
    late_failures: 0,
    failed: null,
    succeeded: null,
    median_withdrawal_rate_at_retirement: null,
    ...overrides,
  };
}

/**
 * One row of the scenario switcher. Defaults put every scenario in one
 * household called "My household", which is the ordinary case and the one
 * most tests mean; pass `household_id`/`household_name` when the test is
 * about two households (#109).
 */
export function planSummary(
  id: string,
  name: string,
  overrides: Partial<PlanSummary> = {},
): PlanSummary {
  return {
    id,
    name,
    household_id: "my-household",
    household_name: "My household",
    sample: false,
    ...overrides,
  };
}

/**
 * Tax figures shaped like the built-in 2026 set, for tests of the screens
 * that show or edit them. A copy rather than the real built-ins, which live
 * in Rust; a test that needs particular numbers should override them.
 */
export function taxFigures(): TaxFigures {
  return {
    tax_year: 2026,
    federal: {
      standard_deduction: { single: 16_100, married_filing_jointly: 32_200 },
      additional_standard_deduction_65: {
        single: 2_050,
        married_filing_jointly: 1_650,
      },
      ordinary_brackets: {
        single: [
          { up_to: 12_400, rate: 0.1 },
          { up_to: 50_400, rate: 0.12 },
          { up_to: null, rate: 0.22 },
        ],
        married_filing_jointly: [
          { up_to: 24_800, rate: 0.1 },
          { up_to: 100_800, rate: 0.12 },
          { up_to: null, rate: 0.22 },
        ],
      },
      capital_gains_brackets: {
        single: [
          { up_to: 49_450, rate: 0 },
          { up_to: null, rate: 0.15 },
        ],
        married_filing_jointly: [
          { up_to: 98_900, rate: 0 },
          { up_to: null, rate: 0.15 },
        ],
      },
    },
    contribution_limits: {
      employer_plan: 24_500,
      employer_plan_catch_up_50: 8_000,
      employer_plan_catch_up_60_63: 11_250,
      ira: 7_500,
      ira_catch_up_50: 1_100,
      annual_additions: 72_000,
      plan_457b: 24_500,
      hsa: 4_400,
      sep_ira: 72_000,
      simple_ira: 17_000,
      simple_ira_catch_up_50: 4_000,
      simple_ira_catch_up_60_63: 5_250,
    },
  };
}
