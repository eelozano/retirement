import { atOrAfter, isWorkingPeriod } from "../../lib/currentSpending";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Person } from "../../types/generated/Person";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import type { YearMonth } from "../../types/generated/YearMonth";
import { MAX_SERIES, OTHER_KEY, type SeriesDef } from "./chartData";

// Derivations for the Plan screen's headline, milestones, and year inspector.
// Everything here reads fields that already exist on PeriodSnapshot or
// MonteCarloResult — nothing is estimated or invented.

/** Divisor that converts a nominal figure in `s` to the displayed basis. */
function basis(s: { deflator: number }, realDollars: boolean): number {
  return realDollars ? s.deflator : 1;
}

/** 1.96 — the standard normal quantile for a two-sided 95% interval. */
const Z_95 = 1.96;

/**
 * Half-width of the 95% **Wilson score** interval on a success rate measured
 * from `n` paths.
 *
 * Wilson rather than the textbook `z * sqrt(p(1-p)/n)`: that formula
 * collapses to exactly zero at p = 0 and p = 1, and plans that never deplete
 * in any path are common — the demo household is one. It would print
 * "100% ± 0", claiming certainty the sample cannot support, which is a worse
 * failure than the over-precision this margin exists to fix. Wilson stays
 * finite at both boundaries.
 *
 * The Wilson interval is asymmetric about `p`, so this returns the larger of
 * the two sides: a single ± that never understates the error.
 */
export function successMargin(p: number, n: number): number {
  if (n <= 0) return 0;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z_95 / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(center + half - p, p - (center - half));
}

/**
 * The year a chart pins by default: the first retirement — the year the plan
 * turns over — rather than the start, where nothing has happened yet.
 * Clamped into the projection, since a retirement before the plan starts
 * (or after it ends) is a year no snapshot describes.
 */
export function defaultPinYear(plan: Plan, projection: Projection): number {
  const first = projection.snapshots[0]?.period_start.year;
  const last = projection.snapshots[projection.snapshots.length - 1]?.period_start.year;
  if (first === undefined || last === undefined) return 0;
  const retirement = plan.people.map((p) => p.retirement.year).sort((a, b) => a - b)[0];
  return Math.min(last, Math.max(first, retirement ?? first));
}

/**
 * Why a working year's residual is called current spending, and what has to
 * be true for it to be right. Shared by every surface that shows one.
 */
export const CURRENT_SPENDING_NOTE =
  "You enter what you save, not what you spend, so what's left over here is what the household lives on. It only reads right if every dollar you save is in this plan.";

export interface HeadlineMetrics {
  /** Fraction of paths that never deplete, or null before the first run. */
  successRate: number | null;
  nPaths: number | null;
  /** Paths that ran dry — the complement of the success rate. */
  failedPaths: number | null;
  /**
   * Half-width of the 95% confidence interval on `successRate`, as a
   * fraction — the sampling error the path count leaves behind. Null before
   * the first run.
   *
   * The success rate is a proportion measured from a finite sample, so it is
   * only precise to about this much: at 1,000 paths near 90% that is a full
   * percentage point, which is why the tile must not print a first decimal
   * without saying so.
   */
  successMargin: number | null;
  /**
   * Where the 10th-percentile path ends, in the displayed basis.
   *
   * The design asked for the *worst* path; `MonteCarloResult` carries
   * percentiles, not per-path results, so there is no minimum to report.
   * p10 is the honest nearest thing and is labelled as such in the UI.
   */
  p10AtEnd: number | null;
  /**
   * First year the median path is at zero, or null if it never is.
   *
   * Also a substitute: there are no per-path depletion years to take a
   * median of, so this is "the year p50 hits zero" and must be worded that
   * way rather than as a median depletion year.
   */
  medianZeroYear: number | null;
  /** Deterministic depletion year for the plan itself, or null. */
  depletionYear: number | null;
  /**
   * Net worth divided by expenses at the first full period after the
   * earliest retirement.
   *
   * Basis-independent: both figures come from the same snapshot and so carry
   * the same deflator, which cancels. Null if no full retirement period
   * falls within the projection or expenses are zero.
   */
  coverYears: number | null;
  /** The year `coverYears` is measured at. */
  coverYear: number | null;
  /** Final projected year — the last snapshot's year, or null with no snapshots. */
  planEndYear: number | null;
  /**
   * The `life_expectancy_age` of whichever person's own mortality determines
   * `planEndYear` (the max over everyone's, matching `Plan::end_month`).
   */
  planEndAge: number;
}

function snapshotForYear(
  projection: Projection,
  year: number,
): PeriodSnapshot | undefined {
  return projection.snapshots.find((s) => s.period_start.year === year);
}

