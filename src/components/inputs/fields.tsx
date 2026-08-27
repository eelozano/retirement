import { useEffect, useState } from "react";
import type { YearMonth } from "../../types/generated/YearMonth";
import { percentToRate, rateToPercent } from "../../lib/format";

// Small controlled field primitives shared by the drawer forms.
//
// Numeric inputs here are *buffered*: while the field has focus the user's
// literal keystrokes are held in local state and only committed upstream once
// they parse to an in-range value. A naively controlled numeric input fights
// the typist — clearing it snaps the old value back (the empty string parses
// to NaN, so nothing commits and React restores the DOM), and clamping a
// half-typed number rewrites the box mid-keystroke, so typing "95" into a
// min=50 field lands as "9595". Buffering also keeps a partial value like
// "2." intact long enough to finish typing "2.5", and guarantees the engine
// never receives a half-typed number.

/**
 * Local edit buffer for a text-backed control.
 *
 * Renders `canonical` when idle; while focused it renders exactly what was
 * typed. Re-syncs from `canonical` whenever the upstream value changes and
 * the field is not being edited (e.g. loading a different plan).
 */
function useEditBuffer(canonical: string) {
  const [text, setText] = useState(canonical);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(canonical);
  }, [canonical, editing]);

  return { text, setText, editing, setEditing };
}

/** Shared numeric input body: commit when valid, clamp once on blur. */
function BufferedNumberInput(props: {
  ariaLabel: string;
  canonical: string;
  min: number;
  max?: number;
  step: number;
  /** Commit a parsed, in-range number upstream. */
  onCommit: (value: number) => void;
}) {
  const { min, max } = props;
  const buffer = useEditBuffer(props.canonical);

  const inRange = (n: number) => n >= min && (max === undefined || n <= max);

  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={props.ariaLabel}
      value={buffer.text}
      step={props.step}
      min={min}
      max={max}
      onFocus={() => buffer.setEditing(true)}
      onChange={(e) => {
        const next = e.currentTarget.value;
        buffer.setEditing(true);
        buffer.setText(next);
        // Only in-range values reach the store. Anything partial ("", "-",
        // "2.", or a number still below min) stays local until blur.
        const parsed = Number(next);
        if (next.trim() !== "" && Number.isFinite(parsed) && inRange(parsed)) {
          props.onCommit(parsed);
        }
      }}
      onBlur={() => {
        buffer.setEditing(false);
        const parsed = Number(buffer.text);
        if (buffer.text.trim() === "" || !Number.isFinite(parsed)) {
          buffer.setText(props.canonical);
          return;
        }
        const clamped = Math.min(max ?? Infinity, Math.max(min, parsed));
        buffer.setText(String(clamped));
        props.onCommit(clamped);
      }}
    />
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      />
    </label>
  );
}

export function NumberField(props: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <BufferedNumberInput
        ariaLabel={props.label}
        canonical={String(props.value)}
        min={props.min ?? 0}
        max={props.max}
        step={props.step ?? 1000}
        onCommit={props.onChange}
      />
    </label>
  );
}

export function PercentField(props: {
  label: string;
  /** Stored as a decimal rate (0.025 = 2.5%). */
  rate: number;
  onChange: (rate: number) => void;
  /** Display-percent bounds; default allows mild deflation, no upper cap. */
  minPercent?: number;
  maxPercent?: number;
}) {
  const label = `${props.label} (%)`;
  return (
    <label className="field">
      <span>{label}</span>
      <BufferedNumberInput
        ariaLabel={label}
        canonical={rateToPercent(props.rate)}
        min={props.minPercent ?? -25}
        max={props.maxPercent}
        step={0.1}
        onCommit={(percent) => props.onChange(percentToRate(percent))}
      />
    </label>
  );
}

export function CheckboxField(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="field field-checkbox">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span>{props.label}</span>
      {props.hint && <small className="field-hint">{props.hint}</small>}
    </label>
  );
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Month + year entry as two explicit controls.
 *
 * Deliberately not `<input type="month">`: WebKit (and so the macOS and Linux
 * webviews Tauri runs in) has no native month picker and silently degrades it
 * to a text box holding "1983-08", where every keystroke is re-parsed and
 * re-padded — typing a digit produced "1983-085", which came back as month 85.
 * A select plus a number input has no unsupported-type fallback and no
 * half-typed string to misparse, so an out-of-range month is unrepresentable.
 *
 * This is a `div role="group"` rather than a `<label>` because it wraps two
 * controls; each carries its own aria-label.
 */
export function YearMonthField(props: {
  label: string;
  value: YearMonth;
  onChange: (value: YearMonth) => void;
  minYear?: number;
  maxYear?: number;
}) {
  const { year, month } = props.value;
  return (
    <div className="field" role="group" aria-label={props.label}>
      <span>{props.label}</span>
      <span className="field-group">
        <select
          aria-label={`${props.label} month`}
          value={month}
          onChange={(e) =>
            props.onChange({ year, month: Number(e.currentTarget.value) })
          }
        >
          {MONTH_NAMES.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
        <BufferedNumberInput
          ariaLabel={`${props.label} year`}
          canonical={String(year)}
          min={props.minYear ?? 1900}
          max={props.maxYear ?? 2200}
          step={1}
          onCommit={(nextYear) =>
            props.onChange({ year: Math.round(nextYear), month })
          }
        />
      </span>
    </div>
  );
}

export function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value as T)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
