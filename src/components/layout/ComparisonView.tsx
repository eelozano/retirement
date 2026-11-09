import { useEffect, useMemo, useRef, useState } from "react";
import { loadPlanNamed, type ProjectionResult, runProjections } from "../../lib/api";
import { yearMonth } from "../../lib/format";
import { usePlanStore } from "../../store/planStore";
import { useMonteCarloBatch } from "../../store/useMonteCarloBatch";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import { ComparisonChart } from "../charts/ComparisonChart";
import { ComparisonTable } from "../charts/ComparisonTable";
import {
  comparedIds,
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

export function ComparisonView() {
  const scenarios = usePlanStore((s) => s.scenarios);
  const activePlan = usePlanStore((s) => s.plan);
  const realDollars = usePlanStore((s) => s.realDollars);
  const monteCarloPaths = usePlanStore((s) => s.monteCarloPaths);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showBand, setShowBand] = useState(false);

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
  // What a scenario's Monte Carlo answer is found by. Only the active plan can
  // be edited; every other scenario is read from disk and cannot change while
  // this screen is up, so revision 0 stands for "unchanging" rather than being
  // tracked per plan.
  const keyFor = (id: string) => `${id}:${id === activeId ? activeRevision : 0}`;

  // Default to the active scenario plus as many others as fit the cap —
  // set once when scenarios first arrive, not on every list refresh, so a
  // rename or a duplicate made elsewhere doesn't silently change what's
  // selected here.
  useEffect(() => {
    if (!activePlan || scenarios.length === 0 || selectedIds.length > 0) return;
    const others = scenarios.map((s) => s.id).filter((id) => id !== activePlan.id);
    setSelectedIds([activePlan.id, ...others].slice(0, MAX_COMPARE));
  }, [activePlan, scenarios, selectedIds]);

  // `selectedIds` is what was ticked; `compared` is what of it still exists.
  // Keyed by the joined ids so a list refresh that changes nothing doesn't
  // rerun every projection.
  const scenarioKey = scenarios.map((s) => s.id).join("\n");
  const comparedKey = activeId
    ? comparedIds(selectedIds, scenarioKey ? scenarioKey.split("\n") : [], activeId).join(
        "\n",
      )
    : "";
  const compared = useMemo(
    () => (comparedKey ? comparedKey.split("\n") : []),
    [comparedKey],
  );

  useEffect(() => {
    if (!activePlan || compared.length === 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const plans: Plan[] = await Promise.all(
          compared.map((id) => (id === activePlan.id ? activePlan : loadPlanNamed(id))),
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
  }, [activePlan, compared]);

  const projectable = results.filter((r) => r.projection);

  // Monte Carlo runs only once the deterministic table is on screen: the
  // four deterministic columns are milliseconds of work and should not wait
  // behind seconds of sampling. Answers are kept per scenario, so ticking a
  // fifth runs that one only.
  const batch = useMonteCarloBatch(
    projectable.map((r) => ({ key: keyFor(r.id), plan: r.plan })),
    !loading,
  );
  const monteCarloFor = (id: string) => batch.result(keyFor(id));

  if (!activePlan) return null;

  const toggle = (id: string, checked: boolean) => {
    if (checked) {
      if (!compared.includes(id) && compared.length < MAX_COMPARE) {
        setSelectedIds([...compared, id]);
      }
    } else {
      setSelectedIds(compared.filter((x) => x !== id));
    }
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
      {/* Every scenario compared here is a projection of the same household's
          balances (#110) — a record of what the numbers were computed from,
          same as the report header. */}
      <p className="compare-hint">
        Balances as of {yearMonth(activePlan.sim_config.start)}
      </p>
      <div className="compare-picker">
        {scenarios.map((s) => {
          const checked = compared.includes(s.id);
          const isBase = s.id === activePlan.id;
          return (
            <label key={s.id}>
              <input
                type="checkbox"
                checked={checked}
                disabled={isBase || (!checked && compared.length >= MAX_COMPARE)}
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
            {batch.progress ? (
              <span className="compare-run">
                <span
                  role="progressbar"
                  aria-label="Monte Carlo progress"
                  aria-valuenow={batch.progress.completed}
                  aria-valuemin={0}
                  aria-valuemax={batch.progress.total}
                >
                  {batch.progress.completed.toLocaleString()} of{" "}
                  {batch.progress.total.toLocaleString()} paths
                </span>
                <button type="button" className="tile-button" onClick={batch.cancel}>
                  Cancel
                </button>
              </span>
            ) : (
              batch.needsRun && (
                <span className="compare-run">
                  <span>
                    {monteCarloPaths !== null &&
                      `${(monteCarloPaths * batch.missing).toLocaleString()} paths across ${batch.missing} ${batch.missing === 1 ? "scenario" : "scenarios"}.`}
                  </span>
                  <button
                    type="button"
                    className="tile-button"
                    disabled={batch.waiting}
                    onClick={batch.run}
                  >
                    Run
                  </button>
                </span>
              )
            )}
          </div>
          <ComparisonChart rows={rows} series={series} showBand={bandOn} />
          <ComparisonTable rows={summary} monteCarloPending={batch.pending} />
        </div>
      )}
    </section>
  );
}
