import { balanceDivisor, flowDivisor } from "../../lib/deflate";
import { currencyCompact } from "../../lib/format";
import { realReturn } from "../../lib/returns";
import type { BacktestResult } from "../../types/generated/BacktestResult";
import type { CohortDetail } from "../../types/generated/CohortDetail";
import type { CohortStatus } from "../../types/generated/CohortStatus";
import type { CohortSummary } from "../../types/generated/CohortSummary";
import type { Plan } from "../../types/generated/Plan";
import { STRATEGIES, type StrategyKey } from "../inputs/AssumptionsSection";

// View-models for the History screen (#178): plain functions from a
// `BacktestResult` or one cohort's `CohortDetail` to what the screen draws,
// so the arithmetic is tested here and the components only lay it out.
//
// Two calendars meet on this screen. A cohort replays a *historical* year —
// 1966 — against the plan's own *calendar* year — 2026 — so every row names
// both, and nothing here calls a historical year "your" year.

/** Start years people ask about first, each with what it is remembered for. */
export const NOTABLE_ERAS: { year: number; label: string }[] = [
  { year: 1929, label: "The 1929 crash" },
  { year: 1937, label: "The 1937 relapse" },
  { year: 1966, label: "1966 stagflation" },
  { year: 1973, label: "The 1973 oil shock" },
  { year: 2000, label: "The 2000 dot-com bust" },
  { year: 2008, label: "The 2008 crisis" },
];

export interface HistoryHeadline {
  /** Succeeded over succeeded plus depleted, or null with no outcomes yet. */
  rate: number | null;
  succeeded: number;
  failed: number;
  /** Start years with an outcome: the rate's denominator. */
  decided: number;
  inProgress: number;
  firstYear: number;
  lastYear: number;
  /** The plan's length in years. */
  horizon: number;
}

export function historyHeadline(result: BacktestResult): HistoryHeadline {
  return {
    rate: result.success_rate,
    succeeded: result.succeeded,
    failed: result.depleted,
    decided: result.succeeded + result.depleted,
    inProgress: result.in_progress,
    firstYear: result.data_first_year,
    lastYear: result.data_last_year,
    horizon: result.n_periods,
  };
}

/** Years the money lasted: up to the year it ran short, or every year the
 * cohort covers. */
export function yearsLasted(cohort: CohortSummary): number {
  return cohort.status === "Depleted" && cohort.depleted_period !== null
    ? cohort.depleted_period
    : cohort.periods_covered;
}

/** Start years with an outcome, worst first: a run that ran out ranks below
 * every one that did not, and sooner below later; survivors rank by what
 * they end with, in today's dollars. In-progress years have no outcome and
 * are left out. */
export function rankedCohorts(result: BacktestResult): CohortSummary[] {
  return result.cohorts
    .filter((c) => c.status !== "InProgress")
    .slice()
    .sort((a, b) => {
      const aFailed = a.status === "Depleted";
      const bFailed = b.status === "Depleted";
      if (aFailed !== bFailed) return aFailed ? -1 : 1;
      if (aFailed) return yearsLasted(a) - yearsLasted(b) || a.start_year - b.start_year;
      return a.end_net_worth_real - b.end_net_worth_real || a.start_year - b.start_year;
    });
}

export interface Extremes {
  worst: CohortSummary;
  median: CohortSummary;
  best: CohortSummary;
}

export function extremes(result: BacktestResult): Extremes | null {
  const ranked = rankedCohorts(result);
  if (ranked.length === 0) return null;
  return {
    worst: ranked[0],
    median: ranked[Math.floor((ranked.length - 1) / 2)],
    best: ranked[ranked.length - 1],
  };
}

