import type { YearMonth } from "../../types/generated/YearMonth";
import { percentToRate, rateToPercent } from "../../lib/format";

// Small controlled field primitives shared by the drawer forms.

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
}) {
  // Clamped, not just HTML-decorated: the browser's min attribute styles an
  // out-of-range value but does not stop it reaching onChange.
  const min = props.min ?? 0;
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        value={props.value}
        step={props.step ?? 1000}
        min={min}
        onChange={(e) => {
          const parsed = e.currentTarget.valueAsNumber;
          if (!Number.isNaN(parsed)) props.onChange(Math.max(min, parsed));
        }}
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
  const min = props.minPercent ?? -25;
  const max = props.maxPercent;
  return (
    <label className="field">
      <span>{props.label} (%)</span>
      <input
        type="number"
        value={rateToPercent(props.rate)}
        step={0.1}
        min={min}
        max={max}
        onChange={(e) => {
          const parsed = e.currentTarget.valueAsNumber;
          if (Number.isNaN(parsed)) return;
          const clamped = Math.min(max ?? Infinity, Math.max(min, parsed));
          props.onChange(percentToRate(clamped));
        }}
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

export function YearMonthField(props: {
  label: string;
  value: YearMonth;
  onChange: (value: YearMonth) => void;
}) {
  const { year, month } = props.value;
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="month"
        value={`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`}
        onChange={(e) => {
          const [y, m] = e.currentTarget.value.split("-").map(Number);
          if (y && m) props.onChange({ year: y, month: m });
        }}
      />
    </label>
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
