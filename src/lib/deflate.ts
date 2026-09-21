// The real-dollar toggle is a division, and which factor it divides by
// depends on what the figure is (#146). The engine emits both: `deflator`,
// the price level at a period's start, and `deflator_end`, at its end.
//
// A flow — income, expenses, taxes, contributions, growth — accrues through
// the period and is grown by the same exponent the start factor uses, so it
// deflates exactly by that. A balance or net worth is a snapshot of the
// period's *end*; dividing it by the start factor would leave a year of
// inflation in it, reading every real balance about 3% high.
//
// Two named functions rather than a field name at each call site, because
// picking the wrong one type-checks and looks plausible on screen.

/** Divisor turning a nominal *flow* into the displayed basis. */
export function flowDivisor(s: { deflator: number }, realDollars: boolean): number {
  return realDollars ? s.deflator : 1;
}

/** Divisor turning a nominal *balance* — an end-of-period figure — into the
 * displayed basis. */
export function balanceDivisor(
  s: { deflator_end: number },
  realDollars: boolean,
): number {
  return realDollars ? s.deflator_end : 1;
}
