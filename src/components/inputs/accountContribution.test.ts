import { describe, expect, it } from "vitest";
import type { Account } from "../../types/generated/Account";
import type { Contribution } from "../../types/generated/Contribution";
import type { ContributionRule } from "../../types/generated/ContributionRule";
import type { OneTimeContribution } from "../../types/generated/OneTimeContribution";
import type { Plan } from "../../types/generated/Plan";
import {
  automaticDeposit,
  CONTRIBUTION_MODES,
  contributionLegend,
  contributionMode,
  contributionSummary,
  depositCandidates,
  landingPhrase,
  oneTimeLegend,
  oneTimeNotCounted,
  ruleForMode,
  ruleSummary,
} from "./accountContribution";

// Expected strings are typed by hand, not built from the functions under test.

function account(
  id: string,
  owner: string,
  kind: Account["kind"],
  plan_type: Account["plan_type"],
  extra: Partial<Account> = {},
): Account {
  return {
    id,
    owner,
    kind,
    name: id,
    balance: 0,
    cost_basis: null,
    plan_type,
    contributions: [],
    one_time_contributions: [],
    employer_match: null,
    ...extra,
  } as Account;
}

function planOf(accounts: Account[], people = PEOPLE): Plan {
  return {
    sim_config: { start: { year: 2026, month: 1 } },
    people,
    accounts,
  } as unknown as Plan;
}

const PEOPLE = [
  {
    id: "alex",
    name: "Alex",
    birth: { year: 1983, month: 8 },
    retirement: { year: 2038, month: 12 },
    life_expectancy_age: 90,
  },
  {
    id: "jordan",
    name: "Jordan",
    birth: { year: 1981, month: 9 },
    retirement: { year: 2044, month: 9 },
    life_expectancy_age: 91,
  },
];

// Alex's pre-tax 401(k) is the source: it has no separate Roth plan beside it
// until one is added (#175).
const alex401k = account("alex-401k", "alex", "TraditionalPreTax", "EmployerPlan");
const alexRoth401k = account("alex-roth-401k", "alex", "Roth", "EmployerPlan");
const alexRothIra = account("alex-roth-ira", "alex", "Roth", "Ira");
const alexBrokerage = account("alex-brokerage", "alex", "Taxable", "None");
const jordanRoth401k = account("jordan-roth-401k", "jordan", "Roth", "EmployerPlan");
const jordan401k = account("jordan-401k", "jordan", "TraditionalPreTax", "EmployerPlan");

describe("contributionMode and ruleForMode", () => {
  it("round-trips every mode", () => {
    for (const { value } of CONTRIBUTION_MODES) {
      expect(contributionMode(ruleForMode(value))).toBe(value);
    }
  });

  it("starts each mode from zero rather than converting", () => {
    expect(ruleForMode("PercentOfSalary")).toEqual({
      PercentOfSalary: { percent: 0, step_up: null },
    });
    expect(ruleForMode("FlatAmount")).toEqual({
      FlatAmount: { amount: 0, growth: "None" },
    });
    expect(ruleForMode("FederalMaximum")).toBe("FederalMaximum");
  });

  it("reads a rule with a step-up or a growth rule as its mode", () => {
    expect(
      contributionMode({
        PercentOfSalary: { percent: 0.1, step_up: { points_per_year: 0.01, cap: 0.15 } },
      }),
    ).toBe("PercentOfSalary");
    expect(contributionMode({ FlatAmount: { amount: 6000, growth: "Inflation" } })).toBe(
      "FlatAmount",
    );
  });
});

describe("depositCandidates", () => {
  it("is only the owner's employer plans of the destination's kind, in plan order", () => {
    const plan = planOf([
      alex401k,
      jordanRoth401k,
      alexRoth401k,
      alexRothIra,
      alexBrokerage,
      account("alex-roth-401k-2", "alex", "Roth", "EmployerPlan"),
    ]);
    expect(depositCandidates(plan, alex401k, "Roth").map((a) => a.id)).toEqual([
      "alex-roth-401k",
      "alex-roth-401k-2",
    ]);
    expect(depositCandidates(plan, alex401k, "PreTax").map((a) => a.id)).toEqual([
      "alex-401k",
    ]);
  });

  it("is empty when the owner has no employer plan of that kind", () => {
    // A Roth IRA is not an employer plan, and Jordan's Roth 401(k) is not Alex's.
    const plan = planOf([alex401k, alexRothIra, jordanRoth401k]);
    expect(depositCandidates(plan, alex401k, "Roth")).toEqual([]);
  });
});

