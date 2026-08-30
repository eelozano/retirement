import { useRef } from "react";
import type { StateTaxProfile } from "../../types/generated/StateTaxProfile";
import type { TaxBracket } from "../../types/generated/TaxBracket";
import { NumberField, PercentField } from "./fields";

/**
 * Editable progressive bracket schedule for `Assumptions.state_tax`. The
 * state picker in `AssumptionsSection` prefills `value` from a preset, but
 * every number here is free to edit afterward — this is what `BracketTax`
 * actually computes with, the preset is only ever a starting point.
 *
 * Invariant maintained by this component: the last bracket is always the
 * unbounded one (`up_to: null`); every earlier bracket has an ascending
 * `up_to`.
 */
export function TaxBracketEditor(props: {
  value: StateTaxProfile;
  onChange: (next: StateTaxProfile) => void;
}) {
  const { brackets } = props.value;

  // `TaxBracket` is generated from the Rust struct and carries no id, so row
  // identity is tracked here instead. Keying rows by array index would let
  // React reuse the wrong row's DOM when a middle bracket is removed — today
  // the buffered inputs in `fields.tsx` happen to resync and hide that, which
  // is not something to depend on.
  const ids = useRef<string[]>([]);
  const nextId = useRef(0);
  const newId = () => `bracket-${nextId.current++}`;
  // Any length we did not cause ourselves (a state preset, a scenario switch)
  // rebuilds the list.
  if (ids.current.length !== brackets.length) {
    ids.current = brackets.map((_, i) => ids.current[i] ?? newId());
  }

  const setBrackets = (next: TaxBracket[]) =>
    props.onChange({ ...props.value, brackets: next });

  const addBracket = () => {
    const last = brackets[brackets.length - 1];
    const prevBound =
      brackets.length >= 2 ? (brackets[brackets.length - 2].up_to ?? 0) : 0;
    const newBound = prevBound + 10_000;
    const inserted: TaxBracket = { up_to: newBound, rate: last.rate };
    // The new bracket lands just before the unbounded one, so its id does too.
    ids.current.splice(brackets.length - 1, 0, newId());
    setBrackets([...brackets.slice(0, -1), inserted, last]);
  };

  const removeBracket = (i: number) => {
    ids.current.splice(i, 1);
    setBrackets(brackets.filter((_, idx) => idx !== i));
  };

  const updateBracket = (i: number, patch: Partial<TaxBracket>) =>
    setBrackets(brackets.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));

  return (
    <div className="tax-bracket-editor">
      <NumberField
        label="Standard deduction ($)"
        value={props.value.standard_deduction}
        onChange={(standard_deduction) =>
          props.onChange({ ...props.value, standard_deduction })
        }
      />
      <table className="tax-bracket-table">
        <thead>
          <tr>
            <th>Rate</th>
            <th>Up to ($)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {brackets.map((bracket, i) => {
            const isLast = i === brackets.length - 1;
            return (
              <tr key={ids.current[i]}>
                <td>
                  <PercentField
                    label={`Bracket ${i + 1} rate`}
                    rate={bracket.rate}
                    minPercent={0}
                    maxPercent={100}
                    onChange={(rate) => updateBracket(i, { rate })}
                  />
                </td>
                <td>
                  {isLast ? (
                    <span className="field-hint">and above</span>
                  ) : (
                    <NumberField
                      label={`Bracket ${i + 1} upper bound`}
                      value={bracket.up_to ?? 0}
                      step={1000}
                      onChange={(up_to) => updateBracket(i, { up_to })}
                    />
                  )}
                </td>
                <td>
                  {!isLast && brackets.length > 1 && (
                    <button
                      type="button"
                      className="remove"
                      aria-label={`Remove bracket ${i + 1}`}
                      onClick={() => removeBracket(i)}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" className="add" onClick={addBracket}>
        Add bracket
      </button>
    </div>
  );
}
