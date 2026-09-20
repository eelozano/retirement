import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "../../store/planStore";
import type { Account } from "../../types/generated/Account";
import type { Plan } from "../../types/generated/Plan";
import { DrawdownSection } from "./DrawdownSection";

function account(
  id: string,
  owner: string,
  kind: Account["kind"],
  plan_type: Account["plan_type"],
  rule_of_55 = false,
): Account {
  return {
    id,
    owner,
    kind,
    name: id,
    balance: 100_000,
    cost_basis: null,
    allocation: "Moderate",
    plan_type,
    contributions: [],
    one_time_contributions: [],
    employer_match: null,
    rule_of_55,
  };
}

/** Invented: he retires in the year he turns 55 under the Rule of 55; she
 * retires at 51 and reaches 59½ in July 2034. */
const plan = {
  people: [
    {
      id: "him",
      name: "Sam",
      birth: { year: 1971, month: 6 },
      retirement: { year: 2026, month: 1 },
      life_expectancy_age: 90,
    },
    {
      id: "her",
      name: "Robin",
      birth: { year: 1975, month: 1 },
      retirement: { year: 2026, month: 1 },
      life_expectancy_age: 90,
    },
  ],
  accounts: [
    account("his-403b", "him", "TraditionalPreTax", "EmployerPlan", true),
    account("her-401k", "her", "TraditionalPreTax", "EmployerPlan"),
    account("brokerage", "him", "Taxable", "None"),
  ],
  streams: [],
  assumptions: { drawdown: "Proportional" },
  sim_config: { start: { year: 2026, month: 1 }, period: "Year" },
} as unknown as Plan;

beforeEach(() => {
  usePlanStore.setState({
    plan: structuredClone(plan),
    updatePlan: (recipe) =>
      usePlanStore.setState((s) => {
        const draft = structuredClone(s.plan) as Plan;
        recipe(draft);
        return { plan: draft };
      }),
  } as Partial<ReturnType<typeof usePlanStore.getState>> as never);
});

function policy() {
  return usePlanStore.getState().plan?.assumptions.drawdown;
}

describe("DrawdownSection", () => {
  it("starts proportional, and switching gives one phase in the default order", async () => {
    render(<DrawdownSection />);
    expect(policy()).toBe("Proportional");
    await userEvent.selectOptions(screen.getByLabelText("Withdraw"), "Phased");
    expect(policy()).toMatchObject({
      Phased: [{ name: "Default order", start: { Boundary: "PlanStart" }, stack: [] }],
    });
    expect(screen.getByText(/every account is drawn in the default order/)).toBeTruthy();
  });

  it("builds a bridge to the last early retiree's 59½ from one button", async () => {
    render(<DrawdownSection />);
    await userEvent.selectOptions(screen.getByLabelText("Withdraw"), "Phased");
    await userEvent.click(screen.getByRole("button", { name: "Bridge to 59½" }));

    expect(policy()).toMatchObject({
      Phased: [
        {
          name: "Bridge to 59½",
          stack: [
            { source: { Account: "brokerage" } },
            { source: { Account: "his-403b" } },
          ],
        },
        { name: "Standard", start: { PenaltyFree: "her" }, stack: [] },
      ],
    });
    // The second phase says when it starts.
    expect(screen.getByText("That's Jul 2034.")).toBeTruthy();
  });

  it("reorders, flags a penalized entry, and removes", async () => {
    render(<DrawdownSection />);
    await userEvent.selectOptions(screen.getByLabelText("Withdraw"), "Phased");
    await userEvent.selectOptions(
      screen.getByLabelText("Add to the list"),
      JSON.stringify({ Account: "brokerage" }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Add to the list"),
      JSON.stringify({ Account: "her-401k" }),
    );
    // Her 401(k) before her 59½ is penalized, and the row says until when.
    const row = screen.getByText("her-401k").closest("tr");
    if (!row) throw new Error("expected a stack row");
    expect(within(row).getByText("10% penalty until Jul 2034")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Move her-401k up" }));
    const order = () => {
      const p = policy();
      return p === "Proportional" || p === undefined
        ? []
        : p.Phased[0].stack.map((e) => ("Account" in e.source ? e.source.Account : ""));
    };
    expect(order()).toEqual(["her-401k", "brokerage"]);

    await userEvent.click(screen.getByRole("button", { name: "Remove her-401k" }));
    expect(order()).toEqual(["brokerage"]);
  });
});