/** One cohort's outcome in a phrase, with ending wealth in today's dollars. */
export function outcomePhrase(cohort: CohortSummary, horizon: number): string {
  switch (cohort.status) {
    case "Depleted":
      return `Ran out after ${yearsLasted(cohort)} ${yearsLasted(cohort) === 1 ? "year" : "years"}`;
    case "InProgress":
      return `Still going after ${cohort.periods_covered} ${cohort.periods_covered === 1 ? "year" : "years"} of history · ${currencyCompact(cohort.end_net_worth_real)}`;
    default:
      return `Lasted all ${horizon} years · ends ${currencyCompact(cohort.end_net_worth_real)}`;
  }
}

export const STATUS_LABEL: Record<CohortStatus, string> = {
  Succeeded: "Lasted",
  Depleted: "Ran out",
  InProgress: "In progress",
};

export interface CohortBar {
  startYear: number;
  status: CohortStatus;
  /** Net worth in today's dollars at the end of the years the cohort covers:
   * the plan's end, or the end of the data for one still in progress. Zero
   * for one that ran out. */
  value: number;
}

export function cohortBars(result: BacktestResult): CohortBar[] {
  return result.cohorts.map((c) => ({
    startYear: c.start_year,
    status: c.status,
    value: c.status === "Depleted" ? 0 : Math.max(0, c.end_net_worth_real),
  }));
}

/** One year of a cohort's ledger. Money is in the displayed basis: flows by
 * the period's start factor, balances by its end factor — this cohort's own
 * history, not the plan's assumed inflation. */
export interface LedgerRow {
  period: number;
  historicalYear: number;
  planYear: number;
  /** "Alex 64 · Jordan 62". */
  ages: string;
  /** That historical year's CPI change, January to January. */
  inflation: number;
  stocks: number;
  bonds: number;
  /** What the household's whole portfolio earned this period, nominal;
   * null when there was nothing invested to earn it. A mid-year start's
   * first period earns only its months. */
  portfolioReturn: number | null;
  /** The same after this period's inflation. */
  portfolioRealReturn: number | null;
  income: number;
  spending: number;
  taxes: number;
  withdrawals: number;
  netWorth: number;
  /** The plan could not cover this year's spending, or any after it. */
  shortfall: boolean;
}

export function cohortLedgerRows(
  plan: Plan,
  detail: CohortDetail,
  realDollars: boolean,
): LedgerRow[] {
  return detail.projection.snapshots.map((s, period) => {
    const market = detail.market[period];
    const d = flowDivisor(s, realDollars);
    const dEnd = balanceDivisor(s, realDollars);
    const invested = s.net_worth - s.growth;
    const portfolioReturn = invested > 0 ? s.growth / invested : null;
    const periodInflation = s.deflator_end / s.deflator - 1;
    const planYear = s.period_start.year;
    return {
      period,
      historicalYear: market?.historical_year ?? NaN,
      planYear,
      ages: plan.people.map((p) => `${p.name} ${planYear - p.birth.year}`).join(" · "),
      inflation: market?.inflation ?? NaN,
      stocks: market?.stocks ?? NaN,
      bonds: market?.bonds ?? NaN,
      portfolioReturn,
      portfolioRealReturn:
        portfolioReturn === null ? null : realReturn(portfolioReturn, periodInflation),
      income: s.income / d,
      spending: s.expenses / d,
      taxes: s.taxes / d,
      withdrawals:
        Object.values(s.withdrawals).reduce<number>((sum, v) => sum + (v ?? 0), 0) / d,
      netWorth: s.net_worth / dEnd,
      shortfall: detail.depleted_period !== null && period >= detail.depleted_period,
    };
  });
}

