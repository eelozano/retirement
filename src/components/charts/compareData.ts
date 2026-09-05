import { depletionYear } from "../../lib/projection";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { Projection } from "../../types/generated/Projection";
import { fanRows } from "./monteCarloData";
import { successMargin } from "./planData";

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

/** Folds the *active* scenario's p10–p90 band into the comparison rows, by
 * year — `CompareRow`'s index signature already admits extra numeric series,
 * so the band rides along as two more keys, exactly as `mergeFan` does for
 * the projection chart.
 *
 * One scenario's band, not every scenario's: five overlapping translucent
 * ranges are a wash of color nobody can read a number out of. The base is the
 * scenario the others are being weighed against, so it is the one whose
 * spread is worth seeing.
 *
 * Merged by year rather than by index because `compareRows` is a year-keyed
 * outer join — scenarios can start and end in different years, and the band's
 * own scenario need not span the widest range.
 */
export function mergeActiveBand(
  rows: CompareRow[],
  monteCarlo: MonteCarloResult,
  realDollars: boolean,
): CompareRow[] {
  const band = new Map(fanRows(monteCarlo, realDollars).map((f) => [f.year, f]));
  return rows.map((row) => {
    const f = band.get(row.year);
    // Null, not 0, for a year the band does not cover: the area should stop,
    // not collapse onto the axis.
    return { ...row, bandBase: f?.outerBase ?? null, bandHeight: f?.outerBand ?? null };
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
  /** Null where this scenario has no Monte Carlo result — the batch has not
   * landed yet, or this scenario's own run failed. The table shows "—", as
   * the headline tile does. */
  successRate: number | null;
  /** Sampling error on `successRate` at the path count behind it, from the
   * same Wilson interval the tile uses (`planData.successMargin`). */
  successMargin: number | null;
  /** Success rate minus the base's, as a fraction. Null for the base row and
   * wherever either side is missing.
   *
   * Deliberately carries no margin of its own. Every scenario in a batch runs
   * at the same seed, so the two rates are measured against the same draws and
   * this difference is far sharper than `successMargin` on either side would
   * suggest — printing ±2 pts beside a +4 pt delta would read as "no
   * difference" when there is one. The honest paired margin is not derivable
   * from two aggregate results, so none is claimed. */
  successDeltaVsBase: number | null;
  /** Net worth at plan end in the 10th-percentile path — the bad-but-not-
   * worst case the deterministic end balance cannot show. */
  p10AtEnd: number | null;
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

/** The 10th-percentile net worth at this scenario's own last period — "at
 * end" means each scenario's end, not a shared year, exactly as
 * `finalNetWorth` does. Deflated by that period's own deflator, since
 * scenarios can carry different inflation assumptions. */
function p10AtEnd(monteCarlo: MonteCarloResult, realDollars: boolean): number | null {
  const last = monteCarlo.percentiles[monteCarlo.percentiles.length - 1];
  if (!last) return null;
  return last.p10 / (realDollars ? last.deflator : 1);
}

interface ScenarioSummaryInput {
  id: string;
  name: string;
  projection: Projection;
  /** This scenario's Monte Carlo result, or null while the batch is still
   * running or if this scenario's run failed. The deterministic columns do
   * not wait on it. */
  monteCarlo: MonteCarloResult | null;
}

/** Per-scenario headline numbers for the comparison table, plus each
 * scenario's final net worth and success rate relative to `baseId` — the plan
 * the user is weighing variants against, not necessarily the first or largest
 * one. */
export function comparisonSummary(
  scenarios: readonly ScenarioSummaryInput[],
  baseId: string,
  realDollars: boolean,
): ComparisonSummaryRow[] {
  const base = scenarios.find((s) => s.id === baseId);
  const baseFinal = base ? finalNetWorth(base.projection, realDollars) : 0;
  const baseSuccess = base?.monteCarlo?.success_rate ?? null;

  return scenarios.map((s) => {
    const final = finalNetWorth(s.projection, realDollars);
    const mc = s.monteCarlo;
    const isBase = s.id === baseId;
    return {
      id: s.id,
      name: s.name,
      isBase,
      finalNetWorth: final,
      deltaVsBase: final - baseFinal,
      depletionYear: depletionYear(s.projection),
      lifetimeTaxes: lifetimeTaxes(s.projection, realDollars),
      successRate: mc ? mc.success_rate : null,
      successMargin: mc ? successMargin(mc.success_rate, mc.n_paths) : null,
      successDeltaVsBase:
        mc && baseSuccess !== null && !isBase ? mc.success_rate - baseSuccess : null,
      p10AtEnd: mc ? p10AtEnd(mc, realDollars) : null,
    };
  });
}
