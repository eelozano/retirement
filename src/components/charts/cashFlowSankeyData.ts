import { isWorkingPeriod } from "../../lib/currentSpending";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import { OTHER_KEY, type SeriesDef } from "./chartData";

// One year's cash flow as a graph: what came in, pooled through the
// household, and what it went out to (#67).
//
// The shape is a hub, deliberately. The engine pools every inflow and taxes
// the period in one pass, so it never decides that "salary paid the tax";
// linking each source to each use would be an allocation the simulation did
// not make. What the engine *does* know is the identity it pins in
// `crates/engine/tests/properties.rs`:
//
//   income + withdrawals = expenses + taxes + contributions + surplus
//
// so the hub balances by construction, and every node here is a term of
// that identity broken out by stream or account. Employer match and market
// growth appear on neither side of it and are not nodes.

export type CompositionSide = "in" | "hub" | "out";

export interface CompositionNode {
  key: string;
  /** Short label, truncated to fit beside a node. */
  label: string;
  /** The untruncated name, for the tooltip. */
  fullLabel: string;
  /** CSS var reference, e.g. var(--series-2). */
  color: string;
  side: CompositionSide;
  value: number;
}

/** Indices into `Composition.nodes`, as Recharts' Sankey wants them. */
export interface CompositionLink {
  source: number;
  target: number;
  value: number;
}

export interface Composition {
  year: number;
  nodes: CompositionNode[];
  links: CompositionLink[];
  /** Everything that reached the household: income plus gross withdrawals. */
  totalIn: number;
  /** Not a flow — went straight into accounts — but worth a note. */
  employerMatch: number;
  /** The forced share of the withdrawal nodes, for a note. */
  requiredDistributions: number;
  /**
   * Outflows the year's inflows could not cover. Zero except in a depleted
   * year, where the engine clamps `surplus` to zero and the identity above
   * breaks by exactly this much; it is drawn as an inflow so the picture
   * still balances and the gap is visible rather than hidden.
   */
  shortfall: number;
  /** Anyone still earning — the residual is current spending, not leftovers. */
  working: boolean;
  /** Nothing moved through the household at all. */
  empty: boolean;
}

export const HUB_KEY = "__household__";
export const SHORTFALL_KEY = "__shortfall__";
export const INCOME_TAX_KEY = "__tax_on_income__";
export const WITHDRAWAL_TAX_KEY = "__tax_on_withdrawals__";
export const RESIDUAL_KEY = "__residual__";

const LABEL_MAX = 22;
/** Below this the link would be invisible anyway, and a $0.00 node is noise. */
const MIN_VALUE = 0.005;

export function truncateLabel(name: string): string {
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1).trimEnd()}…` : name;
}

function node(
  key: string,
  name: string,
  color: string,
  side: CompositionSide,
  value: number,
): CompositionNode {
  return { key, label: truncateLabel(name), fullLabel: name, color, side, value };
}

/**
 * Per-account figures as nodes, in the Plan screen's series order and colors
 * so an account reads the same here as in its balance band. Accounts past
 * `MAX_SERIES` fold into "Other", exactly as the balance stack does.
 */
function accountNodes(
  amounts: PeriodSnapshot["withdrawals"],
  series: SeriesDef[],
  side: CompositionSide,
  divisor: number,
  keyPrefix: string,
): CompositionNode[] {
  const shown = new Set(series.map((s) => s.key));
  let other = 0;
  for (const [id, amount] of Object.entries(amounts)) {
    if (!shown.has(id)) other += (amount ?? 0) / divisor;
  }
  return series
    .map((def) =>
      node(
        `${keyPrefix}${def.key}`,
        def.label,
        def.color,
        side,
        def.key === OTHER_KEY ? other : (amounts[def.key] ?? 0) / divisor,
      ),
    )
    .filter((n) => n.value > MIN_VALUE);
}

/**
 * The composition of one year, or null if the projection has no period
 * starting in it. Nodes are ordered inflows, hub, outflows; within a side,
 * streams before accounts and the residual last, so the diagram reads
 * top-down in the order the engine's steps run.
 */
export function yearComposition(
  plan: Plan,
  projection: Projection,
  year: number,
  series: SeriesDef[],
  realDollars: boolean,
): Composition | null {
  const s = projection.snapshots.find((snap) => snap.period_start.year === year);
  if (!s) return null;
  const d = realDollars ? s.deflator : 1;
  const working = isWorkingPeriod(plan, s);

  const streamNodes = (
    direction: "Income" | "Expense",
    amounts: PeriodSnapshot["income_by_stream"],
    color: string,
    side: CompositionSide,
  ): CompositionNode[] =>
    projection.streams
      .filter((info) => info.direction === direction)
      .map((info) =>
        node(`stream:${info.id}`, info.name, color, side, (amounts[info.id] ?? 0) / d),
      )
      .filter((n) => n.value > MIN_VALUE);

  const inflows = [
    ...streamNodes("Income", s.income_by_stream, "var(--series-2)", "in"),
    ...accountNodes(s.withdrawals, series, "in", d, "withdrawal:"),
  ];

  const incomeTax = (s.taxes - s.withdrawal_taxes) / d;
  const withdrawalTax = s.withdrawal_taxes / d;
  const outflows = [
    ...streamNodes("Expense", s.expenses_by_stream, "var(--series-3)", "out"),
    node(INCOME_TAX_KEY, "Tax on income", "var(--series-7)", "out", incomeTax),
    node(
      WITHDRAWAL_TAX_KEY,
      "Tax on withdrawals",
      "var(--series-7)",
      "out",
      withdrawalTax,
    ),
    ...accountNodes(s.contributions_by_account, series, "out", d, "contribution:"),
    // While anyone is still earning this is what the household lives on,
    // not money looking for a home (#50) — same renaming as the inspector.
    node(
      RESIDUAL_KEY,
      working ? "Current spending" : "Left over",
      "var(--text-primary)",
      "out",
      s.surplus / d,
    ),
  ].filter((n) => n.value > MIN_VALUE);

  const totalIn = inflows.reduce((sum, n) => sum + n.value, 0);
  const totalOut = outflows.reduce((sum, n) => sum + n.value, 0);
  const shortfall = totalOut - totalIn > MIN_VALUE ? totalOut - totalIn : 0;
  if (shortfall > 0) {
    inflows.push(
      node(
        SHORTFALL_KEY,
        "Unfunded shortfall",
        "var(--status-critical)",
        "in",
        shortfall,
      ),
    );
  }

  const hub = node(HUB_KEY, "Household", "var(--axis)", "hub", totalIn + shortfall);
  const nodes = [...inflows, hub, ...outflows];
  const hubIndex = inflows.length;
  const links: CompositionLink[] = [
    ...inflows.map((n, i) => ({ source: i, target: hubIndex, value: n.value })),
    ...outflows.map((n, i) => ({
      source: hubIndex,
      target: hubIndex + 1 + i,
      value: n.value,
    })),
  ];

  return {
    year,
    nodes,
    links,
    totalIn,
    employerMatch: s.employer_match / d,
    requiredDistributions: s.required_distributions / d,
    shortfall,
    working,
    empty: totalIn <= MIN_VALUE && totalOut <= MIN_VALUE,
  };
}
