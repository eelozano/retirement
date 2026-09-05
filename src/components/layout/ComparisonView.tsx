import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelMonteCarlo,
  loadPlanNamed,
  type MonteCarloResultEntry,
  type ProjectionResult,
  runMonteCarlos,
  runProjections,
} from "../../lib/api";
import { nextRunId, usePlanStore } from "../../store/planStore";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import { ComparisonChart } from "../charts/ComparisonChart";
import { ComparisonTable } from "../charts/ComparisonTable";
import {
  compareRows,
  compareSeriesDefs,
  comparisonSummary,
  MAX_COMPARE,
  mergeActiveBand,
} from "../charts/compareData";

interface ScenarioResult {
  id: string;
  name: string;
  plan: Plan;
  projection: Projection | null;
  error: string | null;
}

/** A Monte Carlo batch in flight: aggregated across every scenario in it, so
 * the count climbs once rather than restarting per scenario. */
interface BatchRun {
  runId: number;
  completed: number;
  total: number;
}

/** What a cached Monte Carlo result is keyed by. A scenario's result is only
 * reusable at the same seed and path count, and the active plan's is only
 * reusable until the plan itself changes — `revision` is that plan's object
 * identity, which the store replaces on every edit. */
function cacheKey(id: string, seed: number, paths: number, revision: number): string {
  return `${id}:${seed}:${paths}:${revision}`;
}

/** A scenario's cached Monte Carlo result, or the fact that its run failed —
 * which is not the same as "not run yet", and must not be retried forever. */
type CacheEntry = MonteCarloResult | "failed";

/** The scenarios with no cached result at the current seed and path count:
 * the batch's work list, and the count the Run affordance quotes. */
function pendingScenarios(
  results: readonly ScenarioResult[],
  cache: ReadonlyMap<string, CacheEntry>,
  keyFor: (id: string) => string,
): ScenarioResult[] {
  return results.filter((r) => r.projection !== null && !cache.has(keyFor(r.id)));
}