/** Mirrors the engine's `Person::month_at_age` (birth plus whole years). */
function monthAtAge(person: Person, age: number): YearMonth {
  return { year: person.birth.year + age, month: person.birth.month };
}

/**
 * The `life_expectancy_age` of whichever person's own mortality determines
 * the plan's horizon (the max over everyone's `month_at_age`, matching
 * `Plan::end_month`) — the age the plan-end year is "age N" for.
 */
function planEndAge(plan: Plan): number | null {
  return (
    plan.people.reduce<{ date: YearMonth; age: number } | null>((max, p) => {
      const date = monthAtAge(p, p.life_expectancy_age);
      return !max || atOrAfter(date, max.date)
        ? { date, age: p.life_expectancy_age }
        : max;
    }, null)?.age ?? null
  );
}

/** Mirrors the engine's `Person::month_at_age(life_expectancy_age)`. */
function deathMonth(person: Person): YearMonth {
  return monthAtAge(person, person.life_expectancy_age);
}

export interface FirstDeath {
  decedent: Person;
  date: YearMonth;
  /** Everyone still alive after `date`. */
  survivors: Person[];
}

/**
 * The household's survivor transition, mirroring `Plan::first_death`: the
 * first death that leaves someone behind. `null` for a one-person plan, or
 * when everyone's expectancy lands in the same month — no survivor, nothing
 * transitions.
 */
export function firstDeath(plan: Plan): FirstDeath | null {
  const decedent = plan.people.reduce<Person | null>(
    (first, p) => (!first || !atOrAfter(deathMonth(p), deathMonth(first)) ? p : first),
    null,
  );
  if (!decedent) return null;
  const date = deathMonth(decedent);
  const survivors = plan.people.filter(
    (p) =>
      p !== decedent && atOrAfter(deathMonth(p), date) && !sameMonth(deathMonth(p), date),
  );
  return survivors.length > 0 ? { decedent, date, survivors } : null;
}

function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month;
}

/**
 * First snapshot whose period lies entirely at or after `date` — i.e. the
 * first period a stream starting at `date` covers in full, with no
 * proration stub. Relies on `projection.snapshots` being chronological.
 */
function firstFullPeriodAtOrAfter(
  projection: Projection,
  date: YearMonth,
): PeriodSnapshot | undefined {
  return projection.snapshots.find((s) => atOrAfter(s.period_start, date));
}

export function headlineMetrics(
  plan: Plan,
  projection: Projection,
  monteCarlo: MonteCarloResult | null,
  depletionYear: number | null,
  realDollars: boolean,
): HeadlineMetrics {
  const lastPct = monteCarlo?.percentiles[monteCarlo.percentiles.length - 1];
  const medianZero = monteCarlo?.percentiles.find((p) => p.p50 <= 0);

  // The earliest retirement is the one that puts the portfolio under load.
  const firstRetirement = plan.people
    .map((p) => p.retirement)
    .sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month))[0];
  // Measure at the first full period after retirement, not the transition
  // year itself — that year's expenses can be a prorated stub (as little as
  // one month), which would overstate coverage by up to 12x.
  const atRetirement = firstRetirement
    ? firstFullPeriodAtOrAfter(projection, firstRetirement)
    : undefined;
  const coverYears =
    atRetirement && atRetirement.expenses > 0
      ? atRetirement.net_worth / atRetirement.expenses
      : null;

  return {
    successRate: monteCarlo?.success_rate ?? null,
    nPaths: monteCarlo?.n_paths ?? null,
    failedPaths: monteCarlo
      ? Math.round((1 - monteCarlo.success_rate) * monteCarlo.n_paths)
      : null,
    successMargin: monteCarlo
      ? successMargin(monteCarlo.success_rate, monteCarlo.n_paths)
      : null,
    p10AtEnd: lastPct ? lastPct.p10 / basis(lastPct, realDollars) : null,
    medianZeroYear: medianZero?.period_start.year ?? null,
    depletionYear,
    coverYears,
    coverYear: atRetirement?.period_start.year ?? null,
    planEndYear:
      projection.snapshots[projection.snapshots.length - 1]?.period_start.year ?? null,
    planEndAge: planEndAge(plan) ?? 0,
  };
}

export interface Milestone {
  key: string;
  label: string;
  value: number | null;
  sub: string;
  critical?: boolean;
}

/**
 * Net worth at each person's retirement, at the first death if the
 * household has one, and at the end of the plan.
 */
