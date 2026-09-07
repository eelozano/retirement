import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { usePlanStore } from "../../store/planStore";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import { ReportView } from "./ReportView";

// A printed report outlives the session it came from — it has to say what
// the balances behind it were as of, the same as the Plan screen's status
// band and the comparison header (#110).

// jsdom has no layout engine behind <dialog>, so showModal()/close() are
// unimplemented rather than no-ops — Modal calls them unconditionally.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "base-plan",
    schema_version: 2,
    name: "Base plan",
    sample: false,
    people: [],
    accounts: [],
    streams: [],
    social_security: [],
    assumptions: {
      inflation: 0.03,
      asset_returns: {},
      filing_status: "Single",
      state_tax: {
        state: "Other",
        brackets: [{ up_to: null, rate: 0 }],
        standard_deduction: 0,
      },
      plan_end_age: 95,
      sweep_surplus_from: null,
      survivor_expense_factor: 1,
      social_security_cola: 0,
      asset_volatility: {},
      reinvest_into: null,
    },
    sim_config: {
      start: { year: 2026, month: 1 },
      period: "Year",
      display_real_dollars: false,
    },
    ...overrides,
  };
}

const projection: Projection = { snapshots: [], warnings: [], streams: [] };

describe("ReportView", () => {
  it("carries the balances' as-of date in the header", () => {
    usePlanStore.setState({
      plan: makePlan(),
      projection,
      monteCarlo: null,
      monteCarloStale: false,
      realDollars: false,
    });

    render(<ReportView open onClose={() => {}} />);

    expect(screen.getByText("Balances as of Jan 2026")).toBeInTheDocument();
  });
});
