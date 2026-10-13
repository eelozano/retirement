import {
  FILING_STATUS_OPTIONS,
  STATE_LABELS,
  STRATEGIES,
} from "../components/inputs/AssumptionsSection";
import { landingPhrase, oneTimeName } from "../components/inputs/accountContribution";
import { boundaryPhrase } from "../components/inputs/streamBoundary";
import type { Account } from "../types/generated/Account";
import type { Assumptions } from "../types/generated/Assumptions";
import type { CashFlowStream } from "../types/generated/CashFlowStream";
import type { Contribution } from "../types/generated/Contribution";
import type { ContributionRule } from "../types/generated/ContributionRule";
import type { DrawdownPhase } from "../types/generated/DrawdownPhase";
import type { DrawdownPolicy } from "../types/generated/DrawdownPolicy";
import type { EmployerMatch } from "../types/generated/EmployerMatch";
import type { GrowthRule } from "../types/generated/GrowthRule";
import type { OneTimeContribution } from "../types/generated/OneTimeContribution";
import type { Person } from "../types/generated/Person";
import type { Plan } from "../types/generated/Plan";
import type { SimConfig } from "../types/generated/SimConfig";
import type { SocialSecurityBenefit } from "../types/generated/SocialSecurityBenefit";
import type { StrategyRates } from "../types/generated/StrategyRates";
import { sourceLabel } from "./drawdown";
import { currency, ratePercent, yearMonth } from "./format";

// What one scenario changes relative to another of the same household
// (#191), in words. Since #109 the two share every fact — balances, birth
// months, allocations, the as-of month — so diffing the two composed plans
// can only turn up policy, and nothing here has to tell a real difference
// from a household quirk.
//
// Every field of every type a plan is made of is classified below, in a
// table typed over the type's keys: a fact the household owns, something
// that is not a modelling choice at all, or a setting with a label and a
// way to say its value. A field added to the Rust model therefore fails
// `tsc` here until it has been given one, the way `decompose` refuses to
// compile until a new `Plan` field has a side.

/** One difference between a scenario and the one it is compared with. */
export interface ScenarioChange {
  /** What changed, in a few words — "Alex's retirement", "House sale
   * removed". The summary line is made of these. */
  what: string;
  /** This scenario's value, or null for something it removed. */
  now: string | null;
  /** The compared scenario's value, or null for something this one added. */
  was: string | null;
}

/** A field the household owns. Identical across a household's scenarios by
 * construction, so never compared. */
const FACT = "fact";
/** Identity, bookkeeping or display — not a choice that moves the projection. */
const NOT_POLICY = "not policy";
/** A policy field compared by a dedicated pass rather than one label. */
const OWN_PASS = "own pass";

type Setting<V> = { label: string; describe: (value: V, plan: Plan) => string };
type Field<V> = typeof FACT | typeof NOT_POLICY | typeof OWN_PASS | Setting<V>;
type Fields<T> = { [K in keyof T]-?: Field<T[K]> };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The legends below destructure every field they describe and pass the rest
 * here, so a field added to the type is a `tsc` error until a legend says it. */
function noOtherFields(_rest: Record<string, never>): void {}

/** Changes to the labelled settings of one entity, each named `prefix` +
 * its label. */
function settingChanges<T>(
  fields: Fields<T>,
  was: T,
  now: T,
  wasPlan: Plan,
  nowPlan: Plan,
  prefix: string,
): ScenarioChange[] {
  const changes: ScenarioChange[] = [];
  for (const key of Object.keys(fields) as (keyof T)[]) {
    const field = fields[key] as Field<T[keyof T]>;
    if (typeof field === "string" || same(was[key], now[key])) continue;
    changes.push({
      what: `${prefix}${field.label}`,
      now: field.describe(now[key], nowPlan),
      was: field.describe(was[key], wasPlan),
    });
  }
  return changes;
}

/** Changes to a list whose entries carry ids: an entry only one side has
 * is added or removed, and one both have is changed when anything about it
 * differs — matched by id, so removing the first entry does not read as
 * every later one changing. */