describe("automaticDeposit", () => {
  it("is the source itself when it is already the destination's kind", () => {
    const plan = planOf([alex401k, alexRoth401k]);
    expect(automaticDeposit(plan, alex401k, "PreTax")).toBe(alex401k);
    expect(automaticDeposit(plan, alexRoth401k, "Roth")).toBe(alexRoth401k);
  });

  it("is the owner's first employer plan of the kind when the source is another", () => {
    const plan = planOf([
      alex401k,
      account("alex-roth-401k-b", "alex", "Roth", "EmployerPlan"),
      alexRoth401k,
    ]);
    expect(automaticDeposit(plan, alex401k, "Roth")?.id).toBe("alex-roth-401k-b");
  });

  it("is undefined with no separate employer account to land in", () => {
    // Match into Roth from a pre-tax plan with no Roth employer plan beside
    // it: the engine's MatchUnallocated.
    const plan = planOf([alex401k, alexRothIra, jordanRoth401k]);
    expect(automaticDeposit(plan, alex401k, "Roth")).toBeUndefined();
  });

  it("does not borrow another owner's plan", () => {
    const plan = planOf([alex401k, jordan401k, jordanRoth401k]);
    expect(automaticDeposit(plan, alex401k, "Roth")).toBeUndefined();
  });
});

describe("ruleSummary", () => {
  it("names each kind of rule in a few words", () => {
    expect(ruleSummary("FederalMaximum")).toBe("Max");
    expect(ruleSummary({ PercentOfSalary: { percent: 0.1, step_up: null } })).toBe(
      "10% of salary",
    );
    expect(ruleSummary({ FlatAmount: { amount: 6000, growth: "None" } })).toBe(
      "$6,000/yr",
    );
  });

  it("shows an escalation riding along", () => {
    expect(
      ruleSummary({
        PercentOfSalary: { percent: 0.1, step_up: { points_per_year: 0.01, cap: 0.15 } },
      }),
    ).toBe("10% → 15% of salary");
    expect(ruleSummary({ FlatAmount: { amount: 6000, growth: "Inflation" } })).toBe(
      "$6,000/yr, +inflation",
    );
  });

  it("does not call a fixed growth rate inflation", () => {
    expect(ruleSummary({ FlatAmount: { amount: 6000, growth: { Fixed: 0.03 } } })).toBe(
      "$6,000/yr",
    );
  });
});

describe("contributionSummary", () => {
  const flat = (id: string): Contribution => ({
    id,
    name: "",
    rule: { FlatAmount: { amount: 6000, growth: "None" } },
    start: "PlanStart",
    end: "PlanEnd",
  });
  const sale = (id: string, name: string): OneTimeContribution => ({
    id,
    name,
    amount: 350000,
    growth: "None",
    date: { Date: { year: 2031, month: 6 } },
  });

  it("is a dash when nothing goes in", () => {
    expect(contributionSummary(alexBrokerage)).toBe("—");
  });

  it("describes a single recurring entry by its rule and counts several", () => {
    expect(contributionSummary({ ...alex401k, contributions: [flat("a")] })).toBe(
      "$6,000/yr",
    );
    expect(
      contributionSummary({ ...alex401k, contributions: [flat("a"), flat("b")] }),
    ).toBe("2 schedules");
  });

  it("names a single one-time entry and counts several", () => {
    expect(
      contributionSummary({
        ...alexBrokerage,
        one_time_contributions: [sale("s", "House sale")],
      }),
    ).toBe("House sale");
    expect(
      contributionSummary({
        ...alexBrokerage,
        one_time_contributions: [sale("s", ""), sale("t", "")],
      }),
    ).toBe("2 one-time");
  });

  it("joins recurring and one-time with a plus", () => {
    expect(
      contributionSummary({
        ...alexBrokerage,
        contributions: [flat("a")],
        one_time_contributions: [sale("s", "House sale")],
      }),
    ).toBe("$6,000/yr + House sale");
    // An unnamed lump sum reads as the generic label.
    expect(
      contributionSummary({
        ...alexBrokerage,
        contributions: [flat("a")],
        one_time_contributions: [sale("s", "  ")],
      }),
    ).toBe("$6,000/yr + One-time contribution");
  });
});

describe("contributionLegend", () => {
  const plan = planOf([alex401k]);
  const rule: ContributionRule = { FlatAmount: { amount: 8400, growth: "None" } };

  it("derives the window from the entry", () => {
    const entry: Contribution = {
      id: "c",
      name: "",
      rule,
      start: { Date: { year: 2027, month: 1 } },
      end: { AtRetirement: "alex" },
    };
    expect(contributionLegend(entry, plan)).toBe(
      "$8,400/yr from Jan 2027 until Alex retires (Dec 2038)",
    );
  });

  it("leads with the entry's name when it has one", () => {
    const entry: Contribution = {
      id: "c",
      name: " Car paid off ",
      rule,
      start: "PlanStart",
      end: "PlanEnd",
    };
    expect(contributionLegend(entry, plan)).toBe(
      "Car paid off · $8,400/yr from plan start until plan end",
    );
  });
});

