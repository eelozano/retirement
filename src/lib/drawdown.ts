import { boundaryResolvedDate } from "../components/inputs/streamBoundary";
import type { Account } from "../types/generated/Account";
import type { AccountKind } from "../types/generated/AccountKind";
import type { DrawdownPhase } from "../types/generated/DrawdownPhase";
import type { DrawdownPolicy } from "../types/generated/DrawdownPolicy";
import type { Person } from "../types/generated/Person";
import type { PhaseStart } from "../types/generated/PhaseStart";
import type { Plan } from "../types/generated/Plan";
import type { StackSource } from "../types/generated/StackSource";
import type { YearMonth } from "../types/generated/YearMonth";

// The drawdown policy as the editor needs it: when a phase starts, when an
// account's withdrawals stop being early, and the two presets. The early-
// access rules mirror `sim::early_access` for display only — the engine's
// answer is the one the projection uses, and its `Rule55Ineligible` warning
// is what reports a disagreement.

const monthIndex = (m: YearMonth) => m.year * 12 + (m.month - 1);
const fromIndex = (i: number): YearMonth => ({
  year: Math.floor(i / 12),
  month: (i % 12) + 1,
});

/** The month a person reaches 59½ — `Person::penalty_free_month`. */
export function penaltyFreeMonth(person: Person): YearMonth {
  return fromIndex(monthIndex(person.birth) + 59 * 12 + 6);
}

export type Rule55 =
  | { eligible: true; from: YearMonth }
  | { eligible: false; reason: "NotAnEmployerPlan" | "SeparatedBefore55" };

/** Whether the Rule of 55 would hold for this account — the check
 * `sim::early_access::rule_of_55` makes, whether or not it is elected. */
export function rule55(plan: Plan, account: Account): Rule55 {
  if (
    account.plan_type !== "EmployerPlan" ||
    (account.kind !== "TraditionalPreTax" && account.kind !== "Roth")
  ) {
    return { eligible: false, reason: "NotAnEmployerPlan" };
  }
  const owner = plan.people.find((p) => p.id === account.owner);
  if (!owner || owner.retirement.year < owner.birth.year + 55) {
    return { eligible: false, reason: "SeparatedBefore55" };
  }
  return { eligible: true, from: owner.retirement };
}

/** The month this account's withdrawals stop carrying the 10% penalty, or
 * null if they never carry it. */
export function penalizedUntil(plan: Plan, account: Account): YearMonth | null {
  if (account.kind !== "TraditionalPreTax" && account.kind !== "Roth") return null;
  if (account.plan_type === "Plan457b") return null;
  const owner = plan.people.find((p) => p.id === account.owner);
  if (!owner) return null;
  const free = penaltyFreeMonth(owner);
  const exemption = account.rule_of_55 ? rule55(plan, account) : null;
  if (exemption?.eligible && monthIndex(exemption.from) < monthIndex(free)) {
    return exemption.from;
  }
  return free;
}

/** The month a phase starts, or null if it names someone no longer in the
 * plan. */
export function phaseStartMonth(plan: Plan, start: PhaseStart): YearMonth | null {
  if ("PenaltyFree" in start) {
    const person = plan.people.find((p) => p.id === start.PenaltyFree);
    return person ? penaltyFreeMonth(person) : null;
  }
  const boundary = start.Boundary;
  if (boundary === "PlanStart") return plan.sim_config.start;
  if (boundary === "PlanEnd") return null;
  if ("Date" in boundary) return boundary.Date;
  return boundaryResolvedDate(boundary, plan) ?? null;
}

/** The accounts a stack entry draws from. */
export function sourceAccounts(plan: Plan, source: StackSource): Account[] {
  return "Account" in source
    ? plan.accounts.filter((a) => a.id === source.Account)
    : plan.accounts.filter((a) => a.kind === source.Kind);
}

export const KIND_LABELS: Record<AccountKind, string> = {
  Savings: "savings",
  Taxable: "taxable",
  TraditionalPreTax: "pre-tax",
  Roth: "Roth",
  Hsa: "HSA",
};

export function sourceLabel(plan: Plan, source: StackSource): string {
  if ("Account" in source) {
    return plan.accounts.find((a) => a.id === source.Account)?.name || "Missing account";
  }
  return `All ${KIND_LABELS[source.Kind]} accounts`;
}

