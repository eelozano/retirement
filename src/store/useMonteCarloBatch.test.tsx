import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { diagnostics } from "../test/fixtures";
import type { MonteCarloResult } from "../types/generated/MonteCarloResult";
import type { Plan } from "../types/generated/Plan";

vi.mock("../lib/api", () => ({
  runMonteCarlos: vi.fn(),
  cancelMonteCarlo: vi.fn(),
}));

import * as api from "../lib/api";
import { usePlanStore } from "./planStore";
import { type MonteCarloJob, useMonteCarloBatch } from "./useMonteCarloBatch";

const limits = { min_paths: 100, max_paths: 100_000, auto_run_max_paths: 5000 };
const planRun = { runId: 1, completed: 0, total: 1000 };

function job(key: string): MonteCarloJob {
  return { key, plan: { id: key } as Plan };
}

function result(success_rate: number): MonteCarloResult {
  return { n_paths: 1000, success_rate, percentiles: [], diagnostics: diagnostics() };
}

/** Renders the hook against `jobs`, re-rendering with whatever is passed to
 * `rerender`. */
function setup(jobs: MonteCarloJob[], ready = true) {
  return renderHook((props) => useMonteCarloBatch(props.jobs, props.ready), {
    initialProps: { jobs, ready },
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function startedKeys(): string[] {
  return (vi.mocked(api.runMonteCarlos).mock.lastCall?.[0] ?? []).map((p) => p.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.cancelMonteCarlo).mockResolvedValue(undefined);
  vi.mocked(api.runMonteCarlos).mockImplementation(async (plans) =>
    plans.map(() => ({ Ok: result(0.9) })),
  );
  usePlanStore.setState({
    monteCarloRun: null,
    monteCarloPaths: 1000,
    monteCarloLimits: limits,
    monteCarloSeed: 1,
  });
});

describe("starting", () => {
  it("runs a small job on its own, at the store's paths and seed", async () => {
    const { result: batch } = setup([job("a"), job("b")]);
    await flush();

    expect(startedKeys()).toEqual(["a", "b"]);
    expect(vi.mocked(api.runMonteCarlos).mock.lastCall?.[1]).toEqual({
      n_paths: 1000,
      seed: 1,
    });
    expect(batch.current.result("a")).toEqual(result(0.9));
    expect(batch.current.needsRun).toBe(false);
  });

  it("holds a large job until Run, and counts what is missing", async () => {
    const { result: batch } = setup([
      job("a"),
      job("b"),
      job("c"),
      job("d"),
      job("e"),
      job("f"),
    ]);
    await flush();

    expect(api.runMonteCarlos).not.toHaveBeenCalled();
    expect(batch.current.needsRun).toBe(true);
    expect(batch.current.missing).toBe(6);

    act(() => batch.current.run());
    await flush();

    expect(api.runMonteCarlos).toHaveBeenCalledTimes(1);
    expect(batch.current.needsRun).toBe(false);
  });

  it("does not let a later change inherit an earlier Run", async () => {
    const six = ["a", "b", "c", "d", "e", "f"].map(job);
    vi.mocked(api.runMonteCarlos).mockResolvedValue(null);
    const { result: batch, rerender } = setup(six);
    await flush();
    act(() => batch.current.run());
    await flush();
    expect(api.runMonteCarlos).toHaveBeenCalledTimes(1);

    rerender({ jobs: [...six, job("g")], ready: true });
    await flush();

    expect(api.runMonteCarlos).toHaveBeenCalledTimes(1);
    expect(batch.current.needsRun).toBe(true);
  });

  it("runs only what it has no answer for", async () => {
    const { rerender } = setup([job("a")]);
    await flush();

    rerender({ jobs: [job("a"), job("b")], ready: true });
    await flush();

    expect(startedKeys()).toEqual(["b"]);
  });

  it("does nothing until the screen says it is ready", async () => {
    const { rerender } = setup([job("a")], false);
    await flush();
    expect(api.runMonteCarlos).not.toHaveBeenCalled();

    rerender({ jobs: [job("a")], ready: true });
    await flush();
    expect(api.runMonteCarlos).toHaveBeenCalledTimes(1);
  });

  it("asks again at a new seed", async () => {
    const { result: batch } = setup([job("a")]);
    await flush();

    await act(async () => {
      usePlanStore.setState({ monteCarloSeed: 2 });
    });
    await flush();

    expect(api.runMonteCarlos).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.runMonteCarlos).mock.lastCall?.[1].seed).toBe(2);
    expect(batch.current.result("a")).toEqual(result(0.9));
  });
});

