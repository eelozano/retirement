import type { MonteCarloDiagnostics } from "../types/generated/MonteCarloDiagnostics";

/**
 * Diagnostics for a run with nothing to diagnose: no failures and no
 * retirement to anchor on. What a test that only cares about the success
 * rate or the percentiles puts on its `MonteCarloResult`.
 */
export function emptyDiagnostics(): MonteCarloDiagnostics {
  return {
    early_window_years: 5,
    retirement_period: null,
    depletion_histogram: [],
    early_failures: 0,
    late_failures: 0,
    failed: null,
    succeeded: null,
    median_withdrawal_rate_at_retirement: null,
  };
}
