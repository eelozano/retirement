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
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        value={props.value}
        step={props.step ?? 1000}
        min={props.min ?? 0}
        onChange={(e) => {
          const parsed = e.currentTarget.valueAsNumber;
          if (!Number.isNaN(parsed)) props.onChange(parsed);
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
}) {
  return (
    <label className="field">
      <span>{props.label} (%)</span>
      <input
        type="number"
        value={rateToPercent(props.rate)}
        step={0.1}
        min={0}
        onChange={(e) => {
          const parsed = e.currentTarget.valueAsNumber;
          if (!Number.isNaN(parsed)) props.onChange(percentToRate(parsed));
        }}
      />
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
