import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { basePlan, planSummary } from "../../test/fixtures";
import type { Plan } from "../../types/generated/Plan";
import { ScenarioChanges, useScenarioPlans } from "./ScenarioChanges";

const { loadPlanNamed } = vi.hoisted(() => ({ loadPlanNamed: vi.fn() }));
vi.mock("../../lib/api", () => ({ loadPlanNamed }));

function stayInHome(): Plan {
  const plan = basePlan();
  plan.id = "stay";
  plan.name = "Stay in home";
  plan.accounts[1].one_time_contributions = [];
  plan.people[0].retirement = { year: 2031, month: 6 };
  return plan;
}

describe("ScenarioChanges", () => {
  it("says a scenario is the same as its reference, with nothing to open", () => {
    const copy = { ...basePlan(), id: "copy", name: "Copy" };
    render(<ScenarioChanges plan={copy} reference={basePlan()} />);
    expect(screen.getByText("Same as Base plan")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("summarizes the changes, then lists each against the reference when opened", async () => {
    render(<ScenarioChanges plan={stayInHome()} reference={basePlan()} />);
    const toggle = screen.getByRole("button", {
      name: "2 changes: Alex's retirement, House sale removed",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Alex's retirementJun 2031Base plan: Jun 2033",
      "House sale removedBase plan: $350,000 in today's dollars in Jun 2040",
    ]);
  });
});

describe("useScenarioPlans", () => {
  beforeEach(() => {
    loadPlanNamed.mockReset();
  });

  it("serves the active plan from memory and loads the rest", async () => {
    const active = stayInHome();
    loadPlanNamed.mockImplementation(async (id: string) => ({ ...basePlan(), id }));
    const scenarios = [
      planSummary("base", "Base plan"),
      planSummary("stay", "Stay in home"),
    ];

    const { result } = renderHook(() => useScenarioPlans(scenarios, active));

    expect(result.current("stay")).toBe(active);
    await waitFor(() => expect(result.current("base")?.id).toBe("base"));
    expect(loadPlanNamed).toHaveBeenCalledTimes(1);
    expect(loadPlanNamed).toHaveBeenCalledWith("base");
  });

  it("leaves out a scenario that fails to load", async () => {
    loadPlanNamed.mockImplementation(async (id: string) => {
      if (id === "broken") throw new Error("unreadable");
      return { ...basePlan(), id };
    });
    const scenarios = [
      planSummary("base", "Base plan"),
      planSummary("broken", "Broken"),
      planSummary("stay", "Stay in home"),
    ];

    const { result } = renderHook(() => useScenarioPlans(scenarios, stayInHome()));

    await waitFor(() => expect(result.current("base")).toBeDefined());
    expect(result.current("broken")).toBeUndefined();
  });
});
