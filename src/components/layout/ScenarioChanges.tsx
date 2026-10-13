import { useEffect, useId, useState } from "react";
import { loadPlanNamed, type PlanSummary } from "../../lib/api";
import { changeSummary, scenarioChanges } from "../../lib/scenarioDiff";
import type { Plan } from "../../types/generated/Plan";

// What a scenario changes, under its name in the scenario list (#191): one
// line to tell scenarios apart at a glance, which opens into the full list.
// Every scenario is compared with the first of its household — one rule,
// nothing to choose — so a branch of a branch lists what it inherited too.

/**
 * Every listed scenario's plan, by id: the active one from the store, so an
 * edit shows up as it is typed, and the rest from disk. Reloaded when the
 * list or the active scenario changes — switching flushes the outgoing
 * scenario's pending save first, so what loads is what was last edited.
 * A scenario that fails to load is left out, and its row shows no summary.
 */
export function useScenarioPlans(
  scenarios: readonly PlanSummary[],
  active: Plan | null,
): (id: string) => Plan | undefined {
  const [loaded, setLoaded] = useState<Record<string, Plan>>({});
  const activeId = active?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    const others = scenarios.filter((s) => s.id !== activeId);
    Promise.all(
      others.map((s) =>
        loadPlanNamed(s.id).then(
          (plan) => [s.id, plan] as const,
          () => null,
        ),
      ),
    ).then((entries) => {
      if (cancelled) return;
      setLoaded(Object.fromEntries(entries.filter((e) => e !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [scenarios, activeId]);

  return (id) => (active && id === activeId ? active : loaded[id]);
}

/** The summary line under a scenario's name and, once opened, every change
 * it makes relative to `reference`. */
export function ScenarioChanges(props: { plan: Plan; reference: Plan }) {
  const { plan, reference } = props;
  const [open, setOpen] = useState(false);
  const listId = useId();
  const changes = scenarioChanges(reference, plan);
  const summary = changeSummary(changes, reference.name);

  if (changes.length === 0) {
    return <span className="scenario-summary">{summary}</span>;
  }

  return (
    <>
      <button
        type="button"
        className="scenario-summary scenario-summary-toggle"
        aria-expanded={open}
        aria-controls={listId}
        title={open ? "Hide changes" : "Show every change"}
        onClick={() => setOpen(!open)}
      >
        {summary}
      </button>
      {open && (
        <ul className="scenario-changes" id={listId}>
          {changes.map((c) => (
            <li key={`${c.what}|${c.now}|${c.was}`}>
              <span className="scenario-change-what">{c.what}</span>
              {c.now !== null && <span className="scenario-change-now">{c.now}</span>}
              {c.was !== null && (
                <span className="scenario-change-was">
                  {reference.name}: {c.was}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
