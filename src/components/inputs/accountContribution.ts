import { currency, rateToPercent, yearMonth } from "../../lib/format";
import type { Account } from "../../types/generated/Account";
import type { Contribution } from "../../types/generated/Contribution";
import type { ContributionRule } from "../../types/generated/ContributionRule";
import type { EmployerMatch } from "../../types/generated/EmployerMatch";
import type { OneTimeContribution } from "../../types/generated/OneTimeContribution";
import type { Plan } from "../../types/generated/Plan";
import type { PlanType } from "../../types/generated/PlanType";
import type { Presets } from "../../types/generated/Presets";
import type { StreamBoundary } from "../../types/generated/StreamBoundary";
import type { YearMonth } from "../../types/generated/YearMonth";
import { boundaryPhrase, boundaryResolvedDate } from "./streamBoundary";

// The contribution vocabulary — modes, rules, and the prose an unnamed
// entry describes itself with. It is a property of the account's
// `plan_type`, so it lives beside the account editor that uses it
// (AccountsSection and its ContributionCard) rather than inside either.

export const CONTRIBUTION_MODES = [
  { value: "PercentOfSalary", label: "Percent of salary" },
  { value: "FlatAmount", label: "Flat amount" },
  { value: "FederalMaximum", label: "Federal maximum" },
] as const;

export type ContributionMode = (typeof CONTRIBUTION_MODES)[number]["value"];

export const MATCH_DESTINATIONS = [
  { value: "PreTax", label: "Pre-tax" },
  { value: "Roth", label: "Roth" },
] as const;

/**
 * A new employer band starts as the single most common formula — 100% of
 * the first 3% — rather than empty, so switching it on produces a working
 * plan and the one-tier case needs no assembly. More tiers are added below
 * it, and the non-elective percent starts at zero: a plan that pays on
 * salary alone is entered by typing that figure and removing the tier.
 */
export const DEFAULT_MATCH: EmployerMatch = {
  nonelective_percent: 0,
  tiers: [{ employee_percent: 0.03, match_percent: 1.0 }],
  destination: "PreTax",
};

export function contributionMode(rule: ContributionRule): ContributionMode {
  if (rule === "FederalMaximum") return "FederalMaximum";
  return "PercentOfSalary" in rule ? "PercentOfSalary" : "FlatAmount";
}

/**
 * The mode's own default when the user switches to it. Switching starts each
 * mode from zero rather than trying to convert — a percentage and a dollar
 * figure are not the same input, and a silently converted number would look
 * like a value the user had entered.
 */
export function ruleForMode(mode: ContributionMode): ContributionRule {
  if (mode === "FederalMaximum") return "FederalMaximum";
  return mode === "PercentOfSalary"
    ? { PercentOfSalary: { percent: 0, step_up: null } }
    : { FlatAmount: { amount: 0, growth: "None" } };
}

/**
 * A flat amount that neither escalates nor grows — what an account starts
 * with, and what a newly added entry reads as. Escalation (#79) is off
 * until the user turns it on, and its controls arrive with #81.
 */
export const NO_CONTRIBUTION: ContributionRule = {
  FlatAmount: { amount: 0, growth: "None" },
};

/**
 * The entry every account starts with, and what an undated plan migrated
 * to: `rule` from plan start until the owner retires. The id only has to be
 * distinct within the account.
 */
export function defaultContribution(
  account: Pick<Account, "id" | "owner">,
  rule: ContributionRule = NO_CONTRIBUTION,
): Contribution {
  return {
    id: `${account.id}-contribution`,
    name: "",
    rule,
    start: "PlanStart",
    end: { AtRetirement: account.owner },
  };
}

/**
 * What "federal maximum" resolves to today, so the number is visible before
 * a projection runs — with the tax year it is published for. The figures are
 * the user's own `tax-figures.yaml`, as loaded by `get_presets`: the app has no
 * network, so they are as current as the user last made them, and the tax
 * year says which one that is.
 */
