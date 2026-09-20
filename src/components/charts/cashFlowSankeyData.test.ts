import { describe, expect, it } from "vitest";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import {
  type Composition,
  HUB_KEY,
  INCOME_TAX_KEY,
  PENALTY_KEY,
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
    one_time_contributions: 0,
    required_distributions: 0,
    surplus: 0,
    withdrawals: {},
    growth: 0,
    net_worth: 0,
    income_by_stream: {},
    expenses_by_stream: {},
    withdrawal_taxes: 0,
    early_withdrawal_penalty: 0,
    drawdown_phase: null,
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
  return { snapshots, warnings: [], streams, one_time: [] };
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
  it("gives the early-withdrawal penalty its own outflow, out of the withdrawal tax", () => {
    const c = yearComposition(
      plan,
      projection([
        snapshot({
          withdrawals: { ira: 50_000 },
          expenses: 40_000,
          expenses_by_stream: { spending: 40_000 },
          taxes: 10_000,
          withdrawal_taxes: 10_000,
          early_withdrawal_penalty: 5_000,
        }),
      ]),
      2040,
      series,
      false,
    );
    if (!c) throw new Error("expected a composition");
    const value = (key: string) => c.nodes.find((n) => n.key === key)?.value;
    expect(value(WITHDRAWAL_TAX_KEY)).toBe(5_000);
    expect(value(PENALTY_KEY)).toBe(5_000);
    expect(balance(c)).toEqual({ intoHub: 50_000, outOfHub: 50_000 });
  });

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
          early_withdrawal_penalty: 0,
          drawdown_phase: null,
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
          early_withdrawal_penalty: 0,
          drawdown_phase: null,
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

  it("draws no unfunded shortfall from the float residue of an exactly covered year", () => {
    // Covered to the cent, but the inflow nodes sum 5.8e-11 short of the
    // outflows in binary floating point — under MIN_VALUE, so no shortfall.
    const c = yearComposition(
      plan,
      projection([
        snapshot({
          income: 220_201.49,
          income_by_stream: { salary: 220_201.49 },
          withdrawals: { ira: 146_443.46 },
          expenses: 285_361.67,
          expenses_by_stream: { spending: 285_361.67 },
          taxes: 54_383.47,
          contributions: 26_899.81,
          contributions_by_account: { brokerage: 26_899.81 },
        }),
      ]),
      2040,
      series,
      false,
    );
    expect(c?.shortfall).toBe(0);
    expect(keys(c as Composition, "in")).toEqual(["stream:salary", "withdrawal:ira"]);
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

  it("notes a one-time contribution by name rather than drawing it as a flow", () => {
    const c = yearComposition(
      plan,
      {
        ...projection([
          snapshot({
            period: 3,
            income: 100_000,
            income_by_stream: { salary: 100_000 },
            taxes: 20_000,
            surplus: 80_000,
            deflator: 2,
          }),
        ]),
        one_time: [
          {
            account: "brokerage",
            id: "sale",
            name: "House sale",
            period: 3,
            amount: 700_000,
          },
          // Landed in another year, so not this year's note.
          { account: "brokerage", id: "gift", name: "Gift", period: 4, amount: 5_000 },
        ],
      },
      2040,
      series,
      true,
    );
    expect(c?.oneTime).toEqual([
      {
        key: "one-time:brokerage:sale",
        name: "House sale",
        account: "Brokerage",
        value: 350_000,
      },
    ]);
    expect(c?.nodes.some((n) => n.key.includes("sale"))).toBe(false);
    // The hub balances on the household's own cash alone.
    expect(balance(c as Composition)).toEqual({ intoHub: 50_000, outOfHub: 50_000 });
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
        one_time: [],
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
