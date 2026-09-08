import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReadableWarning } from "../../lib/warnings";
import type { YearMonth } from "../../types/generated/YearMonth";
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
  title: "Alex 403(b): contributing $24,500/yr, not $37,200/yr",
  detail: "Contributions were held to the limit.",
};

// "Now" is fixed so the as-of cue's months-ago count is deterministic.
const NOW = new Date(2026, 8, 15); // Sep 2026

function monthsAgo(n: number): YearMonth {
  const total = NOW.getFullYear() * 12 + NOW.getMonth() - n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

const noop = () => {};

describe("StatusBand", () => {
  it("says so plainly when there is nothing to report", () => {
    render(
      <StatusBand
        metrics={metrics}
        warnings={[]}
        asOf={monthsAgo(0)}
        onOpenRefresh={noop}
        now={NOW}
      />,
    );
    expect(screen.getByText("no warnings")).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("reveals the warning text on opening the disclosure", async () => {
    render(
      <StatusBand
        metrics={metrics}
        warnings={[warning]}
        asOf={monthsAgo(0)}
        onOpenRefresh={noop}
        now={NOW}
      />,
    );
    const summary = screen.getByText("1 warning");
    expect(screen.getByText(warning.title)).not.toBeVisible();

    await userEvent.click(summary);
    expect(screen.getByText(warning.title)).toBeVisible();
    expect(screen.getByText(warning.detail)).toBeVisible();
  });

  it("pluralizes the count", () => {
    render(
      <StatusBand
        metrics={metrics}
        warnings={[warning, { ...warning, key: "w1" }]}
        asOf={monthsAgo(0)}
        onOpenRefresh={noop}
        now={NOW}
      />,
    );
    expect(screen.getByText("2 warnings")).toBeInTheDocument();
  });

  // The solvent count used to be rounded independently of the failed count in
  // planData, so at a rate like this the two roundings could disagree and the
  // band would print a pair that doesn't add up to the path count.
  it("reports a solvent count that complements the failed count exactly", () => {
    const solvent = {
      ...metrics,
      successRate: 0.6665,
      failedPaths: 1667,
      nPaths: 5000,
    } as unknown as HeadlineMetrics;

    render(
      <StatusBand
        metrics={solvent}
        warnings={[]}
        asOf={monthsAgo(0)}
        onOpenRefresh={noop}
        now={NOW}
      />,
    );
    expect(
      screen.getByText(/3,333 of 5,000 simulated paths stay solvent/),
    ).toBeInTheDocument();
  });

  // Above the on-demand threshold an edit leaves the last sample on screen.
  // It is still worth stating, but never as if it described the plan as
  // edited.
  it("says when the sample predates the latest change", () => {
    const stale = {
      ...metrics,
      successRate: 0.9,
      failedPaths: 500,
      nPaths: 5000,
      successStale: true,
    } as unknown as HeadlineMetrics;

    render(
      <StatusBand
        metrics={stale}
        warnings={[]}
        asOf={monthsAgo(0)}
        onOpenRefresh={noop}
        now={NOW}
      />,
    );
    expect(
      screen.getByText(
        /4,500 of 5,000 simulated paths stay solvent \(from before the latest change\)\./,
      ),
    ).toBeInTheDocument();
  });

  // Plain under three months, a warning tone from three, and the nudge to
  // refresh from six (#110) — boundaries, not just interior samples.
  describe("as-of staleness", () => {
    it("reads plainly just under the warning threshold", () => {
      render(
        <StatusBand
          metrics={metrics}
          warnings={[]}
          asOf={monthsAgo(2)}
          onOpenRefresh={noop}
          now={NOW}
        />,
      );
      expect(screen.getByText(/Balances as of .* · 2 months ago/)).toHaveClass(
        "status-asof-plain",
      );
      expect(
        screen.queryByRole("button", { name: /Update balances/ }),
      ).not.toBeInTheDocument();
    });

    it("takes a warning tone exactly at three months", () => {
      render(
        <StatusBand
          metrics={metrics}
          warnings={[]}
          asOf={monthsAgo(3)}
          onOpenRefresh={noop}
          now={NOW}
        />,
      );
      expect(screen.getByText(/3 months ago/)).toHaveClass("status-asof-warning");
      expect(
        screen.queryByRole("button", { name: /Update balances/ }),
      ).not.toBeInTheDocument();
    });

    it("nudges a refresh exactly at six months", async () => {
      const onOpenRefresh = vi.fn();
      render(
        <StatusBand
          metrics={metrics}
          warnings={[]}
          asOf={monthsAgo(6)}
          onOpenRefresh={onOpenRefresh}
          now={NOW}
        />,
      );
      expect(screen.getByText(/6 months ago/)).toHaveClass("status-asof-stale");
      const link = screen.getByRole("button", {
        name: "Update balances to bring the projection up to date",
      });
      await userEvent.click(link);
      expect(onOpenRefresh).toHaveBeenCalledTimes(1);
    });
  });
});
