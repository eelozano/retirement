import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { StateTaxProfile } from "../../types/generated/StateTaxProfile";
import { TaxBracketEditor } from "./TaxBracketEditor";

// Rows are keyed by a client-side id rather than array index. These lock in
// the behavior that keying by index would eventually break: the buffered
// inputs in fields.tsx currently resync on blur and would mask it for a
// while, so the regression would not show up until something else changed.

function Harness() {
  const [value, setValue] = useState<StateTaxProfile>({
    state: "Other",
    standard_deduction: 0,
    brackets: [
      { up_to: 10000, rate: 0.02 },
      { up_to: 50000, rate: 0.04 },
      { up_to: null, rate: 0.06 },
    ],
  });
  return <TaxBracketEditor value={value} onChange={setValue} />;
}

const rate = (n: number) =>
  (screen.getByLabelText(`Bracket ${n} rate (%)`) as HTMLInputElement).value;

describe("TaxBracketEditor", () => {
  it("keeps the surviving rows' values when a middle bracket is removed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect([rate(1), rate(2), rate(3)]).toEqual(["2", "4", "6"]);

    await user.click(screen.getByLabelText("Remove bracket 2"));

    expect([rate(1), rate(2)]).toEqual(["2", "6"]);
    expect(
      (screen.getByLabelText("Bracket 1 upper bound") as HTMLInputElement).value,
    ).toBe("10000");
  });

  it("does not strand a half-typed value on a neighbouring row", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // Leave bracket 3 mid-edit with an uncommitted value, then delete above it.
    const third = screen.getByLabelText("Bracket 3 rate (%)") as HTMLInputElement;
    await user.clear(third);
    await user.type(third, "9");
    await user.click(screen.getByLabelText("Remove bracket 1"));

    // The 9% row is now bracket 2; bracket 1 must show the old bracket 2.
    expect([rate(1), rate(2)]).toEqual(["4", "9"]);
  });

  it("inserts a new bracket before the unbounded one", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Add bracket" }));

    // Four rows, and the last is still the unbounded one.
    expect(rate(4)).toBe("6");
    expect(screen.getByText("and above")).toBeInTheDocument();
    expect(screen.queryByLabelText("Bracket 4 upper bound")).toBeNull();
  });
});
