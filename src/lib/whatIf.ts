import type { AssetClass } from "../types/generated/AssetClass";
import type { Plan } from "../types/generated/Plan";
import type { StreamBoundary } from "../types/generated/StreamBoundary";
import type { YearMonth } from "../types/generated/YearMonth";

// The knobs behind the What-if sandbox, and the pure function that turns the
// saved plan into the hypothetical one.
//
// Deliberately a plain function over a `Plan`, with no store, no IPC and no
// persistence: the sandbox's one invariant is that a hypothetical never
// reaches disk, and the cheapest way to keep it is for the code that builds
// one to have no way of writing anything. `WhatIfScreen` holds the overrides
// in component state and feeds the draft to `runProjection`; the only path
// from here to a file is `promoteToScenario`, which the user asks for by name.

/** How far each knob can travel. Ranges, not validity: the retirement and
 * longevity knobs are clamped further per plan (see the bounds functions
 * below), since what is reachable there depends on the dates in the plan. */
export const MAX_RETIREMENT_SHIFT_YEARS = 10;
export const MAX_LIFE_SHIFT_YEARS = 15;
export const MIN_SPENDING_MULTIPLIER = 0.5;
export const MAX_SPENDING_MULTIPLIER = 1.5;
export const MAX_RETURN_SHIFT_BP = 300;
export const MIN_VOLATILITY_MULTIPLIER = 0.5;
export const MAX_VOLATILITY_MULTIPLIER = 2;
export const MAX_INFLATION_SHIFT_BP = 300;

/** Basis points to a decimal rate: 100 bp = 0.01. */
const BP = 10_000;

export interface WhatIfOverrides {
  /** Whole-year shift of a person's retirement date, keyed by person id. A
   * missing id means no shift. Whole years because V1 iterates annual
   * periods — a six-month shift would move the date without moving a period
   * boundary, which reads as a knob that does nothing. */
  retirementShiftYears: Record<string, number>;
  /** Scales every *expense* stream's `annual_amount`. Income is left alone:
   * this knob answers "what if we spent less", not "what if we earned less". */
  spendingMultiplier: number;
  /** Added to every asset class's expected return, in basis points. Moves the
   * deterministic projection and the center of the Monte Carlo fan together. */
  returnShiftBp: number;
  /** Scales every asset class's volatility. Monte Carlo only — the
   * deterministic projection reads `asset_returns` and never
   * `asset_volatility` (see `engine::run_deterministic`). */
  volatilityMultiplier: number;
  /** Added to the inflation assumption, in basis points. */
  inflationShiftBp: number;
  /** Shifts every person's `life_expectancy_age` by the same whole number of
   * years — "what if we live to 100", the stress test that also moves the
   * survivor transition and the plan horizon with it. */
  lifeExpectancyShiftYears: number;
}

/** Every knob at rest: the saved plan, unchanged. */
export const BASELINE: WhatIfOverrides = {
  retirementShiftYears: {},
  spendingMultiplier: 1,
  returnShiftBp: 0,
  volatilityMultiplier: 1,
  inflationShiftBp: 0,
  lifeExpectancyShiftYears: 0,
};

/** True when the draft would be the saved plan. The sandbox reads the
 * store's own Monte Carlo result rather than re-running an identical one. */
export function isBaseline(o: WhatIfOverrides): boolean {
  return (
    o.spendingMultiplier === 1 &&
    o.returnShiftBp === 0 &&
    o.volatilityMultiplier === 1 &&
    o.inflationShiftBp === 0 &&
    o.lifeExpectancyShiftYears === 0 &&
    Object.values(o.retirementShiftYears).every((years) => years === 0)
  );
}

function monthIndex(date: YearMonth): number {
  return date.year * 12 + (date.month - 1);
}

function addYears(date: YearMonth, years: number): YearMonth {
  return { year: date.year + years, month: date.month };
}

type Rates = Plan["assumptions"]["asset_returns"];

/** Maps every present asset class through `f`. The map is partial — a plan
 * need not price every class — so the absent ones stay absent rather than
 * appearing at zero. */
function mapRates(rates: Rates, f: (rate: number) => number): Rates {
  const next: Rates = {};
  for (const [cls, rate] of Object.entries(rates) as [AssetClass, number][]) {
    next[cls] = f(rate);
  }
  return next;
}

/** Applies the overrides to a plan already owned by the caller. The in-place
 * form exists for `promoteToScenario`, whose recipe mutates a draft the store
 * cloned for it. */
