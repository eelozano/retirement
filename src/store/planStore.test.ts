import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      flat_tax_rate: 0.15,
      plan_end_age: 95,
      sweep_surplus_to_taxable: false,
      social_security_cola: 0,
    },
    sim_config: {
      start: { year: 2025, month: 1 },
      period: "Year",
      display_real_dollars: false,
    },
    ...overrides,
  };
}

const projection: Projection = { snapshots: [], warnings: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  usePlanStore.setState({
    scenarios: [],
    plan: null,
    projection: null,
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
