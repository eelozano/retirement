import { describe, expect, it } from "vitest";
import type { Plan } from "../types/generated/Plan";
import type { Projection } from "../types/generated/Projection";
import { buildProjectionCsv, projectionCsvFilename } from "./csvExport";

const plan = {
  name: "Retirement plan",
  accounts: [
    { id: "acct-1", name: "Enrique 403(b)" },
    { id: "acct-2", name: "Taxable, Enrique" },
  ],
} as unknown as Plan;

const projection: Projection = {
  snapshots: [
    {
      period: 0,
      period_start: { year: 2026, month: 1 },
      balances: { "acct-1": 100_000, "acct-2": 50_000 },
      withdrawals: { "acct-1": 0, "acct-2": 1234.567 },
      income: 80_000,
      income_by_stream: { salary: 70_000, "ss-1": 10_000 },
      expenses: 40_000,
      expenses_by_stream: { spending: 40_000 },
      taxes: 12_000,
      withdrawal_taxes: 300,
      contributions: 20_000,
      contributions_by_account: { "acct-1": 20_000 },
      employer_match: 5_000,
      required_distributions: 0,
      surplus: 3_000,
      growth: 8_000,
      net_worth: 150_000,
      deflator: 1.05,
    },
  ],
  warnings: [],
  streams: [
    { id: "salary", name: "Salary", direction: "Income" },
    { id: "spending", name: "Household spending", direction: "Expense" },
    { id: "ss-1", name: "Enrique's Social Security", direction: "Income" },
  ],
} as unknown as Projection;

describe("buildProjectionCsv", () => {
  /** Metadata block (4 lines) + a blank separator precede the header row. */
  function dataLines(csv: string): string[] {
    return csv.split("\r\n").slice(6);
  }
  function headerLine(csv: string): string {
    return csv.split("\r\n")[5];
  }

  it("names every account as its own balance and withdrawal column", () => {
    const header = headerLine(buildProjectionCsv(plan, projection, false));
    expect(header).toContain("Enrique 403(b) balance");
    expect(header).toContain('"Taxable, Enrique balance"');
    expect(header).toContain("Enrique 403(b) withdrawal");
  });

  /** Splits one CSV line, honouring quoted fields — the plan above has an
   * account name with a comma in it, so a naive split misaligns columns. */
  function splitCsv(line: string): string[] {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted && ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = !quoted;
      } else if (ch === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else {
        cell += ch;
      }
    }
    cells.push(cell);
    return cells;
  }

  it("breaks each total out by stream or account, right after the total", () => {
    const csv = buildProjectionCsv(plan, projection, false);
    const header = splitCsv(headerLine(csv));
    const [dataLine] = dataLines(csv);
    const cells = splitCsv(dataLine);
    const at = (name: string) => cells[header.indexOf(name)];

    const income = header.indexOf("Income");
    expect(header.slice(income, income + 3)).toEqual([
      "Income",
      "Salary income",
      "Enrique's Social Security income",
    ]);
    expect(at("Salary income")).toBe("70000");
    expect(at("Enrique's Social Security income")).toBe("10000");
    expect(header[header.indexOf("Expenses") + 1]).toBe("Household spending expense");
    expect(at("Household spending expense")).toBe("40000");
    expect(header[header.indexOf("Taxes") + 1]).toBe("Tax on withdrawals");
    expect(at("Tax on withdrawals")).toBe("300");
    expect(header[header.indexOf("Contributions") + 1]).toBe(
      "Enrique 403(b) contribution",
    );
    expect(at("Enrique 403(b) contribution")).toBe("20000");
    // An account that received nothing still gets its column, as 0.
    expect(at("Taxable, Enrique contribution")).toBe("0");
  });

  it("quotes an account name that contains a comma", () => {
    const csv = buildProjectionCsv(plan, projection, false);
    expect(csv).toContain('"Taxable, Enrique balance"');
  });

  it("keeps nominal figures as-is and always carries the raw deflator", () => {
    const csv = buildProjectionCsv(plan, projection, false);
    const [dataLine] = dataLines(csv);
    const cells = dataLine.split(",");
    expect(cells[0]).toBe("2026");
    expect(cells[cells.length - 1]).toBe("1.05");
    expect(dataLine).toContain("150000");
  });

  it("deflates every dollar figure but not the deflator itself when real dollars is on", () => {
    const csv = buildProjectionCsv(plan, projection, true);
    const [dataLine] = dataLines(csv);
    const cells = dataLine.split(",");
    // net_worth (150000) / deflator (1.05), rounded to cents.
    expect(Number(cells[cells.length - 2])).toBeCloseTo(150_000 / 1.05, 2);
    expect(cells[cells.length - 1]).toBe("1.05");
  });

  it("names the basis in a metadata block, since a filename or header alone is easy to lose", () => {
    const real = buildProjectionCsv(plan, projection, true);
    const nominal = buildProjectionCsv(plan, projection, false);
    expect(real).toContain("# Basis: Today's dollars (real, deflated)");
    expect(nominal).toContain("# Basis: Nominal dollars");
    expect(real).toContain(`# Plan: ${plan.name}`);
  });

  it("rounds withdrawal figures to cents", () => {
    const csv = buildProjectionCsv(plan, projection, false);
    expect(csv).toContain("1234.57");
  });
});

describe("projectionCsvFilename", () => {
  it("encodes the basis and sanitizes the plan name", () => {
    const messy = { name: "Enrique's Plan / v2" } as unknown as Plan;
    expect(projectionCsvFilename(messy, true)).toMatch(
      /^Enriques-Plan-v2-projection-real-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    expect(projectionCsvFilename(messy, false)).toContain("-projection-nominal-");
  });

  it("falls back to a generic name when the plan name sanitizes to nothing", () => {
    const blank = { name: "///" } as unknown as Plan;
    expect(projectionCsvFilename(blank, false)).toMatch(/^plan-projection-nominal-/);
  });
});
