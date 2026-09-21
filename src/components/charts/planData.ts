import { atOrAfter, isWorkingPeriod } from "../../lib/currentSpending";
import { phaseName } from "../../lib/drawdown";
import { yearBoundary } from "../../lib/yearBoundary";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Person } from "../../types/generated/Person";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import type { YearMonth } from "../../types/generated/YearMonth";
import { oneTimeName } from "../inputs/accountContribution";
import { MAX_SERIES, OTHER_KEY, type SeriesDef } from "./chartData";
import { failureFindings } from "./whyPathsFailData";

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
 * Half of the smallest amount the year inspector prints: `currency` shows
 * whole dollars, so a leftover nearer zero than this reads as "$0" whatever
 * its sign. Below it the leftover *is* zero — see `yearDetail`.
 */
const HALF_A_PRINTED_DOLLAR = 0.5;

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

/**
 * What the net-worth line is, said wherever that line is drawn (#144).
 *
 * `strategy_returns` is the expected return of a *single year* and the
 * deterministic run reads it as a certainty, so it compounds at the typed
 * figure while a sequence of varying years compounds at roughly
 * `μ − σ²/2` — see `medianCompoundedReturn` in `src/lib/returns.ts` and
 * "The return is an arithmetic mean, not a compound rate" in
 * docs/ARCHITECTURE.md. On the example household the line ends about 4.4×
 * the Monte Carlo median, on a screen that elsewhere reports a 61% chance
 * of never running dry. Both are true, about different things, and only
 * this sentence says which is which.
 *
 * Shown only when some strategy actually carries volatility — at σ = 0 the
 * deterministic run *is* the median path, and the sentence would be false.
 */
export const DETERMINISTIC_LINE_NOTE =
  "The net-worth line is a single run where every year earns the expected return. Varying years compound more slowly, so it runs above the Monte Carlo median rather than through it.";

/** Whether any strategy is drawn with a spread — see `DETERMINISTIC_LINE_NOTE`. */
export function hasVolatility(plan: Plan): boolean {
  return Object.values(plan.assumptions.strategy_volatility).some((v) => v > 0);
}

/**
 * The same point as `DETERMINISTIC_LINE_NOTE`, measured for one year: what
 * the inspected year's deterministic net worth is as a multiple of the same
 * year's median path. Shown under the percentile block, where the two
 * numbers are already side by side, so the gap is a figure rather than a
 * claim.
 */
export function medianGapNote(netWorth: number, p50: number): string {
  const lead = "The net worth above is one run at the expected return";
  if (p50 <= 0) {
    return `${lead}. Half the paths have run dry by this year.`;
  }
  if (netWorth <= 0) {
    return `${lead}, and it has run dry by this year.`;
  }
  const ratio = netWorth / p50;
  if (ratio > 0.95 && ratio < 1.05) {
    return `${lead} — about level with this year's median path.`;
  }
  return `${lead} — ${ratio.toFixed(1)}× this year's median path.`;
}

