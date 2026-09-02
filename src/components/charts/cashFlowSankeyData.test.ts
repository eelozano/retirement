import { describe, expect, it } from "vitest";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import {
  type Composition,
  HUB_KEY,
  INCOME_TAX_KEY,
  RESIDUAL_KEY,
  SHORTFALL_KEY,
  WITHDRAWAL_TAX_KEY,
  yearComposition,
} from "./cashFlowSankeyData";
import { MAX_SERIES, OTHER_KEY, type SeriesDef, seriesDefs } from "./chartData";

function snapshot(overrides: Partial<PeriodSnapshot>): PeriodSnapshot {
  return {
    period: 0,
    period_start: { year: 2040, month: 1 },
    balances: {},
    income: 0,
    expenses: 0,
    taxes: 0,
    contributions: 0,
    employer_match: 0,
    required_distributions: 0,
    surplus: 0,
    withdrawals: {},
    growth: 0,
    net_worth: 0,
    income_by_stream: {},
    expenses_by_stream: {},
    withdrawal_taxes: 0,
    contributions_by_account: {},
    deflator: 1,
    ...overrides,
  };
}

const streams: Projection["streams"] = [
  { id: "salary", name: "Salary", direction: "Income" },
  { id: "spending", name: "Household spending", direction: "Expense" },
  {
    id: "ss-survivor-p1",
    name: "Jordan's survivor Social Security",
    direction: "Income",
  },
];

function projection(snapshots: PeriodSnapshot[]): Projection {
  return { snapshots, warnings: [], streams };
}

/** One person, retiring in 2035; the plan-screen series for two accounts. */
const plan = {
  people: [{ id: "p1", retirement: { year: 2035, month: 1 } }],
  accounts: [
    { id: "ira", name: "IRA" },
    { id: "brokerage", name: "Brokerage" },
  ],
} as unknown as Plan;
const series: SeriesDef[] = seriesDefs(plan);

function keys(c: Composition, side: "in" | "out"): string[] {
  return c.nodes.filter((n) => n.side === side).map((n) => n.key);
}

function balance(c: Composition): { intoHub: number; outOfHub: number } {
  const hub = c.nodes.findIndex((n) => n.key === HUB_KEY);
  return {
    intoHub: c.links.filter((l) => l.target === hub).reduce((s, l) => s + l.value, 0),
    outOfHub: c.links.filter((l) => l.source === hub).reduce((s, l) => s + l.value, 0),
  };
}

