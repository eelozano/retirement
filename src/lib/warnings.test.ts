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
        {
          ContributionClamped: {
            account: "acct-1",
            period: 0,
            requested: 37200,
            allowed: 24500,
          },
        },
      ]),
    );
    expect(w.title).toContain("Enrique 403(b)");
    expect(w.title).toContain("$24,500");
    expect(w.title).toContain("$37,200");
  });

  it("dates the clamp, since indexed limits mean it starts in a particular year", () => {
    const [w] = readableWarnings(
      plan,
      projection([
        {
          ContributionClamped: {
            account: "acct-1",
            period: 1,
            requested: 37200,
            allowed: 24500,
          },
        },
      ]),
    );
    expect(w.title).toContain("from 2027");
  });

  it("keeps the two payload-free-looking unallocated warnings apart", () => {
    const [surplus, forced] = readableWarnings(
      plan,
      projection([
        "SurplusUnallocated",
        { RequiredDistributionUnallocated: { period: 1 } },
      ]),
    );
    expect(surplus.title).toContain("Surplus cash");
    expect(forced.title).toContain("Required withdrawals");
    expect(forced.title).toContain("2027");
    // The one that destroys money has to say so; the one that merely leaves
    // cash uninvested must not.
    expect(forced.detail).toContain("net worth");
    expect(surplus.detail).not.toContain("net worth");
  });

  it("tells an unresolvable sweep boundary apart from a missing taxable account", () => {
    const [unresolved] = readableWarnings(plan, projection(["SweepBoundaryUnresolved"]));
    expect(unresolved.detail).toContain("no longer in this plan");
    expect(unresolved.detail).not.toContain("taxable account");
  });

  it("explains a fully crowded-out account differently from a trimmed one", () => {
    const [crowded] = readableWarnings(
      plan,
      projection([
        {
          ContributionClamped: {
            account: "acct-1",
            period: 0,
            requested: 24500,
            allowed: 0,
          },
        },
      ]),
    );
    expect(crowded.detail).toContain("Nothing is being contributed here");
  });

  it("falls back to the raw id when the account is gone", () => {
    const [w] = readableWarnings(
      plan,
      projection([
        {
          ContributionClamped: {
            account: "ghost",
            period: 0,
            requested: 100,
            allowed: 0,
          },
        },
      ]),
    );
    expect(w.title).toContain("ghost");
  });

  it("resolves a depletion period to its calendar year", () => {
    const [w] = readableWarnings(plan, projection([{ DepletedFunds: { period: 1 } }]));
    expect(w.title).toBe("Funds run out in 2027");
  });

  it("explains a match with nowhere to land, and one cut by the annual cap", () => {
    const [unallocated, capped] = readableWarnings(
      plan,
      projection([
        { MatchUnallocated: { account: "acct-1" } },
        {
          AnnualAdditionsClamped: {
            account: "acct-1",
            period: 1,
            requested: 20000,
            allowed: 12000,
          },
        },
      ]),
    );
    expect(unallocated.title).toContain("nowhere to go");
    expect(capped.title).toContain("$12,000");
    expect(capped.title).toContain("from 2027");
    // The distinction that matters: the employee's own contributions are not
    // what gave way.
    expect(capped.detail).toContain("Your own contributions are untouched");
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
        {
          ContributionClamped: { account: "acct-1", period: 0, requested: 2, allowed: 1 },
        },
        {
          ContributionClamped: { account: "acct-1", period: 1, requested: 2, allowed: 1 },
        },
      ]),
    );
    expect(new Set(ws.map((w) => w.key)).size).toBe(2);
  });
});
