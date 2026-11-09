import { beforeEach, describe, expect, it, vi } from "vitest";
import { diagnostics } from "../test/fixtures";
import type { MonteCarloResult } from "../types/generated/MonteCarloResult";
import type { Plan } from "../types/generated/Plan";

vi.mock("./api", () => ({
  runMonteCarlos: vi.fn(),
  cancelMonteCarlo: vi.fn(),
}));

import type { MonteCarloResultEntry } from "./api";
import * as api from "./api";
import { createMonteCarloRunner, withinAutoRun } from "./monteCarloRunner";

const plan = { id: "a" } as Plan;
const other = { id: "b" } as Plan;
const config = { n_paths: 1000, seed: 7 };

function result(success_rate: number): MonteCarloResult {
  return { n_paths: 1000, success_rate, percentiles: [], diagnostics: diagnostics() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Batch = MonteCarloResultEntry[] | null;

/** The id the backend was given for the most recent run. */
function lastRunId(): number {
  return vi.mocked(api.runMonteCarlos).mock.lastCall?.[2] ?? -1;
}

/** The progress callback the backend was given for the most recent run. */
function backendProgress() {
  const report = vi.mocked(api.runMonteCarlos).mock.lastCall?.[3];
  if (!report) throw new Error("no run started");
  return report;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.cancelMonteCarlo).mockResolvedValue(undefined);
});

describe("how a run ends", () => {
  it("finishes with one outcome per plan, in order, naming the plan that failed", async () => {
    vi.mocked(api.runMonteCarlos).mockResolvedValue([
      { Ok: result(0.9) },
      { Err: "not a valid plan" },
    ]);

    const ending = await createMonteCarloRunner().start([plan, other], config, () => {});

    expect(ending).toEqual({ ended: "finished", outcomes: [result(0.9), "failed"] });
  });

  it("marks every plan failed when the whole run is rejected", async () => {
    vi.mocked(api.runMonteCarlos).mockRejectedValue(new Error("worker died"));

    const ending = await createMonteCarloRunner().start([plan, other], config, () => {});

    expect(ending).toEqual({ ended: "finished", outcomes: ["failed", "failed"] });
  });

  it("is cancelled when the backend reports no result", async () => {
    vi.mocked(api.runMonteCarlos).mockResolvedValue(null);

    const ending = await createMonteCarloRunner().start([plan], config, () => {});

    expect(ending).toEqual({ ended: "cancelled" });
  });

  it("is replaced when the same runner starts another, whatever the first resolves to", async () => {
    const first = deferred<Batch>();
    vi.mocked(api.runMonteCarlos).mockReturnValueOnce(first.promise);
    vi.mocked(api.runMonteCarlos).mockResolvedValueOnce([{ Ok: result(0.5) }]);
    const runner = createMonteCarloRunner();

    const firstEnding = runner.start([plan], config, () => {});
    const secondEnding = runner.start([plan], config, () => {});
    first.resolve(null);

    expect(await firstEnding).toEqual({ ended: "replaced" });
    expect(await secondEnding).toEqual({ ended: "finished", outcomes: [result(0.5)] });
  });

  it("is replaced when abandoned, and tells the backend to stop", async () => {
    const run = deferred<Batch>();
    vi.mocked(api.runMonteCarlos).mockReturnValue(run.promise);
    const runner = createMonteCarloRunner();

    const ending = runner.start([plan], config, () => {});
    runner.abandon();

    expect(api.cancelMonteCarlo).toHaveBeenCalledWith(lastRunId());
    run.resolve([{ Ok: result(0.9) }]);
    expect(await ending).toEqual({ ended: "replaced" });
  });
});

