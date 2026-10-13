import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import demoBaseJson from "../../../fixtures/demo/screens/demo-base.json";
import newHouseholdJson from "../../../fixtures/demo/screens/new-household.json";
import type { PlanSummary } from "../../lib/api";
import { planSummary } from "../../test/fixtures";
import type { BacktestResult } from "../../types/generated/BacktestResult";
import type { CohortDetail } from "../../types/generated/CohortDetail";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { Plan } from "../../types/generated/Plan";
import type { Presets } from "../../types/generated/Presets";
import type { Projection } from "../../types/generated/Projection";

// Every call a screen or the store can make across the IPC boundary. Mocked
// whole, so a screen that reaches for one the test did not anticipate gets
// `undefined` — and fails here — rather than a Tauri error nobody reads.
vi.mock("../../lib/api");

import * as api from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
import { CashFlowScreen } from "./CashFlowScreen";
import { ComparisonView } from "./ComparisonView";
import { Dashboard } from "./Dashboard";
import { GrowthScreen } from "./GrowthScreen";
import { HistoryScreen } from "./HistoryScreen";
import { PlanScreen } from "./PlanScreen";
import { ReportView } from "./ReportView";
import { ScenariosScreen } from "./ScenariosScreen";
import { WhatIfScreen } from "./WhatIfScreen";

// A screen that throws on a state nobody tried reaches the app as a blank
// window, and the chart mappers' tests cannot see it: they pin the numbers,
// not whether the screen that composes them survives a household with people
// and nothing else (#103), no Monte Carlo result yet, or a run in flight.
//
// So this renders every screen in each of those states and asserts only that
// it did not throw and that one landmark is there. No chart internals —
// jsdom has no layout, and what Recharts draws is Recharts' business.
//
// The data is what the engine returned, not what a test author guessed:
// `fixtures/demo/screens/*.json` are written by `src-tauri/tests/demo_fixtures.rs`
// and fail there when the engine's output changes shape.

/** What `demo_fixtures.rs` writes: a plan and every result a screen fetches. */
interface ScreenFixture {
  plan: Plan;
  projection: Projection;
  monte_carlo: MonteCarloResult | null;
  backtest: BacktestResult;
  cohort: CohortDetail;
  strategy_stock_share: Presets["strategy_stock_share"];
}

const demo = demoBaseJson as unknown as ScreenFixture;
const created = newHouseholdJson as unknown as ScreenFixture;

interface State {
  name: string;
  fixture: ScreenFixture;
  scenarios: PlanSummary[];
  /** What the store holds for Monte Carlo, and what a started batch does. */
  monteCarlo: "finished" | "none" | "running";
}

/** A copy of the open plan under another id, for the scenarios the screens
 * load by name. */
function sibling(plan: Plan, id: string, name: string): Plan {
  return { ...plan, id, name };
}

const SECOND = "second-scenario";

const states: State[] = [
  {
    name: "the demo household, Monte Carlo finished",
    fixture: demo,
    scenarios: [
      planSummary(demo.plan.id, demo.plan.name),
      planSummary(SECOND, "Second scenario"),
    ],
    monteCarlo: "finished",
  },
  {
    name: "a household just created: people only, no Monte Carlo",
    fixture: created,
    scenarios: [planSummary(created.plan.id, created.plan.name)],
    monteCarlo: "none",
  },
  {
    name: "a Monte Carlo run in progress",
    fixture: demo,
    scenarios: [
      planSummary(demo.plan.id, demo.plan.name),
      planSummary(SECOND, "Second scenario"),
    ],
    monteCarlo: "running",
  },
];

function install(state: State) {
  const { fixture } = state;
  const result = fixture.monte_carlo;

  vi.mocked(api.runProjection).mockResolvedValue(fixture.projection);
  vi.mocked(api.runProjections).mockImplementation(async (plans) =>
    plans.map(() => ({ Ok: fixture.projection })),
  );
  vi.mocked(api.loadPlanNamed).mockImplementation(async (id) =>
    sibling(fixture.plan, id, "Second scenario"),
  );
  vi.mocked(api.runBacktest).mockResolvedValue(fixture.backtest);
  vi.mocked(api.runBacktestCohort).mockResolvedValue(fixture.cohort);
  vi.mocked(api.cancelMonteCarlo).mockResolvedValue(undefined);

  vi.mocked(api.runMonteCarlos).mockImplementation(
    async (plans, _config, runId, onProgress) => {
      if (state.monteCarlo === "running") {
        onProgress({ run_id: runId, completed: 250, total: 1000 });
        return new Promise(() => {});
      }
      return plans.map(() => (result ? { Ok: result } : { Err: "not run" }));
    },
  );
}

