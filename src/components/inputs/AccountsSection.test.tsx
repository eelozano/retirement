import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "../../store/planStore";
import type { Plan } from "../../types/generated/Plan";
import type { Presets } from "../../types/generated/Presets";
import { AccountsSection } from "./AccountsSection";

// Everything about an account is edited here: kind, statutory bucket,
// owner, allocation, balance, the dated contributions going into it, and
// any employer match. Contributions passed through the People pane for a
// while; dated entries brought them back to the account.

const presets = {
  contribution_limits: {
    basis_year: 2026,
    employer_plan: 24500,
    ira: 7500,
  },
} as unknown as Presets;

const plan = {
  people: [
    { id: "p1", name: "Solo", retirement: { year: 2040, month: 1 } },
    { id: "p2", name: "Partner", retirement: { year: 2045, month: 1 } },
  ],
  accounts: [],
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

async function addAccount() {
  await userEvent.click(screen.getByRole("button", { name: "Add account" }));
}

describe("AccountsSection", () => {
  it("adds a taxable account with no statutory bucket, selected in the editor below", async () => {
    render(<AccountsSection />);
    await addAccount();
    expect(currentAccount()?.plan_type).toBe("None");
    // One entry from plan start until the owner retires — what every
    // account did before entries were dated.
    expect(currentAccount()?.contributions).toEqual([
      {
        id: expect.stringMatching(/-contribution$/),
        rule: { FlatAmount: { amount: 0, growth: "None" } },
        start: "PlanStart",
        end: { AtRetirement: "p1" },
      },
    ]);
    expect(screen.queryByLabelText("Plan type")).toBeNull();
    expect(screen.getByRole("button", { name: "New account" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("sets both kind and plan type together from one account-type selection", async () => {
    render(<AccountsSection />);
    await addAccount();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "employer_pretax");
    expect(currentAccount()?.kind).toBe("TraditionalPreTax");
    expect(currentAccount()?.plan_type).toBe("EmployerPlan");

    await userEvent.selectOptions(screen.getByLabelText("Type"), "roth_ira");
    expect(currentAccount()?.kind).toBe("Roth");
    expect(currentAccount()?.plan_type).toBe("Ira");

    // 457(b) and 401(k)/403(b) are statutorily separate buckets even though
    // both are TraditionalPreTax — the picker has to tell them apart.
    await userEvent.selectOptions(screen.getByLabelText("Type"), "plan_457b");
    expect(currentAccount()?.kind).toBe("TraditionalPreTax");
    expect(currentAccount()?.plan_type).toBe("Plan457b");
  });

  it("rewrites a federal-maximum entry when the account is retyped to an uncapped bucket", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "roth_ira");
    usePlanStore.getState().updatePlan((d) => {
      d.accounts[0].contributions[0].rule = "FederalMaximum";
    });

    await userEvent.selectOptions(screen.getByLabelText("Type"), "taxable");
    expect(currentAccount()?.contributions[0].rule).toEqual({
      FlatAmount: { amount: 0, growth: "None" },
    });
  });

  it("switches a savings account to a fixed cash rate instead of a market allocation", async () => {
    render(<AccountsSection />);
    await addAccount();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "savings");
    expect(currentAccount()?.kind).toBe("Savings");
    expect(currentAccount()?.allocation).toEqual({ Cash: expect.any(Number) });
    expect(screen.queryByLabelText("Allocation")).toBeNull();
    expect(screen.getByLabelText("Interest rate (%)")).toBeTruthy();

    // Leaving Savings returns to a market preset — "Cash" isn't otherwise offered.
    await userEvent.selectOptions(screen.getByLabelText("Type"), "taxable");
    expect(currentAccount()?.allocation).toBe("Moderate");
  });

  it("edits owner, allocation, and balance on the selected account", async () => {
    render(<AccountsSection />);
    await addAccount();

    await userEvent.selectOptions(screen.getByLabelText("Owner"), "p2");
    expect(currentAccount()?.owner).toBe("p2");
    expect(screen.getByRole("cell", { name: "Partner" })).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Allocation"), "Aggressive");
    expect(currentAccount()?.allocation).toBe("Aggressive");

    const balance = screen.getByLabelText("Balance today ($)");
    await userEvent.clear(balance);
    await userEvent.type(balance, "5000");
    expect(currentAccount()?.balance).toBe(5000);
    expect(screen.getByRole("cell", { name: "$5,000" })).toBeTruthy();
  });

  it("only offers cost basis on a taxable account — not savings, which has none", async () => {
    render(<AccountsSection />);
    await addAccount();
    expect(screen.getByLabelText("Cost basis ($)")).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "savings");
    expect(screen.queryByLabelText("Cost basis ($)")).toBeNull();
    expect(currentAccount()?.cost_basis).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "roth_ira");
    expect(screen.queryByLabelText("Cost basis ($)")).toBeNull();
    expect(currentAccount()?.cost_basis).toBeNull();
  });

  it("switches the editor to a second account when its row is selected", async () => {
    usePlanStore.setState((s) => ({
      plan: {
        ...(s.plan as Plan),
        accounts: [
          {
            id: "a1",
            owner: "p1",
            kind: "Taxable",
            name: "First",
            balance: 0,
            cost_basis: 0,
            allocation: "Moderate",
            plan_type: "None",
            contributions: [],
            employer_match: null,
          },
          {
            id: "a2",
            owner: "p1",
            kind: "Taxable",
            name: "Second",
            balance: 0,
            cost_basis: 0,
            allocation: "Moderate",
            plan_type: "None",
            contributions: [],
            employer_match: null,
          },
        ],
      },
    }));
    render(<AccountsSection />);

    // The first account is selected by default, so the editor is never empty.
    expect(screen.getByLabelText("Name")).toHaveValue("First");

    await userEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Second");
  });

  it("edits the contribution mode and amount on the account itself", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "employer_pretax");

    await userEvent.selectOptions(
      screen.getByLabelText("Contribution"),
      "PercentOfSalary",
    );
    const percent = screen.getByLabelText("Of salary (%)");
    await userEvent.clear(percent);
    await userEvent.type(percent, "10");
    // `step_up` rides along unset: escalation is off until #81's controls
    // turn it on, and editing the percentage does not disturb it.
    expect(currentAccount()?.contributions[0].rule).toEqual({
      PercentOfSalary: { percent: 0.1, step_up: null },
    });
    // The window is untouched: the mode select edits the rule, not the dates.
    expect(currentAccount()?.contributions[0].end).toEqual({ AtRetirement: "p1" });
    expect(
      screen.getByText("10% of salary from plan start until Solo retires"),
    ).toBeTruthy();

    await userEvent.selectOptions(
      screen.getByLabelText("Contribution"),
      "FederalMaximum",
    );
    expect(currentAccount()?.contributions[0].rule).toBe("FederalMaximum");
    expect(screen.getByText(/\$24,500\/yr in 2026/)).toBeTruthy();
  });

  it("names the savings rate on a savings account, and offers no federal maximum without a bucket", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "savings");

    const mode = screen.getByLabelText("Savings rate");
    expect(screen.queryByLabelText("Contribution")).toBeNull();
    expect(within(mode).queryByRole("option", { name: "Federal maximum" })).toBeNull();
  });

  it("adds a second contribution entry, dated in its own window", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "roth_ira");

    await userEvent.click(screen.getByRole("button", { name: "Add contribution" }));
    expect(currentAccount()?.contributions).toHaveLength(2);
    expect(currentAccount()?.contributions[1]).toEqual({
      id: expect.stringMatching(/^contribution-/),
      rule: { FlatAmount: { amount: 0, growth: "None" } },
      start: "PlanStart",
      end: { AtRetirement: "p1" },
    });
    // Distinct ids: the engine rejects two entries sharing one.
    const [first, second] = currentAccount()?.contributions ?? [];
    expect(first.id).not.toBe(second.id);

    // The second entry runs past retirement — legal for an IRA, and the
    // reason entries got their own dates in the first place.
    const ends = screen.getAllByLabelText("Ends");
    await userEvent.selectOptions(ends[1], "PlanEnd");
    expect(currentAccount()?.contributions[1].end).toBe("PlanEnd");
    expect(currentAccount()?.contributions[0].end).toEqual({ AtRetirement: "p1" });
  });

  it("reveals a month field when a boundary is set to a specific month", async () => {
    render(<AccountsSection />);
    await addAccount();
    expect(screen.queryByText("Start month")).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Starts"), "Date");
    expect(currentAccount()?.contributions[0].start).toEqual({
      Date: { year: 2030, month: 1 },
    });

    await userEvent.selectOptions(screen.getByLabelText("Start month month"), "3");
    expect(currentAccount()?.contributions[0].start).toEqual({
      Date: { year: 2030, month: 3 },
    });
    expect(screen.getByText("$0/yr from Mar 2030 until Solo retires")).toBeTruthy();
  });

  it("removes a contribution entry", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.click(screen.getByRole("button", { name: "Add contribution" }));

    const removes = screen.getAllByRole("button", { name: "Remove contribution" });
    await userEvent.click(removes[0]);
    expect(currentAccount()?.contributions).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Remove contribution" }));
    expect(currentAccount()?.contributions).toHaveLength(0);
    expect(screen.getByText("Nothing goes into this account yet.")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "—" })).toBeTruthy();
  });

  it("re-points retirement boundaries at the new owner when the account changes hands", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Owner"), "p2");

    expect(currentAccount()?.contributions[0].end).toEqual({ AtRetirement: "p2" });
    expect(screen.getByText("$0/yr from plan start until Partner retires")).toBeTruthy();
  });

  it("summarises what is going in, in the table, for each mode and for several entries", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "employer_pretax");

    const amount = screen.getByLabelText("Amount / yr ($)");
    await userEvent.clear(amount);
    await userEvent.type(amount, "6000");
    expect(screen.getByRole("cell", { name: "$6,000/yr" })).toBeTruthy();

    await userEvent.selectOptions(
      screen.getByLabelText("Contribution"),
      "PercentOfSalary",
    );
    const percent = screen.getByLabelText("Of salary (%)");
    await userEvent.clear(percent);
    await userEvent.type(percent, "7.5");
    expect(screen.getByRole("cell", { name: "7.5% of salary" })).toBeTruthy();

    await userEvent.selectOptions(
      screen.getByLabelText("Contribution"),
      "FederalMaximum",
    );
    expect(screen.getByRole("cell", { name: "Max" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Add contribution" }));
    expect(screen.getByRole("cell", { name: "2 schedules" })).toBeTruthy();
  });

  it("seeds, edits, and clears a percent-of-salary step-up", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "employer_pretax");
    await userEvent.selectOptions(
      screen.getByLabelText("Contribution"),
      "PercentOfSalary",
    );
    const percent = screen.getByLabelText("Of salary (%)");
    await userEvent.clear(percent);
    await userEvent.type(percent, "10");

    await userEvent.click(screen.getByLabelText("Increase each year"));
    expect(currentAccount()?.contributions[0].rule).toEqual({
      PercentOfSalary: { percent: 0.1, step_up: { points_per_year: 0.01, cap: 0.15 } },
    });
    expect(screen.getByRole("cell", { name: "10% → 15% of salary" })).toBeTruthy();

    const upTo = screen.getByLabelText("Up to (%)");
    await userEvent.clear(upTo);
    await userEvent.type(upTo, "20");
    expect(currentAccount()?.contributions[0].rule).toEqual({
      PercentOfSalary: { percent: 0.1, step_up: { points_per_year: 0.01, cap: 0.2 } },
    });
    expect(screen.getByRole("cell", { name: "10% → 20% of salary" })).toBeTruthy();

    await userEvent.click(screen.getByLabelText("Increase each year"));
    expect(currentAccount()?.contributions[0].rule).toEqual({
      PercentOfSalary: { percent: 0.1, step_up: null },
    });
    expect(screen.queryByLabelText("Up to (%)")).toBeNull();
  });

  it("grows a flat amount with inflation, and the table summary follows", async () => {
    render(<AccountsSection />);
    await addAccount();
    const amount = screen.getByLabelText("Amount / yr ($)");
    await userEvent.clear(amount);
    await userEvent.type(amount, "6000");

    await userEvent.selectOptions(screen.getByLabelText("Grows with"), "Inflation");
    expect(currentAccount()?.contributions[0].rule).toEqual({
      FlatAmount: { amount: 6000, growth: "Inflation" },
    });
    expect(screen.getByRole("cell", { name: "$6,000/yr, +inflation" })).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Grows with"), "None");
    expect(currentAccount()?.contributions[0].rule).toEqual({
      FlatAmount: { amount: 6000, growth: "None" },
    });
    expect(screen.getByRole("cell", { name: "$6,000/yr" })).toBeTruthy();
  });

  it("adds an employer match with a tiered formula, only on an employer plan", async () => {
    render(<AccountsSection />);
    await addAccount();
    expect(screen.queryByLabelText("Employer match")).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "employer_pretax");
    await userEvent.click(screen.getByLabelText("Employer match"));
    expect(currentAccount()?.employer_match).toEqual({
      tiers: [{ employee_percent: 0.03, match_percent: 1 }],
      destination: "PreTax",
    });

    await userEvent.click(screen.getByRole("button", { name: "Add match tier" }));
    expect(currentAccount()?.employer_match?.tiers).toHaveLength(2);

    // Retyping away from an employer plan takes the match with it.
    await userEvent.selectOptions(screen.getByLabelText("Type"), "roth_ira");
    expect(currentAccount()?.employer_match).toBeNull();
    expect(screen.queryByLabelText("Employer match")).toBeNull();
  });

  it("removes the selected account and clears the editor", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.click(screen.getByRole("button", { name: "Remove account" }));
    expect(usePlanStore.getState().plan?.accounts).toHaveLength(0);
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});
