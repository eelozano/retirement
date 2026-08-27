import { create } from "zustand";
import type { Plan } from "../types/generated/Plan";
import type { Projection } from "../types/generated/Projection";
import { loadPlan, runProjection, savePlan } from "../lib/api";

// Inputs (plan) and results (projection) are kept separate so a stale
// projection is detectable; edits debounce into re-project + save, and the
// previous projection is held on screen while the new one computes.

const DEBOUNCE_MS = 300;

interface PlanStore {
  plan: Plan | null;
  projection: Projection | null;
  /** True while a re-projection is in flight (previous result stays shown). */
  projecting: boolean;
  error: string | null;
  realDollars: boolean;

  init: () => Promise<void>;
  /** Apply an edit to the plan; re-project and persist, debounced. */
  updatePlan: (mutate: (draft: Plan) => void) => void;
  setRealDollars: (real: boolean) => void;
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export const usePlanStore = create<PlanStore>((set, get) => ({
  plan: null,
  projection: null,
  projecting: false,
  error: null,
  realDollars: false,

  init: async () => {
    try {
      const plan = await loadPlan();
      set({ plan, realDollars: plan.sim_config.display_real_dollars });
      const projection = await runProjection(plan);
      set({ projection, error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  updatePlan: (mutate) => {
    const current = get().plan;
    if (!current) return;
    const draft: Plan = structuredClone(current);
    mutate(draft);
    set({ plan: draft, projecting: true });

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
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
}));