describe("cancelling", () => {
  it("stops the run in flight, and ends only when the backend confirms", async () => {
    const run = deferred<Batch>();
    vi.mocked(api.runMonteCarlos).mockReturnValue(run.promise);
    const runner = createMonteCarloRunner();

    const ending = runner.start([plan], config, () => {});
    runner.cancel();
    expect(api.cancelMonteCarlo).toHaveBeenCalledWith(lastRunId());

    run.resolve(null);
    expect(await ending).toEqual({ ended: "cancelled" });
  });

  it("does nothing once the run has ended", async () => {
    vi.mocked(api.runMonteCarlos).mockResolvedValue([{ Ok: result(0.9) }]);
    const runner = createMonteCarloRunner();

    await runner.start([plan], config, () => {});
    runner.cancel();
    runner.abandon();

    expect(api.cancelMonteCarlo).not.toHaveBeenCalled();
  });

  it("swallows a cancel the backend refuses", async () => {
    vi.mocked(api.runMonteCarlos).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.cancelMonteCarlo).mockRejectedValue(new Error("gone"));
    const runner = createMonteCarloRunner();

    void runner.start([plan], config, () => {});

    expect(() => runner.cancel()).not.toThrow();
  });
});

describe("progress", () => {
  it("reports zero of the whole batch before the backend says anything", () => {
    vi.mocked(api.runMonteCarlos).mockReturnValue(new Promise(() => {}));
    const onProgress = vi.fn();

    void createMonteCarloRunner().start([plan, other], config, onProgress);

    expect(onProgress).toHaveBeenCalledExactlyOnceWith({
      runId: lastRunId(),
      completed: 0,
      total: 2000,
    });
  });

  it("passes on ticks from the run in flight", () => {
    vi.mocked(api.runMonteCarlos).mockReturnValue(new Promise(() => {}));
    const onProgress = vi.fn();

    void createMonteCarloRunner().start([plan], config, onProgress);
    backendProgress()({ run_id: lastRunId(), completed: 400, total: 1000 });

    expect(onProgress).toHaveBeenLastCalledWith({
      runId: lastRunId(),
      completed: 400,
      total: 1000,
    });
  });

  it("ignores a tick carrying another run's id", () => {
    vi.mocked(api.runMonteCarlos).mockReturnValue(new Promise(() => {}));
    const onProgress = vi.fn();

    void createMonteCarloRunner().start([plan], config, onProgress);
    backendProgress()({ run_id: lastRunId() - 1, completed: 400, total: 1000 });

    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("ignores a late tick from a run that has been replaced or abandoned", () => {
    vi.mocked(api.runMonteCarlos).mockReturnValue(new Promise(() => {}));
    const runner = createMonteCarloRunner();
    const onFirst = vi.fn();

    void runner.start([plan], config, onFirst);
    const report = backendProgress();
    const firstId = lastRunId();
    void runner.start([plan], config, () => {});
    report({ run_id: firstId, completed: 400, total: 1000 });
    expect(onFirst).toHaveBeenCalledTimes(1);

    const onThird = vi.fn();
    void runner.start([plan], config, onThird);
    const reportThird = backendProgress();
    const thirdId = lastRunId();
    runner.abandon();
    reportThird({ run_id: thirdId, completed: 400, total: 1000 });
    expect(onThird).toHaveBeenCalledTimes(1);
  });
});

describe("run ids", () => {
  it("are never reused across runners, so a Cancel cannot stop the wrong run", () => {
    vi.mocked(api.runMonteCarlos).mockReturnValue(new Promise(() => {}));

    void createMonteCarloRunner().start([plan], config, () => {});
    const first = lastRunId();
    void createMonteCarloRunner().start([plan], config, () => {});

    expect(lastRunId()).toBeGreaterThan(first);
  });
});

describe("the auto-run threshold", () => {
  const limits = { min_paths: 100, max_paths: 100_000, auto_run_max_paths: 5000 };

  it("runs unprompted at the ceiling and asks above it", () => {
    expect(withinAutoRun(5000, limits)).toBe(true);
    expect(withinAutoRun(5001, limits)).toBe(false);
  });

  it("treats every run as automatic until the limits have been read", () => {
    expect(withinAutoRun(1_000_000, null)).toBe(true);
  });
});