export function ComparisonView() {
  const scenarios = usePlanStore((s) => s.scenarios);
  const activePlan = usePlanStore((s) => s.plan);
  const realDollars = usePlanStore((s) => s.realDollars);
  const monteCarloPaths = usePlanStore((s) => s.monteCarloPaths);
  const monteCarloLimits = usePlanStore((s) => s.monteCarloLimits);
  const monteCarloSeed = usePlanStore((s) => s.monteCarloSeed);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [batch, setBatch] = useState<BatchRun | null>(null);
  const [mcStale, setMcStale] = useState(false);
  const [showBand, setShowBand] = useState(false);
  // A monotonic counter bumped by Run, and the value the effect last acted
  // on. The pair is what makes "run now, whatever the threshold" a one-shot:
  // a later selection change must fall back to the threshold rather than
  // inheriting the click.
  const [runToken, setRunToken] = useState(0);
  const consumedToken = useRef(0);

  // Keyed by `cacheKey`, so ticking a fifth scenario runs that scenario only
  // and the other four keep the results they already have. Monte Carlo is
  // seconds of work where the deterministic projection is milliseconds; the
  // deterministic side re-runs freely and this side does not.
  const [mcCache, setMcCache] = useState<ReadonlyMap<string, CacheEntry>>(new Map());

  // The active plan's own revision: its object identity, which the store
  // replaces on every edit. Others cannot change while this screen is up.
  const revisions = useRef(new WeakMap<Plan, number>());
  const nextRevision = useRef(0);
  let activeRevision = 0;
  if (activePlan) {
    let revision = revisions.current.get(activePlan);
    if (revision === undefined) {
      revision = ++nextRevision.current;
      revisions.current.set(activePlan, revision);
    }
    activeRevision = revision;
  }
  const activeId = activePlan?.id;
  // Only the active plan can be edited; every other scenario is read from
  // disk and cannot change while this screen is up, so revision 0 stands for
  // "unchanging" rather than being tracked per plan.
  const keyFor = useCallback(
    (id: string) =>
      cacheKey(
        id,
        monteCarloSeed,
        monteCarloPaths ?? 0,
        id === activeId ? activeRevision : 0,
      ),
    [monteCarloSeed, monteCarloPaths, activeId, activeRevision],
  );

  // Default to the active scenario plus as many others as fit the cap —
  // set once when scenarios first arrive, not on every list refresh, so a
  // rename or a duplicate made elsewhere doesn't silently change what's
  // selected here.
  useEffect(() => {
    if (!activePlan || scenarios.length === 0 || selectedIds.length > 0) return;
    const others = scenarios.map((s) => s.id).filter((id) => id !== activePlan.id);
    setSelectedIds([activePlan.id, ...others].slice(0, MAX_COMPARE));
  }, [activePlan, scenarios, selectedIds]);

  useEffect(() => {
    if (!activePlan || selectedIds.length === 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const plans: Plan[] = await Promise.all(
          selectedIds.map((id) =>
            id === activePlan.id ? activePlan : loadPlanNamed(id),
          ),
        );
        const projections = await runProjections(plans);
        if (cancelled) return;
        const isOk = (r: ProjectionResult): r is { Ok: Projection } => "Ok" in r;
        setResults(
          plans.map((plan, i) => {
            const result = projections[i];
            return {
              id: plan.id,
              name: plan.name,
              plan,
              projection: result && isOk(result) ? result.Ok : null,
              error: result && !isOk(result) ? result.Err : null,
            };
          }),
        );
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activePlan, selectedIds]);

  const projectable = results.filter((r) => r.projection);
  const monteCarloFor = (id: string): MonteCarloResult | null => {
    const hit = mcCache.get(keyFor(id));
    return hit === undefined || hit === "failed" ? null : hit;
  };
  const pending = pendingScenarios(results, mcCache, keyFor);

  // Monte Carlo runs only once the deterministic table is on screen: the
  // four deterministic columns are milliseconds of work and should not wait
  // behind seconds of sampling.
  useEffect(() => {
    if (loading || monteCarloPaths === null) return;
    const work = pendingScenarios(results, mcCache, keyFor);
    if (work.length === 0) {
      setMcStale(false);
      return;
    }

    // #91's threshold is a per-run test; here the work is paths × scenarios,
    // so the test scales with the batch. Five scenarios at the auto-run
    // ceiling is five times the ceiling's worth of paths — a surprise, not a
    // background refresh.
    const forced = runToken !== consumedToken.current;
    const cost = monteCarloPaths * work.length;
    const auto = monteCarloLimits === null || cost <= monteCarloLimits.auto_run_max_paths;
    if (!auto && !forced) {
      setMcStale(true);
      return;
    }
    consumedToken.current = runToken;

    const runId = nextRunId();
    const keys = work.map((r) => keyFor(r.id));
    let superseded = false;
    setMcStale(false);
    setBatch({ runId, completed: 0, total: cost });

    (async () => {
      let entries: MonteCarloResultEntry[] | null;
      try {
        entries = await runMonteCarlos(
          work.map((r) => r.plan),
          { n_paths: monteCarloPaths, seed: monteCarloSeed },
          runId,
          (progress) => {
            if (superseded || progress.run_id !== runId) return;
            setBatch({ runId, completed: progress.completed, total: progress.total });
          },
        );
      } catch {
        // A Monte Carlo failure must not blank a good comparison: the three
        // columns degrade to "—" and the deterministic four still stand.
        entries = keys.map(() => ({ Err: "Monte Carlo run failed" }));
      }
      if (superseded) return;
      setBatch(null);
      if (entries === null) {
        // Cancelled, or superseded by a run started elsewhere. Keep whatever
        // is already cached and offer Run rather than leaving the columns
        // silently empty.
        setMcStale(true);
        return;
      }
      const landed = entries;
      setMcCache((prev) => {
        const next = new Map(prev);
        keys.forEach((key, i) => {
          const entry = landed[i];
          // A failure is cached as such: not retried on the next render, and
          // shown as "—" like any scenario without a result.
          next.set(key, entry && "Ok" in entry ? entry.Ok : "failed");
        });
        return next;
      });
    })();

    return () => {
      superseded = true;
      // Leaving the screen, or changing what is selected, should not leave
      // paths burning: the batch is abandoned, not awaited.
      void cancelMonteCarlo(runId).catch(() => {});
    };
  }, [
    loading,
    results,
    mcCache,
    keyFor,
    monteCarloPaths,
    monteCarloLimits,
    monteCarloSeed,
    runToken,
  ]);

  const onRun = useCallback(() => setRunToken((t) => t + 1), []);
  const onCancel = useCallback(() => {
    if (batch) void cancelMonteCarlo(batch.runId).catch(() => {});
  }, [batch]);

  if (!activePlan) return null;

  const toggle = (id: string, checked: boolean) => {
    setSelectedIds((current) => {
      if (checked) {
        return current.includes(id) || current.length >= MAX_COMPARE
          ? current
          : [...current, id];
      }
      return current.filter((x) => x !== id);
    });
  };

  const ok = projectable;
  const series = compareSeriesDefs(ok);
  const baseMonteCarlo = monteCarloFor(activePlan.id);
  const bandOn = showBand && baseMonteCarlo !== null;
  const plainRows = compareRows(
    ok.map((r) => ({ id: r.id, projection: r.projection! })),
    realDollars,
  );
  const rows = bandOn
    ? mergeActiveBand(plainRows, baseMonteCarlo, realDollars)
    : plainRows;
  const summary = comparisonSummary(
    ok.map((r) => ({
      id: r.id,
      name: r.name,
      projection: r.projection!,
      monteCarlo: monteCarloFor(r.id),
    })),
    activePlan.id,
    realDollars,
  );
  const failed = results.filter((r) => r.error);

  return (
    <section className="card compare-view">
      <h2>Compare scenarios</h2>
      <p className="compare-hint">
        {activePlan.name} is the base — other scenarios are shown relative to it.
        {scenarios.length > MAX_COMPARE && ` Up to ${MAX_COMPARE} at a time.`}
      </p>
      <div className="compare-picker">
        {scenarios.map((s) => {
          const checked = selectedIds.includes(s.id);
          const isBase = s.id === activePlan.id;
          return (
            <label key={s.id}>
              <input
                type="checkbox"
                checked={checked}
                disabled={isBase || (!checked && selectedIds.length >= MAX_COMPARE)}
                onChange={(e) => toggle(s.id, e.currentTarget.checked)}
              />
              {s.name}
            </label>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="banner critical">
          {error}
        </p>
      )}
      {failed.map((f) => (
        <p role="alert" className="banner critical" key={f.id}>
          {f.name}: {f.error}
        </p>
      ))}

      {ok.length === 0 ? (
        <p className="empty-state">
          {loading ? "Projecting…" : "Select at least one scenario to compare."}
        </p>
      ) : (
        <div className={loading ? "refreshing" : ""}>
          <div className="compare-controls">
            <label>
              <input
                type="checkbox"
                checked={showBand}
                disabled={baseMonteCarlo === null}
                onChange={(e) => setShowBand(e.currentTarget.checked)}
              />
              Show {activePlan.name}'s 10th–90th percentile range
            </label>
            {batch ? (
              <span className="compare-run">
                <span
                  role="progressbar"
                  aria-label="Monte Carlo progress"
                  aria-valuenow={batch.completed}
                  aria-valuemin={0}
                  aria-valuemax={batch.total}
                >
                  {batch.completed.toLocaleString()} of {batch.total.toLocaleString()}{" "}
                  paths
                </span>
                <button type="button" className="tile-button" onClick={onCancel}>
                  Cancel
                </button>
              </span>
            ) : (
              mcStale && (
                <span className="compare-run">
                  <span>
                    {monteCarloPaths !== null &&
                      `${(monteCarloPaths * pending.length).toLocaleString()} paths across ${pending.length} ${pending.length === 1 ? "scenario" : "scenarios"}.`}
                  </span>
                  <button type="button" className="tile-button" onClick={onRun}>
                    Run
                  </button>
                </span>
              )
            )}
          </div>
          <ComparisonChart rows={rows} series={series} showBand={bandOn} />
          <ComparisonTable rows={summary} monteCarloPending={batch !== null} />
        </div>
      )}
    </section>
  );
}
