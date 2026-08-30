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

export interface HeadlineMetrics {
  /** Fraction of paths that never deplete, or null before the first run. */
  successRate: number | null;
  nPaths: number | null;
  /** Paths that ran dry — the complement of the success rate. */
  failedPaths: number | null;
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

function atOrAfter(a: YearMonth, b: YearMonth): boolean {
  return a.year !== b.year ? a.year > b.year : a.month >= b.month;
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

/** Net worth at each person's retirement, plus the end of the plan. */
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
  color: string;
  value: number;
  /** Surplus is the only row that can meaningfully go negative. */
  critical?: boolean;
}

export interface BalanceRow {
  key: string;
  label: string;
  color: string;
  value: number;
}

export interface YearDetail {
  year: number;
  netWorth: number;
  ages: { name: string; age: number; retired: boolean }[];
  flows: FlowRow[];
  balances: BalanceRow[];
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

  const flows: FlowRow[] = [
    { key: "income", label: "Income", color: "var(--series-2)", value: s.income / d },
    {
      key: "withdrawals",
      label: "Withdrawals",
      color: "var(--series-1)",
      value: withdrawals / d,
    },
    {
      key: "expenses",
      label: "Expenses",
      color: "var(--series-3)",
      value: s.expenses / d,
    },
    { key: "taxes", label: "Taxes", color: "var(--series-7)", value: s.taxes / d },
    {
      key: "contributions",
      label: "Contributions",
      color: "var(--series-6)",
      value: s.contributions / d,
    },
    // Employer money, so it sits outside the income/outflow arithmetic the
    // rows above balance — shown only when there is some, rather than a
    // permanent $0 row for the many plans with no match.
    ...(s.employer_match > 0
      ? [
          {
            key: "employer_match",
            label: "Employer match",
            color: "var(--series-5)",
            value: s.employer_match / d,
          },
        ]
      : []),
    {
      key: "surplus",
      label: "Surplus",
      color: "var(--muted)",
      value: s.surplus / d,
      critical: s.surplus < 0,
    },
  ];

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
    ages: plan.people.map((p) => ({
      name: p.name,
      age: year - p.birth.year,
      retired: year >= p.retirement.year,
    })),
    flows,
    balances,
  };
}
