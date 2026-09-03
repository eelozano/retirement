import { currency, rateToPercent } from "../../lib/format";
import type { Account } from "../../types/generated/Account";
import type { Contribution } from "../../types/generated/Contribution";
import type { ContributionRule } from "../../types/generated/ContributionRule";
import type { EmployerMatch } from "../../types/generated/EmployerMatch";
import type { Plan } from "../../types/generated/Plan";
import type { PlanType } from "../../types/generated/PlanType";
import type { Presets } from "../../types/generated/Presets";
import { boundaryPhrase } from "./streamBoundary";

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
 * A new match starts as the single most common formula — 100% of the first
 * 3% — rather than empty, so switching it on produces a working plan and the
 * one-tier case needs no assembly. More tiers are added below it.
 */
export const DEFAULT_MATCH: EmployerMatch = {
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
    rule,
    start: "PlanStart",
    end: { AtRetirement: account.owner },
  };
}

/**
 * What "federal maximum" resolves to today, so the number is visible before
 * a projection runs — with the tax year it is published for. The app is
 * local-first with no network, so the figures are as current as the release
 * and the basis year says which one that is.
 */
export function federalMaximumHint(presets: Presets | null, planType: PlanType): string {
  const limits = presets?.contribution_limits;
  if (!limits || planType === "None") return "";
  switch (planType) {
    case "Ira":
      return `${currency(limits.ira)}/yr in ${limits.basis_year}, indexed for inflation and stepped up from age 50.`;
    case "Plan457b":
      return `${currency(limits.plan_457b)}/yr in ${limits.basis_year}, indexed for inflation and stepped up from age 50 — separate from a 401(k)/403(b)'s limit.`;
    case "Hsa":
      return `${currency(limits.hsa)}/yr in ${limits.basis_year} (self-only coverage), indexed for inflation and stepped up from age 55.`;
    case "SepIra":
      return `${currency(limits.sep_ira)}/yr in ${limits.basis_year}, indexed for inflation. Employer contributions only — no catch-up.`;
    case "SimpleIra":
      return `${currency(limits.simple_ira)}/yr in ${limits.basis_year}, indexed for inflation and stepped up from age 50.`;
    default:
      return `${currency(limits.employer_plan)}/yr in ${limits.basis_year}, indexed for inflation and stepped up from age 50.`;
  }
}

/** One rule in a few words — "10% of salary", "$6,000/yr", "Max". */
export function ruleSummary(rule: ContributionRule): string {
  if (rule === "FederalMaximum") return "Max";
  if ("PercentOfSalary" in rule) {
    return `${rateToPercent(rule.PercentOfSalary.percent)}% of salary`;
  }
  return `${currency(rule.FlatAmount.amount)}/yr`;
}

/**
 * What the accounts table shows in its Contributing column. Entries have no
 * names, so a single one is described by its rule and several are counted —
 * the editor below has the detail, and this column exists to answer "is
 * anything going in here?" while scanning the balance sheet.
 */
export function contributionSummary(account: Account): string {
  if (account.contributions.length === 0) return "—";
  if (account.contributions.length > 1)
    return `${account.contributions.length} schedules`;
  return ruleSummary(account.contributions[0].rule);
}

/**
 * An entry's card legend, derived rather than named: "$6,000/yr from Jan
 * 2027 until Alex retires". A name field would be one more thing to keep
 * true after the dates change.
 */
export function contributionLegend(entry: Contribution, plan: Plan): string {
  const window = `from ${boundaryPhrase(entry.start, plan)} until ${boundaryPhrase(entry.end, plan)}`;
  return `${ruleSummary(entry.rule)} ${window}`;
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
