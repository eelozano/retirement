import { usePlanStore } from "../../store/planStore";
import type { Plan } from "../../types/generated/Plan";
import type { StreamBoundary } from "../../types/generated/StreamBoundary";
import { NumberField, SelectField, TextField, YearMonthField } from "./fields";

// Boundary editing: a select for the boundary kind plus a month input when a
// concrete date is chosen. Person-relative options are labeled by name.

type BoundaryChoice = string; // "PlanStart" | "PlanEnd" | "Date" | `Retirement:${id}`

function boundaryToChoice(b: StreamBoundary): BoundaryChoice {
  if (b === "PlanStart" || b === "PlanEnd") return b;
  if ("Date" in b) return "Date";
  if ("AtRetirement" in b) return `Retirement:${b.AtRetirement}`;
  return `Death:${b.AtDeath}`;
}

function choiceToBoundary(choice: BoundaryChoice, prev: StreamBoundary): StreamBoundary {
  if (choice === "PlanStart" || choice === "PlanEnd") return choice;
  if (choice === "Date") {
    const prevDate =
      typeof prev === "object" && "Date" in prev ? prev.Date : { year: 2030, month: 1 };
    return { Date: prevDate };
  }
  const [kind, id] = choice.split(":");
  return kind === "Retirement" ? { AtRetirement: id } : { AtDeath: id };
}

function boundaryOptions(plan: Plan, edge: "start" | "end") {
  const base =
    edge === "start"
      ? [{ value: "PlanStart", label: "Plan start" }]
      : [{ value: "PlanEnd", label: "Plan end" }];
  return [
    ...base,
    { value: "Date", label: "Specific month" },
    ...plan.people.map((p) => ({
      value: `Retirement:${p.id}`,
      label: `${p.name} retires`,
    })),
  ];
}

export function StreamsSection() {
  const plan = usePlanStore((s) => s.plan);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  if (!plan) return null;

  const addStream = () =>
    updatePlan((d) => {
      d.streams.push({
        id: `stream-${Date.now()}`,
        name: "New stream",
        owner: null,
        direction: "Expense",
        annual_amount: 0,
        start: "PlanStart",
        end: "PlanEnd",
        growth: "Inflation",
      });
    });

  return (
    <details className="input-section" open>
      <summary>Income &amp; expenses</summary>
      {plan.streams.map((stream, i) => (
        <fieldset key={stream.id}>
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
            Remove stream
          </button>
        </fieldset>
      ))}
      <button type="button" className="add" onClick={addStream}>
        Add stream
      </button>
    </details>
  );
}
