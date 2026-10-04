import { balanceDivisor, flowDivisor } from "../../lib/deflate";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";

// The categorical palette carries 8 slots; accounts beyond that fold into
// "Other" rather than generating new hues.
export const MAX_SERIES = 8;
export const OTHER_KEY = "__other__";

/** What the year's MAGI is called wherever it is shown — one definition,
 * named on screen (#186). */
export const MAGI_LABEL = "MAGI (ACA)";
export const MAGI_TOOLTIP =
  "Modified adjusted gross income as the ACA premium tax credit counts it: " +
  "taxable income including traditional withdrawals, required distributions, " +
  "interest, dividends and realized gains, plus all of your Social Security, " +
  "taxable or not. Roth withdrawals and the basis you get back from a " +
  "brokerage sale add nothing. Not the figure Medicare's IRMAA uses.";

export interface SeriesDef {
  key: string; // account id or OTHER_KEY
  label: string;
  /** CSS var reference for the series color, e.g. var(--series-1). */
  color: string;
}

export interface ChartRow {
  year: number;
  net_worth: number;
  /** The year's MAGI on the ACA definition — a flow, so the start-of-period
   * factor, unlike the balances beside it. */
  magi: number;
  [accountIdOrOther: string]: number;
}

export function seriesDefs(plan: Plan): SeriesDef[] {
  const defs: SeriesDef[] = plan.accounts.slice(0, MAX_SERIES).map((account, i) => ({
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
    // Every figure here is a balance, so the end-of-period factor.
    const divide = balanceDivisor(s, realDollars);
    const row: ChartRow = {
      year: s.period_start.year,
      net_worth: s.net_worth / divide,
      magi: s.magi / flowDivisor(s, realDollars),
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
