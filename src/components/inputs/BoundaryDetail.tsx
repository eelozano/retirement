import type { StreamBoundary } from "../../types/generated/StreamBoundary";
import { NumberField, YearMonthField } from "./fields";

/**
 * The follow-up field a boundary needs once its kind is chosen: a month for
 * `Date`, an age for `AtAge`, and nothing for the rest, which resolve from
 * the plan on their own.
 *
 * Shared by every Starts/Ends/Lands select — a person's streams, a pension,
 * an account's contributions, and the surplus sweep — so a boundary kind
 * added to `boundaryOptions` is editable everywhere at once rather than in
 * five copies of the same conditional.
 */
export function BoundaryDetail(props: {
  /** Names the edge, e.g. "Start" → "Start month" / "Start age". */
  label: string;
  boundary: StreamBoundary;
  onChange: (boundary: StreamBoundary) => void;
}) {
  const { boundary, onChange } = props;
  if (typeof boundary !== "object") return null;
  if ("Date" in boundary) {
    return (
      <YearMonthField
        label={`${props.label} month`}
        value={boundary.Date}
        onChange={(date) => onChange({ Date: date })}
      />
    );
  }
  if ("AtAge" in boundary) {
    const [person, age] = boundary.AtAge;
    return (
      <NumberField
        label={`${props.label} age`}
        value={age}
        step={1}
        min={0}
        max={120}
        onChange={(next) => onChange({ AtAge: [person, Math.round(next)] })}
      />
    );
  }
  return null;
}
