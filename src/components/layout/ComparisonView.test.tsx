import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planSummary } from "../../test/fixtures";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";

// api.ts is the seam between this screen and Tauri IPC, so these tests cover
// the screen's own ordering against the backend's single run slot.
vi.mock("../../lib/api", () => ({
  loadPlanNamed: vi.fn(),
  runProjections: vi.fn(),
  runMonteCarlos: vi.fn(),
  cancelMonteCarlo: vi.fn(),
}));

import * as api from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
import { ComparisonView } from "./ComparisonView";

const base = {
  id: "base-plan",
  name: "Base plan",
  sim_config: { start: { year: 2026, month: 1 } },
} as unknown as Plan;
const other = { ...base, id: "other-plan", name: "Other plan" } as Plan;

const projection: Projection = { snapshots: [], warnings: [], streams: [], one_time: [] };
const limits = { min_paths: 100, max_paths: 100_000, auto_run_max_paths: 10_000 };
const planRun = { runId: 1, completed: 0, total: 1000 };

/** Lets the screen's projection effect and whatever follows it resolve. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(api.loadPlanNamed).mockResolvedValue(other);
  vi.mocked(api.runProjections).mockResolvedValue([
    { Ok: projection },
    { Ok: projection },
  ]);
  vi.mocked(api.runMonteCarlos).mockResolvedValue(null);
  vi.mocked(api.cancelMonteCarlo).mockResolvedValue(undefined);
  usePlanStore.setState({
    plan: base,
    projection,
    monteCarlo: null,
    monteCarloStale: false,
    monteCarloRun: null,
    monteCarloPaths: 1000,
    monteCarloLimits: limits,
    monteCarloSeed: 1,
    scenarios: [
      planSummary("base-plan", "Base plan"),
      planSummary("other-plan", "Other plan"),
    ],
    realDollars: false,
    error: null,
  });
});

describe("the Monte Carlo batch", () => {
  it("starts on its own when the batch is small", async () => {
    render(<ComparisonView />);
    await settle();

    expect(api.runMonteCarlos).toHaveBeenCalledTimes(1);
    const [plans, config] = vi.mocked(api.runMonteCarlos).mock.lastCall ?? [];
    expect(plans?.map((p) => p.id)).toEqual(["base-plan", "other-plan"]);
    expect(config).toEqual({ n_paths: 1000, seed: 1 });
  });

  it("waits for Run when paths times scenarios is over the threshold", async () => {
    usePlanStore.setState({ monteCarloPaths: 6000 });
    render(<ComparisonView />);
    await settle();

    expect(api.runMonteCarlos).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await settle();

    expect(api.runMonteCarlos).toHaveBeenCalledTimes(1);
  });

  it("leaves the Plan screen's run alone, and starts once its slot frees", async () => {
    usePlanStore.setState({ monteCarloRun: planRun });
    render(<ComparisonView />);
    await settle();

    expect(api.runMonteCarlos).not.toHaveBeenCalled();

    await act(async () => {
      usePlanStore.setState({ monteCarloRun: null });
    });
    await settle();

    expect(api.runMonteCarlos).toHaveBeenCalledTimes(1);
  });

  it("disables Run while the Plan screen's run holds the slot", async () => {
    usePlanStore.setState({ monteCarloPaths: 6000, monteCarloRun: null });
    render(<ComparisonView />);
    await settle();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();

    await act(async () => {
      usePlanStore.setState({ monteCarloRun: planRun });
    });

    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });

  it("clears its progress when a Plan run takes over mid-batch", async () => {
    vi.mocked(api.runMonteCarlos).mockReturnValue(new Promise(() => {}));
    render(<ComparisonView />);
    await settle();
    expect(screen.getByRole("progressbar")).toBeTruthy();

    await act(async () => {
      usePlanStore.setState({ monteCarloRun: planRun });
    });

    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("cancels the batch on leaving the screen", async () => {
    vi.mocked(api.runMonteCarlos).mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<ComparisonView />);
    await settle();
    const runId = vi.mocked(api.runMonteCarlos).mock.lastCall?.[2];

    unmount();

    expect(api.cancelMonteCarlo).toHaveBeenCalledWith(runId);
  });
});
