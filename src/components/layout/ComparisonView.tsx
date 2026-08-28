import { useEffect, useState } from "react";
import { usePlanStore } from "../../store/planStore";
import { loadPlanNamed, runProjections, type ProjectionResult } from "../../lib/api";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import { compareRows, compareSeriesDefs, comparisonSummary, MAX_COMPARE } from "../charts/compareData";
import { ComparisonChart } from "../charts/ComparisonChart";
import { ComparisonTable } from "../charts/ComparisonTable";

interface ScenarioResult {
  id: string;
  name: string;
  projection: Projection | null;
  error: string | null;
}

export function ComparisonView() {
  const scenarios = usePlanStore((s) => s.scenarios);
  const activePlan = usePlanStore((s) => s.plan);
  const realDollars = usePlanStore((s) => s.realDollars);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          selectedIds.map((id) => (id === activePlan.id ? activePlan : loadPlanNamed(id))),
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

  const ok = results.filter((r) => r.projection);
  const series = compareSeriesDefs(ok);
  const rows = compareRows(
    ok.map((r) => ({ id: r.id, projection: r.projection! })),
    realDollars,
  );
  const summary = comparisonSummary(
    ok.map((r) => ({ id: r.id, name: r.name, projection: r.projection! })),
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
          <ComparisonChart rows={rows} series={series} />
          <ComparisonTable rows={summary} />
        </div>
      )}
    </section>
  );
}