function entryChanges<E extends { id: string }>(
  was: readonly E[],
  now: readonly E[],
  name: (entry: E) => string,
  legend: (entry: E, plan: Plan) => string,
  wasPlan: Plan,
  nowPlan: Plan,
): ScenarioChange[] {
  const changes: ScenarioChange[] = [];
  for (const entry of now) {
    const before = was.find((e) => e.id === entry.id);
    if (!before) {
      changes.push({
        what: `${name(entry)} added`,
        now: legend(entry, nowPlan),
        was: null,
      });
    } else if (!same(before, entry)) {
      const nowLegend = legend(entry, nowPlan);
      const wasLegend = legend(before, wasPlan);
      // The legends cover every field but the name, so equal legends mean
      // only the name moved.
      changes.push(
        nowLegend === wasLegend
          ? { what: `${name(before)} renamed`, now: name(entry), was: name(before) }
          : { what: name(entry), now: nowLegend, was: wasLegend },
      );
    }
  }
  for (const entry of was) {
    if (!now.some((e) => e.id === entry.id)) {
      changes.push({
        what: `${name(entry)} removed`,
        now: null,
        was: legend(entry, wasPlan),
      });
    }
  }
  return changes;
}

const personName = (plan: Plan, id: string | null) =>
  plan.people.find((p) => p.id === id)?.name || "Someone";

/** "+inflation", "+3.0%/yr", "flat". */
function growthPhrase(growth: GrowthRule): string {
  if (growth === "Inflation") return "+inflation";
  if (growth === "None") return "flat";
  return `+${ratePercent(growth.Fixed)}/yr`;
}

/** A contribution rule in full: "10% of salary, +1 pt/yr to 15%",
 * "$6,000/yr, +inflation", "the federal maximum". */
function ruleDetail(rule: ContributionRule): string {
  if (rule === "FederalMaximum") return "the federal maximum";
  if ("PercentOfSalary" in rule) {
    const { percent, step_up } = rule.PercentOfSalary;
    const base = `${ratePercent(percent)} of salary`;
    if (!step_up) return base;
    const points = Math.round(step_up.points_per_year * 1000) / 10;
    return `${base}, +${points} pt/yr to ${ratePercent(step_up.cap)}`;
  }
  const { amount, growth } = rule.FlatAmount;
  return `${currency(amount)}/yr, ${growthPhrase(growth)}`;
}

function contributionLegend(entry: Contribution, plan: Plan): string {
  const { id: _id, name: _name, rule, start, end, ...rest } = entry;
  noOtherFields(rest);
  return `${ruleDetail(rule)} from ${boundaryPhrase(start, plan)} until ${boundaryPhrase(end, plan)}`;
}

function oneTimeLegend(entry: OneTimeContribution, plan: Plan): string {
  const { id: _id, name: _name, amount, growth, date, ...rest } = entry;
  noOtherFields(rest);
  const basis =
    growth === "Inflation"
      ? " in today's dollars"
      : growth === "None"
        ? ""
        : `, ${growthPhrase(growth)}`;
  return `${currency(amount)}${basis} ${landingPhrase(date, plan)}`;
}

function streamLegend(stream: CashFlowStream, plan: Plan): string {
  const {
    id: _id,
    name: _name,
    owner,
    direction,
    annual_amount,
    start,
    end,
    growth,
    survivor_percentage,
    kind,
    ...rest
  } = stream;
  noOtherFields(rest);
  const what =
    kind === "Pension" ? "pension" : direction === "Income" ? "income" : "spending";
  const whose = owner ? `${personName(plan, owner)}'s ` : "";
  const survivor =
    survivor_percentage === null
      ? ""
      : `, ${ratePercent(survivor_percentage, 0)} to the survivor`;
  return `${currency(annual_amount)}/yr ${whose}${what} from ${boundaryPhrase(start, plan)} until ${boundaryPhrase(end, plan)}, ${growthPhrase(growth)}${survivor}`;
}

function matchLegend(match: EmployerMatch | null, plan: Plan): string {
  if (!match) return "none";
  const { nonelective_percent, tiers, destination, deposit_into, ...rest } = match;
  noOtherFields(rest);
  const parts = tiers.map(
    (t, i) =>
      `${ratePercent(t.match_percent, 0)} of the ${i === 0 ? "first" : "next"} ${ratePercent(t.employee_percent)}`,
  );
  if (nonelective_percent > 0)
    parts.push(`${ratePercent(nonelective_percent)} of salary`);
  const described = parts.length > 0 ? parts.join(", ") : "nothing";
  const roth = destination === "Roth" ? ", as Roth" : "";
  const into = deposit_into
    ? `, into ${plan.accounts.find((a) => a.id === deposit_into)?.name || "a missing account"}`
    : "";
  return `${described}${roth}${into}`;
}

function phaseLegend(phase: DrawdownPhase, plan: Plan): string {
  const { id: _id, name: _name, start, rule, stack, ...rest } = phase;
  noOtherFields(rest);
  const from =
    "PenaltyFree" in start
      ? `when ${personName(plan, start.PenaltyFree)}'s accounts are penalty-free`
      : `from ${boundaryPhrase(start.Boundary, plan)}`;
  const order = stack
    .map((e) =>
      e.floor > 0
        ? `${sourceLabel(plan, e.source)} (keep ${currency(e.floor)})`
        : sourceLabel(plan, e.source),
    )
    .join(" → ");
  const how =
    rule === "Stack"
      ? `draws ${order || "every account"}`
      : `holds MAGI near ${currency(rule.MagiTarget.target)}, then ${order || "every account"}`;
  return `${from}, ${how}`;
}

