import type { MonteCarloConfig } from "../types/generated/MonteCarloConfig";
import type { MonteCarloResult } from "../types/generated/MonteCarloResult";
import type { Plan } from "../types/generated/Plan";
import { cancelMonteCarlo, type MonteCarloLimits, runMonteCarlos } from "./api";

// The one road to the backend's Monte Carlo commands. The backend keeps a
// single run slot: starting a run cancels whatever held it. Every caller goes
// through a runner, so run ids come from one counter and each caller only has
// to say what a finished run means to it.

/** A Monte Carlo run in flight: which run, and how far along. */
export interface MonteCarloRun {
  runId: number;
  completed: number;
  total: number;
}

/** What one plan in a run came to. A failure is that plan's alone: it costs
 * the three Monte Carlo columns, never the deterministic numbers beside them. */
export type RunOutcome = MonteCarloResult | "failed";

/** How a run ended.
 *
 * - `finished`: one outcome per plan, in request order. A run the backend
 *   rejected outright finishes with every plan failed.
 * - `cancelled`: the backend stopped it, because of Cancel or because another
 *   caller took the slot. The caller's previous result no longer answers what
 *   was asked.
 * - `replaced`: this runner has moved on, by starting another run or by
 *   `abandon`. The outcome is nobody's, so there is nothing to do.
 */
export type RunEnding =
  | { ended: "finished"; outcomes: RunOutcome[] }
  | { ended: "cancelled" }
  | { ended: "replaced" };

export interface MonteCarloRunner {
  /** Starts a run across `plans` at one config, seed included, replacing this
   * runner's previous run. `onProgress` is called once before this returns,
   * with nothing completed, then for each tick while the run is current.
   * Never rejects. */
  start(
    plans: Plan[],
    config: MonteCarloConfig,
    onProgress: (run: MonteCarloRun) => void,
  ): Promise<RunEnding>;
  /** Asks the backend to stop the current run. It ends as `cancelled` once
   * the backend confirms, or as `finished` if it got there first. */
  cancel(): void;
  /** Stops the current run and walks away from it: no more progress, and it
   * ends as `replaced`. For a caller whose question has changed. */
  abandon(): void;
}

/** Monotonic across the session and shared by every runner. Two counters
 * could give two different runs the same id, and a Cancel would then stop the
 * wrong one. */
let lastRunId = 0;

export function createMonteCarloRunner(): MonteCarloRunner {
  let current: number | null = null;

  function stop(runId: number | null) {
    if (runId !== null) void cancelMonteCarlo(runId).catch(() => {});
  }

  return {
    async start(plans, config, onProgress) {
      const runId = ++lastRunId;
      current = runId;
      onProgress({ runId, completed: 0, total: config.n_paths * plans.length });

      let entries: Awaited<ReturnType<typeof runMonteCarlos>>;
      try {
        entries = await runMonteCarlos(plans, config, runId, (progress) => {
          if (progress.run_id !== runId || current !== runId) return;
          onProgress({ runId, completed: progress.completed, total: progress.total });
        });
      } catch {
        entries = plans.map(() => ({ Err: "Monte Carlo run failed" }));
      }

      if (current !== runId) return { ended: "replaced" };
      current = null;
      if (entries === null) return { ended: "cancelled" };
      const landed = entries;
      return {
        ended: "finished",
        outcomes: plans.map((_, i) => {
          const entry = landed[i];
          return entry && "Ok" in entry ? entry.Ok : "failed";
        }),
      };
    },

    cancel() {
      stop(current);
    },

    abandon() {
      const runId = current;
      current = null;
      stop(runId);
    },
  };
}

/** Whether work of `paths` total paths starts unprompted rather than waiting
 * for Run. The limits are null only before they have been read, and until
 * then every run counts as automatic. */
export function withinAutoRun(paths: number, limits: MonteCarloLimits | null): boolean {
  return limits === null || paths <= limits.auto_run_max_paths;
}
