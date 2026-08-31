import type { Plan } from "../../types/generated/Plan";
import { NumberField, SelectField, TextField, YearMonthField } from "./fields";
import type { UpdatePlan } from "./shared";
import { boundaryOptions, boundaryToChoice, choiceToBoundary } from "./streamBoundary";

/**
 * One `CashFlowStream`'s fields — used both for a person's own income/expense
 * streams (People pane) and for household spending (Spending pane). Which
 * list it lives in is entirely determined by `owner`, set by the caller when
 * the stream is created; this component never edits it.
 */
export function StreamCard(props: {
  plan: Plan;
  streamIndex: number;
  updatePlan: UpdatePlan;
  removeLabel: string;
}) {
  const { plan, streamIndex: i, updatePlan } = props;
  const stream = plan.streams[i];

  return (
    <fieldset>
      <legend>{stream.name || `Stream ${i + 1}`}</legend>
      <TextField
        label="Name"
        value={stream.name}
        onChange={(name) =>
          updatePlan((d) => {
            d.streams[i].name = name;
          })
        }
      />
      <SelectField
        label="Direction"
        value={stream.direction}
        options={
          [
            { value: "Income", label: "Income" },
            { value: "Expense", label: "Expense" },
          ] as const
        }
        onChange={(direction) =>
          updatePlan((d) => {
            d.streams[i].direction = direction;
          })
        }
      />
      <NumberField
        label="Amount / yr ($, today's)"
        value={stream.annual_amount}
        onChange={(amount) =>
          updatePlan((d) => {
            d.streams[i].annual_amount = amount;
          })
        }
      />
      <SelectField
        label="Starts"
        value={boundaryToChoice(stream.start)}
        options={boundaryOptions(plan, "start")}
        onChange={(choice) =>
          updatePlan((d) => {
            d.streams[i].start = choiceToBoundary(choice, d.streams[i].start);
          })
        }
      />
      {typeof stream.start === "object" && "Date" in stream.start && (
        <YearMonthField
          label="Start month"
          value={stream.start.Date}
          onChange={(date) =>
            updatePlan((d) => {
              d.streams[i].start = { Date: date };
            })
          }
        />
      )}
      <SelectField
        label="Ends"
        value={boundaryToChoice(stream.end)}
        options={boundaryOptions(plan, "end")}
        onChange={(choice) =>
          updatePlan((d) => {
            d.streams[i].end = choiceToBoundary(choice, d.streams[i].end);
          })
        }
      />
      {typeof stream.end === "object" && "Date" in stream.end && (
        <YearMonthField
          label="End month"
          value={stream.end.Date}
          onChange={(date) =>
            updatePlan((d) => {
              d.streams[i].end = { Date: date };
            })
          }
        />
      )}
      <SelectField
        label="Grows with"
        value={stream.growth === "Inflation" ? "Inflation" : "None"}
        options={
          [
            { value: "Inflation", label: "Inflation" },
            { value: "None", label: "Nothing (flat)" },
          ] as const
        }
        onChange={(growth) =>
          updatePlan((d) => {
            d.streams[i].growth = growth;
          })
        }
      />
      <button
        type="button"
        className="remove"
        onClick={() =>
          updatePlan((d) => {
            d.streams.splice(i, 1);
          })
        }
      >
        {props.removeLabel}
      </button>
    </fieldset>
  );
}
