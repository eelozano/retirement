import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
  getTaxFigures: vi.fn(),
  saveTaxFigures: vi.fn(),
}));

import * as api from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
import { taxFigures } from "../../test/fixtures";
import { TaxFiguresEditor } from "./TaxFiguresEditor";

// The editor is a draft over tax-figures.yaml: it opens on what the file
// says, writes only on Save, and on a save the backend refuses it keeps the
// draft and says why, so nothing typed is lost.

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
const taxFiguresChanged = vi.fn();

function fileSays(figures = taxFigures(), error: string | null = null) {
  vi.mocked(api.getTaxFigures).mockResolvedValue({
    path: PATH,
    figures,
    built_in: taxFigures(),
    error,
  });
}

beforeEach(() => {
  vi.mocked(api.saveTaxFigures).mockReset().mockResolvedValue();
  taxFiguresChanged.mockReset().mockResolvedValue(undefined);
  usePlanStore.setState({ taxFiguresChanged });
});

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("TaxFiguresEditor", () => {
  it("opens on the figures in the file", async () => {
    const edited = taxFigures();
    edited.tax_year = 2027;
    edited.contribution_limits.hsa = 4_500;
    fileSays(edited);
    render(<TaxFiguresEditor open onClose={() => {}} />);

    expect(await screen.findByLabelText("Tax year")).toHaveValue(2027);
    expect(field("HSA (self-only) ($)")).toHaveValue(4500);
    // Married filing jointly is the status shown first.
    expect(field("Standard deduction ($)")).toHaveValue(32200);
  });

  it("saves the draft, then re-runs what is on screen", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fileSays();
    render(<TaxFiguresEditor open onClose={onClose} />);

    const ira = await screen.findByLabelText("IRA ($)");
    await user.clear(ira);
    await user.type(ira, "8000");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const saved = vi.mocked(api.saveTaxFigures).mock.calls[0][0];
    expect(saved.contribution_limits.ira).toBe(8000);
    expect(saved.contribution_limits.hsa).toBe(4400);
    expect(onClose).toHaveBeenCalled();
    expect(taxFiguresChanged).toHaveBeenCalled();
  });

  it("keeps the draft open and says why when the save is refused", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fileSays();
    vi.mocked(api.saveTaxFigures).mockRejectedValue(
      "ordinary_brackets.single: bracket 2 ceiling 1000 must be above 12400",
    );
    render(<TaxFiguresEditor open onClose={onClose} />);

    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Not saved: ordinary_brackets.single: bracket 2",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(taxFiguresChanged).not.toHaveBeenCalled();

    // Resetting starts over, so the complaint about the old draft goes.
    await user.click(screen.getByRole("button", { name: "Reset to built-in 2026" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("resets the draft to the built-in figures without saving", async () => {
    const user = userEvent.setup();
    const edited = taxFigures();
    edited.contribution_limits.ira = 9_999;
    fileSays(edited);
    render(<TaxFiguresEditor open onClose={() => {}} />);

    expect(await screen.findByLabelText("IRA ($)")).toHaveValue(9999);
    await user.click(screen.getByRole("button", { name: "Reset to built-in 2026" }));

    expect(field("IRA ($)")).toHaveValue(7500);
    expect(api.saveTaxFigures).not.toHaveBeenCalled();
  });

  it("shows each filing status's own schedule", async () => {
    const user = userEvent.setup();
    fileSays();
    render(<TaxFiguresEditor open onClose={() => {}} />);

    expect(await screen.findByLabelText("Ordinary bracket 1 upper bound")).toHaveValue(
      24800,
    );
    await user.click(screen.getByRole("button", { name: "Single" }));

    expect(field("Standard deduction ($)")).toHaveValue(16100);
    expect(field("Ordinary bracket 1 upper bound")).toHaveValue(12400);
    expect(field("Capital gains bracket 1 upper bound")).toHaveValue(49450);
  });

  it("says when the file could not be used", async () => {
    fileSays(taxFigures(), "tax-figures.yaml: tax_year 26 is not a plausible year");
    render(<TaxFiguresEditor open onClose={() => {}} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("built-in 2026 figures");
    expect(alert).toHaveTextContent("Saving replaces the file");
  });
});
