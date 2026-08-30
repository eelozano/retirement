import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "../../store/planStore";
import type { Plan } from "../../types/generated/Plan";
import type { Presets } from "../../types/generated/Presets";
import { AccountsSection } from "./AccountsSection";

// An account's statutory bucket (`plan_type`) and its contribution mode are
// two separate axes, and the UI has to keep them consistent: a taxable
// brokerage has neither a bucket nor a federal maximum. The statutory
// figures themselves come from Rust presets, never hardcoded here.

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
  people: [{ id: "p1", name: "Solo" }],
  accounts: [],
} as unknown as Plan;

beforeEach(() => {
  usePlanStore.setState({
    plan: structuredClone(plan),
    presets,
    // updatePlan normally debounces a re-project and a save; here it only
    // needs to apply the recipe to the in-memory draft.
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
  it("creates a taxable account with no statutory bucket", async () => {
    render(<AccountsSection />);
    await addAccount();
    expect(currentAccount()?.plan_type).toBe("None");
    expect(screen.queryByLabelText("Plan type")).toBeNull();
  });

  it("picks the bucket the account kind implies, and lets it be overridden", async () => {
    render(<AccountsSection />);
    await addAccount();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "TraditionalPreTax");
    expect(currentAccount()?.plan_type).toBe("EmployerPlan");

    await userEvent.selectOptions(screen.getByLabelText("Type"), "Roth");
    expect(currentAccount()?.plan_type).toBe("Ira");

    // A Roth 401(k) is taxed like a Roth IRA and capped like a 401(k) —
    // which is the whole reason the two axes are separate.
    await userEvent.selectOptions(screen.getByLabelText("Plan type"), "EmployerPlan");
    expect(currentAccount()?.plan_type).toBe("EmployerPlan");

    await userEvent.selectOptions(screen.getByLabelText("Type"), "Taxable");
    expect(currentAccount()?.plan_type).toBe("None");
  });

  it("offers no federal maximum on an account that has no statutory cap", async () => {
    render(<AccountsSection />);
    await addAccount();
    const mode = screen.getByLabelText("Contribution");
    expect([...mode.querySelectorAll("option")].map((o) => o.textContent)).not.toContain(
      "Federal maximum",
    );
  });

  it("switches an account between the three contribution modes", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "TraditionalPreTax");

    await userEvent.selectOptions(
      screen.getByLabelText("Contribution"),
      "PercentOfSalary",
    );
    const percent = screen.getByLabelText("Of salary (%)");
    await userEvent.clear(percent);
    await userEvent.type(percent, "8");
    expect(currentAccount()?.contribution).toEqual({ PercentOfSalary: 0.08 });

    await userEvent.selectOptions(screen.getByLabelText("Contribution"), "FlatAmount");
    const amount = screen.getByLabelText("Amount / yr ($)");
    await userEvent.clear(amount);
    await userEvent.type(amount, "12000");
    expect(currentAccount()?.contribution).toEqual({ FlatAmount: 12000 });

    await userEvent.selectOptions(
      screen.getByLabelText("Contribution"),
      "FederalMaximum",
    );
    expect(currentAccount()?.contribution).toBe("FederalMaximum");
    // No amount field: the point of the mode is that there is no number to
    // type, and the figure it resolves to is disclosed with its tax year.
    expect(screen.queryByLabelText("Amount / yr ($)")).toBeNull();
    expect(screen.getByText(/\$24,500\/yr in 2026/)).toBeTruthy();
  });

  it("drops the federal maximum when an account is retyped as taxable", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "TraditionalPreTax");
    await userEvent.selectOptions(
      screen.getByLabelText("Contribution"),
      "FederalMaximum",
    );

    await userEvent.selectOptions(screen.getByLabelText("Type"), "Taxable");
    expect(currentAccount()?.contribution).toEqual({ FlatAmount: 0 });
  });
});
