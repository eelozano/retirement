import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "../../store/planStore";
import type { Plan } from "../../types/generated/Plan";
import { AccountsSection } from "./AccountsSection";

// Contribution mode and employer match moved to the People pane (they're
// part of the paycheck story, not the balance sheet) — those are covered in
// PeopleSection.test.tsx. This file covers what's left on the account
// itself: kind, statutory bucket, owner, allocation, balance.

const plan = {
  people: [
    { id: "p1", name: "Solo" },
    { id: "p2", name: "Partner" },
  ],
  accounts: [],
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

  it("offers cost basis on a taxable or savings account, not elsewhere", async () => {
    render(<AccountsSection />);
    await addAccount();
    expect(screen.getByLabelText("Cost basis ($)")).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "savings");
    expect(screen.getByLabelText("Cost basis ($)")).toBeTruthy();

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
            contribution: { FlatAmount: 0 },
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
            contribution: { FlatAmount: 0 },
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

  it("removes the selected account and clears the editor", async () => {
    render(<AccountsSection />);
    await addAccount();
    await userEvent.click(screen.getByRole("button", { name: "Remove account" }));
    expect(usePlanStore.getState().plan?.accounts).toHaveLength(0);
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});