/** The ledger's headline: how this start year went, in the plan's own years. */
export function cohortVerdict(
  plan: Plan,
  detail: CohortDetail,
  horizon: number,
  realDollars: boolean,
): string {
  const snapshots = detail.projection.snapshots;
  const last = snapshots[snapshots.length - 1];
  const ending = last
    ? currencyCompact(last.net_worth / balanceDivisor(last, realDollars))
    : "";
  const basis = realDollars ? "today's dollars" : "nominal dollars";
  if (detail.status === "Depleted" && detail.depleted_period !== null) {
    const year = snapshots[detail.depleted_period]?.period_start.year;
    const ages = plan.people
      .map((p) => `${p.name} ${(year ?? 0) - p.birth.year}`)
      .join(", ");
    return `Starting in ${detail.start_year}, the money runs out in ${year} (${ages}), ${detail.depleted_period} ${detail.depleted_period === 1 ? "year" : "years"} in.`;
  }
  if (detail.status === "InProgress") {
    return `Starting in ${detail.start_year}, history has only ${detail.periods_covered} of the plan's ${horizon} years so far, and the money is still going: ${ending} in ${basis} at the end of ${detail.market[detail.market.length - 1]?.historical_year}.`;
  }
  return `Starting in ${detail.start_year}, the money lasts all ${horizon} years and ends at ${ending} in ${basis}.`;
}

/** The named strategy holding the most money, or null when every account is
 * on a fixed rate. It is the one whose typed return the screen compares
 * with history. */
export function dominantStrategy(plan: Plan): StrategyKey | null {
  const totals = new Map<StrategyKey, number>();
  for (const account of plan.accounts) {
    const strategy = STRATEGIES.find((s) => s.variant === account.allocation);
    if (strategy)
      totals.set(strategy.key, (totals.get(strategy.key) ?? 0) + account.balance);
  }
  let best: StrategyKey | null = null;
  for (const [key, total] of totals) {
    if (best === null || total > (totals.get(best) ?? 0)) best = key;
  }
  return best;
}

export interface ForecastGap {
  strategy: StrategyKey;
  strategyLabel: string;
  /** What the strategy's mix compounded at after inflation over the record. */
  historicalReal: number;
  /** The plan's typed return for it, after the plan's assumed inflation. */
  typedReal: number;
}

/** Why the historical rate and the Monte Carlo rate disagree, in the one
 * figure that explains most of it: what history paid against what the plan
 * expects, for the strategy holding the most money. */
export function forecastGap(plan: Plan, result: BacktestResult): ForecastGap | null {
  const key = dominantStrategy(plan);
  if (!key) return null;
  const strategy = STRATEGIES.find((s) => s.key === key);
  return {
    strategy: key,
    strategyLabel: strategy?.label ?? key,
    historicalReal: result.historical_real_return[key],
    typedReal: realReturn(
      plan.assumptions.strategy_returns[key],
      plan.assumptions.inflation,
    ),
  };
}

function csvField(value: string | number | null): string {
  if (value === null || (typeof value === "number" && Number.isNaN(value))) return "";
  const s = typeof value === "number" ? String(Math.round(value * 1e6) / 1e6) : value;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The ledger as CSV: rates as decimals, money in the displayed basis. */
export function ledgerCsv(
  plan: Plan,
  detail: CohortDetail,
  realDollars: boolean,
): string {
  const rows = cohortLedgerRows(plan, detail, realDollars);
  const lines = [
    "# Retirement Planner historical backtest",
    `# Plan: ${plan.name}`,
    `# Start year: ${detail.start_year} (${STATUS_LABEL[detail.status]})`,
    `# Basis: ${realDollars ? "Today's dollars (deflated by this start year's own CPI)" : "Nominal dollars"}`,
    "Historical year,Plan year,Ages,Inflation,Stocks,Bonds,Portfolio return,Portfolio real return,Income,Spending,Taxes,Withdrawals,Net worth,Shortfall",
    ...rows.map((r) =>
      [
        r.historicalYear,
        r.planYear,
        r.ages,
        r.inflation,
        r.stocks,
        r.bonds,
        r.portfolioReturn,
        r.portfolioRealReturn,
        Math.round(r.income * 100) / 100,
        Math.round(r.spending * 100) / 100,
        Math.round(r.taxes * 100) / 100,
        Math.round(r.withdrawals * 100) / 100,
        Math.round(r.netWorth * 100) / 100,
        r.shortfall ? "yes" : "",
      ]
        .map(csvField)
        .join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
}
