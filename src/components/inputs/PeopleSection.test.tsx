import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "../../store/planStore";
import type { Plan } from "../../types/generated/Plan";
import { PeopleSection } from "./PeopleSection";

// A person's own income/expense streams and their Social Security benefits
// live on the person's card here — grouped by `owner` instead of scattered
// across separate flat panels. What they *save* does not: contributions and
// the employer match are edited on the account, covered in
// AccountsSection.test.tsx.

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
    presets: null,
    updatePlan: (recipe) =>
      usePlanStore.setState((s) => {
        const draft = structuredClone(s.plan) as Plan;
        recipe(draft);
        return { plan: draft };
      }),
  } as Partial<ReturnType<typeof usePlanStore.getState>> as never);
});

describe("PeopleSection", () => {
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

  it("no longer carries a saving band for the accounts the person owns", () => {
    render(<PeopleSection />);
    expect(screen.queryByText("Saving")).toBeNull();
    expect(screen.queryByText(/^Into /)).toBeNull();
    expect(screen.queryByLabelText("Contribution")).toBeNull();
    expect(screen.queryByLabelText("Employer match")).toBeNull();
  });
});
