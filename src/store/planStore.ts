import { create } from "zustand";
import {
  cancelMonteCarlo as cancelMonteCarloApi,
  deletePlan,
  duplicatePlan,
  getMonteCarloLimits,
  getMonteCarloPaths,
  getPresets,
  listPlans,
  loadPlan,
  loadPlanNamed,
  type MonteCarloLimits,
  type PlanSummary,
  setMonteCarloPaths as persistMonteCarloPaths,
  restoreSnapshot as restoreSnapshotApi,
  runMonteCarlo,
  runProjection,
  savePlan,
  setActivePlan,
} from "../lib/api";
import type { MonteCarloResult } from "../types/generated/MonteCarloResult";
import type { Plan } from "../types/generated/Plan";
import type { Presets } from "../types/generated/Presets";
import type { Projection } from "../types/generated/Projection";

// Inputs (plan) and results (projection) are kept separate so a stale
// projection is detectable; edits debounce into re-project + save, and the
// previous projection is held on screen while the new one computes.
//
// Only the active scenario's plan/projection are held in memory —
// `scenarios` is just the id/name list for the switcher. Switching,
// duplicating, or deleting a scenario always round-trips through the
// backend rather than caching every scenario, since plans and annual
// projections are both tiny.

const DEBOUNCE_MS = 300;

// Monte Carlo runs off to the side rather than in front of the deterministic
// projection, and — above a path count the backend decides — on demand
// rather than after every edit.
//
// The path count is a user setting (Settings → Simulation), because the
// success rate is only as precise as the sample behind it: at 1,000 paths the
// standard error near a 90% success rate is about a percentage point. Higher
// counts cost real time — 100,000 paths is ~5s against the seed plan, where
// the deterministic projection is a few milliseconds — so the two runs are
// never awaited together (see `startMonteCarlo`), and past
// `MonteCarloLimits.auto_run_max_paths` an edit only marks the last result
// stale; the user runs when ready. Every run reports progress and can be
// cancelled, and starting one cancels the one before it.
//
// The seed starts fixed, at 1, and is never persisted: the same saved plan
// must show the same success rate on every launch, and must not flicker
// between re-projections while editing. "Re-roll" draws a fresh seed for the
// session, which is the only way to *see* the sampling error the tile's
// margin describes.
const INITIAL_MC_SEED = 1;

/** A Monte Carlo run in flight: which run, and how far along. */
export interface MonteCarloRun {
  runId: number;
  completed: number;
  total: number;
}

/** Monotonic across the session, so a result (or a cancellation, or an
 * error) can be matched to the run that produced it and ignored if that run
 * has since been superseded. Not in the store: nothing renders it. */
let lastRunId = 0;

/** A fresh `u32` seed that is not the one in use. `Math.random` is fine:
 * this is a sampling seed, not a secret. */
function freshSeed(current: number): number {
  let seed = current;
  while (seed === current) {
    seed = Math.floor(Math.random() * 0x1_0000_0000);
  }
  return seed;
}

interface PlanStore {
  scenarios: PlanSummary[];
  plan: Plan | null;
  /** State-tax bracket prefills and other Rust-side defaults, fetched once
   * at startup so the frontend never duplicates them. */
  presets: Presets | null;
  projection: Projection | null;
  /** Percentile fan + success rate for the active plan. Null only before the
   * first run, or if a Monte Carlo run failed while the projection succeeded. */
  monteCarlo: MonteCarloResult | null;
  /** True while a re-projection is in flight (previous result stays shown).
   * Tracks the deterministic projection only — Monte Carlo runs alongside it
   * and can take far longer at high path counts. */
  projecting: boolean;
  /** Paths per Monte Carlo run, from app settings. Null only before `init`
   * has read it; the default lives in Rust, not here. */
  monteCarloPaths: number | null;
  /** The clamp range and the on-demand threshold, from the backend. Null
   * only before `init`; until then every run is treated as automatic. */
  monteCarloLimits: MonteCarloLimits | null;
  /** Seed for the session. Starts at 1 on every launch; see `rerollSeed`. */
  monteCarloSeed: number;
  /** True when `monteCarlo` no longer describes the plan on screen — an edit
   * landed in on-demand mode, or a run that would have replaced it was
   * cancelled. The tile greys the figure and offers Run. */
  monteCarloStale: boolean;
  /** The run in flight, or null. Progress ticks update it in place. */
  monteCarloRun: MonteCarloRun | null;
  error: string | null;
  realDollars: boolean;
  showMonteCarloBand: boolean;

