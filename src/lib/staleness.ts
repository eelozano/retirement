import type { YearMonth } from "../types/generated/YearMonth";

/**
 * How the as-of cue is toned: plain under three months, a warning tone from
 * three, and the nudge to refresh from six (#110). Constants rather than a
 * setting — a household refreshes every few months, not on a schedule it
 * configures.
 */
const WARNING_MONTHS = 3;
const STALE_MONTHS = 6;

export type StalenessTone = "plain" | "warning" | "stale";

/** Calendar months from `asOf` to `now`, clamped to zero — balances are
 * never observed in the future, but a clock skewed a day into the next
 * month should read as "this month," not "-1 months ago." */
export function monthsSince(asOf: YearMonth, now: Date): number {
  const nowMonths = now.getFullYear() * 12 + now.getMonth();
  const asOfMonths = asOf.year * 12 + (asOf.month - 1);
  return Math.max(0, nowMonths - asOfMonths);
}

export function stalenessTone(monthsAgo: number): StalenessTone {
  if (monthsAgo >= STALE_MONTHS) return "stale";
  if (monthsAgo >= WARNING_MONTHS) return "warning";
  return "plain";
}

/** "this month" / "1 month ago" / "N months ago". */
export function monthsAgoLabel(monthsAgo: number): string {
  if (monthsAgo === 0) return "this month";
  if (monthsAgo === 1) return "1 month ago";
  return `${monthsAgo} months ago`;
}
