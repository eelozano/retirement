import { describe, expect, it } from "vitest";
import type { Account } from "../types/generated/Account";
import type { Person } from "../types/generated/Person";
import type { Plan } from "../types/generated/Plan";
import {
  bridgePolicy,
  forgetAccount,
  penalizedUntil,
  penaltyFreeMonth,
  penaltyWarning,
  phaseName,
  phaseStartMonth,
  rule55,
} from "./drawdown";

function person(
  id: string,
  birth: [number, number],
  retirement: [number, number],
): Person {
  return {
    id,
    name: id,
    birth: { year: birth[0], month: birth[1] },
    retirement: { year: retirement[0], month: retirement[1] },
    life_expectancy_age: 90,
  };
}

function account(
  id: string,
  owner: string,
  kind: Account["kind"],
  plan_type: Account["plan_type"],
  rule_of_55 = false,
): Account {
  return {
    id,
    owner,
    kind,
    name: id,
    balance: 100_000,
    cost_basis: null,
    allocation: "Moderate",
    plan_type,
    contributions: [],
    one_time_contributions: [],
    employer_match: null,
    rule_of_55,
  };
}

/** The household the feature was built for, invented: he turns 55 in 2026
 * and retires that January on a 403(b) under the Rule of 55; she retires at
 * 51 and her 401(k) waits for her 59½, in July 2034. */
function household(): Plan {
  return {
    people: [person("him", [1971, 6], [2026, 1]), person("her", [1975, 1], [2026, 1])],
    accounts: [
      account("his-403b", "him", "TraditionalPreTax", "EmployerPlan", true),
      account("her-401k", "her", "TraditionalPreTax", "EmployerPlan"),
      account("brokerage", "him", "Taxable", "None"),
      account("her-roth", "her", "Roth", "Ira"),
    ],
    sim_config: { start: { year: 2026, month: 1 } },
    assumptions: { drawdown: "Proportional" },
  } as unknown as Plan;
}

describe("early access", () => {
  it("reaches 59½ six calendar months after the 59th birthday", () => {
    expect(penaltyFreeMonth(person("p", [1975, 1], [2026, 1]))).toEqual({
      year: 2034,
      month: 7,
    });
    expect(penaltyFreeMonth(person("p", [1975, 9], [2026, 1]))).toEqual({
      year: 2035,
      month: 3,
    });
  });

  it("frees an elected, eligible employer plan from the retirement month", () => {
    const plan = household();
    expect(rule55(plan, plan.accounts[0])).toEqual({
      eligible: true,
      from: { year: 2026, month: 1 },
    });
    expect(penalizedUntil(plan, plan.accounts[0])).toEqual({ year: 2026, month: 1 });
  });

  it("does not free an account that is not elected, or cannot be", () => {
    const plan = household();
    // Eligible dates, but not elected.
    expect(penalizedUntil(plan, plan.accounts[1])).toEqual({ year: 2034, month: 7 });
    // Retired at 51: too early for the Rule of 55.
    expect(rule55(plan, plan.accounts[1])).toEqual({
      eligible: false,
      reason: "SeparatedBefore55",
    });
    expect(rule55(plan, plan.accounts[3])).toEqual({
      eligible: false,
      reason: "NotAnEmployerPlan",
    });
  });

  it("never penalizes taxable money or a 457(b)", () => {
    const plan = household();
    expect(penalizedUntil(plan, plan.accounts[2])).toBeNull();
    expect(
      penalizedUntil(plan, account("gov", "her", "TraditionalPreTax", "Plan457b")),
    ).toBeNull();
  });

  it("warns on a stack entry that would be penalized when its phase starts", () => {
    const plan = household();
    const start = { year: 2026, month: 1 };
    expect(penaltyWarning(plan, { Account: "her-401k" }, start)).toEqual({
      year: 2034,
      month: 7,
    });
    expect(penaltyWarning(plan, { Account: "his-403b" }, start)).toBeNull();
    // From her 59½ on, nothing to warn about.
    expect(
      penaltyWarning(plan, { Account: "her-401k" }, { year: 2034, month: 7 }),
    ).toBeNull();
    // A whole type warns if any account in it would be penalized.
    expect(penaltyWarning(plan, { Kind: "TraditionalPreTax" }, start)).toEqual({
      year: 2034,
      month: 7,
    });
  });
});

describe("bridgePolicy", () => {
  it("draws only penalty-free money until the last early retiree reaches 59½", () => {
    const plan = household();
    const policy = bridgePolicy(plan);
    expect(policy).not.toBeNull();
    if (policy === null || policy === "Proportional") return;
    const [bridge, standard] = policy.Phased;

    expect(bridge.start).toEqual({ Boundary: "PlanStart" });
    // Taxable first, then the 403(b) the Rule of 55 frees. Her 401(k) and
    // Roth are left for the default order.
    expect(bridge.stack.map((e) => e.source)).toEqual([
      { Account: "brokerage" },
      { Account: "his-403b" },
    ]);
    expect(standard.start).toEqual({ PenaltyFree: "her" });
    expect(standard.stack).toEqual([]);
    expect(phaseStartMonth(plan, standard.start)).toEqual({ year: 2034, month: 7 });
  });

  it("has nothing to bridge when nobody retires before 59½", () => {
    const plan = household();
    plan.people = [person("late", [1960, 1], [2026, 1])];
    expect(bridgePolicy(plan)).toBeNull();
  });
});

describe("forgetAccount", () => {
  it("drops a deleted account from every stack and leaves the rest", () => {
    const plan = household();
    plan.assumptions.drawdown = bridgePolicy(plan) ?? "Proportional";
    forgetAccount(plan, "brokerage");
    const policy = plan.assumptions.drawdown;
    if (policy === "Proportional") throw new Error("expected phases");
    expect(policy.Phased[0].stack.map((e) => e.source)).toEqual([
      { Account: "his-403b" },
    ]);
  });
});

describe("phaseName", () => {
  it("names a phase by the id a snapshot carries", () => {
    const plan = household();
    plan.assumptions.drawdown = bridgePolicy(plan) ?? "Proportional";
    const policy = plan.assumptions.drawdown;
    if (policy === "Proportional") throw new Error("expected phases");
    expect(phaseName(plan, policy.Phased[1].id)).toBe("Standard");
    expect(phaseName(plan, null)).toBeNull();
    expect(phaseName(plan, "gone")).toBeNull();
  });
});
