import { create } from "zustand";
import type { Plan } from "../types/generated/Plan";
import type { Presets } from "../types/generated/Presets";
import type { Projection } from "../types/generated/Projection";
import {
  deletePlan,
  duplicatePlan,
  getPresets,
  listPlans,
  loadPlan,
  loadPlanNamed,
  runProjection,
  savePlan,
  setActivePlan,
  type PlanSummary,
} from "../lib/api";

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

interface PlanStore {
  scenarios: PlanSummary[];
  plan: Plan | null;
  /** State-tax bracket prefills and other Rust-side defaults, fetched once
   * at startup so the frontend never duplicates them. */
  presets: Presets | null;
  projection: Projection | null;
  /** True while a re-projection is in flight (previous result stays shown). */
  projecting: boolean;
  error: string | null;
  realDollars: boolean;

  init: () => Promise<void>;
  /** Apply an edit to the plan; re-project and persist, debounced. */
  updatePlan: (mutate: (draft: Plan) => void) => void;
  setRealDollars: (real: boolean) => void;
  switchScenario: (id: string) => Promise<void>;
  /** Branches the active scenario off into a new one under `newName`, and
   * switches to it. */
  duplicateActive: (newName: string) => Promise<void>;
  deleteScenario: (id: string) => Promise<void>;
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

/** Makes `plan` the displayed scenario: projects it, records it as the one
 * to load on next launch, and adopts its own real-dollars preference. */
async function activate(
  set: (partial: Partial<PlanStore>) => void,
  plan: Plan,
): Promise<void> {
  set({
    plan,
    projecting: true,
    realDollars: plan.sim_config.display_real_dollars,
  });
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
  projecting: false,
  error: null,
  realDollars: false,

  init: async () => {
    try {
      const [scenarios, plan, presets] = await Promise.all([
        listPlans(),
        loadPlan(),
        getPresets(),
      ]);
      set({ scenarios, presets });
      await activate(set, plan);
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
        const [projection] = await Promise.all([
          runProjection(latest),
          savePlan(latest),
        ]);
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

  switchScenario: async (id) => {
    const current = get().plan;
    if (!current || id === current.id) return;
    await flushPendingSave(get);
    try {
      const plan = await loadPlanNamed(id);
      await activate(set, plan);
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
      await activate(set, copy);
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
        await activate(set, plan);
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
