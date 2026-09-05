import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";

// The sandbox's one invariant is that nothing it does reaches disk, so the
// seam that is mocked here is the whole IPC surface: if a hypothetical could
// be persisted, it would have to come through one of these.
vi.mock("../../lib/api", () => ({
  runProjection: vi.fn(),
  runProjections: vi.fn(),
  runMonteCarlo: vi.fn(),
  runMonteCarlos: vi.fn(),
  cancelMonteCarlo: vi.fn(),
  savePlan: vi.fn(),
  duplicatePlan: vi.fn(),
  deletePlan: vi.fn(),
  listPlans: vi.fn(),
  loadPlan: vi.fn(),
  loadPlanNamed: vi.fn(),
  setActivePlan: vi.fn(),
  restoreSnapshot: vi.fn(),
  getPresets: vi.fn(),
  getMonteCarloPaths: vi.fn(),
  setMonteCarloPaths: vi.fn(),
  getMonteCarloLimits: vi.fn(),
}));

import * as api from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
import { WhatIfScreen } from "./WhatIfScreen";

// Recharts measures its container; jsdom has no ResizeObserver to measure
// with. The chart renders at zero width, which is all this file needs — the
// assertions are about what was called, not what was drawn.
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

const plan = {
  id: "base-plan",
  schema_version: 1,
  name: "Base plan",
  people: [
    {
      id: "p1",
      name: "Alex",
      birth: { year: 1983, month: 8 },
      retirement: { year: 2038, month: 12 },
      life_expectancy_age: 90,
    },
  ],
  accounts: [],
  streams: [
    {
      id: "s1",
      name: "Spending",
      owner: null,
      direction: "Expense",
      annual_amount: 80_000,
      start: "PlanStart",
      end: "PlanEnd",
      growth: "Inflation",
      survivor_percentage: null,
    },
  ],
  social_security: [],
  assumptions: {
    inflation: 0.025,
    asset_returns: { UsEquity: 0.07 },
    asset_volatility: { UsEquity: 0.16 },
    filing_status: "Single",
    state_tax: {
      state: "Other",
      brackets: [{ up_to: null, rate: 0 }],
      standard_deduction: 0,
    },
    plan_end_age: 95,
    sweep_surplus_from: null,
    survivor_expense_factor: 1,
    social_security_cola: 0,
    reinvest_into: null,
  },
  sim_config: {
    start: { year: 2026, month: 1 },
    period: "Year",
    display_real_dollars: false,
  },
} as unknown as Plan;

const projection: Projection = { snapshots: [], warnings: [], streams: [] };

/** Past the screen's slider-settle debounce, and through whatever promises
 * the projection and Monte Carlo effects resolve. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
}

/** Drags a slider to `value` — `fireEvent.change` is how a range input is
 * moved without a pointer. */
