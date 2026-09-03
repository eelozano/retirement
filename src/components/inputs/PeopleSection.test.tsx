import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "../../store/planStore";
import type { Plan } from "../../types/generated/Plan";
import type { Presets } from "../../types/generated/Presets";
import { PeopleSection } from "./PeopleSection";

// Contribution mode, employer match, a person's own income/expense streams,
// and their Social Security benefits all moved onto the person's card here —
// grouped by `owner` instead of scattered across separate flat panels.

const presets = {
  contribution_limits: {
    basis_year: 2026,
    employer_plan: 24500,
    employer_plan_catch_up_50: 8000,
    employer_plan_catch_up_60_63: 11250,
    ira: 7500,
    ira_catch_up_50: 1100,
  },
} as unknown as Presets;

const plan = {
  people: [
    {
      id: "p1",
      name: "Alex",
      birth: { year: 1983, month: 8 },
      retirement: { year: 2038, month: 12 },
      life_expectancy_age: 90,
    },
  ],
  accounts: [
    {
      id: "a1",
      owner: "p1",
      kind: "TraditionalPreTax",
      name: "403(b)",
      balance: 0,
      cost_basis: null,
      allocation: "Moderate",
      plan_type: "EmployerPlan",
      contributions: [
        {
          id: "a1-contribution",
          rule: { FlatAmount: { amount: 0 } },
          start: "PlanStart",
          end: { AtRetirement: "p1" },
        },
      ],
      employer_match: null,
    },
  ],
  streams: [],
  social_security: [],
  assumptions: { social_security_cola: 0.02 },
} as unknown as Plan;

beforeEach(() => {
  usePlanStore.setState({
    plan: structuredClone(plan),
    presets,
    updatePlan: (recipe) =>
      usePlanStore.setState((s) => {
        const draft = structuredClone(s.plan) as Plan;
        recipe(draft);
        return { plan: draft };
      }),
  } as Partial<ReturnType<typeof usePlanStore.getState>> as never);
});

function currentAccount() {
  return usePlanStore.getState().plan?.accounts[0];
}

describe("PeopleSection", () => {
  it("edits an owned account's contribution mode from the person's card, not the account", async () => {
    render(<PeopleSection />);

    await userEvent.selectOptions(
      screen.getByLabelText("Contribution"),
      "PercentOfSalary",
    );
    const percent = screen.getByLabelText("Of salary (%)");
    await userEvent.clear(percent);
    await userEvent.type(percent, "10");
    expect(currentAccount()?.contributions[0].rule).toEqual({
      PercentOfSalary: { percent: 0.1 },
    });
    // The window is untouched: the mode select edits the rule, not the dates.
    expect(currentAccount()?.contributions[0].end).toEqual({ AtRetirement: "p1" });

    await userEvent.selectOptions(
      screen.getByLabelText("Contribution"),
      "FederalMaximum",
    );
    expect(currentAccount()?.contributions[0].rule).toBe("FederalMaximum");
    expect(screen.getByText(/\$24,500\/yr in 2026/)).toBeTruthy();
  });

  it("adds an employer match with a tiered formula", async () => {
    render(<PeopleSection />);

    await userEvent.click(screen.getByLabelText("Employer match"));
    expect(currentAccount()?.employer_match).toEqual({
      tiers: [{ employee_percent: 0.03, match_percent: 1 }],
      destination: "PreTax",
    });

    await userEvent.click(screen.getByRole("button", { name: "Add match tier" }));
    expect(currentAccount()?.employer_match?.tiers).toHaveLength(2);
  });

  it("shows a hint instead of a saving band when the person owns no accounts", () => {
    usePlanStore.setState((s) => ({ plan: { ...(s.plan as Plan), accounts: [] } }));
    render(<PeopleSection />);
    expect(screen.getByText(/No accounts yet/)).toBeTruthy();
  });

  it("adds and edits a stream owned by the person, defaulting to income that ends at their retirement", async () => {
    render(<PeopleSection />);

    await userEvent.click(screen.getByRole("button", { name: "Add stream" }));
    const stream = usePlanStore.getState().plan?.streams[0];
    expect(stream?.owner).toBe("p1");
    expect(stream?.direction).toBe("Income");
    expect(stream?.end).toEqual({ AtRetirement: "p1" });

    const amount = screen.getByLabelText("Amount / yr ($, today's)");
    await userEvent.clear(amount);
    await userEvent.type(amount, "120000");
    expect(usePlanStore.getState().plan?.streams[0].annual_amount).toBe(120000);
  });

  it("adds and edits a Social Security benefit owned by the person, with no owner select", async () => {
    render(<PeopleSection />);

    await userEvent.click(
      screen.getByRole("button", { name: "Add Social Security benefit" }),
    );
    expect(usePlanStore.getState().plan?.social_security[0]?.owner).toBe("p1");
    expect(screen.queryByLabelText("Owner")).toBeNull();

    const amount = screen.getByLabelText(
      "Benefit at full retirement age ($/yr, today's)",
    );
    await userEvent.clear(amount);
    await userEvent.type(amount, "32000");
    expect(usePlanStore.getState().plan?.social_security[0].benefit_at_fra).toBe(32000);
  });

  it("adds a new person", async () => {
    render(<PeopleSection />);
    await userEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(usePlanStore.getState().plan?.people).toHaveLength(2);
    expect(screen.getAllByText("New person")).toHaveLength(1);
  });

  it("names each person's card, so an account's contribution reads as that person's story", () => {
    render(<PeopleSection />);
    const card = screen
      .getByText("Into 403(b)", { selector: "legend" })
      .closest(".person-card");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("Alex")).toBeTruthy();
  });
});
