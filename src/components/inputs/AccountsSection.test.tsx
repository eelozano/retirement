import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "../../store/planStore";
import type { Plan } from "../../types/generated/Plan";
import type { Presets } from "../../types/generated/Presets";
import { AccountsSection } from "./AccountsSection";

// Accounts added through the UI used to be created uncapped, so an account
// of the same kind was capped or not purely depending on whether it came
// from the seed plan. The limits come from Rust presets, never hardcoded here.

const presets = {
  contribution_limits: { TraditionalPreTax: 24500, Roth: 7500 },
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

describe("AccountsSection", () => {
  it("creates a taxable account uncapped", async () => {
    render(<AccountsSection />);
    await userEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(currentAccount()?.contribution_limit).toBeNull();
    expect(screen.getByLabelText("Cap contributions")).not.toBeChecked();
  });

  it("prefills the statutory limit when the kind changes", async () => {
    render(<AccountsSection />);
    await userEvent.click(screen.getByRole("button", { name: "Add account" }));

    await userEvent.selectOptions(screen.getByLabelText("Type"), "TraditionalPreTax");
    expect(currentAccount()?.contribution_limit).toBe(24500);

    await userEvent.selectOptions(screen.getByLabelText("Type"), "Roth");
    expect(currentAccount()?.contribution_limit).toBe(7500);

    await userEvent.selectOptions(screen.getByLabelText("Type"), "Taxable");
    expect(currentAccount()?.contribution_limit).toBeNull();
  });

  it("exposes the limit for editing once the cap is on", async () => {
    render(<AccountsSection />);
    await userEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(screen.queryByLabelText("Contribution limit / yr ($)")).toBeNull();

    await userEvent.click(screen.getByLabelText("Cap contributions"));
    const field = screen.getByLabelText("Contribution limit / yr ($)");
    await userEvent.clear(field);
    await userEvent.type(field, "31000");
    expect(currentAccount()?.contribution_limit).toBe(31000);
  });
});
