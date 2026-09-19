import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RAIL_COLLAPSED_KEY, useRailCollapsed } from "../../lib/railPreference";
import { type Destination, Rail } from "./Rail";

// The rail used to be six icon-only buttons whose only name was a tooltip.
// It is labelled now, in two groups, and collapses back to icons: these pin
// what has to survive that — every destination reachable by name, exactly one
// current, and a name on each item even with the label gone.

const LABELS = [
  "Plan",
  "Cash flow",
  "Growth",
  "What-if",
  "Scenarios",
  "Inputs",
  "Update balances",
  "Report",
  "Settings",
];

function setup(over: { active?: Destination; collapsed?: boolean } = {}) {
  const handlers = {
    onNavigate: vi.fn(),
    onOpenStorage: vi.fn(),
    onOpenReport: vi.fn(),
    onToggleCollapsed: vi.fn(),
  };
  render(
    <Rail
      active={over.active ?? "plan"}
      collapsed={over.collapsed ?? false}
      {...handlers}
    />,
  );
  return handlers;
}

describe("Rail", () => {
  it("names every destination and both groups when expanded", () => {
    setup();
    const nav = screen.getByRole("navigation", { name: "Screens" });
    for (const label of LABELS) {
      expect(within(nav).getByRole("button", { name: label })).toBeVisible();
    }
    expect(within(nav).getByRole("group", { name: "Plan" })).toBeVisible();
    expect(within(nav).getByRole("group", { name: "Setup" })).toBeVisible();
    // Expanded, the visible label is the name; a tooltip would repeat it.
    expect(screen.getByRole("button", { name: "Plan" })).not.toHaveAttribute("title");
  });

  it("marks exactly the active destination as current", () => {
    setup({ active: "growth" });
    const current = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Growth");
  });

  it("navigates, and opens the report and settings, from their rows", async () => {
    const user = userEvent.setup();
    const h = setup();
    await user.click(screen.getByRole("button", { name: "Update balances" }));
    expect(h.onNavigate).toHaveBeenCalledWith("refresh");
    await user.click(screen.getByRole("button", { name: "Report" }));
    expect(h.onOpenReport).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(h.onOpenStorage).toHaveBeenCalledOnce();
    expect(h.onNavigate).toHaveBeenCalledOnce();
  });

  it("toggles from the collapse button", async () => {
    const user = userEvent.setup();
    const h = setup();
    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(h.onToggleCollapsed).toHaveBeenCalledOnce();
  });

  it("drops the labels and headings when collapsed but keeps every name", () => {
    setup({ collapsed: true });
    expect(screen.queryByText("Retirement Planner")).not.toBeInTheDocument();
    // Headings are gone as text; the groups still carry their names.
    expect(screen.queryByText("Setup")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Setup" })).toBeInTheDocument();
    for (const label of LABELS) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toHaveAttribute("title", label);
      expect(button).not.toHaveTextContent(label);
    }
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });
});

// Node 25 ships its own global `localStorage`, which shadows jsdom's and has
// no working methods without a backing file. An in-memory Storage keeps the
// hook's tests about the hook.
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe("useRailCollapsed", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts expanded", () => {
    const { result } = renderHook(() => useRailCollapsed());
    expect(result.current[0]).toBe(false);
  });

  it("restores a saved collapse, and saves each toggle", () => {
    localStorage.setItem(RAIL_COLLAPSED_KEY, "true");
    const { result } = renderHook(() => useRailCollapsed());
    expect(result.current[0]).toBe(true);

    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe("false");

    act(() => result.current[1]());
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe("true");
  });

  it("still works for the session when storage throws", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useRailCollapsed());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
  });
});