export function applyOverridesTo(draft: Plan, o: WhatIfOverrides): void {
  for (const person of draft.people) {
    const shift = o.retirementShiftYears[person.id] ?? 0;
    if (shift !== 0) person.retirement = addYears(person.retirement, shift);
    // `life_expectancy_age` is a `u8`: a negative age cannot be serialized at
    // all. The floor is a guard, not a policy — `lifeExpectancyShiftBounds`
    // is what keeps the knob inside a sensible range.
    person.life_expectancy_age = Math.max(
      1,
      person.life_expectancy_age + o.lifeExpectancyShiftYears,
    );
  }

  if (o.spendingMultiplier !== 1) {
    for (const stream of draft.streams) {
      if (stream.direction === "Expense") {
        stream.annual_amount *= o.spendingMultiplier;
      }
    }
  }

  const returnShift = o.returnShiftBp / BP;
  if (returnShift !== 0) {
    draft.assumptions.asset_returns = mapRates(
      draft.assumptions.asset_returns,
      // Not floored at zero: a bond class at 2% shifted down 300 bp is a real
      // question, and the engine has no trouble with a negative expected
      // return.
      (rate) => rate + returnShift,
    );
  }

  if (o.volatilityMultiplier !== 1) {
    draft.assumptions.asset_volatility = mapRates(
      draft.assumptions.asset_volatility,
      (sigma) => sigma * o.volatilityMultiplier,
    );
  }

  if (o.inflationShiftBp !== 0) {
    draft.assumptions.inflation += o.inflationShiftBp / BP;
  }
}

/** The hypothetical plan: `plan` with the knobs applied, and nothing else
 * touched. Never mutates its argument. */
export function applyOverrides(plan: Plan, o: WhatIfOverrides): Plan {
  const draft: Plan = structuredClone(plan);
  applyOverridesTo(draft, o);
  return draft;
}

/** How far a knob can travel on this plan, in whole years. Always contains
 * zero: the saved plan is valid, so leaving a knob alone is always legal. */
export interface ShiftBounds {
  min: number;
  max: number;
}

/** Plan types whose contributions come out of an employer's payroll, and so
 * cannot outlive the owner's retirement. Mirrors `needs_employer` in
 * `engine::model::validation`. */
const EMPLOYER_PLAN_TYPES = new Set(["EmployerPlan", "Plan457b", "SimpleIra", "SepIra"]);

/** The month a contribution's end boundary resolves to for the purpose of
 * "must not be after the owner retires", or null when it moves with the
 * person being shifted (or is anchored before retirement anyway).
 *
 * `PlanEnd` and `AtDeath` are always past retirement and so cannot appear on
 * a valid employer-plan contribution; they return null here and are left to
 * the engine, which is the authority on validity either way. */
function fixedEndMonth(
  plan: Plan,
  end: StreamBoundary,
  shiftingPersonId: string,
): number | null {
  if (typeof end === "string") return null;
  if ("Date" in end) return monthIndex(end.Date);
  if ("AtRetirement" in end && end.AtRetirement !== shiftingPersonId) {
    const other = plan.people.find((p) => p.id === end.AtRetirement);
    return other ? monthIndex(other.retirement) : null;
  }
  return null;
}

/**
 * How far this person's retirement date can move before the plan stops being
 * one the engine will accept.
 *
 * Clamping rather than showing validation errors: a slider that stops is a
 * better answer to "why can't I retire in 2029?" than a chart that vanishes
 * and a message where it used to be. The two rules replicated here are the
 * ones that are *about* a retirement date, both from
 * `engine::model::validation`:
 *
 * 1. Retirement must be after birth.
 * 2. An employer plan's contributions cannot end after its owner retires.
 *
 * They are a clamp, not a revalidation — the engine still validates the draft
 * and the sandbox still shows whatever it says, which is what covers any rule
 * not enumerated here.
 */
export function retirementShiftBounds(plan: Plan, personId: string): ShiftBounds {
  const person = plan.people.find((p) => p.id === personId);
  if (!person) return { min: 0, max: 0 };

  const retirement = monthIndex(person.retirement);
  let min = -MAX_RETIREMENT_SHIFT_YEARS;
  let max = MAX_RETIREMENT_SHIFT_YEARS;

  // Rule 1: strictly after birth, hence the +1 month.
  min = Math.max(min, Math.ceil((monthIndex(person.birth) + 1 - retirement) / 12));

  // Rule 2, in both directions: moving *this* person earlier can strand a
  // contribution to their own employer plan, and moving them later can
  // strand someone else's contribution that ends at this person's retirement.
  for (const account of plan.accounts) {
    if (!EMPLOYER_PLAN_TYPES.has(account.plan_type)) continue;
    for (const entry of account.contributions) {
      if (account.owner === personId) {
        const end = fixedEndMonth(plan, entry.end, personId);
        if (end !== null) min = Math.max(min, Math.ceil((end - retirement) / 12));
      } else if (
        typeof entry.end === "object" &&
        "AtRetirement" in entry.end &&
        entry.end.AtRetirement === personId
      ) {
        const owner = plan.people.find((p) => p.id === account.owner);
        if (owner) {
          max = Math.min(
            max,
            Math.floor((monthIndex(owner.retirement) - retirement) / 12),
          );
        }
      }
    }
  }

  // A valid plan satisfies every rule at zero. Pinning the range around zero
  // keeps that true even for a plan that reached here invalid.
  return { min: Math.min(0, min), max: Math.max(0, max) };
}