describe("landingPhrase", () => {
  const plan = planOf([alex401k]);

  it("says 'in' for a specific month", () => {
    expect(landingPhrase({ Date: { year: 2031, month: 6 } }, plan)).toBe("in Jun 2031");
  });

  it("says 'when' for a person-relative boundary", () => {
    expect(landingPhrase({ AtRetirement: "alex" }, plan)).toBe(
      "when Alex retires (Dec 2038)",
    );
    expect(landingPhrase({ AtAge: ["jordan", 65] }, plan)).toBe(
      "when Jordan turns 65 (Sep 2046)",
    );
  });

  it("says 'at' for the plan's own edges", () => {
    expect(landingPhrase("PlanStart", plan)).toBe("at plan start");
    expect(landingPhrase("PlanEnd", plan)).toBe("at plan end");
  });
});

describe("oneTimeLegend", () => {
  const plan = planOf([alexBrokerage]);

  it("says when an amount is in today's dollars", () => {
    const entry: OneTimeContribution = {
      id: "s",
      name: "House sale",
      amount: 350000,
      growth: "Inflation",
      date: { AtRetirement: "alex" },
    };
    expect(oneTimeLegend(entry, plan)).toBe(
      "House sale · $350,000 in today's dollars when Alex retires (Dec 2038)",
    );
  });

  it("leaves it out for an exact nominal amount, and names an unnamed entry", () => {
    const entry: OneTimeContribution = {
      id: "s",
      name: "",
      amount: 20000,
      growth: "None",
      date: { Date: { year: 2031, month: 6 } },
    };
    expect(oneTimeLegend(entry, plan)).toBe(
      "One-time contribution · $20,000 in Jun 2031",
    );
  });
});

describe("oneTimeNotCounted", () => {
  // The plan starts Jan 2026. Alex (born Aug 1983, to 90) outlives Jordan
  // (born Sep 1981, to 91 → Sep 2072), so the horizon is Aug 2073.
  const plan = planOf([alexBrokerage]);
  const entry = (date: OneTimeContribution["date"]): OneTimeContribution => ({
    id: "s",
    name: "House sale",
    amount: 350000,
    growth: "None",
    date,
  });

  it("flags a date before the projection starts", () => {
    expect(oneTimeNotCounted(entry({ Date: { year: 2025, month: 12 } }), plan)).toBe(
      "Dec 2025 is before the projection starts in Jan 2026, so this isn't counted. If the money has already arrived, it belongs in the balance; if not, move its date.",
    );
  });

  it("flags a date at or after the last death", () => {
    expect(oneTimeNotCounted(entry({ Date: { year: 2073, month: 8 } }), plan)).toBe(
      "Aug 2073 is after the projection ends, so this isn't counted.",
    );
    expect(oneTimeNotCounted(entry({ Date: { year: 2090, month: 1 } }), plan)).toBe(
      "Jan 2090 is after the projection ends, so this isn't counted.",
    );
  });

  it("counts a date inside the window, including both edges", () => {
    expect(oneTimeNotCounted(entry({ Date: { year: 2031, month: 6 } }), plan)).toBeNull();
    // The first month of the projection, and the last month before the end.
    expect(oneTimeNotCounted(entry({ Date: { year: 2026, month: 1 } }), plan)).toBeNull();
    expect(oneTimeNotCounted(entry({ Date: { year: 2073, month: 7 } }), plan)).toBeNull();
  });

  it("checks the month a retirement resolves to", () => {
    expect(oneTimeNotCounted(entry({ AtRetirement: "alex" }), plan)).toBeNull();
    const retiredAlready = planOf(
      [alexBrokerage],
      [{ ...PEOPLE[0], retirement: { year: 2025, month: 6 } }, PEOPLE[1]],
    );
    expect(oneTimeNotCounted(entry({ AtRetirement: "alex" }), retiredAlready)).toBe(
      "Jun 2025 is before the projection starts in Jan 2026, so this isn't counted. If the money has already arrived, it belongs in the balance; if not, move its date.",
    );
  });

  it("has nothing to say about a person who is no longer in the plan", () => {
    expect(oneTimeNotCounted(entry({ AtRetirement: "ghost" }), plan)).toBeNull();
  });

  it("has nothing to say about the plan's own edges, which validation refuses", () => {
    expect(oneTimeNotCounted(entry("PlanStart"), plan)).toBeNull();
    expect(oneTimeNotCounted(entry("PlanEnd"), plan)).toBeNull();
  });

  it("applies no end bound to a plan with nobody in it", () => {
    const empty = planOf([alexBrokerage], []);
    expect(
      oneTimeNotCounted(entry({ Date: { year: 2090, month: 1 } }), empty),
    ).toBeNull();
    expect(oneTimeNotCounted(entry({ Date: { year: 2025, month: 12 } }), empty)).toBe(
      "Dec 2025 is before the projection starts in Jan 2026, so this isn't counted. If the money has already arrived, it belongs in the balance; if not, move its date.",
    );
  });
});