function open(state: State) {
  const { fixture } = state;
  usePlanStore.setState({
    ...usePlanStore.getInitialState(),
    initialized: true,
    plan: fixture.plan,
    projection: fixture.projection,
    presets: { strategy_stock_share: fixture.strategy_stock_share } as Presets,
    scenarios: state.scenarios,
    monteCarlo: state.monteCarlo === "finished" ? fixture.monte_carlo : null,
    monteCarloRun:
      state.monteCarlo === "running" ? { runId: 1, completed: 250, total: 1000 } : null,
    projecting: state.monteCarlo === "running",
    monteCarloPaths: 1000,
    monteCarloLimits: { min_paths: 100, max_paths: 100_000, auto_run_max_paths: 10_000 },
    realDollars: true,
  });
}

/** Lets the mocked results land and the screen render again with them: a
 * crash that depends on the shape of fetched data happens on that render. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const noop = () => {};

interface Screen {
  name: string;
  element: () => ReactElement;
  /** The landmark that says the screen is there, for a state: the one
   * section it always shows, or what it shows in place of it. */
  landmark: (state: State) => () => HTMLElement;
}

const region = (name: string) => () => screen.getByRole("region", { name });

const screens: Screen[] = [
  {
    name: "Plan",
    element: () => (
      <PlanScreen onOpenCashFlow={noop} onOpenAccounts={noop} onOpenRefresh={noop} />
    ),
    // With no accounts there is nothing to chart, and the screen says so.
    landmark: (state) =>
      state.fixture.plan.accounts.length === 0
        ? () => screen.getByText(/Add an account under Inputs/)
        : region("Projection"),
  },
  {
    name: "Cash flow",
    element: () => <CashFlowScreen />,
    landmark: () => region("Cash flow"),
  },
  {
    name: "Growth",
    element: () => <GrowthScreen />,
    landmark: () => region("Growth"),
  },
  {
    name: "Scenarios",
    element: () => <ScenariosScreen />,
    landmark: (state) => () => {
      // The comparison is part of this destination once there is more than one
      // scenario to compare.
      if (state.scenarios.length > 1) {
        screen.getByRole("heading", { name: "Compare scenarios" });
      }
      return region("Scenarios")();
    },
  },
  {
    name: "History",
    element: () => <HistoryScreen />,
    landmark: () => region("History headline"),
  },
  {
    name: "What-if",
    element: () => <WhatIfScreen />,
    landmark: () => region("What-if controls"),
  },
  {
    name: "Report",
    element: () => <ReportView open onClose={noop} />,
    landmark: (state) => () =>
      screen.getByRole("heading", { level: 1, name: state.fixture.plan.name }),
  },
];

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // React reports an error it caught — an error boundary, a failed effect —
  // here rather than throwing, so a render that "passes" can still have failed.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe.each(states)("with $name", (state) => {
  beforeEach(() => {
    install(state);
    open(state);
  });

  it.each(screens)("renders the $name screen", async (s) => {
    render(s.element());
    await settle();
    expect(s.landmark(state)()).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("renders the app shell", async () => {
    render(<Dashboard />);
    await settle();
    expect(screen.getByRole("textbox", { name: "Scenario name" })).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("comparing scenarios", () => {
  // The first thing a user can do after #103 is branch the household they just
  // described, which puts a second scenario beside an empty one.
  it("renders for a household just created and a branch of it", async () => {
    const state: State = {
      ...states[1],
      scenarios: [
        planSummary(created.plan.id, created.plan.name),
        planSummary(SECOND, "Branch"),
      ],
    };
    install(state);
    open(state);
    render(<ComparisonView />);
    await settle();
    expect(
      screen.getByRole("heading", { name: "Compare scenarios" }),
    ).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