describe("yearComposition", () => {
  it("decomposes a retired year into streams and accounts around a balanced hub", () => {
    const c = yearComposition(
      plan,
      projection([
        snapshot({
          income: 30_000,
          income_by_stream: { "ss-survivor-p1": 30_000 },
          withdrawals: { ira: 40_000, brokerage: 10_000 },
          expenses: 60_000,
          expenses_by_stream: { spending: 60_000 },
          taxes: 9_000,
          withdrawal_taxes: 4_000,
          surplus: 11_000,
        }),
      ]),
      2040,
      series,
      false,
    );
    expect(c).not.toBeNull();
    if (!c) return;

    expect(keys(c, "in")).toEqual([
      "stream:ss-survivor-p1",
      "withdrawal:ira",
      "withdrawal:brokerage",
    ]);
    expect(keys(c, "out")).toEqual([
      "stream:spending",
      INCOME_TAX_KEY,
      WITHDRAWAL_TAX_KEY,
      RESIDUAL_KEY,
    ]);
    // Synthesized streams are labelled from the projection, not the plan.
    expect(c.nodes[0].fullLabel).toBe("Jordan's survivor Social Security");
    // Accounts keep their Plan-screen colours.
    expect(c.nodes[1].color).toBe(series[0].color);

    const tax = (key: string) => c.nodes.find((n) => n.key === key)?.value;
    expect(tax(INCOME_TAX_KEY)).toBe(5_000);
    expect(tax(WITHDRAWAL_TAX_KEY)).toBe(4_000);

    expect(c.totalIn).toBe(80_000);
    expect(balance(c)).toEqual({ intoHub: 80_000, outOfHub: 80_000 });
    expect(c.shortfall).toBe(0);
    expect(c.working).toBe(false);
    expect(c.nodes.find((n) => n.key === RESIDUAL_KEY)?.label).toBe("Left over");
  });

  it("calls the residual current spending while anyone still works", () => {
    const c = yearComposition(
      plan,
      projection([
        snapshot({
          period_start: { year: 2030, month: 1 },
          income: 100_000,
          income_by_stream: { salary: 100_000 },
          contributions: 20_000,
          contributions_by_account: { ira: 20_000 },
          taxes: 15_000,
          surplus: 65_000,
        }),
      ]),
      2030,
      series,
      false,
    );
    expect(c?.working).toBe(true);
    expect(keys(c as Composition, "out")).toEqual([
      INCOME_TAX_KEY,
      "contribution:ira",
      RESIDUAL_KEY,
    ]);
    expect(c?.nodes.find((n) => n.key === RESIDUAL_KEY)?.label).toBe("Current spending");
  });

  it("drops zero-valued streams, accounts, and tax nodes rather than drawing hairlines", () => {
    const c = yearComposition(
      plan,
      projection([
        snapshot({
          income: 50_000,
          income_by_stream: { salary: 50_000, "ss-survivor-p1": 0 },
          withdrawals: { ira: 0 },
          expenses: 50_000,
          expenses_by_stream: { spending: 50_000 },
        }),
      ]),
      2040,
      series,
      false,
    );
    expect(keys(c as Composition, "in")).toEqual(["stream:salary"]);
    expect(keys(c as Composition, "out")).toEqual(["stream:spending"]);
    expect(c?.links).toHaveLength(2);
  });

  it("draws a depleted year's uncovered outflows as an unfunded inflow so the hub still balances", () => {
    const c = yearComposition(
      plan,
      projection([
        snapshot({
          withdrawals: { ira: 10_000 },
          expenses: 60_000,
          expenses_by_stream: { spending: 60_000 },
          taxes: 1_000,
          withdrawal_taxes: 1_000,
          surplus: 0,
        }),
      ]),
      2040,
      series,
      false,
    );
    expect(c?.shortfall).toBe(51_000);
    expect(keys(c as Composition, "in")).toEqual(["withdrawal:ira", SHORTFALL_KEY]);
    expect(balance(c as Composition)).toEqual({ intoHub: 61_000, outOfHub: 61_000 });
    expect(c?.empty).toBe(false);
  });

  it("folds accounts past the series cap into Other, as the balance stack does", () => {
    const many = {
      ...plan,
      accounts: Array.from({ length: MAX_SERIES + 2 }, (_, i) => ({
        id: `a${i}`,
        name: `Account ${i}`,
      })),
    } as unknown as Plan;
    const withdrawals = Object.fromEntries(many.accounts.map((a) => [a.id, 1_000]));
    const c = yearComposition(
      many,
      projection([
        snapshot({
          withdrawals,
          expenses: (MAX_SERIES + 2) * 1_000,
          expenses_by_stream: { spending: (MAX_SERIES + 2) * 1_000 },
        }),
      ]),
      2040,
      seriesDefs(many),
      false,
    );
    const inflows = c?.nodes.filter((n) => n.side === "in") ?? [];
    expect(inflows).toHaveLength(MAX_SERIES + 1);
    const other = inflows[inflows.length - 1];
    expect(other.key).toBe(`withdrawal:${OTHER_KEY}`);
    expect(other.value).toBe(2_000);
  });

  it("deflates every figure when showing today's dollars", () => {
    const c = yearComposition(
      plan,
      projection([
        snapshot({
          income: 200,
          income_by_stream: { salary: 200 },
          taxes: 40,
          surplus: 160,
          employer_match: 20,
          deflator: 2,
        }),
      ]),
      2040,
      series,
      true,
    );
    expect(c?.totalIn).toBe(100);
    expect(c?.employerMatch).toBe(10);
    expect(c?.nodes.find((n) => n.key === INCOME_TAX_KEY)?.value).toBe(20);
  });

  it("reports an empty year and an unknown year distinctly", () => {
    const p = projection([snapshot({})]);
    expect(yearComposition(plan, p, 2040, series, false)?.empty).toBe(true);
    expect(yearComposition(plan, p, 2041, series, false)).toBeNull();
  });

  it("truncates long names for the diagram but keeps them whole for the tooltip", () => {
    const longName = "A very long pension name that will not fit";
    const c = yearComposition(
      plan,
      {
        snapshots: [
          snapshot({ income: 10, income_by_stream: { pension: 10 }, surplus: 10 }),
        ],
        warnings: [],
        streams: [{ id: "pension", name: longName, direction: "Income" }],
      },
      2040,
      series,
      false,
    );
    expect(c?.nodes[0].fullLabel).toBe(longName);
    expect(c?.nodes[0].label.length).toBeLessThan(longName.length);
    expect(c?.nodes[0].label.endsWith("…")).toBe(true);
  });
});