function drawdownLegend(policy: DrawdownPolicy): string {
  if (policy === "Proportional") return "proportional to balances";
  return policy.Phased.map((p) => p.name || "Unnamed phase").join(" → ");
}

const PERSON_FIELDS: Fields<Person> = {
  id: NOT_POLICY,
  name: FACT,
  birth: FACT,
  retirement: { label: "retirement", describe: (v) => yearMonth(v) },
  life_expectancy_age: { label: "life expectancy", describe: (v) => `age ${v}` },
};

const ACCOUNT_FIELDS: Fields<Account> = {
  id: NOT_POLICY,
  owner: FACT,
  kind: FACT,
  name: FACT,
  balance: FACT,
  cost_basis: FACT,
  allocation: FACT,
  plan_type: FACT,
  contributions: OWN_PASS,
  one_time_contributions: OWN_PASS,
  employer_match: { label: "employer contribution", describe: matchLegend },
  rule_of_55: {
    label: "Rule of 55",
    describe: (v) => (v ? "elected" : "not elected"),
  },
};

const BENEFIT_FIELDS: Fields<SocialSecurityBenefit> = {
  id: NOT_POLICY,
  owner: FACT,
  benefit_at_fra: FACT,
  full_retirement_age: FACT,
  claiming_age: { label: "Social Security claiming age", describe: (v) => `age ${v}` },
  cola_override: {
    label: "Social Security COLA",
    describe: (v) => (v === null ? "the plan's default" : ratePercent(v)),
  },
};

const ASSUMPTION_FIELDS: Fields<Assumptions> = {
  inflation: { label: "Inflation", describe: (v) => ratePercent(v) },
  strategy_returns: OWN_PASS,
  strategy_volatility: OWN_PASS,
  filing_status: {
    label: "Filing status",
    describe: (v) => FILING_STATUS_OPTIONS.find((o) => o.value === v)?.label ?? v,
  },
  state_tax: {
    label: "State tax",
    describe: (v) => {
      const top = Math.max(0, ...v.brackets.map((b) => b.rate));
      return `${STATE_LABELS[v.state]}: top rate ${ratePercent(top)}, ${currency(v.standard_deduction)} deduction`;
    },
  },
  // Superseded by each person's life expectancy (#28) and read only when an
  // old file is migrated, so a difference here moves nothing.
  plan_end_age: NOT_POLICY,
  sweep_surplus_from: {
    label: "Surplus reinvested",
    describe: (v, plan) => (v === null ? "never" : `from ${boundaryPhrase(v, plan)}`),
  },
  survivor_expense_factor: {
    label: "Survivor spending",
    describe: (v) => `${ratePercent(v, 0)} of household spending`,
  },
  social_security_cola: {
    label: "Social Security COLA",
    describe: (v) => ratePercent(v),
  },
  social_security_reduction: {
    label: "Social Security cut",
    describe: (v) =>
      v === null
        ? "none"
        : `${ratePercent(v.payable_fraction, 0)} payable from ${yearMonth(v.from)}`,
  },
  reinvest_into: {
    label: "Reinvestment account",
    describe: (v, plan) =>
      v === null
        ? "the first taxable account"
        : plan.accounts.find((a) => a.id === v)?.name || "a missing account",
  },
  drawdown: OWN_PASS,
  dividend_yield: { label: "Dividend yield", describe: (v) => ratePercent(v) },
};

const SIM_CONFIG_FIELDS: Fields<SimConfig> = {
  // The household's as-of month, which every scenario composes its start from.
  start: FACT,
  period: FACT,
  // How the charts open, not what they show.
  display_real_dollars: NOT_POLICY,
};

/** Every top-level part of a plan. Here only for `tsc`: each `OWN_PASS` has
 * a pass in `scenarioChanges`. */
const PLAN_FIELDS: Fields<Plan> = {
  id: NOT_POLICY,
  schema_version: NOT_POLICY,
  name: NOT_POLICY,
  sample: FACT,
  people: OWN_PASS,
  accounts: OWN_PASS,
  streams: OWN_PASS,
  social_security: OWN_PASS,
  assumptions: OWN_PASS,
  sim_config: OWN_PASS,
};
void PLAN_FIELDS;

