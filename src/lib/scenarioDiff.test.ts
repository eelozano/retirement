import { describe, expect, it } from "vitest";
import { basePlan as base } from "../test/fixtures";
import type { Plan } from "../types/generated/Plan";
import { changeSummary, scenarioChanges } from "./scenarioDiff";

/** A branch of `base`: its own id and name, then whatever `edit` changes. */
function branch(edit: (plan: Plan) => void): Plan {
  const plan = base();
  plan.id = "branch";
  plan.name = "Branch";
  edit(plan);
  return plan;
}

describe("scenarioChanges", () => {
  it("finds nothing between a scenario and an unedited copy of it", () => {
    expect(
      scenarioChanges(
        base(),
        branch(() => {}),
      ),
    ).toEqual([]);
  });

  it("ignores the name, the id and how the charts open", () => {
    const other = branch((p) => {
      p.sim_config.display_real_dollars = false;
    });
    expect(scenarioChanges(base(), other)).toEqual([]);
  });

  it("reports a removed lump sum by name, with what it was", () => {
    const stay = branch((p) => {
      p.accounts[1].one_time_contributions = [];
    });
    expect(scenarioChanges(base(), stay)).toEqual([
      {
        what: "House sale removed",
        now: null,
        was: "$350,000 in today's dollars in Jun 2040",
      },
    ]);
  });

  it("reports a retirement move once, not again on every window tied to it", () => {
    const early = branch((p) => {
      p.people[0].retirement = { year: 2031, month: 6 };
    });
    expect(scenarioChanges(base(), early)).toEqual([
      { what: "Alex's retirement", now: "Jun 2031", was: "Jun 2033" },
    ]);
  });

  it("matches list entries by id, so removing the first does not shift the rest", () => {
    const noMain = branch((p) => {
      p.accounts[0].contributions.shift();
    });
    const changes = scenarioChanges(base(), noMain);
    expect(changes).toHaveLength(1);
    expect(changes[0].what).toBe("Alex 401(k) contribution removed");
    expect(changes[0].was).toBe(
      "10.0% of salary from plan start until Alex retires (Jun 2033)",
    );
  });

  it("names a changed recurring contribution and says both rules", () => {
    const more = branch((p) => {
      p.accounts[0].contributions[1].rule = {
        FlatAmount: { amount: 10_000, growth: "Inflation" },
      };
    });
    const [change] = scenarioChanges(base(), more);
    expect(change.what).toBe("Alex 401(k) · Catch-up");
    expect(change.now).toMatch(/^\$10,000\/yr, \+inflation from Alex turns 50/);
    expect(change.was).toMatch(/^\$7,500\/yr, \+inflation from Alex turns 50/);
  });

  it("reports added and changed cash flows", () => {
    const other = branch((p) => {
      p.streams[0].annual_amount = 80_000;
      p.streams.push({
        id: "rent",
        name: "Rent",
        owner: null,
        direction: "Expense",
        annual_amount: 30_000,
        start: { Date: { year: 2040, month: 7 } },
        end: "PlanEnd",
        growth: "Inflation",
        survivor_percentage: null,
        kind: "General",
      });
    });
    expect(scenarioChanges(base(), other)).toEqual([
      {
        what: "Household spending",
        now: "$80,000/yr spending from plan start until plan end, +inflation",
        was: "$90,000/yr spending from plan start until plan end, +inflation",
      },
      {
        what: "Rent added",
        now: "$30,000/yr spending from Jul 2040 until plan end, +inflation",
        was: null,
      },
    ]);
  });

  it("says when only an entry's name changed", () => {
    const renamed = branch((p) => {
      p.streams[0].name = "Boston expenses";
    });
    expect(scenarioChanges(base(), renamed)).toEqual([
      {
        what: "Household spending renamed",
        now: "Boston expenses",
        was: "Household spending",
      },
    ]);
  });

  it("covers claiming, returns and the withdrawal order", () => {
    const other = branch((p) => {
      p.social_security[0].claiming_age = 70;
      p.assumptions.strategy_returns.moderate = 0.06;
      p.assumptions.inflation = 0.025;
      p.assumptions.drawdown = {
        Phased: [
          {
            id: "bridge",
            name: "Bridge",
            start: { Boundary: "PlanStart" },
            rule: "Stack",
            stack: [{ source: { Kind: "Taxable" }, floor: 0 }],
          },
        ],
      };
    });
    expect(scenarioChanges(base(), other).map((c) => [c.what, c.now, c.was])).toEqual([
      ["Alex's Social Security claiming age", "age 70", "age 67"],
      ["Moderate return", "6.0%", "6.5%"],
      ["Withdrawal order", "Bridge", "proportional to balances"],
      ["Inflation", "2.5%", "3.0%"],
    ]);
  });

  it("never reports a household fact, even one a stale copy disagrees on", () => {
    // Saving a scenario rewrites the household its siblings compose from, so
    // a balance cannot actually differ; if it ever did, it is not something
    // this scenario chose.
    const stale = branch((p) => {
      p.accounts[0].balance = 1;
      p.people[0].birth = { year: 1980, month: 1 };
      p.sim_config.start = { year: 2025, month: 1 };
    });
    expect(scenarioChanges(base(), stale)).toEqual([]);
  });
});

describe("changeSummary", () => {
  it("says a scenario matches its reference by the reference's name", () => {
    expect(changeSummary([], "Base plan")).toBe("Same as Base plan");
  });

  it("lists the first three changes and counts the rest", () => {
    const change = (what: string) => ({ what, now: null, was: null });
    expect(changeSummary([change("A")], "Base plan")).toBe("1 change: A");
    expect(changeSummary(["A", "B", "C", "D", "E"].map(change), "Base plan")).toBe(
      "5 changes: A, B, C, +2 more",
    );
  });
});
