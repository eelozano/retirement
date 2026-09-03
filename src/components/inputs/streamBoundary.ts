import type { Plan } from "../../types/generated/Plan";
import type { StreamBoundary } from "../../types/generated/StreamBoundary";

// Boundary editing: a select for the boundary kind plus a month input when a
// concrete date is chosen. Person-relative options are labeled by name.
// Shared by the People pane's own streams, the household Spending pane,
// and an account's dated contribution entries.

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

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * A boundary as a clause — "plan start", "Jan 2027", "Alex retires" — so a
 * card with no name of its own can describe its window from its data.
 */
export function boundaryPhrase(b: StreamBoundary, plan: Plan): string {
  if (b === "PlanStart") return "plan start";
  if (b === "PlanEnd") return "plan end";
  if ("Date" in b) return `${MONTH_ABBR[b.Date.month - 1]} ${b.Date.year}`;
  const retires = "AtRetirement" in b;
  const id = retires ? b.AtRetirement : b.AtDeath;
  const name = plan.people.find((p) => p.id === id)?.name || "the owner";
  return retires ? `${name} retires` : `${name} dies`;
}
