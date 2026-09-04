import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonteCarloResult } from "../types/generated/MonteCarloResult";
import type { Plan } from "../types/generated/Plan";
import type { Projection } from "../types/generated/Projection";

// api.ts is the seam between the store and Tauri IPC — mocking it here
// (rather than the raw @tauri-apps/api/core invoke) keeps these tests about
// the store's own async ordering, not the IPC transport.
vi.mock("../lib/api", () => ({
  listPlans: vi.fn(),
  loadPlan: vi.fn(),
  loadPlanNamed: vi.fn(),
  runProjection: vi.fn(),
  savePlan: vi.fn(),
  setActivePlan: vi.fn(),
  duplicatePlan: vi.fn(),
  deletePlan: vi.fn(),
  getPresets: vi.fn(),
  runMonteCarlo: vi.fn(),
  getMonteCarloPaths: vi.fn(),
  setMonteCarloPaths: vi.fn(),
}));

import * as api from "../lib/api";
import { usePlanStore } from "./planStore";

function makePlan(overrides: Partial<Plan>): Plan {
  return {
    id: "base-plan",
    schema_version: 1,
    name: "Base plan",
    people: [],
    accounts: [],
    streams: [],
    social_security: [],
    assumptions: {
      inflation: 0.03,
      asset_returns: {},
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
      asset_volatility: {},
      reinvest_into: null,
    },
    sim_config: {
      start: { year: 2025, month: 1 },
      period: "Year",
      display_real_dollars: false,
    },
    ...overrides,
  };
}

const projection: Projection = { snapshots: [], warnings: [], streams: [] };

function mcResult(success_rate: number, n_paths: number): MonteCarloResult {
  return { n_paths, success_rate, percentiles: [] };
}

/** A promise whose resolution this test controls, so a run can be held open
 * while assertions are made about everything that should not be waiting on
 * it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The store's own debounce, plus enough slack that the timer has fired. */
const PAST_DEBOUNCE_MS = 400;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  usePlanStore.setState({
    scenarios: [],
    plan: null,
    projection: null,
    monteCarlo: null,
    monteCarloPaths: null,
    projecting: false,
    error: null,
    realDollars: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("switchScenario", () => {
  it("flushes a pending debounced edit before loading the other scenario", async () => {
    const base = makePlan({ id: "base-plan", name: "Base plan" });
    const editedBase = { ...base, name: "Edited base" };
    const sellHome = makePlan({ id: "sell-home", name: "Sell the home" });

    usePlanStore.setState({ plan: base, projection, scenarios: [] });
    vi.mocked(api.runProjection).mockResolvedValue(projection);
    vi.mocked(api.savePlan).mockResolvedValue(undefined);
    vi.mocked(api.loadPlanNamed).mockResolvedValue(sellHome);
    vi.mocked(api.setActivePlan).mockResolvedValue(undefined);

    // An edit lands but its 300ms debounce hasn't fired yet.
    usePlanStore.getState().updatePlan((draft) => {
      draft.name = editedBase.name;
    });
    expect(api.savePlan).not.toHaveBeenCalled();

    await usePlanStore.getState().switchScenario("sell-home");

    // The edit to the outgoing scenario was persisted, not dropped.
    expect(api.savePlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: "base-plan", name: "Edited base" }),
    );
    expect(api.loadPlanNamed).toHaveBeenCalledWith("sell-home");
    expect(usePlanStore.getState().plan?.id).toBe("sell-home");
  });

  it("is a no-op when switching to the already-active scenario", async () => {
    const base = makePlan({ id: "base-plan" });
    usePlanStore.setState({ plan: base, projection });

    await usePlanStore.getState().switchScenario("base-plan");

    expect(api.loadPlanNamed).not.toHaveBeenCalled();
  });
});

