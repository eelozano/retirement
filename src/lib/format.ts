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
