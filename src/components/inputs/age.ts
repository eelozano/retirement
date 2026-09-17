import type { YearMonth } from "../../types/generated/YearMonth";

/**
 * How old someone born in `birth` is in `date`, as a phrase — "That's age
 * 58 and 3 months." Retirement is entered as a month but reasoned about as
 * an age ("retire at 58"), and the answer is otherwise a birth date and
 * some arithmetic away.
 */
export function ageAt(birth: YearMonth, date: YearMonth): string | undefined {
  const months = (date.year - birth.year) * 12 + (date.month - birth.month);
  if (months < 0) return undefined;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (rest === 0) return `That's age ${years}.`;
  return `That's age ${years} and ${rest} month${rest === 1 ? "" : "s"}.`;
}