describe("duplicateActive", () => {
  it("duplicates the active scenario, refreshes the list, and switches to the copy", async () => {
    const base = makePlan({ id: "base-plan", name: "Base plan" });
    const copy = makePlan({ id: "sell-home", name: "Sell the home" });

    usePlanStore.setState({ plan: base, projection, scenarios: [] });
    vi.mocked(api.duplicatePlan).mockResolvedValue(copy);
    vi.mocked(api.listPlans).mockResolvedValue([
      { id: "base-plan", name: "Base plan" },
      { id: "sell-home", name: "Sell the home" },
    ]);
    vi.mocked(api.runProjection).mockResolvedValue(projection);
    vi.mocked(api.setActivePlan).mockResolvedValue(undefined);

    await usePlanStore.getState().duplicateActive("Sell the home");

    expect(api.duplicatePlan).toHaveBeenCalledWith("base-plan", "Sell the home");
    expect(usePlanStore.getState().scenarios).toHaveLength(2);
    expect(usePlanStore.getState().plan?.id).toBe("sell-home");
  });
});

describe("deleteScenario", () => {
  it("switches to another scenario when the active one is deleted", async () => {
    const base = makePlan({ id: "base-plan" });
    const sellHome = makePlan({ id: "sell-home", name: "Sell the home" });

    usePlanStore.setState({
      plan: base,
      projection,
      scenarios: [
        { id: "base-plan", name: "Base plan" },
        { id: "sell-home", name: "Sell the home" },
      ],
    });
    vi.mocked(api.deletePlan).mockResolvedValue(undefined);
    vi.mocked(api.listPlans).mockResolvedValue([
      { id: "sell-home", name: "Sell the home" },
    ]);
    vi.mocked(api.loadPlanNamed).mockResolvedValue(sellHome);
    vi.mocked(api.runProjection).mockResolvedValue(projection);
    vi.mocked(api.setActivePlan).mockResolvedValue(undefined);

    await usePlanStore.getState().deleteScenario("base-plan");

    expect(api.deletePlan).toHaveBeenCalledWith("base-plan");
    expect(usePlanStore.getState().plan?.id).toBe("sell-home");
  });

  it("leaves the active scenario alone when deleting a different one", async () => {
    const base = makePlan({ id: "base-plan" });
    usePlanStore.setState({
      plan: base,
      projection,
      scenarios: [
        { id: "base-plan", name: "Base plan" },
        { id: "sell-home", name: "Sell the home" },
      ],
    });
    vi.mocked(api.deletePlan).mockResolvedValue(undefined);
    vi.mocked(api.listPlans).mockResolvedValue([{ id: "base-plan", name: "Base plan" }]);

    await usePlanStore.getState().deleteScenario("sell-home");

    expect(api.loadPlanNamed).not.toHaveBeenCalled();
    expect(usePlanStore.getState().plan?.id).toBe("base-plan");
  });
});

