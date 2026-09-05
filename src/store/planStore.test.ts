import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnostics } from "../test/fixtures";
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
  cancelMonteCarlo: vi.fn(),
  getMonteCarloPaths: vi.fn(),
  setMonteCarloPaths: vi.fn(),
  getMonteCarloLimits: vi.fn(),
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
  return { n_paths, success_rate, percentiles: [], diagnostics: diagnostics() };
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

describe("promoteToScenario", () => {
  it("applies the recipe to the copy, saves it, and switches to it", async () => {
    const base = makePlan({ id: "base-plan", name: "Base plan" });
    const copy = makePlan({ id: "spend-less", name: "Spend less" });

    usePlanStore.setState({ plan: base, projection, scenarios: [] });
    vi.mocked(api.duplicatePlan).mockResolvedValue(copy);
    vi.mocked(api.savePlan).mockResolvedValue(undefined);
    vi.mocked(api.listPlans).mockResolvedValue([
      { id: "base-plan", name: "Base plan" },
      { id: "spend-less", name: "Spend less" },
    ]);
    vi.mocked(api.runProjection).mockResolvedValue(projection);
    vi.mocked(api.setActivePlan).mockResolvedValue(undefined);

    await usePlanStore.getState().promoteToScenario("Spend less", (draft) => {
      draft.assumptions.inflation = 0.05;
    });

    expect(api.duplicatePlan).toHaveBeenCalledWith("base-plan", "Spend less");
    expect(api.savePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "spend-less",
        assumptions: expect.objectContaining({ inflation: 0.05 }),
      }),
    );
    expect(usePlanStore.getState().plan?.id).toBe("spend-less");
    expect(usePlanStore.getState().plan?.assumptions.inflation).toBe(0.05);
    // The scenario it was promoted from is untouched — that is the whole
    // point of promoting rather than editing.
    expect(base.assumptions.inflation).toBe(0.03);
  });

  it("keeps the copy's identity whatever the recipe does to it", async () => {
    const base = makePlan({ id: "base-plan", name: "Base plan" });
    const copy = makePlan({ id: "spend-less", name: "Spend less" });

    usePlanStore.setState({ plan: base, projection, scenarios: [] });
    vi.mocked(api.duplicatePlan).mockResolvedValue(copy);
    vi.mocked(api.savePlan).mockResolvedValue(undefined);
    vi.mocked(api.listPlans).mockResolvedValue([]);
    vi.mocked(api.runProjection).mockResolvedValue(projection);
    vi.mocked(api.setActivePlan).mockResolvedValue(undefined);

    await usePlanStore.getState().promoteToScenario("Spend less", (draft) => {
      draft.id = "base-plan";
      draft.name = "Base plan";
    });

    // A recipe that reaches for the id must not be able to write over the
    // plan it was branched from.
    expect(api.savePlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: "spend-less", name: "Spend less" }),
    );
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
    // Resolves once saved, not once the run lands.
    await vi.advanceTimersByTimeAsync(0);

    expect(api.setMonteCarloPaths).toHaveBeenCalledWith(25000);
    expect(api.runMonteCarlo).toHaveBeenCalledWith(
      base,
      { n_paths: 25000, seed: expect.any(Number) },
      expect.any(Number),
      expect.any(Function),
    );
    // The deterministic projection does not depend on the path count.
    expect(api.runProjection).not.toHaveBeenCalled();
    expect(usePlanStore.getState().monteCarlo).toBe(fresh);
    expect(usePlanStore.getState().monteCarloPaths).toBe(25000);
  });
});

/** The threshold as the backend would report it, with the path count set
 * either side of it. */
const limits = { min_paths: 100, max_paths: 100_000, auto_run_max_paths: 5000 };

/** The `onProgress` callback the store handed to the most recent run. */
function lastProgressCallback() {
  const calls = vi.mocked(api.runMonteCarlo).mock.calls;
  return calls[calls.length - 1][3];
}

