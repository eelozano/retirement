import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
  getStorageInfo: vi.fn(),
  getTaxFiguresInfo: vi.fn(),
  listSnapshots: vi.fn(),
  chooseStorageDir: vi.fn(),
  setStorageDir: vi.fn(),
  revealStorageDir: vi.fn(),
  exportPlans: vi.fn(),
}));

import * as api from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
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
    vi.mocked(api.getTaxFiguresInfo).mockResolvedValue({
      path: PATH,
      tax_year: 2026,
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
    vi.mocked(api.getTaxFiguresInfo).mockResolvedValue({
      path: PATH,
      tax_year: 2026,
      error: "tax-figures.yaml: contribution_limits.ira must be zero or more, not -5",
    });
    render(<StorageSettings open onClose={() => {}} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("built-in 2026 figures are in force");
    expect(alert).toHaveTextContent("contribution_limits.ira");
  });
});