function strategyChanges(
  was: StrategyRates,
  now: StrategyRates,
  noun: string,
): ScenarioChange[] {
  return STRATEGIES.filter((s) => was[s.key] !== now[s.key]).map((s) => ({
    what: `${s.label} ${noun}`,
    now: ratePercent(now[s.key]),
    was: ratePercent(was[s.key]),
  }));
}

function drawdownChanges(
  was: DrawdownPolicy,
  now: DrawdownPolicy,
  wasPlan: Plan,
  nowPlan: Plan,
): ScenarioChange[] {
  if (same(was, now)) return [];
  if (was === "Proportional" || now === "Proportional") {
    return [
      {
        what: "Withdrawal order",
        now: drawdownLegend(now),
        was: drawdownLegend(was),
      },
    ];
  }
  const name = (p: DrawdownPhase) => `Withdrawal phase “${p.name || "Unnamed"}”`;
  const changes = entryChanges(
    was.Phased,
    now.Phased,
    name,
    phaseLegend,
    wasPlan,
    nowPlan,
  );
  // The same phases in a different order change which one is in force when.
  const order = (phases: DrawdownPhase[]) => phases.map((p) => p.id).join();
  const kept = (a: DrawdownPhase[], b: DrawdownPhase[]) =>
    a.filter((p) => b.some((q) => q.id === p.id));
  if (order(kept(was.Phased, now.Phased)) !== order(kept(now.Phased, was.Phased))) {
    changes.push({
      what: "Withdrawal phase order",
      now: drawdownLegend(now),
      was: drawdownLegend(was),
    });
  }
  return changes;
}

/**
 * Everything `scenario` changes relative to `reference`, another scenario of
 * the same household: people, Social Security, cash flows, accounts, then
 * assumptions. Empty when the two would project the same.
 */
export function scenarioChanges(reference: Plan, scenario: Plan): ScenarioChange[] {
  const changes: ScenarioChange[] = [];
  const was = reference;
  const now = scenario;

  // A household's scenarios have the same people, accounts and benefits —
  // saving one fills the others in — so these match one-for-one by id.
  for (const person of now.people) {
    const before = was.people.find((p) => p.id === person.id);
    if (!before) continue;
    changes.push(
      ...settingChanges(PERSON_FIELDS, before, person, was, now, `${person.name}'s `),
    );
  }

  for (const benefit of now.social_security) {
    const before = was.social_security.find((b) => b.id === benefit.id);
    if (!before) continue;
    const owner = `${personName(now, benefit.owner)}'s `;
    changes.push(...settingChanges(BENEFIT_FIELDS, before, benefit, was, now, owner));
  }

  changes.push(
    ...entryChanges(
      was.streams,
      now.streams,
      (s) =>
        s.name.trim() ||
        (s.direction === "Income" ? "Unnamed income" : "Unnamed spending"),
      streamLegend,
      was,
      now,
    ),
  );

  for (const account of now.accounts) {
    const before = was.accounts.find((a) => a.id === account.id);
    if (!before) continue;
    const recurringName = (c: Contribution) =>
      c.name.trim()
        ? `${account.name} · ${c.name.trim()}`
        : `${account.name} contribution`;
    changes.push(
      ...entryChanges(
        before.contributions,
        account.contributions,
        recurringName,
        contributionLegend,
        was,
        now,
      ),
      ...entryChanges(
        before.one_time_contributions,
        account.one_time_contributions,
        oneTimeName,
        oneTimeLegend,
        was,
        now,
      ),
      ...settingChanges(ACCOUNT_FIELDS, before, account, was, now, `${account.name} `),
    );
  }

  const a = was.assumptions;
  const b = now.assumptions;
  changes.push(
    ...strategyChanges(a.strategy_returns, b.strategy_returns, "return"),
    ...strategyChanges(a.strategy_volatility, b.strategy_volatility, "volatility"),
    ...drawdownChanges(a.drawdown, b.drawdown, was, now),
    ...settingChanges(ASSUMPTION_FIELDS, a, b, was, now, ""),
    ...settingChanges(SIM_CONFIG_FIELDS, was.sim_config, now.sim_config, was, now, ""),
  );

  return changes;
}

/** The line under a scenario's name: "Same as Base plan", or "3 changes:
 * Alex's retirement, House sale removed, Inflation" — the first few, then a
 * count of the rest. */
export function changeSummary(
  changes: readonly ScenarioChange[],
  referenceName: string,
): string {
  if (changes.length === 0) return `Same as ${referenceName}`;
  const shown = changes.slice(0, 3).map((c) => c.what);
  const more = changes.length - shown.length;
  const count = changes.length === 1 ? "1 change" : `${changes.length} changes`;
  return `${count}: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}