/**
 * How far the shared longevity knob can travel. One bound that has to hold
 * for everyone, since the knob moves the whole household together.
 *
 * The floor is not a validation rule — `life_expectancy_age` has none — but a
 * horizon that ends before the plan starts is not a shorter life, it is no
 * projection at all. A year of plan is the minimum worth drawing.
 */
export function lifeExpectancyShiftBounds(plan: Plan): ShiftBounds {
  const start = monthIndex(plan.sim_config.start);
  let min = -MAX_LIFE_SHIFT_YEARS;

  for (const person of plan.people) {
    const death = monthIndex(person.birth) + person.life_expectancy_age * 12;
    min = Math.max(min, Math.ceil((start + 12 - death) / 12));
    // `u8`, so an age can never go to or below zero.
    min = Math.max(min, 1 - person.life_expectancy_age);
  }

  return { min: Math.min(0, min), max: MAX_LIFE_SHIFT_YEARS };
}

/** A signed whole-percent reading of a multiplier: 0.9 → "−10%". Clearer
 * than "×0.90" for a knob whose whole point is the size of the change. */
function signedPercent(multiplier: number): string {
  const points = Math.round((multiplier - 1) * 100);
  return points >= 0 ? `+${points}%` : `−${-points}%`;
}

function signedBp(bp: number): string {
  return bp >= 0 ? `+${bp} bp` : `−${-bp} bp`;
}

function years(n: number): string {
  return `${n} ${Math.abs(n) === 1 ? "year" : "years"}`;
}

/**
 * One sentence per knob that is off its rest position — what the draft
 * actually differs by, in the reader's words rather than the field's.
 * Empty when nothing has moved.
 */
export function overrideLabels(plan: Plan, o: WhatIfOverrides): string[] {
  const labels: string[] = [];

  for (const person of plan.people) {
    const shift = o.retirementShiftYears[person.id] ?? 0;
    if (shift === 0) continue;
    labels.push(
      `${person.name} retires ${years(Math.abs(shift))} ${shift < 0 ? "earlier" : "later"}`,
    );
  }
  if (o.spendingMultiplier !== 1) {
    labels.push(`Spending ${signedPercent(o.spendingMultiplier)}`);
  }
  if (o.returnShiftBp !== 0) {
    labels.push(`Returns ${signedBp(o.returnShiftBp)} on every asset class`);
  }
  if (o.volatilityMultiplier !== 1) {
    labels.push(`Volatility ×${o.volatilityMultiplier.toFixed(2)}`);
  }
  if (o.inflationShiftBp !== 0) {
    labels.push(`Inflation ${signedBp(o.inflationShiftBp)}`);
  }
  if (o.lifeExpectancyShiftYears !== 0) {
    const n = Math.abs(o.lifeExpectancyShiftYears);
    labels.push(
      `Everyone lives ${years(n)} ${o.lifeExpectancyShiftYears < 0 ? "less" : "longer"}`,
    );
  }

  return labels;
}

/** A name for the scenario a hypothetical would become — the base plan plus
 * what was changed, so a promoted sandbox arrives in the switcher already
 * saying what it is. Editable: this is a starting point, not a decision. */
export function suggestScenarioName(plan: Plan, o: WhatIfOverrides): string {
  const parts: string[] = [];

  for (const person of plan.people) {
    const shift = o.retirementShiftYears[person.id] ?? 0;
    if (shift !== 0) {
      parts.push(`${person.name} retires ${shift > 0 ? "+" : "−"}${Math.abs(shift)}y`);
    }
  }
  if (o.spendingMultiplier !== 1)
    parts.push(`spending ${signedPercent(o.spendingMultiplier)}`);
  if (o.returnShiftBp !== 0) parts.push(`returns ${signedBp(o.returnShiftBp)}`);
  if (o.volatilityMultiplier !== 1)
    parts.push(`vol ×${o.volatilityMultiplier.toFixed(2)}`);
  if (o.inflationShiftBp !== 0) parts.push(`inflation ${signedBp(o.inflationShiftBp)}`);
  if (o.lifeExpectancyShiftYears !== 0) {
    const shift = o.lifeExpectancyShiftYears;
    parts.push(`lifespan ${shift > 0 ? "+" : "−"}${Math.abs(shift)}y`);
  }

  return parts.length === 0 ? `${plan.name} copy` : `${plan.name} — ${parts.join(", ")}`;
}