/**
 * The earliest month, from `from` on, that some account behind `source` is
 * still penalized until — what the stack row's badge warns about. Null when
 * every account it draws from is penalty-free by then.
 */
export function penaltyWarning(
  plan: Plan,
  source: StackSource,
  from: YearMonth | null,
): YearMonth | null {
  if (!from) return null;
  let latest: YearMonth | null = null;
  for (const account of sourceAccounts(plan, source)) {
    const until = penalizedUntil(plan, account);
    if (until && monthIndex(until) > monthIndex(from)) {
      if (!latest || monthIndex(until) > monthIndex(latest)) latest = until;
    }
  }
  return latest;
}

/** A phase's display name, by the id `PeriodSnapshot::drawdown_phase`
 * carries. */
export function phaseName(plan: Plan, id: string | null): string | null {
  if (id === null) return null;
  const { drawdown } = plan.assumptions;
  if (drawdown === "Proportional") return null;
  return drawdown.Phased.find((p) => p.id === id)?.name ?? null;
}

let nextId = 0;
export function newPhaseId(): string {
  nextId += 1;
  return `phase-${Date.now()}-${nextId}`;
}

/** One phase from plan start with nothing listed: every account drawn in
 * the engine's default order — penalty-free money first, then by type. */
export function defaultOrderPolicy(): DrawdownPolicy {
  return {
    Phased: [
      {
        id: newPhaseId(),
        name: "Default order",
        start: { Boundary: "PlanStart" },
        stack: [],
      },
    ],
  };
}

/** Whoever reaches 59½ last among the people who retire before it — the
 * month a bridge has to reach. Null when nobody retires early. */
function lastEarlyRetiree(plan: Plan): Person | null {
  const early = plan.people.filter(
    (p) => monthIndex(p.retirement) < monthIndex(penaltyFreeMonth(p)),
  );
  return (
    early.sort(
      (a, b) => monthIndex(penaltyFreeMonth(b)) - monthIndex(penaltyFreeMonth(a)),
    )[0] ?? null
  );
}

/**
 * A bridge to 59½: from plan start, draw only what can be reached without
 * the penalty — savings, taxable accounts, and any account the Rule of 55 or
 * a 457(b) frees — and from the month the last early retiree reaches 59½,
 * the default order. Null when nobody retires before 59½, since there is
 * nothing to bridge.
 */
export function bridgePolicy(plan: Plan): DrawdownPolicy | null {
  const person = lastEarlyRetiree(plan);
  if (!person) return null;
  // Reachable without the penalty before 59½: money that was never
  // retirement money, and any retirement account an exemption frees earlier.
  const reachable = plan.accounts.filter((a) => {
    if (a.kind === "Savings" || a.kind === "Taxable") return true;
    if (a.kind !== "TraditionalPreTax" && a.kind !== "Roth") return false;
    const owner = plan.people.find((p) => p.id === a.owner);
    const until = penalizedUntil(plan, a);
    return (
      owner !== undefined &&
      (until === null || monthIndex(until) < monthIndex(penaltyFreeMonth(owner)))
    );
  });
  const order: AccountKind[] = ["Savings", "Taxable", "TraditionalPreTax", "Roth"];
  reachable.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const bridge: DrawdownPhase = {
    id: newPhaseId(),
    name: "Bridge to 59½",
    start: { Boundary: "PlanStart" },
    stack: reachable.map((a) => ({ source: { Account: a.id }, floor: 0 })),
  };
  const standard: DrawdownPhase = {
    id: newPhaseId(),
    name: "Standard",
    start: { PenaltyFree: person.id },
    stack: [],
  };
  return { Phased: [bridge, standard] };
}

/** Removes every stack entry naming `accountId` — run when the account is
 * deleted, so a stack never names an account the plan no longer has. */
export function forgetAccount(plan: Plan, accountId: string): void {
  const { drawdown } = plan.assumptions;
  if (drawdown === "Proportional") return;
  for (const phase of drawdown.Phased) {
    phase.stack = phase.stack.filter(
      (e) => !("Account" in e.source) || e.source.Account !== accountId,
    );
  }
}

export function sameSource(a: StackSource, b: StackSource): boolean {
  return "Account" in a
    ? "Account" in b && a.Account === b.Account
    : "Kind" in b && a.Kind === b.Kind;
}