export interface HeadlineMetrics {
  /** Fraction of paths that never deplete, or null before the first run. */
  successRate: number | null;
  nPaths: number | null;
  /**
   * Paths that ran dry. The exact count the engine put in the diagnostics,
   * not the success rate multiplied back out: the rate is a rounded ratio,
   * and reconstructing a count from it can print a figure that does not add
   * up against the path total.
   */
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
   * True when the Monte Carlo figures above were computed against an
   * earlier version of the plan, seed, or path count than the one on screen
   * — an edit landed in on-demand mode, or the run that would have refreshed
   * them was cancelled. Every surface that prints them has to say so.
   */
  successStale: boolean;
  /**
   * Where the 10th-percentile path ends, in the displayed basis.
   *
   * The design asked for the *worst* path; `MonteCarloResult` carries
   * percentiles, not per-path results, so there is no minimum to report.
   * p10 is the honest nearest thing and is labelled as such in the UI.
   */
  p10AtEnd: number | null;
  /**
   * The year half the failed paths have run dry by — the nearest-rank median
   * over `diagnostics.depletion_histogram`, so "half of them by this year" is
   * literally what it reports.
   *
   * Null when no path failed. This used to be the year the p50 *line* hit
   * zero, which is a different statistic entirely: the median path's balance,
   * not the median failure's date.
   */
  medianFailureYear: number | null;
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
 *
 * Mirrors `SimConfig::first_full_period_at_or_after`, stub clause included:
 * a period is a whole calendar year exactly when it starts in January, and
 * period 0 of a plan started mid-year is not one (#106). Without that test,
 * a household already retired when they wrote a September plan would have
 * its "at retirement" figures read off a four-month stub.
 */
function firstFullPeriodAtOrAfter(
  projection: Projection,
  date: YearMonth,
): PeriodSnapshot | undefined {
  return projection.snapshots.find(
    (s) => s.period_start.month === 1 && atOrAfter(s.period_start, date),
  );
}

export function headlineMetrics(
  plan: Plan,
  projection: Projection,
  monteCarlo: MonteCarloResult | null,
  depletionYear: number | null,
  realDollars: boolean,
  monteCarloStale = false,
): HeadlineMetrics {
  const lastPct = monteCarlo?.percentiles[monteCarlo.percentiles.length - 1];
  const diagnostics = monteCarlo ? failureFindings(monteCarlo) : null;

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
    failedPaths: monteCarlo ? (monteCarlo.diagnostics.failed?.n ?? 0) : null,
    successMargin: monteCarlo
      ? successMargin(monteCarlo.success_rate, monteCarlo.n_paths)
      : null,
    successStale: monteCarlo !== null && monteCarloStale,
    p10AtEnd: lastPct ? lastPct.p10 / basis(lastPct, realDollars) : null,
    medianFailureYear: diagnostics?.timing.medianYear ?? null,
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
    const { stubYear, firstFullYear } = yearBoundary(person.retirement);
    const s = snapshotForYear(projection, stubYear);
    const age = stubYear - person.birth.year;
    return {
      key: person.id,
      label: `At ${person.name}'s retirement`,
      value: s ? s.net_worth / basis(s, realDollars) : null,
      // A mid-year retirement's stub year is not a full year of it, so the
      // value shown — net worth at that year's end — needs to say which
      // year it is: the first full year (age `firstFullYear`) would be a
      // different, later figure.
      sub:
        stubYear === firstFullYear
          ? `${stubYear} · age ${age}`
          : `end of ${stubYear} · age ${age}`,
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
  /**
   * Retired, retiring, dead, or neither — death wins, since it ends the
   * rest. `retires` is the stub year a mid-year retirement falls in (the
   * same status death gets in its own stub year, `dies`); a January
   * retirement has no stub, so it is `retired` from that year on.
   */
  status: "retired" | "retires" | "dies" | "died" | null;
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
  /**
   * One-time contributions that landed this year, beside growth for the same
   * reason growth sits there: money from outside the plan never passes
   * through household cash, so it explains net worth rather than joining the
   * equation below. Empty in almost every year.
   */
  oneTime: { key: string; label: string; value: number }[];
  /** The drawdown phase in force at the start of the year, by name, or null
   * under the proportional drawdown. */
  phase: string | null;
  /** Income plus gross withdrawals: everything that reached the household. */
  moneyIn: number;
  /**
   * `moneyIn` less expenses, taxes, and contributions. Computed rather than
   * read from `surplus` so the panel visibly ties out — and because the
   * engine clamps `surplus` to zero in a depleted year, where the household
   * genuinely could not cover its outflows. The difference tells the truth
   * there; `surplus` would report a reassuring $0.
   *
   * Exactly zero within half a printed dollar of it. A drawdown that covers
   * the year leaves the two sides equal only to within float residue, and a
   * residue a hair below zero used to read as a red "Shortfall −$0".
   */
  leftOver: number;
  leftOverLabel: string;
  /** `leftOver < 0` — the plan could not fund this year, by at least a
   * printed dollar. */
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
    {
      key: "taxes",
      label: "Taxes",
      group: "out",
      value: (s.taxes - s.early_withdrawal_penalty) / d,
    },
    // Its own outflow rather than folded into taxes: it is the cost of
    // withdrawing before 59½, which the drawdown order can avoid and income
    // tax cannot. Shown only in the years there is one.
    ...(s.early_withdrawal_penalty > 0
      ? [
          {
            key: "early_withdrawal_penalty",
            label: "Early-withdrawal penalty",
            group: "out" as const,
            value: s.early_withdrawal_penalty / d,
          },
        ]
      : []),
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
  // The engine balanced these figures before handing them over: when a
  // drawdown covers the year, its gross-up converges to within ~1e-9 of the
  // need, so the two sides differ only by float residue — which can land a
  // hair below zero. Anything the panel would print as $0 is zero, so an
  // exactly covered year is neither a shortfall nor "−$0".
  const residual = moneyIn - total("out");
  const leftOver = Math.abs(residual) < HALF_A_PRINTED_DOLLAR ? 0 : residual;

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

  // Named as the engine deposited them, rather than re-resolved here from the
  // plan's dates: which year a retirement-dated sale lands in is the engine's
  // answer to give.
  const oneTime = projection.one_time
    .filter((o) => o.period === s.period)
    .map((o) => ({
      key: `one-time:${o.account}:${o.id}`,
      label: `${oneTimeName(o)} → ${plan.accounts.find((a) => a.id === o.account)?.name ?? o.account}`,
      value: o.amount / d,
    }));

  return {
    year,
    netWorth: s.net_worth / d,
    oneTime,
    ages: plan.people.map((p) => {
      const death = deathMonth(p);
      const { stubYear, firstFullYear } = yearBoundary(p.retirement);
      return {
        name: p.name,
        age: year - p.birth.year,
        status:
          year > death.year
            ? "died"
            : year === death.year
              ? "dies"
              : year >= firstFullYear
                ? "retired"
                : year === stubYear
                  ? "retires"
                  : null,
      };
    }),
    flows,
    phase: phaseName(plan, s.drawdown_phase),
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
