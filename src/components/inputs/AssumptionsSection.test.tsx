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
    strategy_returns: {
      very_aggressive: 0.07,
      aggressive: 0.07,
      moderate: 0.06,
      conservative: 0.04,
      very_conservative: 0.04,
    },
    strategy_volatility: {
      very_aggressive: 0.16,
      aggressive: 0.16,
      moderate: 0.12,
      conservative: 0.09,
      very_conservative: 0.09,
    },
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
    dividend_yield: 0,
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

describe("Investment strategies", () => {
  const defaults = {
    very_aggressive: 0.0692,
    aggressive: 0.0635,
    moderate: 0.0573,
    conservative: 0.0506,
    very_conservative: 0.0435,
  };
  const defaultVolatility = {
    very_aggressive: 0.1303,
    aggressive: 0.1102,
    moderate: 0.0912,
    conservative: 0.0742,
    very_conservative: 0.0609,
  };
  const withPresets = () =>
    usePlanStore.setState({
      presets: {
        default_assumptions: {
          strategy_returns: defaults,
          strategy_volatility: defaultVolatility,
        },
        strategy_stock_share: {
          very_aggressive: 1,
          aggressive: 0.8,
          moderate: 0.6,
          conservative: 0.4,
          very_conservative: 0.2,
        },
      },
    } as never);
  const assumptions = () => usePlanStore.getState().plan?.assumptions;
  const reset = () =>
    screen.getByRole<HTMLButtonElement>("button", { name: "Reset to defaults" });

  it("lists five tiers in risk order, each naming its mix in a tooltip", () => {
    withPresets();
    render(<AssumptionsSection />);
    const headings = screen
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    const names = [
      "Very Aggressive",
      "Aggressive",
      "Moderate",
      "Conservative",
      "Very Conservative",
    ];
    const mixes = ["100/0", "80/20", "60/40", "40/60", "20/80"];
    names.forEach((name, i) => {
      expect(headings[i]).toContain(name);
      expect(headings[i]).toContain(`${mixes[i]} stocks/bonds`);
    });
  });

  it("resets every return and volatility to the shipped defaults", async () => {
    withPresets();
    render(<AssumptionsSection />);
    expect(reset().disabled).toBe(false);

    await userEvent.click(reset());
    expect(assumptions()?.strategy_returns).toEqual(defaults);
    expect(assumptions()?.strategy_volatility).toEqual(defaultVolatility);
    expect(reset().disabled).toBe(true);
  });

  it("cannot reset before the presets have loaded", () => {
    render(<AssumptionsSection />);
    expect(reset().disabled).toBe(true);
  });
});

describe("Taxable dividend yield", () => {
  it("starts at zero and stores what is typed as a rate", async () => {
    render(<AssumptionsSection />);
    const field = screen.getByLabelText("Taxable dividend yield (%)");
    expect(usePlanStore.getState().plan?.assumptions.dividend_yield).toBe(0);

    await userEvent.clear(field);
    await userEvent.type(field, "1.3");
    expect(usePlanStore.getState().plan?.assumptions.dividend_yield).toBeCloseTo(0.013);
  });
});
