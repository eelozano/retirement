import { depletionYear } from "../../lib/projection";
import type { Projection } from "../../types/generated/Projection";

// Comparing net worth across scenarios, not accounts within one — a
// separate palette assignment from chartData.ts's per-account series, but
// the same fixed categorical color slots and the same "fold extras into
// Other" discipline (here: a hard cap instead, since scenarios are
// deliberately chosen one at a time rather than derived from a plan).
export const MAX_COMPARE = 5;

export interface CompareSeriesDef {
  key: string; // scenario id
  label: string; // scenario name
  color: string;
}

export function compareSeriesDefs(
  scenarios: readonly { id: string; name: string }[],
): CompareSeriesDef[] {
  return scenarios.map((s, i) => ({
    key: s.id,
    label: s.name,
    color: `var(--series-${i + 1})`,
  }));
}

export interface CompareRow {
  year: number;
  // null where a scenario's plan has already ended for that year — kept as
  // a gap rather than 0, so the line stops instead of dropping to the axis.
  [scenarioId: string]: number | null;
}

interface ScenarioProjection {
  id: string;
  projection: Projection;
}

/** One row per year across every scenario's simulated range (a year-keyed
 * outer join, not index alignment — scenarios can start or end in
 * different years). Each scenario is deflated by its own `deflator`, since
 * scenarios can carry different inflation assumptions. */
export function compareRows(
  scenarios: readonly ScenarioProjection[],
  realDollars: boolean,
): CompareRow[] {
  const byYear = scenarios.map(({ id, projection }) => {
    const snapshots = new Map(projection.snapshots.map((s) => [s.period_start.year, s]));
    return { id, snapshots };
  });

  const years = new Set<number>();
  for (const { snapshots } of byYear) {
    for (const year of snapshots.keys()) years.add(year);
  }

  return [...years]
    .sort((a, b) => a - b)
    .map((year) => {
      const row: CompareRow = { year };
      for (const { id, snapshots } of byYear) {
        const snap = snapshots.get(year);
        row[id] = snap ? snap.net_worth / (realDollars ? snap.deflator : 1) : null;
      }
      return row;
    });
}

export interface ComparisonSummaryRow {
  id: string;
  name: string;
  isBase: boolean;
  finalNetWorth: number;
  deltaVsBase: number;
  depletionYear: number | null;
  lifetimeTaxes: number;
}

function finalNetWorth(projection: Projection, realDollars: boolean): number {
  const last = projection.snapshots[projection.snapshots.length - 1];
  if (!last) return 0;
  return last.net_worth / (realDollars ? last.deflator : 1);
}

function lifetimeTaxes(projection: Projection, realDollars: boolean): number {
  return projection.snapshots.reduce(
    (sum, s) => sum + s.taxes / (realDollars ? s.deflator : 1),
    0,
  );
}

/** Per-scenario headline numbers for the comparison table, plus each
 * scenario's final net worth relative to `baseId` — the plan the user is
 * weighing variants against, not necessarily the first or largest one. */
export function comparisonSummary(
  scenarios: readonly { id: string; name: string; projection: Projection }[],
  baseId: string,
  realDollars: boolean,
): ComparisonSummaryRow[] {
  const base = scenarios.find((s) => s.id === baseId);
  const baseFinal = base ? finalNetWorth(base.projection, realDollars) : 0;

  return scenarios.map((s) => {
    const final = finalNetWorth(s.projection, realDollars);
    return {
      id: s.id,
      name: s.name,
      isBase: s.id === baseId,
      finalNetWorth: final,
      deltaVsBase: final - baseFinal,
      depletionYear: depletionYear(s.projection),
      lifetimeTaxes: lifetimeTaxes(s.projection, realDollars),
    };
  });
}
