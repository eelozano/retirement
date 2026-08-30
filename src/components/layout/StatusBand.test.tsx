import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ReadableWarning } from "../../lib/warnings";
import type { HeadlineMetrics } from "../charts/planData";
import { StatusBand } from "./StatusBand";

// The band used to report warnings as a bare count, so a plan could run on
// materially different contributions than the ones entered with nothing on
// screen that said so. The text has to be reachable.

const metrics = {
  depletionYear: null,
  successRate: null,
  failedPaths: null,
  nPaths: null,
} as unknown as HeadlineMetrics;

const warning: ReadableWarning = {
  key: "w0",
  title: "Enrique 403(b): contributing $24,500/yr, not $37,200/yr",
  detail: "Contributions were held to the limit.",
};

describe("StatusBand", () => {
  it("says so plainly when there is nothing to report", () => {
    render(<StatusBand metrics={metrics} warnings={[]} />);
    expect(screen.getByText("no warnings")).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("reveals the warning text on opening the disclosure", async () => {
    render(<StatusBand metrics={metrics} warnings={[warning]} />);
    const summary = screen.getByText("1 warning");
    expect(screen.getByText(warning.title)).not.toBeVisible();

    await userEvent.click(summary);
    expect(screen.getByText(warning.title)).toBeVisible();
    expect(screen.getByText(warning.detail)).toBeVisible();
  });

  it("pluralizes the count", () => {
    render(
      <StatusBand metrics={metrics} warnings={[warning, { ...warning, key: "w1" }]} />,
    );
    expect(screen.getByText("2 warnings")).toBeInTheDocument();
  });
});
