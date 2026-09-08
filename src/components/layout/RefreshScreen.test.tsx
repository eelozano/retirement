import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefreshRequest } from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
import { planSummary } from "../../test/fixtures";
import type { Household } from "../../types/generated/Household";
import type { Plan } from "../../types/generated/Plan";
import { RefreshScreen } from "./RefreshScreen";

// The screen's job is to send the right request: a dated set of readings, and
// only the rates the user actually answered. Everything about what those
// readings then *do* is pinned in Rust (src-tauri/src/refresh.rs) — here we
// only care that the sitting is described faithfully.

const plan = {
  id: "base-plan",
  name: "Base plan",
  people: [{ id: "alex", name: "Alex", birth: { year: 1983, month: 8 } }],
  accounts: [
    {
      id: "taxable-brokerage",
      name: "Taxable Brokerage",
      owner: "alex",
      balance: 150_000,
      cost_basis: 110_000,
      contributions: [],
    },
    {
      id: "alex-401k",
      name: "Alex 401(k)",
      owner: "alex",
      balance: 400_000,
      cost_basis: null,
      contributions: [],
    },
  ],
  streams: [
    {
      id: "alex-salary",
      name: "Alex salary",
      owner: "alex",
      direction: "Income",
      annual_amount: 140_000,
      growth: "Inflation",
    },
  ],
  social_security: [],
  assumptions: { inflation: 0.025 },
  sim_config: { start: { year: 2026, month: 1 }, display_real_dollars: false },
} as unknown as Plan;

const household = {
  id: "base-plan",
  name: "The Rivera household",
  as_of: { year: 2026, month: 1 },
  people: [{ id: "alex", name: "Alex", birth: { year: 1983, month: 8 } }],
  accounts: [
    {
      id: "taxable-brokerage",
      observations: [
        { as_of: { year: 2026, month: 1 }, balance: 150_000, cost_basis: 110_000 },
      ],
    },
    {
      id: "alex-401k",
      observations: [
        { as_of: { year: 2025, month: 4 }, balance: 400_000, cost_basis: null },
      ],
    },
  ],
  social_security: [],
} as unknown as Household;

const refreshHousehold =
  vi.fn<(request: Omit<RefreshRequest, "scenario_id">) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-12-04T12:00:00"));
  refreshHousehold.mockReset();
  refreshHousehold.mockResolvedValue(undefined);
  usePlanStore.setState({
    plan: structuredClone(plan),
    household: structuredClone(household),
    scenarios: [planSummary("base-plan", "Base plan", { household_id: "base-plan" })],
    refreshHousehold,
  } as Partial<ReturnType<typeof usePlanStore.getState>> as never);
});

function sent(): Omit<RefreshRequest, "scenario_id"> {
  expect(refreshHousehold).toHaveBeenCalledTimes(1);
  const [request] = refreshHousehold.mock.calls[0] ?? [];
  if (!request) throw new Error("the screen sent no request");
  return request;
}

async function record() {
  await userEvent.click(screen.getByRole("button", { name: /^Record balances as of/ }));
}

