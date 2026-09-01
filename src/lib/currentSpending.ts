import type { PeriodSnapshot } from "../types/generated/PeriodSnapshot";
import type { Person } from "../types/generated/Person";
import type { Plan } from "../types/generated/Plan";
import type { Projection } from "../types/generated/Projection";
import type { YearMonth } from "../types/generated/YearMonth";

// Reading the working-phase surplus for what it is (#50).
//
// This app takes savings as the input and lets spending fall out as the
// residual: contributions are budgeted exactly and typed in, the grocery
// bill is not. So while the household is still earning, `surplus` —
// income minus contributions, taxes and any expenses that *are* modelled —
// is not leftover cash looking for a home. It is what the household lives
// on, and the app used to call it leftovers and throw it away.
//
// Two things follow, and both live here: the label the number carries while
// anyone is still working, and the estimate it gives for the one input a
// projection cannot do without — retirement spending.

/** `a >= b`, comparing year then month. */
export function atOrAfter(a: YearMonth, b: YearMonth): boolean {
  return a.year !== b.year ? a.year > b.year : a.month >= b.month;
}

/**
 * The last person to stop earning — the point after which no salary is
 * covering household spending, so a leftover really is a leftover. `null`
 * for a plan with no people.
 */
export function lastToRetire(plan: Plan): Person | null {
  return plan.people.reduce<Person | null>(
    (last, p) => (!last || atOrAfter(p.retirement, last.retirement) ? p : last),
    null,
  );
}

/** The first retirement in the household — the end of a full working year. */
function firstRetirement(plan: Plan): YearMonth | null {
  return plan.people.reduce<YearMonth | null>(
    (first, p) => (!first || !atOrAfter(p.retirement, first) ? p.retirement : first),
    null,
  );
}

/**
 * Whether this period's surplus should be read as current spending rather
 * than as leftover cash: true while *anyone* is still earning, since their
 * salary is still what the residual is measuring.
 */
export function isWorkingPeriod(plan: Plan, snapshot: PeriodSnapshot): boolean {
  const last = lastToRetire(plan);
  return last !== null && !atOrAfter(snapshot.period_start, last.retirement);
}

/**
 * Whether the plan already says something about what the household spends
 * once everyone has retired — the question the seeded stream answers.
 *
 * Asked of the projection rather than of the streams, because a plan can
 * cover its retirement years from any direction: one expense running
 * `PlanStart` → `PlanEnd`, as the seed plan does, models them just as
 * completely as one that starts at a retirement. Offering to add a whole
 * household's spending on top of either would silently double it.
 *
 * `true` — nothing to offer — when the plan has no people, or retires
 * everyone after the projection ends.
 */
export function retirementSpendingIsModelled(
  plan: Plan,
  projection: Projection,
): boolean {
  const last = lastToRetire(plan);
  if (!last) return true;
  const retired = projection.snapshots.find((s) =>
    atOrAfter(s.period_start, last.retirement),
  );
  return !retired || retired.expenses > 0;
}

export interface CurrentSpending {
  /**
   * Annual spending in **today's** dollars — deflated, because the same
   * figure twenty years out in nominal dollars would seed a retirement
   * estimate roughly twice too high.
   */
  annualAmount: number;
  /** The working year it was measured in. */
  year: number;
}

/**
 * What the household currently lives on, derived from the last projection
 * period that is a full working year for everyone.
 *
 * `surplus + expenses` is income minus contributions and taxes, which is
 * take-home minus what the household saves — so a plan that models some
 * spending explicitly and leaves the rest residual still gives the whole
 * figure. Required distributions are backed out: they are cash from a
 * portfolio rather than something a paycheck leaves over.
 *
 * The derivation only holds if every dollar the household saves is modelled
 * in the plan. Saving that happens outside it — mortgage principal, a 529,
 * cash in the bank — reads as spending here, because the engine cannot tell
 * the two apart. It is a starting point to sanity-check, not a measurement,
 * and the UI has to say so wherever it shows the number.
 *
 * `null` when no period qualifies (nobody is working, retirement precedes
 * the projection) or the arithmetic comes out non-positive.
 */
export function currentSpendingEstimate(
  plan: Plan,
  projection: Projection,
): CurrentSpending | null {
  const retirement = firstRetirement(plan);
  if (!retirement) return null;

  const snapshots = projection.snapshots;
  let found: CurrentSpending | null = null;
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    // A period counts only if it ends at or before the first retirement —
    // the year someone retires is part salary, part not, and would read
    // low. The next period's start is this one's end; the final snapshot
    // has no successor and is never a full year of anything here.
    const periodEnd = snapshots[i + 1]?.period_start;
    if (!periodEnd || !atOrAfter(retirement, periodEnd)) break;

    const annualAmount = (s.surplus + s.expenses - s.required_distributions) / s.deflator;
    if (annualAmount > 0) found = { annualAmount, year: s.period_start.year };
  }
  return found;
}