function drag(label: string | RegExp, value: number) {
  fireEvent.change(screen.getByLabelText(label), { target: { value: String(value) } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(api.runProjection).mockResolvedValue(projection);
  vi.mocked(api.runMonteCarlos).mockResolvedValue(null);
  vi.mocked(api.cancelMonteCarlo).mockResolvedValue(undefined);
  usePlanStore.setState({
    plan,
    projection,
    monteCarlo: null,
    monteCarloStale: false,
    monteCarloRun: null,
    monteCarloPaths: 1000,
    monteCarloLimits: { min_paths: 100, max_paths: 100_000, auto_run_max_paths: 10_000 },
    monteCarloSeed: 1,
    scenarios: [{ id: "base-plan", name: "Base plan" }],
    realDollars: false,
    error: null,
  });
});

describe("the sandbox never writes", () => {
  it("moves every knob without persisting anything", async () => {
    render(<WhatIfScreen />);

    drag("Alex retires", -3);
    drag("Spending", 0.8);
    drag("Returns", -200);
    drag("Volatility", 1.75);
    drag("Inflation", 100);
    drag("Everyone lives", 7);
    await settle();

    expect(api.savePlan).not.toHaveBeenCalled();
    expect(api.duplicatePlan).not.toHaveBeenCalled();
    expect(api.setActivePlan).not.toHaveBeenCalled();
    // The plan the store holds — the one an autosave would write — is the
    // one that was loaded, object identity and all.
    expect(usePlanStore.getState().plan).toBe(plan);

    // Not a vacuous pass: the knobs did reach the engine, on a draft that is
    // not the saved plan.
    const draft = vi.mocked(api.runProjection).mock.lastCall?.[0];
    expect(draft).toBeDefined();
    expect(draft).not.toBe(plan);
    expect(draft?.people[0]?.retirement.year).toBe(2035);
    expect(draft?.people[0]?.life_expectancy_age).toBe(97);
    expect(draft?.streams[0]?.annual_amount).toBeCloseTo(64_000, 6);
    expect(draft?.assumptions.inflation).toBeCloseTo(0.035, 10);
    expect(draft?.assumptions.asset_returns.UsEquity).toBeCloseTo(0.05, 10);
    expect(draft?.assumptions.asset_volatility.UsEquity).toBeCloseTo(0.28, 10);
  });

  it("throws the hypothetical away when a knob comes back to rest", async () => {
    render(<WhatIfScreen />);

    drag("Spending", 0.8);
    await settle();
    drag("Spending", 1);
    await settle();

    const draft = vi.mocked(api.runProjection).mock.lastCall?.[0];
    expect(draft?.streams[0]?.annual_amount).toBe(80_000);
    expect(api.savePlan).not.toHaveBeenCalled();
  });
});

describe("save as scenario", () => {
  it("is the one path to disk, and lands on a copy", async () => {
    const copy = { ...structuredClone(plan), id: "spend-less", name: "Spend less" };
    vi.mocked(api.duplicatePlan).mockResolvedValue(copy);
    vi.mocked(api.savePlan).mockResolvedValue(undefined);
    vi.mocked(api.listPlans).mockResolvedValue([
      { id: "base-plan", name: "Base plan" },
      { id: "spend-less", name: "Spend less" },
    ]);
    vi.mocked(api.setActivePlan).mockResolvedValue(undefined);

    render(<WhatIfScreen />);
    drag("Spending", 0.8);
    await settle();

    // The name is offered, not demanded: it says what the scenario is.
    const name = screen.getByLabelText("Save as scenario") as HTMLInputElement;
    expect(name.value).toBe("Base plan — spending −20%");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();

    expect(api.duplicatePlan).toHaveBeenCalledWith(
      "base-plan",
      "Base plan — spending −20%",
    );
    expect(api.savePlan).toHaveBeenCalledTimes(1);
    expect(api.savePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "spend-less",
        streams: [expect.objectContaining({ annual_amount: 64_000 })],
      }),
    );
  });

  it("has nothing to save until a knob moves", () => {
    render(<WhatIfScreen />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("the saved plan moving underneath", () => {
  it("says so when an edit lands while a knob is off its rest position", async () => {
    render(<WhatIfScreen />);
    drag("Spending", 0.9);
    await settle();

    const edited = structuredClone(plan);
    edited.assumptions.inflation = 0.04;
    await act(async () => {
      usePlanStore.setState({ plan: edited });
    });

    expect(screen.getByRole("status")).toHaveTextContent(/changed while this was open/);
    // Rebuilt from the new plan, same knobs.
    const draft = vi.mocked(api.runProjection).mock.lastCall?.[0];
    expect(draft?.assumptions.inflation).toBe(0.04);
    expect(draft?.streams[0]?.annual_amount).toBeCloseTo(72_000, 6);
  });

  it("stays quiet for a rename, which moves no number", async () => {
    render(<WhatIfScreen />);
    drag("Spending", 0.9);
    await settle();

    await act(async () => {
      usePlanStore.setState({ plan: { ...structuredClone(plan), name: "Base plan v2" } });
    });

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("resets the knobs when the scenario itself changes", async () => {
    render(<WhatIfScreen />);
    drag("Spending", 0.9);
    await settle();

    await act(async () => {
      usePlanStore.setState({
        plan: { ...structuredClone(plan), id: "other-plan", name: "Other plan" },
      });
    });
    await settle();

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    const draft = vi.mocked(api.runProjection).mock.lastCall?.[0];
    expect(draft?.streams[0]?.annual_amount).toBe(80_000);
  });
});

describe("the run control", () => {
  it("runs both sides in one batch, at one seed", async () => {
    render(<WhatIfScreen />);
    drag("Spending", 0.9);
    await settle();

    const [plans, config] = vi.mocked(api.runMonteCarlos).mock.lastCall ?? [];
    expect(plans).toHaveLength(2);
    expect(plans?.[0]?.streams[0]?.annual_amount).toBe(80_000);
    expect(plans?.[1]?.streams[0]?.annual_amount).toBeCloseTo(72_000, 6);
    expect(config).toEqual({ n_paths: 1000, seed: 1 });
  });

  it("holds the run back above the on-demand threshold, and offers it", async () => {
    usePlanStore.setState({ monteCarloPaths: 50_000 });
    render(<WhatIfScreen />);
    drag("Spending", 0.9);
    await settle();

    expect(api.runMonteCarlos).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await settle();

    expect(api.runMonteCarlos).toHaveBeenCalledTimes(1);
  });
});
