import type { Plan } from "../../types/generated/Plan";
import { BoundaryDetail } from "./BoundaryDetail";
import {
  CheckboxField,
  NumberField,
  PercentField,
  SelectField,
  TextField,
} from "./fields";
import {
  applyLifespan,
  colaRate,
  lifespanOf,
  lifespanOptions,
  monthlyBenefit,
} from "./pension";
import type { UpdatePlan } from "./shared";
import {
  boundaryDateHint,
  boundaryOptions,
  boundaryToChoice,
  choiceToBoundary,
} from "./streamBoundary";

/**
 * A `CashFlowStream` of `kind: "Pension"`, asked the way a pension
 * statement reads: the monthly check at its first payment, whether it has a
 * COLA, and whose life it is paid for. The engine counts a pension's COLA
 * from that first payment rather than from the plan start.
 */
export function PensionCard(props: {
  plan: Plan;
  streamIndex: number;
  updatePlan: UpdatePlan;
}) {
  const { plan, streamIndex: i, updatePlan } = props;
  const stream = plan.streams[i];
  const cola = colaRate(stream.growth, plan.assumptions.inflation);
  const lifespan = lifespanOf(stream);

  return (
    <fieldset>
      <legend>{stream.name || `Pension ${i + 1}`}</legend>
      <TextField
        label="Name"
        value={stream.name}
        onChange={(name) =>
          updatePlan((d) => {
            d.streams[i].name = name;
          })
        }
      />
      <NumberField
        label="Monthly benefit ($)"
        hint="The check at its first payment, as your pension statement quotes it."
        value={monthlyBenefit(stream)}
        step={50}
        onChange={(monthly) =>
          updatePlan((d) => {
            d.streams[i].annual_amount = monthly * 12;
          })
        }
      />
      <SelectField
        label="Starts"
        value={boundaryToChoice(stream.start)}
        options={boundaryOptions(plan, "start")}
        tooltip={boundaryDateHint(stream.start, plan)}
        onChange={(choice) =>
          updatePlan((d) => {
            d.streams[i].start = choiceToBoundary(choice, d.streams[i].start);
          })
        }
      />
      <BoundaryDetail
        label="Start"
        boundary={stream.start}
        onChange={(boundary) =>
          updatePlan((d) => {
            d.streams[i].start = boundary;
          })
        }
      />
      <CheckboxField
        label="Has a cost-of-living adjustment (COLA)"
        hint="When off, the check stays the same dollar amount for life."
        checked={cola !== null}
        onChange={(checked) =>
          updatePlan((d) => {
            d.streams[i].growth = checked ? { Fixed: d.assumptions.inflation } : "None";
          })
        }
      />
      {cola !== null && (
        <PercentField
          label="COLA"
          hint="Applied each year from the first payment."
          rate={cola}
          onChange={(rate) =>
            updatePlan((d) => {
              d.streams[i].growth = { Fixed: rate };
            })
          }
        />
      )}
      <SelectField
        label="Paid"
        value={lifespan}
        options={lifespanOptions(plan, stream)}
        onChange={(choice) =>
          updatePlan((d) => {
            applyLifespan(d.streams[i], choice);
          })
        }
      />
      {lifespan === "Joint" && stream.survivor_percentage !== null && (
        <PercentField
          label="Survivor share"
          hint="The full check stops when this pension's owner dies; this share of it continues for the survivor."
          rate={stream.survivor_percentage}
          minPercent={0}
          maxPercent={100}
          onChange={(rate) =>
            updatePlan((d) => {
              d.streams[i].survivor_percentage = rate;
            })
          }
        />
      )}
      <button
        type="button"
        className="remove"
        onClick={() =>
          updatePlan((d) => {
            d.streams.splice(i, 1);
          })
        }
      >
        Remove pension
      </button>
    </fieldset>
  );
}