export function milestones(
  plan: Plan,
  projection: Projection,
  depletionYear: number | null,
  realDollars: boolean,
): Milestone[] {
  const out: Milestone[] = plan.people.map((person) => {
    const s = snapshotForYear(projection, person.retirement.year);
    return {
      key: person.id,
      label: `At ${person.name}'s retirement`,
      value: s ? s.net_worth / basis(s, realDollars) : null,
      sub: `${person.retirement.year} · age ${person.retirement.year - person.birth.year}`,
    };
  });

  // The first death belongs here for the same reason a retirement does: it
  // is a year the plan changes shape — one Social Security benefit instead
  // of two, a single filer's brackets, a smaller household budget.
  const death = firstDeath(plan);
  if (death) {
    const s = snapshotForYear(projection, death.date.year);
    const [survivor] = death.survivors;
    out.push({
      key: "__first-death__",
      label: `At ${death.decedent.name}'s death`,
      value: s ? s.net_worth / basis(s, realDollars) : null,
      sub: `${death.date.year} · ${
        death.survivors.length === 1
          ? `${survivor.name} alone`
          : `${death.survivors.length} survive`
      }`,
    });
  }

  const last = projection.snapshots[projection.snapshots.length - 1];
  if (depletionYear !== null) {
    out.push({
      key: "__end__",
      label: "At depletion",
      value: 0,
      sub: `${depletionYear} · nothing left`,
      critical: true,
    });
  } else if (last) {
    out.push({
      key: "__end__",
      label: "At plan end",
      value: last.net_worth / basis(last, realDollars),
      sub: `${last.period_start.year} · age ${planEndAge(plan) ?? "?"} · ${realDollars ? "today's dollars" : "nominal"}`,
    });
  }
  return out;
}

export interface FlowRow {
  key: string;
  label: string;
  /**
   * Which side of the cash identity this row sits on. The engine pins
   * `income + withdrawals == contributions + expenses + taxes + surplus`
   * (`crates/engine/tests/properties.rs`), so these two groups are the whole
   * story of the household's cash — and growth and employer match, which
   * appear on neither side, are deliberately not flow rows at all.
   */
  group: "in" | "out";
  value: number;
  critical?: boolean;
  /**
   * An annotation on the row above rather than another addend — RMDs are
   * already inside withdrawals, and employer match never passed through
   * household cash. Rendered indented and muted, and excluded from the
   * group's total.
   */
  subset?: boolean;
}

export interface BalanceRow {
  key: string;
  label: string;
  color: string;
  value: number;
}

/** How one person stands in the inspected year. */
export interface PersonYear {
  name: string;
  age: number;
  /** Retired, dead, or neither — death wins, since it ends the rest. */
  status: "retired" | "dies" | "died" | null;
}

export interface YearDetail {
  year: number;
  netWorth: number;
  ages: PersonYear[];
  flows: FlowRow[];
  /**
   * Market return for the year. Not a flow row: it never passes through
   * household cash, so it sits with net worth — the number it explains —
   * rather than in the middle of an equation it plays no part in.
   */
  growth: { value: number; critical: boolean };
  /** Income plus gross withdrawals: everything that reached the household. */
  moneyIn: number;
  /**
   * `moneyIn` less expenses, taxes, and contributions. Computed rather than
   * read from `surplus` so the panel visibly ties out — and because the
   * engine clamps `surplus` to zero in a depleted year, where the household
   * genuinely could not cover its outflows. The difference tells the truth
   * there; `surplus` would report a reassuring $0.
   */
  leftOver: number;
  leftOverLabel: string;
  /** `leftOver < 0` — the plan could not fund this year. */
  shortfall: boolean;
  balances: BalanceRow[];
  /**
   * What the survivor transition did to this year, on the years it explains
   * — without it, the drop in income at the first death reads as a glitch.
   * `null` on every year before it.
   */
  transition: string | null;
  /**
   * Why the last flow row is called current spending in a working year, and
   * what has to be true for it to be right. `null` once everyone has
   * retired and the row is a plain surplus again.
   */
  spendingNote: string | null;
}

/**
 * Everything the inspector shows for one year. This is the first place in
 * the app that surfaces income, taxes, contributions, withdrawals, and
 * surplus — the engine has computed them since M1 and nothing displayed them.
 */