export function federalMaximumHint(presets: Presets | null, planType: PlanType): string {
  const limits = presets?.tax_figures.contribution_limits;
  const year = presets?.tax_figures.tax_year;
  if (!limits || planType === "None") return "";
  switch (planType) {
    case "Ira":
      return `${currency(limits.ira)}/yr in ${year}, indexed for inflation and stepped up from age 50.`;
    case "Plan457b":
      return `${currency(limits.plan_457b)}/yr in ${year}, indexed for inflation and stepped up from age 50 — separate from a 401(k)/403(b)'s limit.`;
    case "Hsa":
      return `${currency(limits.hsa)}/yr in ${year} (self-only coverage), indexed for inflation and stepped up from age 55.`;
    case "SepIra":
      return `${currency(limits.sep_ira)}/yr in ${year}, indexed for inflation. Employer contributions only — no catch-up.`;
    case "SimpleIra":
      return `${currency(limits.simple_ira)}/yr in ${year}, indexed for inflation and stepped up from age 50.`;
    default:
      return `${currency(limits.employer_plan)}/yr in ${year}, indexed for inflation and stepped up from age 50.`;
  }
}

/**
 * One rule in a few words — "10% of salary", "$6,000/yr", "Max", and with
 * an escalation riding along: "10% → 15% of salary", "$6,000/yr,
 * +inflation".
 */
export function ruleSummary(rule: ContributionRule): string {
  if (rule === "FederalMaximum") return "Max";
  if ("PercentOfSalary" in rule) {
    const { percent, step_up } = rule.PercentOfSalary;
    const base = `${rateToPercent(percent)}% of salary`;
    return step_up
      ? `${rateToPercent(percent)}% → ${rateToPercent(step_up.cap)}% of salary`
      : base;
  }
  const { amount, growth } = rule.FlatAmount;
  const base = `${currency(amount)}/yr`;
  return growth === "Inflation" ? `${base}, +inflation` : base;
}

/**
 * What the accounts table shows in its Contributing column. A single
 * recurring entry is described by its rule and several are counted, and a
 * one-time entry is named: "$6,000/yr + House sale". The editor below has
 * the detail; this column exists to answer "is anything going in here?"
 * while scanning the balance sheet.
 */
export function contributionSummary(account: Account): string {
  const { contributions, one_time_contributions: oneTime } = account;
  const parts: string[] = [];
  if (contributions.length === 1) parts.push(ruleSummary(contributions[0].rule));
  else if (contributions.length > 1) parts.push(`${contributions.length} schedules`);
  if (oneTime.length === 1) parts.push(oneTimeName(oneTime[0]));
  else if (oneTime.length > 1) parts.push(`${oneTime.length} one-time`);
  return parts.length > 0 ? parts.join(" + ") : "—";
}

/**
 * An entry's card legend: "$6,000/yr from Jan 2027 until Alex retires", led
 * by the entry's name when it has one — "Car paid off · $8,400/yr from …".
 * The derived part is always there, so a name only adds what the entry is
 * for, and moving its dates cannot make the legend wrong.
 */
export function contributionLegend(entry: Contribution, plan: Plan): string {
  const window = `from ${boundaryPhrase(entry.start, plan)} until ${boundaryPhrase(entry.end, plan)}`;
  const described = `${ruleSummary(entry.rule)} ${window}`;
  const name = entry.name.trim();
  return name ? `${name} · ${described}` : described;
}

/**
 * Whether an account can take money from outside the plan: only a brokerage
 * or a savings account, since every other kind caps what can go in each
 * year. Mirrors the destination rule in `engine::model::validation`.
 */
export function takesOutsideMoney(account: Pick<Account, "kind">): boolean {
  return account.kind === "Taxable" || account.kind === "Savings";
}

