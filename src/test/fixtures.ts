import type { MonteCarloDiagnostics } from "../types/generated/MonteCarloDiagnostics";
import type { PathGroupStats } from "../types/generated/PathGroupStats";
import type { Spread } from "../types/generated/Spread";

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