describe("the Plan screen's run goes first", () => {
  it("waits for it, then starts when the slot frees", async () => {
    usePlanStore.setState({ monteCarloRun: planRun });
    const { result: batch } = setup([job("a")]);
    await flush();

    expect(api.runMonteCarlos).not.toHaveBeenCalled();
    expect(batch.current.waiting).toBe(true);
    expect(batch.current.pending).toBe(true);

    await act(async () => {
      usePlanStore.setState({ monteCarloRun: null });
    });
    await flush();

    expect(api.runMonteCarlos).toHaveBeenCalledTimes(1);
    expect(batch.current.waiting).toBe(false);
  });

  it("gives way mid-batch, clears its progress, and retries", async () => {
    vi.mocked(api.runMonteCarlos).mockReturnValueOnce(new Promise(() => {}));
    const { result: batch } = setup([job("a")]);
    await flush();
    expect(batch.current.progress).not.toBeNull();

    await act(async () => {
      usePlanStore.setState({ monteCarloRun: planRun });
    });
    expect(batch.current.progress).toBeNull();

    await act(async () => {
      usePlanStore.setState({ monteCarloRun: null });
    });
    await flush();
    expect(api.runMonteCarlos).toHaveBeenCalledTimes(2);
  });
});

describe("stopping", () => {
  it("cancels the run on leaving the screen", async () => {
    vi.mocked(api.runMonteCarlos).mockReturnValue(new Promise(() => {}));
    const { unmount } = setup([job("a")]);
    await flush();
    const runId = vi.mocked(api.runMonteCarlos).mock.lastCall?.[2];

    unmount();

    expect(api.cancelMonteCarlo).toHaveBeenCalledWith(runId);
  });

  it("clears its progress when the question goes away mid-run", async () => {
    vi.mocked(api.runMonteCarlos).mockReturnValue(new Promise(() => {}));
    const { result: batch, rerender } = setup([job("a")]);
    await flush();

    rerender({ jobs: [], ready: true });
    await flush();

    expect(batch.current.progress).toBeNull();
    expect(batch.current.needsRun).toBe(false);
  });

  it("offers Run after a cancel, and keeps what it had", async () => {
    const { result: batch, rerender } = setup([job("a")]);
    await flush();

    let confirm: (value: null) => void = () => {};
    vi.mocked(api.runMonteCarlos).mockReturnValue(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    rerender({ jobs: [job("a"), job("b")], ready: true });
    await flush();

    act(() => batch.current.cancel());
    expect(api.cancelMonteCarlo).toHaveBeenCalled();
    await act(async () => confirm(null));

    expect(batch.current.progress).toBeNull();
    expect(batch.current.needsRun).toBe(true);
    expect(batch.current.result("a")).toEqual(result(0.9));
  });
});

describe("what it remembers", () => {
  it("does not retry a failure, and shows it as no result", async () => {
    vi.mocked(api.runMonteCarlos).mockResolvedValue([{ Err: "bad plan" }]);
    const { result: batch, rerender } = setup([job("a")]);
    await flush();

    rerender({ jobs: [job("a")], ready: true });
    await flush();

    expect(api.runMonteCarlos).toHaveBeenCalledTimes(1);
    expect(batch.current.result("a")).toBeNull();
    expect(batch.current.missing).toBe(0);
  });

  it("keeps twelve, dropping the oldest first", async () => {
    const { rerender } = setup([job("k0")]);
    await flush();
    for (let i = 1; i <= 12; i++) {
      rerender({ jobs: [job(`k${i}`)], ready: true });
      await flush();
    }
    expect(api.runMonteCarlos).toHaveBeenCalledTimes(13);

    // k1 is still held, so going back to it costs nothing...
    rerender({ jobs: [job("k1")], ready: true });
    await flush();
    expect(api.runMonteCarlos).toHaveBeenCalledTimes(13);

    // ...and k0, the oldest, was the one that had to go.
    rerender({ jobs: [job("k0")], ready: true });
    await flush();
    expect(api.runMonteCarlos).toHaveBeenCalledTimes(14);
    expect(startedKeys()).toEqual(["k0"]);
  });

  it("never drops what is currently asked for", async () => {
    // Twelve remembered, the oldest of which is still on screen.
    const { rerender } = setup([job("held")]);
    await flush();
    for (let i = 1; i <= 11; i++) {
      rerender({ jobs: [job("held"), job(`k${i}`)], ready: true });
      await flush();
    }

    rerender({ jobs: [job("held"), job("k12")], ready: true });
    await flush();

    // A thirteenth answer forced one out, and "held" was the oldest. Had it
    // gone, the hook would have run it again.
    expect(api.runMonteCarlos).toHaveBeenCalledTimes(13);
    expect(startedKeys()).toEqual(["k12"]);
  });
});
