import type { Plan } from "../../types/generated/Plan";
import type { StreamBoundary } from "../../types/generated/StreamBoundary";

// Boundary editing: a select for the boundary kind plus a month input when a
// concrete date is chosen. Person-relative options are labeled by name.
// Shared by the People pane's own streams and the household Spending pane.

export type BoundaryChoice = string; // "PlanStart" | "PlanEnd" | "Date" | `Retirement:${id}`

export function boundaryToChoice(b: StreamBoundary): BoundaryChoice {
  if (b === "PlanStart" || b === "PlanEnd") return b;
  if ("Date" in b) return "Date";
  if ("AtRetirement" in b) return `Retirement:${b.AtRetirement}`;
  return `Death:${b.AtDeath}`;
}

export function choiceToBoundary(
  choice: BoundaryChoice,
  prev: StreamBoundary,
): StreamBoundary {
  if (choice === "PlanStart" || choice === "PlanEnd") return choice;
  if (choice === "Date") {
    const prevDate =
      typeof prev === "object" && "Date" in prev ? prev.Date : { year: 2030, month: 1 };
    return { Date: prevDate };
  }
  const [kind, id] = choice.split(":");
  return kind === "Retirement" ? { AtRetirement: id } : { AtDeath: id };
}

export function boundaryOptions(plan: Plan, edge: "start" | "end") {
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
