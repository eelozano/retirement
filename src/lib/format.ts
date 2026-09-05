const wholeCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const compactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

export function currency(value: number): string {
  return wholeCurrency.format(value);
}

/** $1.3M-style figure for stat tiles and axis ticks. */
export function currencyCompact(value: number): string {
  return compactCurrency.format(value);
}

/** Stored decimal rate (0.025) → display percent string ("2.5"). */
export function rateToPercent(rate: number): string {
  return String(Math.round(rate * 10000) / 100);
}

/** Display percent (2.5) → stored decimal rate (0.025). */
export function percentToRate(percent: number): number {
  return percent / 100;
}

/**
 * Stored decimal rate (0.025) → a display percent ("2.5%"), with a true minus
 * sign rather than a hyphen so a negative return reads as a number and not as
 * a list dash.
 */
export function ratePercent(rate: number, decimals = 1): string {
  const rounded = (rate * 100).toFixed(decimals);
  // Rounding can land on "-0.0"; a signed zero is noise, not information.
  if (Number(rounded) === 0) return `${(0).toFixed(decimals)}%`;
  return rounded.startsWith("-") ? `−${rounded.slice(1)}%` : `${rounded}%`;
}

/**
 * A Monte Carlo success rate at the precision its sample supports, and the
 * margin that says how much that is.
 *
 * A rate measured from N paths carries sampling error of roughly `margin`, so
 * printing a first decimal when the margin is half a point wide advertises
 * precision that isn't there. Below half a point the decimal is meaningful
 * and is kept.
 *
 * Shared by the headline tile and the scenario comparison table so a rate
 * never reads at two precisions on two screens.
 */
export function successPercent(rate: number, margin: number | null): string {
  const value = rate * 100;
  const decimals = marginDecimals(margin);
  // Round toward the honest side: 99.96% should not read as 100%.
  if (value >= 100 - 0.5 * 10 ** -decimals && value < 100) {
    return `${(100 - 10 ** -decimals).toFixed(decimals)}%`;
  }
  return `${value.toFixed(decimals)}%`;
}

/** The ± that follows a success rate, at the same precision as the rate. */
export function successMarginPercent(margin: number): string {
  const value = (margin * 100).toFixed(marginDecimals(margin));
  // Only exactly one point is singular — "±0.4 pts" is right, "±1 pts" isn't.
  return `±${value} ${value === "1" ? "pt" : "pts"}`;
}

/**
 * A difference between two success rates, in percentage points — the
 * comparison table's "vs. base" column.
 *
 * Takes the row's own `margin` only to borrow its precision, not to print it:
 * scenarios in a batch share a seed, so the difference is measured against
 * the same draws and is sharper than either rate's margin implies. See
 * `ComparisonSummaryRow.successDeltaVsBase`.
 */
export function successPointsDelta(delta: number, margin: number | null): string {
  const decimals = marginDecimals(margin);
  const points = (delta * 100).toFixed(decimals);
  // A signed zero is noise; a true minus sign keeps a negative reading as a
  // number rather than a list dash, as `ratePercent` does.
  if (Number(points) === 0) return `${(0).toFixed(decimals)} pts`;
  const magnitude = points.replace("-", "");
  const unit = magnitude === "1" ? "pt" : "pts";
  return points.startsWith("-") ? `−${magnitude} ${unit}` : `+${points} ${unit}`;
}

/** Whole points once the margin is half a point or wider, else one decimal. */
function marginDecimals(margin: number | null): number {
  return (margin ?? 0) * 100 >= 0.5 ? 0 : 1;
}