export function yearDetail(
  plan: Plan,
  projection: Projection,
  year: number,
  series: SeriesDef[],
  realDollars: boolean,
): YearDetail | null {
  const s = snapshotForYear(projection, year);
  if (!s) return null;
  const d = basis(s, realDollars);

  const withdrawals = Object.values(s.withdrawals).reduce<number>(
    (sum, v) => sum + (v ?? 0),
    0,
  );
  const working = isWorkingPeriod(plan, s);

  const flows: FlowRow[] = [
    { key: "income", label: "Income", group: "in", value: s.income / d },
    {
      key: "withdrawals",
      label: "Withdrawals",
      group: "in",
      value: withdrawals / d,
    },
    // A subset of the row above, not another inflow — hence the label, and
    // hence its place directly beneath it. Broken out because it is the part
    // the household did not choose, and it is what explains a tax bill
    // jumping in the year an owner reaches 73 or 75. Shown only in the years
    // there is one.
    ...(s.required_distributions > 0
      ? [
          {
            key: "required_distributions",
            label: "of which RMDs",
            group: "in" as const,
            value: s.required_distributions / d,
            subset: true,
          },
        ]
      : []),
    {
      key: "expenses",
      label: "Expenses",
      group: "out",
      value: s.expenses / d,
    },
    { key: "taxes", label: "Taxes", group: "out", value: s.taxes / d },
    {
      key: "contributions",
      label: "Contributions",
      group: "out",
      value: s.contributions / d,
    },
    // Employer money never passes through household cash, so it is an
    // annotation on contributions rather than an outflow of its own — it
    // keeps the "what we saved this year" story together without joining a
    // sum it isn't part of. Shown only when there is some, rather than a
    // permanent $0 row for the many plans with no match.
    ...(s.employer_match > 0
      ? [
          {
            key: "employer_match",
            label: "employer adds",
            group: "out" as const,
            value: s.employer_match / d,
            subset: true,
          },
        ]
      : []),
  ];

  // The two sides of the engine's pinned cash identity. Subset rows are
  // annotations on the row above, so they never join a total.
  const total = (group: "in" | "out") =>
    flows
      .filter((f) => f.group === group && !f.subset)
      .reduce((sum, f) => sum + f.value, 0);
  const moneyIn = total("in");
  const leftOver = moneyIn - total("out");

  // Same bucketing as the chart stack, so the inspector and the areas can
  // never disagree about which accounts are shown.
  const shown = new Set(plan.accounts.slice(0, MAX_SERIES).map((a) => a.id));
  let other = 0;
  const byId = new Map<string, number>();
  for (const [id, balance] of Object.entries(s.balances)) {
    const value = (balance ?? 0) / d;
    if (shown.has(id)) byId.set(id, value);
    else other += value;
  }
  const balances: BalanceRow[] = series.map((def) => ({
    key: def.key,
    label: def.label,
    color: def.color,
    value: def.key === OTHER_KEY ? other : (byId.get(def.key) ?? 0),
  }));

  return {
    year,
    netWorth: s.net_worth / d,
    ages: plan.people.map((p) => {
      const death = deathMonth(p);
      return {
        name: p.name,
        age: year - p.birth.year,
        status:
          year > death.year
            ? "died"
            : year === death.year
              ? "dies"
              : year >= p.retirement.year
                ? "retired"
                : null,
      };
    }),
    flows,
    growth: { value: s.growth / d, critical: s.growth < 0 },
    moneyIn,
    leftOver,
    // While anyone is still earning, this is not money looking for a home —
    // it is what the household lives on (#50). Savings are the input in this
    // app and spending is the residual, so calling it "left over" in a
    // working year invites exactly the wrong conclusion.
    leftOverLabel:
      leftOver < 0 ? "Shortfall" : working ? "Current spending" : "Left over",
    shortfall: leftOver < 0,
    balances,
    transition: transitionNote(plan, year),
    spendingNote: working ? CURRENT_SPENDING_NOTE : null,
  };
}

/**
 * The one-line explanation of the survivor transition for `year`, listing
 * only the consequences this plan actually carries: a plan with no Social
 * Security, no joint filing, and no step-down factor gets the bare fact.
 */
function transitionNote(plan: Plan, year: number): string | null {
  const death = firstDeath(plan);
  if (!death || year < death.date.year) return null;
  if (year > death.date.year) {
    return `A household of ${death.survivors.length} since ${death.decedent.name}'s death in ${death.date.year}.`;
  }

  const consequences: string[] = [];
  if (plan.social_security.length > 0) {
    consequences.push("Social Security drops to the larger of the two benefits");
  }
  if (plan.assumptions.filing_status === "MarriedFilingJointly") {
    consequences.push("filing status is Single from next year");
  }
  if (plan.assumptions.survivor_expense_factor < 1) {
    consequences.push(
      `household spending steps to ${Math.round(plan.assumptions.survivor_expense_factor * 100)}%`,
    );
  }
  const head = `${death.decedent.name} dies in ${death.date.year}`;
  return consequences.length > 0 ? `${head}: ${consequences.join("; ")}.` : `${head}.`;
}
