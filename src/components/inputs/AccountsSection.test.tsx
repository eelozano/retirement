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
  tax_figures: {
    tax_year: 2026,
    contribution_limits: {
      employer_plan: 24500,
      ira: 7500,
    },
  },
} as unknown as Presets;

const plan = {
  people: [
    {
      id: "p1",
      name: "Solo",
      birth: { year: 1975, month: 1 },
      retirement: { year: 2040, month: 1 },
      life_expectancy_age: 90,
    },
    {
      id: "p2",
      name: "Partner",
      birth: { year: 1978, month: 1 },
      retirement: { year: 2045, month: 1 },
      life_expectancy_age: 90,
    },
  ],
  accounts: [],
  assumptions: {
    strategy_returns: { aggressive: 0.075, moderate: 0.067, conservative: 0.059 },
    strategy_volatility: { aggressive: 0.155, moderate: 0.115, conservative: 0.09 },
    drawdown: "Proportional",
  },
  sim_config: { start: { year: 2025, month: 1 }, period: "Year" },
} as unknown as Plan;

beforeEach(() => {
  usePlanStore.setState({
    plan: structuredClone(plan),
    presets,
    household: null,
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

/** The fieldset of the `index`th one-time contribution card. */
function oneTimeCard(index = 0): HTMLElement {
  const remove = screen.getAllByRole("button", { name: "Remove one-time contribution" })[
    index
  ];
  const card = remove.closest("fieldset");
  if (!card) throw new Error("the remove button sits outside a card");
  return card;
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
        name: "",
        rule: { FlatAmount: { amount: 0, growth: "None" } },
        start: "PlanStart",
        end: { AtRetirement: "p1" },
      },
    ]);
    expect(currentAccount()?.one_time_contributions).toEqual([]);
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

  it("starts a savings account on a fixed rate rather than a strategy", async () => {
    render(<AccountsSection />);
    await addAccount();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "savings");
    expect(currentAccount()?.kind).toBe("Savings");
    expect(currentAccount()?.allocation).toEqual({ FixedRate: expect.any(Number) });
    expect(screen.getByLabelText("Fixed rate (%)")).toBeTruthy();

    // The select stays visible and reads the rate row it is actually on.
    // Before #129 `allocationName` returned "Moderate" for anything that
    // wasn't a string, so a fixed-rate account claimed a strategy nobody
    // had chosen — and the next edit to any other field wrote it in.
    expect(screen.getByLabelText<HTMLSelectElement>("Allocation").value).toBe(
      "FixedRate",
    );

    // Leaving Savings keeps the rate: it is legal on any kind now, so
    // silently replacing a rate the user typed would be the wrong move.
    await userEvent.selectOptions(screen.getByLabelText("Type"), "taxable");
    expect(currentAccount()?.allocation).toEqual({ FixedRate: expect.any(Number) });
  });

  it("edits owner, allocation, and balance on the selected account", async () => {
    render(<AccountsSection />);
    await addAccount();

    await userEvent.selectOptions(screen.getByLabelText("Owner"), "p2");
    expect(currentAccount()?.owner).toBe("p2");
    expect(screen.getByRole("cell", { name: "Partner" })).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Allocation"), "Aggressive");
    expect(currentAccount()?.allocation).toBe("Aggressive");

    const balance = screen.getByLabelText("Balance as of Jan 2025 ($)");
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
            one_time_contributions: [],
            employer_match: null,
            rule_of_55: false,
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
            one_time_contributions: [],
            employer_match: null,
            rule_of_55: false,
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

  // A partially refreshed household can have accounts at different ages
  // (#111) — the column has to read each row's own date, not one date for
  // the whole table.
  it("reads each account's own as-of date, falling back to the plan start for one the household hasn't seen", () => {
    usePlanStore.setState((s) => ({
      plan: {
        ...(s.plan as Plan),
        accounts: [
          {
            id: "a1",
            owner: "p1",
            kind: "Taxable",
            name: "Old",
            balance: 0,
            cost_basis: 0,
            allocation: "Moderate",
            plan_type: "None",
            contributions: [],
            one_time_contributions: [],
            employer_match: null,
            rule_of_55: false,
          },
          {
            id: "a2",
            owner: "p1",
            kind: "Taxable",
            name: "Unsaved",
            balance: 0,
            cost_basis: 0,
            allocation: "Moderate",
            plan_type: "None",
            contributions: [],
            one_time_contributions: [],
            employer_match: null,
            rule_of_55: false,
          },
        ],
      },
      household: {
        id: "h1",
        name: "Household",
        sample: false,
        as_of: { year: 2025, month: 1 },
        people: [],
        accounts: [
          {
            id: "a1",
            owner: "p1",
            kind: "Taxable",
            plan_type: "None",
            name: "Old",
            allocation: "Moderate",
            observations: [
              { as_of: { year: 2024, month: 6 }, balance: 0, cost_basis: 0 },
            ],
          },
        ],
        social_security: [],
      } as unknown as ReturnType<typeof usePlanStore.getState>["household"],
    }));
    render(<AccountsSection />);

    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByRole("cell", { name: "Jun 2024" })).toBeTruthy();
    // "a2" has no entry in the household yet (added this session, not saved) —
    // reads as the plan's own start date rather than blank.
    expect(within(rows[2]).getByRole("cell", { name: "Jan 2025" })).toBeTruthy();
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
      screen.getByText("10% of salary from plan start until Solo retires (Jan 2040)"),
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
      name: "",
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
    expect(
      screen.getByText("$0/yr from Mar 2030 until Solo retires (Jan 2040)"),
    ).toBeTruthy();
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
    expect(
      screen.getByText("$0/yr from plan start until Partner retires (Jan 2045)"),
    ).toBeTruthy();
  });

  it("summarises what is going in, in the table, for each mode and for several entries", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "employer_pretax");

    const amount = screen.getByLabelText("Amount ($)");
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
    const amount = screen.getByLabelText("Amount ($)");
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

  it("enters a flat contribution amount per month", async () => {
    render(<AccountsSection />);
    await addAccount();

    await userEvent.selectOptions(screen.getByLabelText("Amount ($) unit"), "month");
    const amount = screen.getByLabelText("Amount ($)");
    await userEvent.clear(amount);
    await userEvent.type(amount, "500");

    expect(currentAccount()?.contributions[0].rule).toEqual({
      FlatAmount: { amount: 6000, growth: "None" },
    });
    expect(screen.getByRole("cell", { name: "$6,000/yr" })).toBeTruthy();
  });

  it("adds an employer match with a tiered formula, only on an employer plan", async () => {
    render(<AccountsSection />);
    await addAccount();
    expect(screen.queryByLabelText("Employer contributions")).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "employer_pretax");
    await userEvent.click(screen.getByLabelText("Employer contributions"));
    expect(currentAccount()?.employer_match).toEqual({
      nonelective_percent: 0,
      tiers: [{ employee_percent: 0.03, match_percent: 1 }],
      destination: "PreTax",
    });

    await userEvent.click(screen.getByRole("button", { name: "Add match tier" }));
    expect(currentAccount()?.employer_match?.tiers).toHaveLength(2);

    // Retyping away from an employer plan takes the match with it.
    await userEvent.selectOptions(screen.getByLabelText("Type"), "roth_ira");
    expect(currentAccount()?.employer_match).toBeNull();
    expect(screen.queryByLabelText("Employer contributions")).toBeNull();
  });

  it("takes an employer contribution that does not depend on a match", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "employer_pretax");
    await userEvent.click(screen.getByLabelText("Employer contributions"));

    // A plan that puts in 10% of pay whether or not the employee defers:
    // type the percent, then drop the tier the default started with.
    const adds = screen.getByLabelText("Employer adds, whatever you contribute (%)");
    await userEvent.clear(adds);
    await userEvent.type(adds, "10");
    await userEvent.tab();
    expect(currentAccount()?.employer_match?.nonelective_percent).toBeCloseTo(0.1);

    await userEvent.click(screen.getByRole("button", { name: "Remove tier" }));
    expect(currentAccount()?.employer_match?.tiers).toHaveLength(0);
  });

  it("names a recurring contribution ahead of its derived description", async () => {
    render(<AccountsSection />);
    await addAccount();

    await userEvent.type(screen.getByLabelText("Name (optional)"), "Auto-invest");
    expect(currentAccount()?.contributions[0].name).toBe("Auto-invest");
    expect(
      screen.getByText(
        "Auto-invest · $0/yr from plan start until Solo retires (Jan 2040)",
      ),
    ).toBeTruthy();
  });

  it("offers a one-time contribution only on an account that can take outside money", async () => {
    render(<AccountsSection />);
    await addAccount();
    const offer = () =>
      screen.queryByRole("button", { name: "Add one-time contribution" });
    expect(offer()).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "employer_pretax");
    expect(offer()).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "savings");
    expect(offer()).toBeTruthy();
  });

  it("adds a named one-time contribution in today's dollars, landing at a retirement", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.click(
      screen.getByRole("button", { name: "Add one-time contribution" }),
    );
    expect(currentAccount()?.one_time_contributions).toEqual([
      {
        id: expect.stringMatching(/^one-time-/),
        name: "",
        amount: 0,
        growth: "Inflation",
        // January of the year after the plan starts.
        date: { Date: { year: 2026, month: 1 } },
      },
    ]);

    await userEvent.type(within(oneTimeCard()).getByLabelText("Name"), "House sale");
    const amount = within(oneTimeCard()).getByLabelText("Amount ($)");
    await userEvent.clear(amount);
    await userEvent.type(amount, "350000");
    await userEvent.selectOptions(
      within(oneTimeCard()).getByLabelText("Lands"),
      "Retirement:p1",
    );

    expect(currentAccount()?.one_time_contributions[0]).toMatchObject({
      name: "House sale",
      amount: 350000,
      growth: "Inflation",
      date: { AtRetirement: "p1" },
    });
    expect(
      screen.getByText(
        "House sale · $350,000 in today's dollars when Solo retires (Jan 2040)",
      ),
    ).toBeTruthy();
    // The table names it beside the account's recurring entry.
    expect(screen.getByRole("cell", { name: "$0/yr + House sale" })).toBeTruthy();
  });

  it("says when a one-time contribution falls before the projection, and removes it", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.click(
      screen.getByRole("button", { name: "Add one-time contribution" }),
    );

    const year = within(oneTimeCard()).getByLabelText("Landing month year");
    await userEvent.clear(year);
    await userEvent.type(year, "2024");
    expect(
      within(oneTimeCard()).getByText(
        /Jan 2024 is before the projection starts in Jan 2025, so this isn't counted/,
      ),
    ).toBeTruthy();

    await userEvent.click(
      within(oneTimeCard()).getByRole("button", { name: "Remove one-time contribution" }),
    );
    expect(currentAccount()?.one_time_contributions).toEqual([]);
  });

  it("keeps a one-time contribution's date when the account changes hands", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.click(
      screen.getByRole("button", { name: "Add one-time contribution" }),
    );
    await userEvent.selectOptions(
      within(oneTimeCard()).getByLabelText("Lands"),
      "Retirement:p1",
    );

    await userEvent.selectOptions(screen.getByLabelText("Owner"), "p2");
    // The recurring entry is paid from its owner's paycheck and follows them;
    // a sale at Solo's retirement does not move because the account did.
    expect(currentAccount()?.contributions[0].end).toEqual({ AtRetirement: "p2" });
    expect(currentAccount()?.one_time_contributions[0].date).toEqual({
      AtRetirement: "p1",
    });
  });

  it("takes a Roth's contributions to date as its basis, and keeps them across Roth types", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "roth_ira");
    expect(currentAccount()?.cost_basis).toBeNull();

    const contributions = screen.getByLabelText("Contributions to date ($)");
    await userEvent.clear(contributions);
    await userEvent.type(contributions, "40000");
    await userEvent.tab();
    expect(currentAccount()?.cost_basis).toBe(40000);

    // An IRA and a Roth 401(k) are both Roth: what was entered stays.
    await userEvent.selectOptions(screen.getByLabelText("Type"), "employer_roth");
    expect(currentAccount()?.cost_basis).toBe(40000);
    // Anything else starts blank.
    await userEvent.selectOptions(screen.getByLabelText("Type"), "traditional_ira");
    expect(currentAccount()?.cost_basis).toBeNull();
  });

  it("offers the Rule of 55 on an employer plan only, and clears it when the type changes", async () => {
    render(<AccountsSection />);
    await addAccount();
    expect(screen.queryByRole("checkbox", { name: /Rule of 55/ })).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "employer_pretax");
    await userEvent.click(screen.getByRole("checkbox", { name: /Rule of 55/ }));
    expect(currentAccount()?.rule_of_55).toBe(true);
    // Born 1975, retiring 2040 at 65 — in or after the year they turn 55.
    expect(screen.getByText(/qualifies from Jan 2040/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "traditional_ira");
    expect(currentAccount()?.rule_of_55).toBe(false);
    expect(screen.queryByRole("checkbox", { name: /Rule of 55/ })).toBeNull();
  });

  it("drops a removed account from every withdrawal list", async () => {
    render(<AccountsSection />);
    await addAccount();
    const id = currentAccount()?.id ?? "";
    usePlanStore.setState((s) => {
      const draft = structuredClone(s.plan) as Plan;
      draft.assumptions.drawdown = {
        Phased: [
          {
            id: "only",
            name: "Only",
            start: { Boundary: "PlanStart" },
            stack: [{ source: { Account: id }, floor: 0 }],
          },
        ],
      };
      return { plan: draft };
    });
    await userEvent.click(screen.getByRole("button", { name: "Remove account" }));
    const drawdown = usePlanStore.getState().plan?.assumptions.drawdown;
    expect(drawdown).toEqual({
      Phased: [{ id: "only", name: "Only", start: { Boundary: "PlanStart" }, stack: [] }],
    });
  });

  it("removes the selected account and clears the editor", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.click(screen.getByRole("button", { name: "Remove account" }));
    expect(usePlanStore.getState().plan?.accounts).toHaveLength(0);
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});
