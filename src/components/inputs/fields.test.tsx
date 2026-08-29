import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { YearMonth } from "../../types/generated/YearMonth";
import { NumberField, PercentField, YearMonthField } from "./fields";

// These cover the "input fights the user while typing" class of bug: the
// fields are controlled and re-derived from the store on every keystroke, so
// a half-typed value must never be parsed, clamped, or reformatted back into
// the DOM mid-edit. Each test drives real keyboard input rather than firing a
// synthetic change event, because the bugs only appear across keystrokes.

/** Wrapper that owns state the way the real drawer sections do. */
function NumberHarness(props: { initial: number; min?: number }) {
  const [value, setValue] = useState(props.initial);
  return (
    <NumberField
      label="Amount"
      value={value}
      min={props.min}
      step={1}
      onChange={setValue}
    />
  );
}

function PercentHarness(props: { initial: number }) {
  const [rate, setRate] = useState(props.initial);
  return <PercentField label="Inflation" rate={rate} onChange={setRate} />;
}

function YearMonthHarness(props: { initial: YearMonth }) {
  const [value, setValue] = useState(props.initial);
  return <YearMonthField label="Born" value={value} onChange={setValue} />;
}

describe("NumberField", () => {
  it("can be cleared and retyped", async () => {
    const user = userEvent.setup();
    render(<NumberHarness initial={150000} />);
    const input = screen.getByLabelText("Amount");

    await user.clear(input);
    // The field must actually empty out — previously React restored the old
    // value the instant the box went blank, making it impossible to retype.
    expect(input).toHaveValue(null);

    await user.type(input, "1200");
    expect(input).toHaveValue(1200);
  });

  it("does not clamp while the user is still typing toward a valid value", async () => {
    const user = userEvent.setup();
    render(<NumberHarness initial={95} min={50} />);
    const input = screen.getByLabelText("Amount");

    await user.clear(input);
    // Typing "95" passes through "9", which is below min. Clamping that first
    // keystroke to 50 would rewrite the DOM and swallow the "5".
    await user.type(input, "95");
    expect(input).toHaveValue(95);
  });

  it("clamps to min on blur, not mid-keystroke", async () => {
    const user = userEvent.setup();
    render(<NumberHarness initial={95} min={50} />);
    const input = screen.getByLabelText("Amount");

    await user.clear(input);
    await user.type(input, "9");
    await user.tab();
    expect(input).toHaveValue(50);
  });
});

describe("PercentField", () => {
  it("allows typing a decimal value", async () => {
    const user = userEvent.setup();
    render(<PercentHarness initial={0.025} />);
    const input = screen.getByLabelText("Inflation (%)");

    await user.clear(input);
    // Reformatting on every keystroke used to erase the trailing "." the
    // moment it was typed, so a decimal could never be entered.
    await user.type(input, "2.5");
    expect(input).toHaveValue(2.5);
  });
});

describe("YearMonthField", () => {
  it("lets the year be retyped digit by digit without losing characters", async () => {
    const user = userEvent.setup();
    render(<YearMonthHarness initial={{ year: 1983, month: 8 }} />);
    const year = screen.getByLabelText("Born year");

    await user.clear(year);
    await user.type(year, "1990");
    expect(year).toHaveValue(1990);
  });

  it("edits the month independently of the year", async () => {
    const user = userEvent.setup();
    render(<YearMonthHarness initial={{ year: 1983, month: 8 }} />);
    const month = screen.getByLabelText("Born month");
    const year = screen.getByLabelText("Born year");

    await user.selectOptions(month, "6");
    expect(month).toHaveValue("6");
    expect(year).toHaveValue(1983);
  });

  it("never emits an out-of-range month", async () => {
    const seen: YearMonth[] = [];
    function Recording() {
      const [value, setValue] = useState<YearMonth>({ year: 1983, month: 8 });
      return (
        <YearMonthField
          label="Born"
          value={value}
          onChange={(next) => {
            seen.push(next);
            setValue(next);
          }}
        />
      );
    }
    const user = userEvent.setup();
    render(<Recording />);

    await user.clear(screen.getByLabelText("Born year"));
    await user.type(screen.getByLabelText("Born year"), "1990");
    await user.selectOptions(screen.getByLabelText("Born month"), "12");

    expect(seen.length).toBeGreaterThan(0);
    for (const value of seen) {
      expect(value.month).toBeGreaterThanOrEqual(1);
      expect(value.month).toBeLessThanOrEqual(12);
    }
  });
});
