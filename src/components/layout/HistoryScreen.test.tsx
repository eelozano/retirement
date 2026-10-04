import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BacktestResult } from "../../types/generated/BacktestResult";
import type { CohortDetail } from "../../types/generated/CohortDetail";
import type { CohortSummary } from "../../types/generated/CohortSummary";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";

vi.mock("../../lib/api", () => ({
  runBacktest: vi.fn(),
  runBacktestCohort: vi.fn(),
  exportTextFile: vi.fn(),
}));

import * as api from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
import { HistoryScreen } from "./HistoryScreen";

// Recharts measures its container; jsdom has nothing to measure with.
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const rates = (r: number) => ({
  very_aggressive: r,
  aggressive: r,
  moderate: r,
  conservative: r,
  very_conservative: r,
});

const plan = {
  id: "base-plan",
  name: "Base plan",
  people: [
    {
      id: "p1",
      name: "Alex",
      birth: { year: 1966, month: 1 },
      retirement: { year: 2026, month: 1 },
      life_expectancy_age: 90,
    },
  ],
  accounts: [
    {
      id: "a",
      owner: "p1",
      kind: "Roth",
      name: "Roth",
      balance: 1_000_000,
      allocation: "Aggressive",
    },
  ],
  streams: [],
  social_security: [],
  assumptions: {
    inflation: 0.03,
    strategy_returns: rates(0.0635),
    strategy_volatility: rates(0.11),
  },
  sim_config: { start: { year: 2026, month: 1 }, display_real_dollars: true },
} as unknown as Plan;

const projection: Projection = { snapshots: [], warnings: [], streams: [], one_time: [] };

function cohort(
  start_year: number,
  overrides: Partial<CohortSummary> = {},
): CohortSummary {
  return {
    start_year,
    status: "Succeeded",
    periods_covered: 2,
    depleted_period: null,
    net_worth_real: [1, 1],
    end_net_worth_real: 1_500_000,
    min_net_worth_real: 1,
    ...overrides,
  };
}

const result: BacktestResult = {
  data_first_year: 1965,
  data_last_year: 1968,
  n_periods: 2,
  cohorts: [
    cohort(1965),
    cohort(1966, { status: "Depleted", depleted_period: 1, end_net_worth_real: 0 }),
    cohort(1967, { end_net_worth_real: 2_000_000 }),
    cohort(1968, { status: "InProgress", periods_covered: 1 }),
  ],
  succeeded: 2,
  depleted: 1,
  in_progress: 1,
  success_rate: 2 / 3,
  historical_real_return: rates(0.064),
};

function detail(start_year: number): CohortDetail {
  return {
    start_year,
    status: start_year === 1966 ? "Depleted" : "Succeeded",
    periods_covered: 1,
    depleted_period: null,
    projection: {
      snapshots: [
        {
          period: 0,
          period_start: { year: 2026, month: 1 },
          balances: { a: 900_000 },
          income: 0,
          expenses: 50_000,
          taxes: 0,
          contributions: 0,
          employer_match: 0,
          one_time_contributions: 0,
          required_distributions: 0,
          surplus: 0,
          withdrawals: { a: 50_000 },
          growth: -50_000,
          magi: 0,
          net_worth: 900_000,
          income_by_stream: {},
          expenses_by_stream: {},
          withdrawal_taxes: 0,
          early_withdrawal_penalty: 0,
          drawdown_phase: null,
          contributions_by_account: {},
          deflator: 1,
          deflator_end: 1.03,
        },
      ],
      warnings: [],
      streams: [],
      one_time: [],
    },
    market: [
      {
        historical_year: start_year,
        stocks: -0.1,
        bonds: 0.02,
        inflation: 0.034,
        strategy_returns: rates(-0.076),
      },
    ],
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.runBacktest).mockResolvedValue(result);
  vi.mocked(api.runBacktestCohort).mockImplementation(async (_plan, year) =>
    detail(year),
  );
  usePlanStore.setState({
    plan,
    projection,
    presets: { strategy_stock_share: { ...rates(0.6), aggressive: 0.8 } } as never,
    monteCarlo: { success_rate: 0.41 } as never,
    monteCarloStale: false,
    realDollars: true,
  });
});

describe("the History screen", () => {
  it("leads with the decided rate and says what it leaves out", async () => {
    render(<HistoryScreen />);
    await settle();
    expect(screen.getByText("67%")).toBeTruthy();
    expect(screen.getByText("1 of 3 start years ran out")).toBeTruthy();
    expect(screen.getByText(/1 recent ones are still going/)).toBeTruthy();
  });

  it("sets the two rates side by side, with what history paid against the plan", async () => {
    render(<HistoryScreen />);
    await settle();
    expect(screen.getByText("History: 67%")).toBeTruthy();
    expect(screen.getByText("Monte Carlo: 41%")).toBeTruthy();
    expect(screen.getByText(/the Aggressive mix \(80\/20\)/)).toBeTruthy();
    expect(screen.getByText("6.4%")).toBeTruthy();
  });

  it("opens the worst start year first, and another on request", async () => {
    render(<HistoryScreen />);
    await settle();
    expect(api.runBacktestCohort).toHaveBeenLastCalledWith(plan, 1966);
    expect(screen.getByRole("region", { name: "Starting in 1966" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next start year" }));
    await settle();
    expect(api.runBacktestCohort).toHaveBeenLastCalledWith(plan, 1967);
    expect(screen.getByRole("region", { name: "Starting in 1967" })).toBeTruthy();
  });

  it("shows each year's market figures in the ledger", async () => {
    render(<HistoryScreen />);
    await settle();
    const ledger = screen.getByRole("region", { name: "Starting in 1966" });
    expect(ledger.textContent).toContain("3.4%");
    expect(ledger.textContent).toContain("−10.0%");
  });
});
