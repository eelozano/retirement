import { describe, expect, it } from "vitest";
import type { Plan } from "../../types/generated/Plan";
import { grownRate, listRates, monthsBetween, refreshMonths } from "./refreshRates";

const plan = {
  people: [
    { id: "alex", name: "Alex" },
    { id: "jordan", name: "Jordan" },
  ],
  streams: [
    {
      id: "alex-salary",
      name: "Alex salary",
      owner: "alex",
      direction: "Income",
      annual_amount: 140_000,
      growth: "Inflation",
    },
    {
      id: "household-spending",
      name: "Household spending",
      owner: null,
      direction: "Expense",
      annual_amount: 96_000,
      growth: "Inflation",
    },
  ],
  accounts: [
    {
      id: "taxable-brokerage",
      name: "Taxable Brokerage",
      owner: "alex",
      contributions: [
        {
          id: "transfer",
          rule: { FlatAmount: { amount: 40_000, growth: "None" } },
          start: "PlanStart",
          end: { AtRetirement: "alex" },
        },
        // Intent, not a figure: it rides the salary it is a percentage of.
        {
          id: "escalating",
          rule: { PercentOfSalary: { percent: 0.1, step_up: null } },
        },
      ],
    },
    {
      id: "alex-401k",
      name: "Alex 401(k)",
      owner: "alex",
      // Intent again: the engine indexes the statutory figure forward.
      contributions: [{ id: "max", rule: "FederalMaximum" }],
    },
  ],
} as unknown as Plan;

describe("listRates", () => {
  it("lists every start-dollar figure and nothing that is intent", () => {
    expect(listRates(plan).map((r) => r.key)).toEqual([
      "stream:alex-salary",
      "stream:household-spending",
      "contribution:taxable-brokerage:transfer",
    ]);
  });

  it("names each figure and where it lives, so two salaries are tellable apart", () => {
    const [salary, spending, transfer] = listRates(plan);
    expect(salary.label).toBe("Alex salary");
    expect(salary.detail).toBe("Income · Alex");
    expect(spending.detail).toBe("Spending · Household");
    expect(transfer.label).toBe("Into Taxable Brokerage");
    // An entry has no name of its own, so its window is what tells two
    // entries on the same account apart.
    expect(transfer.detail).toBe("Alex · plan start to Alex retires");
    expect(transfer.amount).toBe(40_000);
  });

  it("addresses a contribution by its account and its entry, not by name", () => {
    expect(listRates(plan)[2].target).toEqual({
      Contribution: { account: "taxable-brokerage", id: "transfer" },
    });
  });
});

describe("grownRate", () => {
  it("restores what the figure bought, over the months elapsed", () => {
    // Eleven months of 2.5%: 140,000 × 1.025^(11/12).
    expect(grownRate(140_000, 0.025, 11)).toBe(143_205);
    // A whole year is the plain rate.
    expect(grownRate(140_000, 0.025, 12)).toBe(143_500);
  });

  it("is the identity over no elapsed months", () => {
    expect(grownRate(96_000, 0.03, 0)).toBe(96_000);
  });
});

describe("refreshMonths", () => {
  it("offers this month first and never one before the balances on file", () => {
    const months = refreshMonths(
      { year: 2026, month: 9 },
      new Date("2026-12-04T12:00:00"),
    );
    expect(months).toEqual([
      { year: 2026, month: 12 },
      { year: 2026, month: 11 },
      { year: 2026, month: 10 },
      { year: 2026, month: 9 },
    ]);
  });

  it("crosses the year boundary", () => {
    expect(
      refreshMonths({ year: 2026, month: 11 }, new Date("2027-01-15T12:00:00")),
    ).toEqual([
      { year: 2027, month: 1 },
      { year: 2026, month: 12 },
      { year: 2026, month: 11 },
    ]);
  });

  it("still offers the month on file when the clock is behind it", () => {
    expect(
      refreshMonths({ year: 2026, month: 9 }, new Date("2026-07-04T12:00:00")),
    ).toEqual([{ year: 2026, month: 9 }]);
  });
});

describe("monthsBetween", () => {
  it("counts whole months across years and never goes negative", () => {
    expect(monthsBetween({ year: 2026, month: 1 }, { year: 2026, month: 12 })).toBe(11);
    expect(monthsBetween({ year: 2026, month: 11 }, { year: 2027, month: 2 })).toBe(3);
    expect(monthsBetween({ year: 2026, month: 12 }, { year: 2026, month: 1 })).toBe(0);
  });
});
