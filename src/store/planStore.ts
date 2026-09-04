import { create } from "zustand";
import {
  deletePlan,
  duplicatePlan,
  getMonteCarloPaths,
  getPresets,
  listPlans,
  loadPlan,
  loadPlanNamed,
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

// Monte Carlo re-runs on every edit, but off to the side rather than in front
// of the deterministic projection.
//
// The path count is a user setting now (Settings → Simulation), because the
// success rate is only as precise as the sample behind it: at 1,000 paths the
// standard error near a 90% success rate is about a percentage point. Higher
// counts cost real time — 25,000 paths is ~1.7s against the seed plan, where
// the deterministic projection is a few milliseconds — so the two runs are no
// longer awaited together. See `refreshMonteCarlo`.
//
// Fixed seed: the same plan must not show a different success rate each time
// it re-projects, or the headline number would flicker while editing.
const MC_SEED = 1;

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
  error: string | null;
  realDollars: boolean;
  showMonteCarloBand: boolean;

  init: () => Promise<void>;
  /** Apply an edit to the plan; re-project and persist, debounced. */
  updatePlan: (mutate: (draft: Plan) => void) => void;
  setRealDollars: (real: boolean) => void;
  /** Persists a new path count and re-runs Monte Carlo. The deterministic
   * projection does not depend on it, so it is not re-run. */
  setMonteCarloPaths: (paths: number) => Promise<void>;
  setShowMonteCarloBand: (show: boolean) => void;
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

/** Re-runs Monte Carlo for `plan` and attaches the result when it lands.
 *
 * Deliberately not awaited alongside the projection: the user can ask for
 * 25,000 paths, and holding every deterministic number back behind a ~1.7s
 * run would make editing feel stalled. Never rejects — a Monte Carlo failure
 * must not blank a good projection, and the headline tile degrades to "—" on
 * its own. */
async function refreshMonteCarlo(
  set: (partial: Partial<PlanStore>) => void,
  get: () => PlanStore,
  plan: Plan,
): Promise<void> {
  const n_paths = get().monteCarloPaths;
  if (n_paths === null) return;
  const monteCarlo = await runMonteCarlo(plan, { n_paths, seed: MC_SEED }).catch(
    () => null,
  );
  // Drop the result if another edit or scenario switch landed meanwhile.
  if (get().plan === plan) set({ monteCarlo });
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
    // Session-only: always starts off, regardless of the persisted plan
    // value, so it never surprises with stale state from a prior session.
    showMonteCarloBand: false,
  });
  void refreshMonteCarlo(set, get, plan);
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
  error: null,
  realDollars: false,
  showMonteCarloBand: false,

  init: async () => {
    try {
      const [scenarios, plan, presets, monteCarloPaths] = await Promise.all([
        listPlans(),
        loadPlan(),
        getPresets(),
        getMonteCarloPaths(),
      ]);
      // Set before activating: `activate` starts the first Monte Carlo run.
      set({ scenarios, presets, monteCarloPaths });
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

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = undefined;
      const latest = get().plan;
      if (!latest) return;
      try {
        // Off to the side, so the tiles below update at projection speed
        // however many paths the user has asked for. The previous success
        // rate stays on screen until the new one lands.
        void refreshMonteCarlo(set, get, latest);
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
    if (plan) await refreshMonteCarlo(set, get, plan);
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