  init: () => Promise<void>;
  /** Apply an edit to the plan; re-project and persist, debounced. */
  updatePlan: (mutate: (draft: Plan) => void) => void;
  setRealDollars: (real: boolean) => void;
  /** Persists a new path count and starts a Monte Carlo run at it — a
   * deliberate click, so it runs regardless of the on-demand threshold. The
   * deterministic projection does not depend on it, so it is not re-run.
   * Resolves once the count is saved, not once the run lands. */
  setMonteCarloPaths: (paths: number) => Promise<void>;
  setShowMonteCarloBand: (show: boolean) => void;
  /** Runs Monte Carlo against the plan on screen, now, whatever the
   * threshold — the Run affordance on a stale tile. */
  runMonteCarloNow: () => void;
  /** Stops the run in flight. The previous result stays on screen, marked
   * stale, since it is now known not to be what was asked for. */
  cancelMonteCarlo: () => void;
  /** Draws a fresh seed for the session and re-runs, so the user can watch a
   * new sample land somewhere inside the margin. Never persisted. */
  rerollSeed: () => void;
  switchScenario: (id: string) => Promise<void>;
  /** Branches the active scenario off into a new one under `newName`, and
   * switches to it. */
  duplicateActive: (newName: string) => Promise<void>;
  deleteScenario: (id: string) => Promise<void>;
  /** Restores the active plan to a prior snapshot and re-activates it. */
  restoreSnapshot: (timestamp: string) => Promise<void>;
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

/** Cancels any pending debounced save and persists it immediately. Called
 * before switching away from or duplicating the active scenario, so an
 * in-flight edit is never silently dropped or duplicated from a stale
 * on-disk copy. */
async function flushPendingSave(get: () => PlanStore) {
  if (debounceTimer === undefined) return;
  clearTimeout(debounceTimer);
  debounceTimer = undefined;
  const latest = get().plan;
  if (latest) {
    await savePlan(latest).catch(() => {});
  }
}

/** Whether edits should mark the result stale rather than re-run. */
function onDemand(state: PlanStore): boolean {
  const limits = state.monteCarloLimits;
  const paths = state.monteCarloPaths;
  return limits !== null && paths !== null && paths > limits.auto_run_max_paths;
}

/** Starts a Monte Carlo run for `plan` and attaches the result when it
 * lands. Any run already in flight is superseded: the backend cancels it,
 * and whatever it resolves to is ignored here by run id.
 *
 * Deliberately not awaited alongside the projection: the user can ask for
 * 100,000 paths, and holding every deterministic number back behind a ~5s
 * run would make editing feel stalled. Never rejects — a Monte Carlo failure
 * must not blank a good projection, and the headline tile degrades to "—" on
 * its own. */
async function startMonteCarlo(
  set: (partial: Partial<PlanStore>) => void,
  get: () => PlanStore,
  plan: Plan,
): Promise<void> {
  const n_paths = get().monteCarloPaths;
  if (n_paths === null) return;
  const runId = ++lastRunId;
  const seed = get().monteCarloSeed;
  set({ monteCarloRun: { runId, completed: 0, total: n_paths } });

  const current = () => get().monteCarloRun?.runId === runId;
  let result: MonteCarloResult | null | "failed";
  try {
    result = await runMonteCarlo(plan, { n_paths, seed }, runId, (progress) => {
      if (progress.run_id !== runId || !current()) return;
      set({
        monteCarloRun: { runId, completed: progress.completed, total: progress.total },
      });
    });
  } catch {
    result = "failed";
  }
  // Superseded: a newer run owns the slot and this outcome is nobody's.
  if (!current()) return;

  if (result === null) {
    // Cancelled — by `cancelMonteCarlo`, which has already marked the
    // previous result stale. Just clear the in-flight state.
    set({ monteCarloRun: null });
  } else if (result === "failed") {
    set({ monteCarlo: null, monteCarloStale: false, monteCarloRun: null });
  } else if (get().plan === plan) {
    set({ monteCarlo: result, monteCarloStale: false, monteCarloRun: null });
  } else {
    // An edit landed during the run and, in auto mode, is about to start
    // another. Drop this result rather than show it against the wrong plan.
    set({ monteCarloRun: null });
  }
}

/** Makes `plan` the displayed scenario: projects it, records it as the one
 * to load on next launch, and adopts its own real-dollars preference. */
async function activate(
  set: (partial: Partial<PlanStore>) => void,
  get: () => PlanStore,
  plan: Plan,
): Promise<void> {
  set({
    plan,
    projecting: true,
    realDollars: plan.sim_config.display_real_dollars,
    // Cleared rather than left standing: this is a different scenario, so the
    // outgoing success rate would be wrong, not merely stale. An *edit* keeps
    // the previous value (see `updatePlan`), since it is still the same plan.
    monteCarlo: null,
    monteCarloStale: false,
    // Session-only: always starts off, regardless of the persisted plan
    // value, so it never surprises with stale state from a prior session.
    showMonteCarloBand: false,
  });
  // Regardless of the on-demand threshold: opening a scenario is one run,
  // and it is what the path-count setting means. Cancel bounds the cost of
  // switching again mid-run.
  void startMonteCarlo(set, get, plan);
  try {
    const [projection] = await Promise.all([
      runProjection(plan),
      setActivePlan(plan.id).catch(() => {}),
    ]);
    set({ projection, projecting: false, error: null });
  } catch (e) {
    set({ error: String(e), projecting: false });
  }
}

export const usePlanStore = create<PlanStore>((set, get) => ({
  scenarios: [],
  plan: null,
  presets: null,
  projection: null,
  monteCarlo: null,
  projecting: false,
  monteCarloPaths: null,
  monteCarloLimits: null,
  monteCarloSeed: INITIAL_MC_SEED,
  monteCarloStale: false,
  monteCarloRun: null,
  error: null,
  realDollars: false,
  showMonteCarloBand: false,

  init: async () => {
    try {
      const [scenarios, plan, presets, monteCarloPaths, monteCarloLimits] =
        await Promise.all([
          listPlans(),
          loadPlan(),
          getPresets(),
          getMonteCarloPaths(),
          getMonteCarloLimits(),
        ]);
      // Set before activating: `activate` starts the first Monte Carlo run.
      set({ scenarios, presets, monteCarloPaths, monteCarloLimits });
      await activate(set, get, plan);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  updatePlan: (mutate) => {
    const current = get().plan;
    if (!current) return;
    const draft: Plan = structuredClone(current);
    mutate(draft);
    const nameChanged = draft.name !== current.name;
    set({ plan: draft, projecting: true });

    // On demand: the result is stale from this keystroke, not from when the
    // debounce fires, and a run in flight is now computing a plan the user
    // has left — stop it rather than let it land and be dropped.
    const demand = onDemand(get());
    if (demand) {
      set({ monteCarloStale: true });
      get().cancelMonteCarlo();
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = undefined;
      const latest = get().plan;
      if (!latest) return;
      try {
        // Off to the side, so the tiles below update at projection speed
        // however many paths the user has asked for. The previous success
        // rate stays on screen until the new one lands.
        if (!demand) void startMonteCarlo(set, get, latest);
        const [projection] = await Promise.all([runProjection(latest), savePlan(latest)]);
        // Drop stale results if another edit landed meanwhile.
        if (get().plan === latest) {
          set({ projection, projecting: false, error: null });
        }
        // The switcher shows names, so keep it in sync after a rename.
        if (nameChanged) {
          listPlans()
            .then((scenarios) => set({ scenarios }))
            .catch(() => {});
        }
      } catch (e) {
        set({ error: String(e), projecting: false });
      }
    }, DEBOUNCE_MS);
  },

  setRealDollars: (real) => {
    set({ realDollars: real });
    get().updatePlan((draft) => {
      draft.sim_config.display_real_dollars = real;
    });
  },

  setMonteCarloPaths: async (paths) => {
    await persistMonteCarloPaths(paths);
    set({ monteCarloPaths: paths });
    const plan = get().plan;
    if (plan) void startMonteCarlo(set, get, plan);
  },

  runMonteCarloNow: () => {
    const plan = get().plan;
    if (plan) void startMonteCarlo(set, get, plan);
  },

  cancelMonteCarlo: () => {
    const run = get().monteCarloRun;
    if (!run) return;
    // Stale as of the cancel, not as of the result arriving: whatever is on
    // screen is now known to be not what was asked for. The in-flight state
    // clears when the backend confirms with a null result.
    if (get().monteCarlo !== null) set({ monteCarloStale: true });
    void cancelMonteCarloApi(run.runId).catch(() => {});
  },

  rerollSeed: () => {
    set({ monteCarloSeed: freshSeed(get().monteCarloSeed) });
    get().runMonteCarloNow();
  },

  setShowMonteCarloBand: (show) => {
    // Not persisted to the plan — this is a session-only display
    // preference that always resets to off on next launch.
    set({ showMonteCarloBand: show });
  },

  switchScenario: async (id) => {
    const current = get().plan;
    if (!current || id === current.id) return;
    await flushPendingSave(get);
    try {
      const plan = await loadPlanNamed(id);
      await activate(set, get, plan);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  duplicateActive: async (newName) => {
    const current = get().plan;
    if (!current) return;
    await flushPendingSave(get);
    try {
      const copy = await duplicatePlan(current.id, newName);
      set({ scenarios: await listPlans() });
      await activate(set, get, copy);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  deleteScenario: async (id) => {
    try {
      await deletePlan(id);
      const scenarios = await listPlans();
      set({ scenarios });
      const current = get().plan;
      if (current && current.id === id && scenarios[0]) {
        const plan = await loadPlanNamed(scenarios[0].id);
        await activate(set, get, plan);
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  restoreSnapshot: async (timestamp) => {
    const current = get().plan;
    if (!current) return;
    // Flushes and cancels any pending debounced save first, so it can't
    // fire after the restore with a stale draft and clobber it.
    await flushPendingSave(get);
    try {
      const restored = await restoreSnapshotApi(current.id, timestamp);
      await activate(set, get, restored);
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
