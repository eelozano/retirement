import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
  getStorageInfo: vi.fn(),
  getTaxFigures: vi.fn(),
  saveTaxFigures: vi.fn(),
  listSnapshots: vi.fn(),
  chooseStorageDir: vi.fn(),
  setStorageDir: vi.fn(),
  revealStorageDir: vi.fn(),
  exportPlans: vi.fn(),
}));

import * as api from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
import { taxFigures } from "../../test/fixtures";
import { StorageSettings } from "./StorageSettings";

// The yearly tax figures live in a file the user edits by hand, so the
// settings window is where they learn which year is in force, where the
// file is, and — the part that matters most — that an edit could not be
// used and the built-in figures are standing in.

// jsdom has no layout engine behind <dialog>; see ReportView.test.tsx.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});

const FIGURES = taxFigures();
const PATH = "/Users/me/Documents/Retirement Planner/tax-figures.yaml";

beforeEach(() => {
  vi.mocked(api.getStorageInfo).mockResolvedValue({
    effective_dir: "/Users/me/Documents/Retirement Planner",
    is_default: true,
    default_dir: "/Users/me/Documents/Retirement Planner",
  });
  usePlanStore.setState({ plan: null, monteCarloPaths: 5_000, monteCarloLimits: null });
});

describe("StorageSettings tax figures", () => {
  it("names the tax year in force and where the file is", async () => {
    vi.mocked(api.getTaxFigures).mockResolvedValue({
      path: PATH,
      figures: FIGURES,
      built_in: FIGURES,
      error: null,
    });
    render(<StorageSettings open onClose={() => {}} />);

    expect(await screen.findByText(PATH)).toBeInTheDocument();
    expect(
      screen.getByText(/Every plan uses the 2026 federal tax brackets/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says when the file could not be used", async () => {
    vi.mocked(api.getTaxFigures).mockResolvedValue({
      path: PATH,
      figures: FIGURES,
      built_in: FIGURES,
      error: "tax-figures.yaml: contribution_limits.ira must be zero or more, not -5",
    });
    render(<StorageSettings open onClose={() => {}} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("built-in 2026 figures are in force");
    expect(alert).toHaveTextContent("contribution_limits.ira");
  });

  it("opens the editor on the figures in the file", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getTaxFigures).mockResolvedValue({
      path: PATH,
      figures: FIGURES,
      built_in: FIGURES,
      error: null,
    });
    render(<StorageSettings open onClose={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "Edit figures…" }));
    expect(await screen.findByLabelText("Tax year")).toHaveValue(2026);
  });
});