/**
 * A new one-time entry: nothing yet, in today's dollars, landing in January
 * of the year after the plan starts. Today's dollars because a sale years
 * off is estimated from what it would fetch now.
 */
export function newOneTimeContribution(plan: Plan): OneTimeContribution {
  return {
    id: `one-time-${Date.now()}`,
    name: "",
    amount: 0,
    growth: "Inflation",
    date: { Date: { year: plan.sim_config.start.year + 1, month: 1 } },
  };
}

/** A one-time entry's name, or what to call it until it has one. */
export function oneTimeName(entry: Pick<OneTimeContribution, "name">): string {
  return entry.name.trim() || "One-time contribution";
}

/** "in Jun 2031", "when Alex retires (Apr 2042)". */
function landingPhrase(date: StreamBoundary, plan: Plan): string {
  const phrase = boundaryPhrase(date, plan);
  if (typeof date !== "object") return `at ${phrase}`;
  return "Date" in date ? `in ${phrase}` : `when ${phrase}`;
}

/**
 * A one-time entry's card legend: "House sale · $350,000 in today's dollars
 * when Alex retires (Apr 2042)". It leads with the name, because nothing
 * else about a lump sum says why it is there, and it says when an amount is
 * in today's dollars, since that figure lands as a larger nominal one.
 */
export function oneTimeLegend(entry: OneTimeContribution, plan: Plan): string {
  const basis = entry.growth === "Inflation" ? " in today's dollars" : "";
  return `${oneTimeName(entry)} · ${currency(entry.amount)}${basis} ${landingPhrase(entry.date, plan)}`;
}

/**
 * The month a one-time entry lands: its date, or the retirement or death it
 * is tied to. `undefined` for the plan's own start or end, which validation
 * refuses, and for a person no longer in the plan.
 */
export function oneTimeMonth(
  entry: Pick<OneTimeContribution, "date">,
  plan: Plan,
): YearMonth | undefined {
  if (typeof entry.date === "object" && "Date" in entry.date) return entry.date.Date;
  return boundaryResolvedDate(entry.date, plan);
}

/**
 * Why a one-time entry won't be counted, or null when it will be. Its month
 * falls before the projection starts — which is where a sale ends up once
 * the balances holding it are refreshed — or at or after the last death,
 * where the projection ends. The same window `simulate` deposits within.
 */
export function oneTimeNotCounted(entry: OneTimeContribution, plan: Plan): string | null {
  const month = oneTimeMonth(entry, plan);
  if (!month) return null;
  const index = (m: YearMonth) => m.year * 12 + (m.month - 1);
  const start = plan.sim_config.start;
  if (index(month) < index(start)) {
    return `${yearMonth(month)} is before the projection starts in ${yearMonth(start)}, so this isn't counted. If the money has already arrived, it belongs in the balance; if not, move its date.`;
  }
  const horizon = Math.max(
    ...plan.people.map((p) =>
      index({ year: p.birth.year + p.life_expectancy_age, month: p.birth.month }),
    ),
  );
  if (plan.people.length > 0 && index(month) >= horizon) {
    return `${yearMonth(month)} is after the projection ends, so this isn't counted.`;
  }
  return null;
}

/**
 * What the entry's end date is allowed to be, in the account's own terms.
 * Employer plans are fed by an employer's paycheck, so validation rejects an
 * entry that outlives the owner's retirement; an IRA or HSA is deliberately
 * left free, and the hint says so before the error would.
 */
export function contributionEndHint(planType: PlanType): string | undefined {
  switch (planType) {
    case "EmployerPlan":
    case "Plan457b":
    case "SimpleIra":
    case "SepIra":
      return "Money into an employer's plan comes out of that employer's paycheck, so this can't run past the owner's retirement.";
    case "Ira":
    case "Hsa":
      return "This one may run past retirement — a spousal IRA on a working partner's income, or an HSA under HDHP coverage.";
    default:
      return undefined;
  }
}
