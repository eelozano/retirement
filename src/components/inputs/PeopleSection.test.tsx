import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "../../store/planStore";
import type { Plan } from "../../types/generated/Plan";
import { PeopleSection } from "./PeopleSection";

// A person's own income/expense streams, Social Security benefits and pensions
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
      rule_of_55: false,
    },
  ],
  streams: [],
  social_security: [],
  assumptions: { social_security_cola: 0.02, inflation: 0.025 },
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

  it("adds a single-life pension with no COLA, entered as a monthly check, alongside Social Security", async () => {
    render(<PeopleSection />);

    await userEvent.click(screen.getByRole("button", { name: "Add pension" }));
    const added = usePlanStore.getState().plan?.streams[0];
    expect(added?.kind).toBe("Pension");
    expect(added?.end).toEqual({ AtDeath: "p1" });
    expect(added?.growth).toBe("None");
    // Grouped with Social Security, not with the salary and expense streams.
    expect(screen.getByText("Social Security & pensions")).toBeTruthy();
    expect(screen.queryByLabelText("Amount / yr ($, today's)")).toBeNull();

    // The pension's own start can be pinned to an age too — "full benefit
    // at 65" is how a pension statement puts it.
    await userEvent.selectOptions(screen.getByLabelText("Starts"), "Age:p1");
    await userEvent.clear(screen.getByLabelText("Start age"));
    await userEvent.type(screen.getByLabelText("Start age"), "65");
    expect(usePlanStore.getState().plan?.streams[0].start).toEqual({ AtAge: ["p1", 65] });

    const monthly = screen.getByLabelText("Monthly benefit ($)");
    await userEvent.clear(monthly);
    await userEvent.type(monthly, "1500");
    expect(usePlanStore.getState().plan?.streams[0].annual_amount).toBe(18000);

    await userEvent.click(
      screen.getByRole("checkbox", { name: /cost-of-living adjustment/ }),
    );
    expect(usePlanStore.getState().plan?.streams[0].growth).toEqual({ Fixed: 0.025 });
  });

  it("ends a stream at an age, editable as an age rather than a month", async () => {
    render(<PeopleSection />);

    await userEvent.click(screen.getByRole("button", { name: "Add stream" }));
    await userEvent.selectOptions(screen.getByLabelText("Ends"), "Age:p1");
    expect(usePlanStore.getState().plan?.streams[0].end).toEqual({ AtAge: ["p1", 65] });

    const age = screen.getByLabelText("End age");
    await userEvent.clear(age);
    await userEvent.type(age, "62");
    expect(usePlanStore.getState().plan?.streams[0].end).toEqual({ AtAge: ["p1", 62] });
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

  it("derives full retirement age from the birth year, including the mid-year cohorts", async () => {
    // Born 1957, so SSA's full retirement age is 66 years 6 months — a value
    // the old whole-year field could not express at all (#149).
    usePlanStore.setState((s) => {
      const draft = structuredClone(s.plan) as Plan;
      draft.people[0].birth = { year: 1957, month: 8 };
      return { plan: draft };
    });
    render(<PeopleSection />);
    await userEvent.click(
      screen.getByRole("button", { name: "Add Social Security benefit" }),
    );

    expect(
      usePlanStore.getState().plan?.social_security[0].full_retirement_age,
    ).toBeNull();
    expect(screen.getByText(/66 years 6 months/)).toBeTruthy();
    // While it is derived there is no field to type a wrong one into.
    expect(screen.queryByLabelText("Full retirement age (years)")).toBeNull();
  });

  it("overrides full retirement age from the derived one, and goes back", async () => {
    render(<PeopleSection />);
    await userEvent.click(
      screen.getByRole("button", { name: "Add Social Security benefit" }),
    );

    await userEvent.click(
      screen.getByRole("checkbox", { name: /Set full retirement age myself/ }),
    );
    // Seeded from the derived age — Alex is born 1983, so 67 — rather than
    // from a blank the user has to fill in.
    expect(usePlanStore.getState().plan?.social_security[0].full_retirement_age).toEqual({
      years: 67,
      months: 0,
    });

    const months = screen.getByLabelText("…and months");
    await userEvent.clear(months);
    await userEvent.type(months, "6");
    expect(
      usePlanStore.getState().plan?.social_security[0].full_retirement_age?.months,
    ).toBe(6);

    await userEvent.click(
      screen.getByRole("checkbox", { name: /Set full retirement age myself/ }),
    );
    expect(
      usePlanStore.getState().plan?.social_security[0].full_retirement_age,
    ).toBeNull();
  });

  it("heads a benefit with its owner's name, numbering only a second one", async () => {
    render(<PeopleSection />);
    const add = screen.getByRole("button", { name: "Add Social Security benefit" });

    await userEvent.click(add);
    expect(screen.getByText("Alex's Social Security")).toBeTruthy();

    // A second benefit on the same person earns numbers; the index is within
    // the owner, not the household, so this pair reads 1 and 2 rather than
    // continuing a count started on someone else's card.
    await userEvent.click(add);
    expect(screen.getByText("Alex's Social Security 1")).toBeTruthy();
    expect(screen.getByText("Alex's Social Security 2")).toBeTruthy();
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
