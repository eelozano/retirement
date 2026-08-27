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
