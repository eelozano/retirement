import { currency } from "../../lib/format";
import type { ContributionRule } from "../../types/generated/ContributionRule";
import type { EmployerMatch } from "../../types/generated/EmployerMatch";
import type { PlanType } from "../../types/generated/PlanType";
import type { Presets } from "../../types/generated/Presets";

// Shared between AccountsSection (which no longer edits contributions) and
// the People pane's Saving band (which does) — an account's contribution is
// part of the paycheck story, so it moved, but the mode/rule vocabulary is
// still a property of the account's `plan_type`.

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
  return mode === "PercentOfSalary" ? { PercentOfSalary: 0 } : { FlatAmount: 0 };
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
