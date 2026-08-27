import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";

// The categorical palette carries 8 slots; accounts beyond that fold into
// "Other" rather than generating new hues.
export const MAX_SERIES = 8;
export const OTHER_KEY = "__other__";

export interface SeriesDef {
  key: string; // account id or OTHER_KEY
  label: string;
  /** CSS var reference for the series color, e.g. var(--series-1). */
  color: string;
}

export interface ChartRow {
  year: number;
  net_worth: number;
  [accountIdOrOther: string]: number;
}

export function seriesDefs(plan: Plan): SeriesDef[] {
  const defs: SeriesDef[] = plan.accounts
    .slice(0, MAX_SERIES)
    .map((account, i) => ({
      key: account.id,
      label: account.name,
      color: `var(--series-${i + 1})`,
    }));
  if (plan.accounts.length > MAX_SERIES) {
    defs.push({ key: OTHER_KEY, label: "Other", color: "var(--muted)" });
  }
  return defs;
}

/** Snapshot rows for charting, deflated to today's dollars when asked. */
export function chartRows(
  plan: Plan,
  projection: Projection,
  realDollars: boolean,
): ChartRow[] {
  const shown = new Set(plan.accounts.slice(0, MAX_SERIES).map((a) => a.id));
  return projection.snapshots.map((s) => {
    const divide = realDollars ? s.deflator : 1;
    const row: ChartRow = {
      year: s.period_start.year,
      net_worth: s.net_worth / divide,
    };
    let other = 0;
    for (const [id, balance] of Object.entries(s.balances)) {
      const value = (balance ?? 0) / divide;
      if (shown.has(id)) row[id] = value;
      else other += value;
    }
    if (other > 0) row[OTHER_KEY] = other;
    return row;
  });
}
