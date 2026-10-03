import { useEffect, useRef, useState } from "react";
import type { BacktestResult } from "../types/generated/BacktestResult";
import type { CohortDetail } from "../types/generated/CohortDetail";
import type { Plan } from "../types/generated/Plan";
import type { Projection } from "../types/generated/Projection";
import { runBacktest, runBacktestCohort } from "./api";

// The History screen's data, held by the screen rather than the store: a
// replay is only worth running while someone is looking at it, and it is
// cheap enough (tens of milliseconds) to re-run whenever they return.
//
// Both hooks key off the *projection*, not the plan. The store debounces an
// edit into a re-projection, so a new projection is the signal that the plan
// has settled — keying off the plan would replay on every keystroke. While a
// re-run is in flight the previous result stays on screen, as the Plan
// screen keeps its previous projection, and a response that arrives after a
// newer request has gone out is dropped.

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function useLatest<T>(
  key: unknown,
  enabled: boolean,
  fetch: () => Promise<T>,
): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({
    data: null,
    loading: false,
    error: null,
  });
  const request = useRef(0);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the trigger; `fetch` is read through a ref so a new closure each render does not re-run it.
  useEffect(() => {
    if (!enabled) return;
    const id = ++request.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchRef
      .current()
      .then((data) => {
        if (id === request.current) setState({ data, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (id === request.current) {
          setState((s) => ({ ...s, loading: false, error: String(e) }));
        }
      });
  }, [key, enabled]);

  return state;
}

/** Every start year, for the plan as of its latest projection. */
export function useBacktest(
  plan: Plan | null,
  projection: Projection | null,
): Loadable<BacktestResult> {
  return useLatest(projection, plan !== null && projection !== null, () =>
    runBacktest(plan as Plan),
  );
}

/** One start year in full, re-run when it changes or the plan settles. */
export function useCohort(
  plan: Plan | null,
  projection: Projection | null,
  startYear: number | null,
): Loadable<CohortDetail> {
  return useLatest(
    projection === null ? null : `${projectionId(projection)}:${startYear}`,
    plan !== null && projection !== null && startYear !== null,
    () => runBacktestCohort(plan as Plan, startYear as number),
  );
}

/** Projections are replaced, never mutated, so identity is the change
 * signal; a WeakMap gives each one a stable number to fold into a key. */
const ids = new WeakMap<Projection, number>();
let nextId = 0;
function projectionId(projection: Projection): number {
  let id = ids.get(projection);
  if (id === undefined) {
    id = ++nextId;
    ids.set(projection, id);
  }
  return id;
}
