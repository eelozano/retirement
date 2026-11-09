import { useCallback, useEffect, useRef, useState } from "react";
import {
  createMonteCarloRunner,
  type MonteCarloRun,
  type RunOutcome,
  withinAutoRun,
} from "../lib/monteCarloRunner";
import type { MonteCarloResult } from "../types/generated/MonteCarloResult";
import type { Plan } from "../types/generated/Plan";
import { usePlanStore } from "./planStore";

// Monte Carlo for a screen weighing several plans against each other: the
// Scenarios table and the What-if sandbox. A screen says which plans it wants
// answers for, and this works out which of them still need running, whether
// that happens on its own or waits for Run, and what to remember.
//
// Path count, seed and limits come from the store, because they are the app's
// one setting: every plan on a screen is measured at the same seed, so the
// differences between them mean something.

/** How many answers to keep. Going back to an earlier selection or slider
 * position should show the answer it already has, but a long session should
 * not hold every percentile fan it has ever computed. */
const REMEMBERED = 12;

/** One plan a screen wants an answer for. The same `key` must always mean the
 * same plan: it is what a remembered answer is found by. */
export interface MonteCarloJob {
  key: string;
  plan: Plan;
}

export interface MonteCarloBatch {
  /** The answer for `key`, or null if there is none yet or its run failed. */
  result: (key: string) => MonteCarloResult | null;
  /** The run in flight, or null. */
  progress: MonteCarloRun | null;
  /** True when answers are missing and it is the user's move. */
  needsRun: boolean;
  /** How many of the jobs have no answer, failed ones not counted. */
  missing: number;
  /** True while the Plan screen's run holds the backend's single slot. Nothing
   * starts until it has finished. */
  waiting: boolean;
  /** True when answers are on their way, so the table can say so. */
  pending: boolean;
  /** Runs what is missing, now, whatever the threshold. */
  run: () => void;
  /** Stops the run in flight. */
  cancel: () => void;
}

/** `remembered` with the outcomes that have just landed, oldest entries
 * dropped down to the cap. Anything in `asked` stays, whatever its age. */
function remember(
  remembered: ReadonlyMap<string, RunOutcome>,
  keys: readonly string[],
  outcomes: readonly RunOutcome[],
  asked: ReadonlySet<string>,
): ReadonlyMap<string, RunOutcome> {
  const next = new Map(remembered);
  keys.forEach((key, i) => {
    next.set(key, outcomes[i] ?? "failed");
  });
  for (const key of [...next.keys()]) {
    if (next.size <= REMEMBERED) break;
    if (!asked.has(key)) next.delete(key);
  }
  return next;
}

/** Keeps a Monte Carlo answer for each job. `ready` is false while the screen
 * cannot yet say what it is asking: everything is held where it is, and a run
 * in flight stops. */
export function useMonteCarloBatch(
  jobs: readonly MonteCarloJob[],
  ready: boolean,
): MonteCarloBatch {
  const paths = usePlanStore((s) => s.monteCarloPaths);
  const limits = usePlanStore((s) => s.monteCarloLimits);
  const seed = usePlanStore((s) => s.monteCarloSeed);
  const waiting = usePlanStore((s) => s.monteCarloRun !== null);

  const [runner] = useState(createMonteCarloRunner);
  const [remembered, setRemembered] = useState<ReadonlyMap<string, RunOutcome>>(
    new Map(),
  );
  const [progress, setProgress] = useState<MonteCarloRun | null>(null);
  const [needsRun, setNeedsRun] = useState(false);
  // A counter bumped by Run, and the value last acted on. The pair makes "run
  // now, whatever the threshold" a one-shot: a later change falls back to the
  // threshold rather than inheriting the click.
  const [runToken, setRunToken] = useState(0);
  const consumedToken = useRef(0);

  // An answer is only reusable at the same seed and path count.
  const storedKey = useCallback(
    (key: string) => `${key}:${seed}:${paths ?? 0}`,
    [seed, paths],
  );

  // Screens rebuild their job lists on every render. The joined keys are what
  // says whether the question actually changed.
  const askedKey = jobs.map((job) => storedKey(job.key)).join("\n");
  const latestJobs = useRef(jobs);
  latestJobs.current = jobs;

  // biome-ignore lint/correctness/useExhaustiveDependencies: askedKey stands for the job list, which is read through a ref so that a new array with the same keys does not restart the run.
  useEffect(() => {
    if (!ready || paths === null) return;

    // The backend keeps one run slot, and a batch here would cancel the Plan
    // screen's own run, whose number that screen is showing. Wait instead:
    // this effect re-runs when the slot frees.
    if (waiting) return;

    const asked = latestJobs.current;
    const work = asked.filter((job) => !remembered.has(storedKey(job.key)));
    if (work.length === 0) {
      setNeedsRun(false);
      return;
    }

    // The threshold scales with the work: five scenarios at the auto-run
    // ceiling is five times the ceiling's worth of paths, a surprise rather
    // than a background refresh.
    const forced = runToken !== consumedToken.current;
    if (!withinAutoRun(paths * work.length, limits) && !forced) {
      setNeedsRun(true);
      return;
    }
    consumedToken.current = runToken;
    setNeedsRun(false);

    const keys = work.map((job) => storedKey(job.key));
    const askedKeys = new Set(asked.map((job) => storedKey(job.key)));
    void runner
      .start(
        work.map((job) => job.plan),
        { n_paths: paths, seed },
        setProgress,
      )
      .then((ending) => {
        if (ending.ended === "replaced") return;
        setProgress(null);
        if (ending.ended === "cancelled") {
          // Keep what is remembered and offer Run, rather than leaving the
          // columns silently empty.
          setNeedsRun(true);
          return;
        }
        setRemembered((previous) => remember(previous, keys, ending.outcomes, askedKeys));
      });

    return () => {
      // Leaving the screen or changing the question should not leave paths
      // burning. An abandoned run never clears its own progress, and the next
      // pass of this effect may have nothing to start.
      runner.abandon();
      setProgress(null);
    };
  }, [
    ready,
    paths,
    limits,
    seed,
    waiting,
    askedKey,
    remembered,
    storedKey,
    runToken,
    runner,
  ]);

  const missing = jobs.filter((job) => !remembered.has(storedKey(job.key))).length;

  return {
    result: (key) => {
      const outcome = remembered.get(storedKey(key));
      return outcome === undefined || outcome === "failed" ? null : outcome;
    },
    progress,
    needsRun: needsRun && missing > 0,
    missing,
    waiting,
    pending: progress !== null || (ready && waiting && missing > 0),
    run: () => setRunToken((token) => token + 1),
    cancel: () => runner.cancel(),
  };
}
