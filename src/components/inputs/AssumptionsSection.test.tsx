import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "../../store/planStore";
import type { Plan } from "../../types/generated/Plan";
import { AssumptionsSection } from "./AssumptionsSection";

const plan = {
  people: [
    {
      id: "p1",
      name: "Alex",
      birth: { year: 1970, month: 1 },
      retirement: { year: 2032, month: 1 },
      life_expectancy_age: 90,
    },
  ],
  accounts: [],
  streams: [],
  social_security: [],
  assumptions: {
    inflation: 0.025,
    strategy_returns: { aggressive: 0.07, moderate: 0.06, conservative: 0.04 },
    strategy_volatility: { aggressive: 0.16, moderate: 0.12, conservative: 0.09 },
    filing_status: "Single",
    state_tax: {
      state: "Other",
      brackets: [{ up_to: null, rate: 0 }],
      standard_deduction: 0,
    },
    plan_end_age: 95,
    sweep_surplus_from: null,
    survivor_expense_factor: 1,
    social_security_cola: 0.025,
    social_security_reduction: null,
    reinvest_into: null,
    drawdown: "Proportional",
  },
  sim_config: { start: { year: 2026, month: 1 }, period: "Year" },
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

function cut() {
  return usePlanStore.getState().plan?.assumptions.social_security_reduction;
}

describe("Social Security cut", () => {
  it("assumes none until asked, then starts from the Trustees' figures", async () => {
    render(<AssumptionsSection />);
    expect(cut()).toBeNull();
    expect(screen.queryByLabelText("Share of benefits still paid (%)")).toBeNull();

    await userEvent.click(
      screen.getByRole("checkbox", { name: /Assume a Social Security cut/ }),
    );
    expect(cut()).toEqual({ from: { year: 2034, month: 1 }, payable_fraction: 0.81 });
    expect(screen.getByLabelText("Share of benefits still paid (%)")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("checkbox", { name: /Assume a Social Security cut/ }),
    );
    expect(cut()).toBeNull();
  });
});
