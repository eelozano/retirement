import type { AccountKind } from "../../types/generated/AccountKind";
import type { PlanType } from "../../types/generated/PlanType";

/**
 * The account types a user actually holds, each mapped to the engine's two
 * orthogonal fields: `kind` (tax treatment) and `planType` (statutory
 * contribution-limit bucket). Real names that share both fields are combined
 * into one row rather than listed separately — a 401(k) and a 403(b) are
 * taxed the same way and capped by the same statute — but every name they
 * stand for is still named in the description, so picking the right one
 * doesn't require knowing that they're the same thing under the hood.
 */
export const ACCOUNT_TYPES = [
  {
    value: "taxable",
    label: "Taxable brokerage",
    kind: "Taxable",
    planType: "None",
    description:
      "A standard investment account with no tax advantages. Gains are taxed when sold; growth follows the market allocation below.",
  },
  {
    value: "savings",
    label: "Savings",
    kind: "Savings",
    planType: "None",
    description:
      "Cash savings — a bank savings or money-market account. Grows at its own configured interest rate instead of a market allocation; interest is taxed as ordinary income.",
  },
  {
    value: "traditional_ira",
    label: "Traditional IRA",
    kind: "TraditionalPreTax",
    planType: "Ira",
    description:
      "Individual retirement account funded pre-tax (or tax-deductible); withdrawals are taxed as ordinary income. Shares one contribution limit with a Roth IRA.",
  },
  {
    value: "roth_ira",
    label: "Roth IRA",
    kind: "Roth",
    planType: "Ira",
    description:
      "Individual retirement account funded after-tax; qualified withdrawals are tax-free. Shares one contribution limit with a Traditional IRA.",
  },
  {
    value: "employer_pretax",
    label: "401(k) / 403(b) / 401(a)",
    kind: "TraditionalPreTax",
    planType: "EmployerPlan",
    description:
      "Employer-sponsored retirement plan funded pre-tax from your paycheck. Covers a 401(k), a 403(b) (schools, hospitals, and other nonprofits), and a 401(a) (common for government employers, often mandatory contributions — real 401(a) rules vary by employer and are approximated here as a standard employer plan).",
  },
  {
    value: "employer_roth",
    label: "Roth 401(k) / Roth 403(b)",
    kind: "Roth",
    planType: "EmployerPlan",
    description:
      "Employer-sponsored plan funded after-tax; qualified withdrawals are tax-free. Shares one contribution limit with a Traditional 401(k)/403(b)/401(a).",
  },
  {
    value: "plan_457b",
    label: "457(b)",
    kind: "TraditionalPreTax",
    planType: "Plan457b",
    description:
      "Deferred-compensation plan for state/local government and certain nonprofit employees. Has its own contribution limit, separate from a 401(k) or 403(b) — you can max out both in the same year.",
  },
  {
    value: "roth_457b",
    label: "Roth 457(b)",
    kind: "Roth",
    planType: "Plan457b",
    description:
      "After-tax version of a 457(b); qualified withdrawals are tax-free. Shares its contribution limit with a Traditional 457(b).",
  },
  {
    value: "sep_ira",
    label: "SEP-IRA",
    kind: "TraditionalPreTax",
    planType: "SepIra",
    description:
      "Simplified Employee Pension, for self-employed people and small-business owners. Employer contributions only, with a much higher limit than a regular IRA.",
  },
  {
    value: "simple_ira",
    label: "SIMPLE IRA",
    kind: "TraditionalPreTax",
    planType: "SimpleIra",
    description:
      "Savings Incentive Match Plan, for small businesses. Its own contribution limit, separate from a regular IRA or a 401(k).",
  },
  {
    value: "hsa",
    label: "HSA",
    kind: "Hsa",
    planType: "Hsa",
    description:
      "Health Savings Account. Contributions are pre-tax and withdrawals are tax-free (assuming they cover qualified medical expenses) — its own contribution limit, with catch-up starting at 55.",
  },
] as const satisfies readonly {
  value: string;
  label: string;
  kind: AccountKind;
  planType: PlanType;
  description: string;
}[];

export type AccountTypeValue = (typeof ACCOUNT_TYPES)[number]["value"];

/** Every row offered in the picker, `{ value, label }` only. */
export const ACCOUNT_TYPE_OPTIONS = ACCOUNT_TYPES.map(({ value, label }) => ({
  value,
  label,
}));

/**
 * The catalog row matching an account's current `(kind, plan_type)` pair, if
 * one exists — an account read from an older plan file, or one whose plan
 * type was hand-picked away from a preset combination, may not match any
 * row exactly.
 */
export function accountTypeFor(kind: AccountKind, planType: PlanType) {
  return ACCOUNT_TYPES.find((t) => t.kind === kind && t.planType === planType);
}

export function accountTypeByValue(value: string) {
  return ACCOUNT_TYPES.find((t) => t.value === value);
}
