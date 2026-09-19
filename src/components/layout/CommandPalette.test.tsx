import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

// The palette is the escape hatch for depth the rail should not hold: type a
// screen's name, land on it. These pin the shortcut, the filter, and that the
// list is the rail's own.

// jsdom has no layout engine behind <dialog>; see ReportView.test.tsx.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});

function setup() {
  const handlers = {
    onNavigate: vi.fn(),
    onOpenReport: vi.fn(),
    onOpenStorage: vi.fn(),
    onOpenChange: vi.fn(),
  };
  // Controlled from outside, as Dashboard does.
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <CommandPalette
        open={open}
        onOpenChange={(next) => {
          handlers.onOpenChange(next);
          setOpen(next);
        }}
        onNavigate={handlers.onNavigate}
        onOpenReport={handlers.onOpenReport}
        onOpenStorage={handlers.onOpenStorage}
      />
    );
  }
  render(<Harness />);
  return { user: userEvent.setup(), ...handlers };
}

describe("CommandPalette", () => {
  it("opens on Ctrl-K and on Cmd-K, and toggles closed on a second press", async () => {
    const { user } = setup();
    const dialog = document.querySelector("dialog");
    expect(dialog).not.toHaveAttribute("open");

    await user.keyboard("{Control>}k{/Control}");
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("combobox")).toBeInTheDocument();

    await user.keyboard("{Control>}k{/Control}");
    expect(dialog).not.toHaveAttribute("open");

    await user.keyboard("{Meta>}k{/Meta}");
    expect(dialog).toHaveAttribute("open");
  });

  it("lists every rail destination and the two actions", async () => {
    const { user } = setup();
    await user.keyboard("{Control>}k{/Control}");
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual([
      "PlanPlan",
      "Cash flowPlan",
      "GrowthPlan",
      "What-ifPlan",
      "ScenariosPlan",
      "InputsSetup",
      "Update balancesSetup",
      "ReportAction",
      "SettingsAction",
    ]);
  });

  it("filters by what is typed, ignoring case", async () => {
    const { user } = setup();
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox"), "CASH");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Cash flow");
  });

  it("goes to the highlighted screen on Enter, and closes", async () => {
    const { user, onNavigate, onOpenChange } = setup();
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox"), "cash{Enter}");
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("cashflow");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(document.querySelector("dialog")).not.toHaveAttribute("open");
  });

  it("moves the highlight with the arrow keys, wrapping at both ends", async () => {
    const { user, onNavigate } = setup();
    await user.keyboard("{Control>}k{/Control}");
    const input = screen.getByRole("combobox");
    // A real showModal() focuses the input; the polyfilled one does not.
    await user.click(input);
    expect(screen.getByRole("option", { name: /^Plan/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", "palette-option-cashflow");

    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", "palette-option-settings");

    await user.keyboard("{Enter}");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("runs Report and Settings as the actions they are", async () => {
    const { user, onOpenReport, onOpenStorage, onNavigate } = setup();
    await user.keyboard("{Control>}k{/Control}");
    await user.click(screen.getByRole("option", { name: /^Report/ }));
    expect(onOpenReport).toHaveBeenCalledOnce();

    await user.keyboard("{Control>}k{/Control}");
    await user.click(screen.getByRole("option", { name: /^Settings/ }));
    expect(onOpenStorage).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("says so when nothing matches, and Enter does nothing", async () => {
    const { user, onNavigate } = setup();
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox"), "zzz{Enter}");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing matches");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("starts empty each time it opens", async () => {
    const { user } = setup();
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox"), "cash");
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.getAllByRole("option")).toHaveLength(9);
  });

  it("reports the platform closing it (Escape) so state follows", async () => {
    const { user, onOpenChange } = setup();
    await user.keyboard("{Control>}k{/Control}");
    // The platform fires `close` on Escape; the polyfilled dialog does not.
    fireEvent(document.querySelector("dialog") as HTMLDialogElement, new Event("close"));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