describe("RefreshScreen", () => {
  it("dates the sitting this month by default, and says so on the button", () => {
    render(<RefreshScreen />);
    expect(
      screen.getByRole("button", { name: "Record balances as of Dec 2026" }),
    ).toBeTruthy();
  });

  it("offers no month before the balances on file", async () => {
    render(<RefreshScreen />);
    const picker = screen.getByLabelText("Balances as of") as HTMLSelectElement;
    const offered = [...picker.options].map((o) => o.textContent);
    expect(offered[0]).toBe("Dec 2026");
    expect(offered[offered.length - 1]).toBe("Jan 2026");
    expect(offered).not.toContain("Dec 2025");
  });

  it("shows each account's last reading and the month it was read", () => {
    render(<RefreshScreen />);
    // A partially refreshed household has accounts at different ages, which
    // is exactly what the previous-figure column is for (#110).
    const rows = screen.getAllByRole("row");
    const cell = (name: string) =>
      rows.find((r) => r.textContent?.includes(name))?.textContent ?? "";
    expect(cell("Taxable Brokerage")).toContain("$150,000");
    expect(cell("Taxable Brokerage")).toContain("Jan 2026");
    expect(cell("Alex 401(k)")).toContain("Apr 2025");
  });

  it("sends every account, so the backend decides which ones actually changed", async () => {
    render(<RefreshScreen />);
    await userEvent.clear(screen.getByLabelText("Taxable Brokerage balance"));
    await userEvent.type(screen.getByLabelText("Taxable Brokerage balance"), "165000");
    await record();

    expect(sent().as_of).toEqual({ year: 2026, month: 12 });
    expect(sent().accounts).toEqual([
      { id: "taxable-brokerage", balance: 165_000, cost_basis: 110_000 },
      // Untouched, and still sent: "unchanged" is a comparison the ledger
      // makes, not a claim this screen gets to assert.
      { id: "alex-401k", balance: 400_000, cost_basis: null },
    ]);
  });

  it("sends no rate change for a figure left alone", async () => {
    render(<RefreshScreen />);
    await record();
    expect(sent().rates).toEqual([]);
  });

  it("offers the grown figure and sends it only when it is chosen", async () => {
    render(<RefreshScreen />);
    // Eleven months of 2.5% on $140,000.
    const grow = screen.getByRole("radio", { name: "Grow to $143,205" });
    await userEvent.click(grow);
    await record();

    expect(sent().rates).toEqual([
      {
        target: { Stream: { id: "alex-salary" } },
        amount: 143_205,
        apply_to_siblings: false,
      },
    ]);
  });

  it("sends a retyped figure as typed", async () => {
    render(<RefreshScreen />);
    const field = screen.getByLabelText("Alex salary new amount");
    await userEvent.clear(field);
    await userEvent.type(field, "152000");
    await record();
    expect(sent().rates[0].amount).toBe(152_000);
  });

  it("keeps the sibling offer out of a household with one scenario", () => {
    render(<RefreshScreen />);
    expect(screen.queryByText(/Apply to the/)).toBeNull();
  });

  it("offers the sibling rule per rate once the household has branched", async () => {
    usePlanStore.setState({
      scenarios: [
        planSummary("base-plan", "Base plan", { household_id: "base-plan" }),
        planSummary("retire-early", "Retire early", { household_id: "base-plan" }),
      ],
    } as Partial<ReturnType<typeof usePlanStore.getState>> as never);
    render(<RefreshScreen />);

    // Only on a rate that is actually changing — there is nothing to copy
    // across from a figure being kept.
    expect(screen.queryByText(/Apply to the 1 other scenario/)).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Grow to $143,205" }));
    await userEvent.click(screen.getByRole("checkbox"));
    await record();
    expect(sent().rates[0].apply_to_siblings).toBe(true);
  });

  it("keeps a refused refresh on this screen, with what was typed intact", async () => {
    refreshHousehold.mockRejectedValueOnce(
      new Error("June 2026 is before the balances on file"),
    );
    render(<RefreshScreen />);
    await userEvent.clear(screen.getByLabelText("Taxable Brokerage balance"));
    await userEvent.type(screen.getByLabelText("Taxable Brokerage balance"), "165000");
    await record();

    expect(screen.getByRole("alert").textContent).toContain(
      "before the balances on file",
    );
    expect(
      (screen.getByLabelText("Taxable Brokerage balance") as HTMLInputElement).value,
    ).toBe("165000");
  });

  it("shows birth months without offering to edit them", () => {
    render(<RefreshScreen />);
    expect(screen.getByText("born Aug 1983")).toBeTruthy();
    expect(screen.queryByLabelText(/birth/i)).toBeNull();
  });
});
