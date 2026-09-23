import type { Plan } from "../types/generated/Plan";
import type { Projection } from "../types/generated/Projection";
import { phaseName } from "./drawdown";
import { dateStamp, sanitizedPlanName } from "./exportFilename";

// The CSV twin of the year table, minus the account-count cap the chart
// applies for legibility (`MAX_SERIES` in chartData.ts) — a spreadsheet has
// no reason to fold anything into "Other".
//
// Per-stream and per-account columns (#67) sit right after the total they
// decompose, and are taken from `projection.streams` rather than the plan so
// the Social Security and survivor streams the engine synthesizes get
// columns too. One-time contributions follow the employer match the same way:
// their total, then a column for each entry the engine actually deposited
// (`projection.one_time`), zero outside the year it landed.

/** Wraps a field in quotes and escapes internal quotes if it needs it — the
 * free-text values here are account, stream and one-time contribution names. */
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
 * displayed basis, plus both deflators so the other basis is always
 * recoverable from the file alone. Balances and net worth are end-of-period
 * figures and are divided by the end factor; every flow by the start factor
 * (#146) — which is why there are two columns and not one. The basis is also
 * named in a metadata block up top — filename and header row are both easy
 * to lose track of once a file has been saved, forwarded, or opened in
 * something else.
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

  const incomeStreams = projection.streams.filter((s) => s.direction === "Income");
  const expenseStreams = projection.streams.filter((s) => s.direction === "Expense");
  const oneTime = projection.one_time;

  const header = [
    "Year",
    ...plan.accounts.map((a) => `${a.name} balance`),
    "Income",
    ...incomeStreams.map((s) => `${s.name} income`),
    "Expenses",
    ...expenseStreams.map((s) => `${s.name} expense`),
    "Taxes",
    "Tax on withdrawals",
    "Early-withdrawal penalty (in taxes)",
    "Contributions",
    ...plan.accounts.map((a) => `${a.name} contribution`),
    "Employer contributions",
    "One-time contributions",
    ...oneTime.map((o) => `${o.name.trim() || "One-time contribution"} (one-time)`),
    "Required distributions",
    "Surplus",
    ...plan.accounts.map((a) => `${a.name} withdrawal`),
    "Withdrawal phase",
    "Growth",
    "Net worth",
    "Deflator (start of year)",
    "Deflator (end of year)",
  ];

  const rows = projection.snapshots.map((s) => {
    const m = (nominal: number) => money(nominal, s.deflator, realDollars);
    const balance = (nominal: number) => money(nominal, s.deflator_end, realDollars);
    return [
      s.period_start.year,
      ...plan.accounts.map((a) => balance(s.balances[a.id] ?? 0)),
      m(s.income),
      ...incomeStreams.map((st) => m(s.income_by_stream[st.id] ?? 0)),
      m(s.expenses),
      ...expenseStreams.map((st) => m(s.expenses_by_stream[st.id] ?? 0)),
      m(s.taxes),
      m(s.withdrawal_taxes),
      m(s.early_withdrawal_penalty),
      m(s.contributions),
      ...plan.accounts.map((a) => m(s.contributions_by_account[a.id] ?? 0)),
      m(s.employer_match),
      m(s.one_time_contributions),
      ...oneTime.map((o) => m(o.period === s.period ? o.amount : 0)),
      m(s.required_distributions),
      m(s.surplus),
      ...plan.accounts.map((a) => m(s.withdrawals[a.id] ?? 0)),
      phaseName(plan, s.drawdown_phase) ?? "",
      m(s.growth),
      balance(s.net_worth),
      s.deflator,
      s.deflator_end,
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
