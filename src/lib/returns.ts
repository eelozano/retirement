// Two rates the Assumptions pane derives from figures the plan already
// holds. Neither is stored: they are restatements of `strategy_returns`,
// `strategy_volatility` and `inflation`, computed here rather than round-
// tripped through `run_projection` so they update on every keystroke.
//
// They exist because the stored figure alone does not say what it means. It
// is nominal, and it is the average of a single year — see the doc comments
// below and "The return is an arithmetic mean, not a compound rate" in
// docs/ARCHITECTURE.md.

/**
 * What a nominal expected return is worth once inflation is out of it.
 *
 * The Fisher relation, not a subtraction: the engine grows balances at the
 * nominal rate and deflates by `(1 + inflation)^years` separately, so the
 * two compose multiplicatively. At 7.5% against 3% that is 4.37%, where
 * subtracting would say 4.5%.
 */
export function realReturn(nominal: number, inflation: number): number {
  return (1 + nominal) / (1 + inflation) - 1;
}

/**
 * The rate the *median* Monte Carlo path compounds at, which is below the
 * typed return.
 *
 * `strategy_returns` is the expected return of one year, and
 * `StochasticReturns` (crates/engine/src/strategies/returns.rs) uses it that
 * way: it *adds* `σ · shock` to the period mean, and periods are calendar
 * years, so the draws are symmetric about the typed figure and their average
 * is it. A sequence of such years does not compound at that figure — the
 * median of a product of draws is `exp(E[ln(1+r)])`, and to second order
 * `E[ln(1+r)] ≈ ln(1+μ) − σ²/(2(1+μ)²)`.
 *
 * Exact at σ = 0, where the deterministic projection and the Monte Carlo
 * median are the same run and this returns μ.
 */
export function medianCompoundedReturn(mean: number, stddev: number): number {
  return Math.exp(Math.log(1 + mean) - stddev ** 2 / (2 * (1 + mean) ** 2)) - 1;
}
