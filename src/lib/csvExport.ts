import type { Plan } from "../types/generated/Plan";
import type { Projection } from "../types/generated/Projection";
import { dateStamp, sanitizedPlanName } from "./exportFilename";

// The CSV twin of the year table, minus the account-count cap the chart
// applies for legibility (`MAX_SERIES` in chartData.ts) — a spreadsheet has
// no reason to fold anything into "Other".

/** Wraps a field in quotes and escapes internal quotes if it needs it — the
 * only free-text values here are account names. */
function csvField(value: string | number): string {
  const s = typeof value === "number" ? String(value) : value;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A nominal snapshot figure, converted to the displayed basis and rounded
 * to cents — raw numbers for spreadsheet import, not `currency()` display
 * formatting. */
function money(nominal: number, deflator: number, realDollars: boolean): number {
  const value = realDollars ? nominal / deflator : nominal;
  return Math.round(value * 100) / 100;
}

/**
 * One row per period, every `PeriodSnapshot` figure in the currently
 * displayed basis, plus the `deflator` itself so the other basis is always
 * recoverable from the file alone. The basis is also named in a metadata
 * block up top — filename and header row are both easy to lose track of
 * once a file has been saved, forwarded, or opened in something else.
 */
export function buildProjectionCsv(
  plan: Plan,
  projection: Projection,
  realDollars: boolean,
): string {
  const basisLabel = realDollars ? "Today's dollars (real, deflated)" : "Nominal dollars";
  const meta = [
    "# Retirement Planner projection export",
    `# Plan: ${plan.name}`,
    `# Basis: ${basisLabel}`,
    `# Generated: ${new Date().toISOString()}`,
  ];

  const header = [
    "Year",
    ...plan.accounts.map((a) => `${a.name} balance`),
    "Income",
    "Expenses",
    "Taxes",
    "Contributions",
    "Employer match",
    "Required distributions",
    "Surplus",
    ...plan.accounts.map((a) => `${a.name} withdrawal`),
    "Growth",
    "Net worth",
    "Deflator",
  ];

  const rows = projection.snapshots.map((s) => {
    const m = (nominal: number) => money(nominal, s.deflator, realDollars);
    return [
      s.period_start.year,
      ...plan.accounts.map((a) => m(s.balances[a.id] ?? 0)),
      m(s.income),
      m(s.expenses),
      m(s.taxes),
      m(s.contributions),
      m(s.employer_match),
      m(s.required_distributions),
      m(s.surplus),
      ...plan.accounts.map((a) => m(s.withdrawals[a.id] ?? 0)),
      m(s.growth),
      m(s.net_worth),
      s.deflator,
    ];
  });

  const lines = [
    ...meta,
    "",
    header.map(csvField).join(","),
    ...rows.map((r) => r.map(csvField).join(",")),
  ];
  return lines.join("\r\n");
}

/** `<plan name>-projection-{real,nominal}-<date>.csv`, filesystem-safe — the
 * basis lives in the filename too, since a header row alone is easy to lose
 * once a file is opened elsewhere. */
export function projectionCsvFilename(plan: Plan, realDollars: boolean): string {
  const basis = realDollars ? "real" : "nominal";
  return `${sanitizedPlanName(plan)}-projection-${basis}-${dateStamp()}.csv`;
}
