import { describe, expect, it } from "vitest";
import type { PeriodSnapshot } from "../../types/generated/PeriodSnapshot";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import { chartRows } from "./chartData";

const RATE = 0.03;
const OPENING = 1_000_000;

const plan = { accounts: [{ id: "a", name: "Account" }] } as unknown as Plan;

/**
 * The case from #146: an account earning exactly the inflation rate, with
 * nothing going in or out, so its real value is `OPENING` in every year by
 * construction. Nominal at the end of year `n` is `OPENING * 1.03^(n+1)`;
 * the deflator is the factor at the year's start, `deflator_end` at its end.
 */
function inflationTrackingProjection(years: number): Projection {
  const snapshots = Array.from({ length: years }, (_, n) => {
    const nominal = OPENING * (1 + RATE) ** (n + 1);
    return {
      period: n,
      period_start: { year: 2026 + n, month: 1 },
      balances: { a: nominal },
      net_worth: nominal,
      deflator: (1 + RATE) ** n,
      deflator_end: (1 + RATE) ** (n + 1),
    } as unknown as PeriodSnapshot;
  });
  return { snapshots, warnings: [], streams: [], one_time: [] };
}

describe("chartRows", () => {
  it("shows an account that only keeps pace with inflation as flat in real dollars", () => {
    const rows = chartRows(plan, inflationTrackingProjection(30), true);
    expect(rows).toHaveLength(30);
    for (const row of rows) {
      expect(Math.abs(row.net_worth / OPENING - 1)).toBeLessThan(1e-9);
      expect(Math.abs(row.a / OPENING - 1)).toBeLessThan(1e-9);
    }
  });

  it("leaves nominal balances as the engine emitted them", () => {
    const rows = chartRows(plan, inflationTrackingProjection(3), false);
    expect(rows.map((r) => r.net_worth)).toEqual([
      OPENING * 1.03,
      OPENING * 1.03 ** 2,
      OPENING * 1.03 ** 3,
    ]);
  });
});