describe("Monte Carlo run control", () => {
  beforeEach(() => {
    vi.mocked(api.runProjection).mockResolvedValue(projection);
    vi.mocked(api.savePlan).mockResolvedValue(undefined);
    vi.mocked(api.cancelMonteCarlo).mockResolvedValue(undefined);
  });

  it("above the threshold, an edit marks the result stale and does not re-run", async () => {
    const base = makePlan({ id: "base-plan" });
    const previous = mcResult(0.9, 25000);
    usePlanStore.setState({
      plan: base,
      projection,
      monteCarlo: previous,
      monteCarloPaths: 25000,
      monteCarloLimits: limits,
      monteCarloStale: false,
      monteCarloRun: null,
    });

    usePlanStore.getState().updatePlan((draft) => {
      draft.name = "Edited";
    });
    // Stale from the keystroke, before the debounce has fired.
    expect(usePlanStore.getState().monteCarloStale).toBe(true);

    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
    expect(api.runProjection).toHaveBeenCalled();
    expect(api.runMonteCarlo).not.toHaveBeenCalled();
    // The last figure stays on screen, flagged, rather than blanking.
    expect(usePlanStore.getState().monteCarlo).toBe(previous);
  });

  it("at or below the threshold, an edit re-runs as before without flagging stale", async () => {
    const base = makePlan({ id: "base-plan" });
    const fresh = mcResult(0.88, 5000);
    usePlanStore.setState({
      plan: base,
      projection,
      monteCarlo: mcResult(0.9, 5000),
      monteCarloPaths: 5000,
      monteCarloLimits: limits,
      monteCarloStale: false,
      monteCarloRun: null,
    });
    vi.mocked(api.runMonteCarlo).mockResolvedValue(fresh);

    usePlanStore.getState().updatePlan((draft) => {
      draft.name = "Edited";
    });
    expect(usePlanStore.getState().monteCarloStale).toBe(false);

    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
    expect(api.runMonteCarlo).toHaveBeenCalledTimes(1);
    expect(usePlanStore.getState().monteCarlo).toBe(fresh);
    expect(usePlanStore.getState().monteCarloRun).toBeNull();
  });

  it("an on-demand edit cancels the run in flight instead of letting it land", async () => {
    const base = makePlan({ id: "base-plan" });
    const run = deferred<MonteCarloResult | null>();
    usePlanStore.setState({
      plan: base,
      projection,
      monteCarlo: mcResult(0.9, 25000),
      monteCarloPaths: 25000,
      monteCarloLimits: limits,
      monteCarloRun: null,
    });
    vi.mocked(api.runMonteCarlo).mockReturnValue(run.promise);

    usePlanStore.getState().runMonteCarloNow();
    const runId = usePlanStore.getState().monteCarloRun?.runId;
    expect(runId).toEqual(expect.any(Number));

    usePlanStore.getState().updatePlan((draft) => {
      draft.name = "Edited";
    });
    expect(api.cancelMonteCarlo).toHaveBeenCalledWith(runId);

    // The backend confirms the cancel with a null result.
    run.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(usePlanStore.getState().monteCarloRun).toBeNull();
    expect(usePlanStore.getState().monteCarloStale).toBe(true);
  });

  it("cancel keeps the previous result on screen and marks it stale", async () => {
    const base = makePlan({ id: "base-plan" });
    const previous = mcResult(0.9, 25000);
    const run = deferred<MonteCarloResult | null>();
    usePlanStore.setState({
      plan: base,
      projection,
      monteCarlo: previous,
      monteCarloPaths: 25000,
      monteCarloLimits: limits,
      monteCarloStale: false,
      monteCarloRun: null,
    });
    vi.mocked(api.runMonteCarlo).mockReturnValue(run.promise);

    usePlanStore.getState().runMonteCarloNow();
    usePlanStore.getState().cancelMonteCarlo();
    // Stale as of the click, not as of the backend's confirmation.
    expect(usePlanStore.getState().monteCarloStale).toBe(true);

    run.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    // The old `.catch(() => null)` path would have blanked this to "—".
    expect(usePlanStore.getState().monteCarlo).toBe(previous);
    expect(usePlanStore.getState().monteCarloRun).toBeNull();
  });

  it("ignores the outcome of a superseded run, including its cancellation", async () => {
    const base = makePlan({ id: "base-plan" });
    const first = deferred<MonteCarloResult | null>();
    const second = deferred<MonteCarloResult | null>();
    usePlanStore.setState({
      plan: base,
      projection,
      monteCarlo: null,
      monteCarloPaths: 25000,
      monteCarloLimits: limits,
      monteCarloRun: null,
    });
    vi.mocked(api.runMonteCarlo)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    usePlanStore.getState().runMonteCarloNow();
    usePlanStore.getState().runMonteCarloNow();
    const secondId = usePlanStore.getState().monteCarloRun?.runId;

    // The backend cancelled the first run when the second started. Its null
    // must not clear the second run's in-flight state...
    first.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(usePlanStore.getState().monteCarloRun?.runId).toBe(secondId);

    // ...and a late progress tick from it is ignored too.
    lastProgressCallback()({ run_id: (secondId ?? 0) - 1, completed: 99, total: 25000 });
    expect(usePlanStore.getState().monteCarloRun?.completed).toBe(0);

    const fresh = mcResult(0.91, 25000);
    second.resolve(fresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(usePlanStore.getState().monteCarlo).toBe(fresh);
    expect(usePlanStore.getState().monteCarloRun).toBeNull();
    expect(usePlanStore.getState().monteCarloStale).toBe(false);
  });

  it("applies progress ticks to the run in flight", async () => {
    const base = makePlan({ id: "base-plan" });
    const run = deferred<MonteCarloResult | null>();
    usePlanStore.setState({
      plan: base,
      projection,
      monteCarlo: null,
      monteCarloPaths: 50000,
      monteCarloLimits: limits,
      monteCarloRun: null,
    });
    vi.mocked(api.runMonteCarlo).mockReturnValue(run.promise);

    usePlanStore.getState().runMonteCarloNow();
    const runId = usePlanStore.getState().monteCarloRun?.runId ?? 0;
    expect(usePlanStore.getState().monteCarloRun).toEqual({
      runId,
      completed: 0,
      total: 50000,
    });

    lastProgressCallback()({ run_id: runId, completed: 12400, total: 50000 });
    expect(usePlanStore.getState().monteCarloRun).toEqual({
      runId,
      completed: 12400,
      total: 50000,
    });
  });

  it("re-roll draws a new session seed and runs with it", async () => {
    const base = makePlan({ id: "base-plan" });
    const fresh = mcResult(0.87, 5000);
    usePlanStore.setState({
      plan: base,
      projection,
      monteCarlo: mcResult(0.9, 5000),
      monteCarloPaths: 5000,
      monteCarloLimits: limits,
      monteCarloSeed: 1,
      monteCarloRun: null,
    });
    vi.mocked(api.runMonteCarlo).mockResolvedValue(fresh);

    usePlanStore.getState().rerollSeed();
    const seed = usePlanStore.getState().monteCarloSeed;
    expect(seed).not.toBe(1);
    expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true);
    expect(api.runMonteCarlo).toHaveBeenCalledWith(
      base,
      { n_paths: 5000, seed },
      expect.any(Number),
      expect.any(Function),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(usePlanStore.getState().monteCarlo).toBe(fresh);
  });

  it("a failed run blanks the tile rather than leaving a wrong figure up", async () => {
    const base = makePlan({ id: "base-plan" });
    usePlanStore.setState({
      plan: base,
      projection,
      monteCarlo: mcResult(0.9, 5000),
      monteCarloPaths: 5000,
      monteCarloLimits: limits,
      monteCarloStale: true,
      monteCarloRun: null,
    });
    vi.mocked(api.runMonteCarlo).mockRejectedValue(new Error("invalid plan"));

    usePlanStore.getState().runMonteCarloNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(usePlanStore.getState().monteCarlo).toBeNull();
    expect(usePlanStore.getState().monteCarloStale).toBe(false);
    expect(usePlanStore.getState().monteCarloRun).toBeNull();
  });
});