// The point of these: Monte Carlo used to be awaited in the same
// `Promise.all` as the deterministic projection, so every tile on the Plan
// screen waited on it. Once the path count became a user setting that can
// reach 25,000 paths (~1.7s), that coupling would have stalled every edit.
// The contract now is that the projection never waits on Monte Carlo, and
// that a Monte Carlo result is only applied if it is still relevant when it
// lands.
describe("Monte Carlo decoupling", () => {
  it("applies the projection while the Monte Carlo run is still in flight", async () => {
    const base = makePlan({ id: "base-plan" });
    const previous = mcResult(0.9, 5000);
    const run = deferred<MonteCarloResult>();

    usePlanStore.setState({
      plan: base,
      projection: null,
      monteCarlo: previous,
      monteCarloPaths: 5000,
    });
    vi.mocked(api.runProjection).mockResolvedValue(projection);
    vi.mocked(api.savePlan).mockResolvedValue(undefined);
    vi.mocked(api.runMonteCarlo).mockReturnValue(run.promise);

    usePlanStore.getState().updatePlan((draft) => {
      draft.name = "Edited";
    });
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    // `run` is deliberately still unresolved. The deterministic half of the
    // screen is nonetheless done and no longer showing a pending state — this
    // is the assertion the old `Promise.all` could not have satisfied.
    expect(usePlanStore.getState().projection).toBe(projection);
    expect(usePlanStore.getState().projecting).toBe(false);
    // And the previous success rate is still on screen rather than blanked to
    // "—" for the duration of the run.
    expect(usePlanStore.getState().monteCarlo).toBe(previous);

    const fresh = mcResult(0.81, 5000);
    run.resolve(fresh);
    await vi.advanceTimersByTimeAsync(0);

    expect(usePlanStore.getState().monteCarlo).toBe(fresh);
  });

  it("drops a Monte Carlo result whose plan is no longer the active one", async () => {
    const base = makePlan({ id: "base-plan" });
    const previous = mcResult(0.9, 5000);
    const run = deferred<MonteCarloResult>();

    usePlanStore.setState({
      plan: base,
      projection,
      monteCarlo: previous,
      monteCarloPaths: 5000,
    });
    vi.mocked(api.runProjection).mockResolvedValue(projection);
    vi.mocked(api.savePlan).mockResolvedValue(undefined);
    vi.mocked(api.runMonteCarlo).mockReturnValue(run.promise);

    usePlanStore.getState().updatePlan((draft) => {
      draft.name = "Edited once";
    });
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    // A second edit lands while the first run is still going, so the run in
    // flight now describes a plan the user has already moved past.
    usePlanStore.getState().updatePlan((draft) => {
      draft.name = "Edited twice";
    });
    run.resolve(mcResult(0.42, 5000));
    await vi.advanceTimersByTimeAsync(0);

    expect(usePlanStore.getState().monteCarlo).toBe(previous);
  });

  it("clears the success rate on a scenario switch rather than showing the outgoing one", async () => {
    const base = makePlan({ id: "base-plan" });
    const sellHome = makePlan({ id: "sell-home", name: "Sell the home" });
    const run = deferred<MonteCarloResult>();

    usePlanStore.setState({
      plan: base,
      projection,
      monteCarlo: mcResult(0.9, 5000),
      monteCarloPaths: 5000,
    });
    vi.mocked(api.loadPlanNamed).mockResolvedValue(sellHome);
    vi.mocked(api.runProjection).mockResolvedValue(projection);
    vi.mocked(api.setActivePlan).mockResolvedValue(undefined);
    vi.mocked(api.runMonteCarlo).mockReturnValue(run.promise);

    await usePlanStore.getState().switchScenario("sell-home");

    // Unlike an edit, this is a different plan entirely — keeping the old
    // number would attribute one scenario's odds to another.
    expect(usePlanStore.getState().plan?.id).toBe("sell-home");
    expect(usePlanStore.getState().monteCarlo).toBeNull();
  });

  it("re-runs only Monte Carlo when the path count changes", async () => {
    const base = makePlan({ id: "base-plan" });
    const fresh = mcResult(0.895, 25000);

    usePlanStore.setState({
      plan: base,
      projection,
      monteCarlo: mcResult(0.89, 5000),
      monteCarloPaths: 5000,
    });
    vi.mocked(api.setMonteCarloPaths).mockResolvedValue(undefined);
    vi.mocked(api.runMonteCarlo).mockResolvedValue(fresh);

    await usePlanStore.getState().setMonteCarloPaths(25000);

    expect(api.setMonteCarloPaths).toHaveBeenCalledWith(25000);
    expect(api.runMonteCarlo).toHaveBeenCalledWith(base, {
      n_paths: 25000,
      seed: expect.any(Number),
    });
    // The deterministic projection does not depend on the path count.
    expect(api.runProjection).not.toHaveBeenCalled();
    expect(usePlanStore.getState().monteCarlo).toBe(fresh);
    expect(usePlanStore.getState().monteCarloPaths).toBe(25000);
  });
});
