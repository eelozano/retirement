import { describe, expect, it } from "vitest";
import type { PeriodSnapshot } from "../types/generated/PeriodSnapshot";
import type { Plan } from "../types/generated/Plan";
import type { Projection } from "../types/generated/Projection";
import { readableWarnings } from "./warnings";

const plan = {
  accounts: [{ id: "acct-1", name: "Enrique 403(b)" }],
  streams: [{ id: "salary", name: "Enrique salary" }],
  social_security: [],
} as unknown as Plan;

function projection(warnings: Projection["warnings"]): Projection {
  return {
    snapshots: [
      { period: 0, period_start: { year: 2026, month: 1 } } as PeriodSnapshot,
      { period: 1, period_start: { year: 2027, month: 1 } } as PeriodSnapshot,
    ],
    warnings,
  };
}

describe("readableWarnings", () => {
  it("names the account and both figures behind a clamped contribution", () => {
    const [w] = readableWarnings(
      plan,
      projection([
        { ContributionClamped: { account: "acct-1", requested: 37200, allowed: 24500 } },
      ]),
    );
    expect(w.title).toContain("Enrique 403(b)");
    expect(w.title).toContain("$24,500");
    expect(w.title).toContain("$37,200");
  });

  it("explains a fully crowded-out account differently from a trimmed one", () => {
    const [crowded] = readableWarnings(
      plan,
      projection([
        { ContributionClamped: { account: "acct-1", requested: 24500, allowed: 0 } },
      ]),
    );
    expect(crowded.detail).toContain("Nothing is being contributed here");
  });

  it("falls back to the raw id when the account is gone", () => {
    const [w] = readableWarnings(
      plan,
      projection([
        { ContributionClamped: { account: "ghost", requested: 100, allowed: 0 } },
      ]),
    );
    expect(w.title).toContain("ghost");
  });

  it("resolves a depletion period to its calendar year", () => {
    const [w] = readableWarnings(plan, projection([{ DepletedFunds: { period: 1 } }]));
    expect(w.title).toBe("Funds run out in 2027");
  });

  it("covers the unit-variant and stream-reference warnings", () => {
    const [surplus, unknown] = readableWarnings(
      plan,
      projection(["SurplusUnallocated", { UnknownPersonRef: { stream: "salary" } }]),
    );
    expect(surplus.title).toContain("Surplus");
    expect(unknown.title).toBe("Enrique salary was skipped");
  });

  it("gives every warning a distinct key", () => {
    const ws = readableWarnings(
      plan,
      projection([
        { ContributionClamped: { account: "acct-1", requested: 2, allowed: 1 } },
        { ContributionClamped: { account: "acct-1", requested: 2, allowed: 1 } },
      ]),
    );
    expect(new Set(ws.map((w) => w.key)).size).toBe(2);
  });
});
