import { yearMonth } from "../../lib/format";
import type { Plan } from "../../types/generated/Plan";
import type { StreamBoundary } from "../../types/generated/StreamBoundary";
import type { YearMonth } from "../../types/generated/YearMonth";

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

/**
 * The calendar month a person-relative boundary resolves to, so a reader
 * doesn't have to hop to the People pane and read `retirement` (or do the
 * birth-plus-life-expectancy arithmetic for `AtDeath`) by hand. Mirrors
 * `resolve_boundary` in `sim/mod.rs` for these two arms. `undefined` for
 * `PlanStart`/`PlanEnd`/`Date`, which are already self-evident, or if the
 * named person no longer exists.
 */
export function boundaryResolvedDate(
  b: StreamBoundary,
  plan: Plan,
): YearMonth | undefined {
  if (typeof b !== "object") return undefined;
  if ("AtRetirement" in b)
    return plan.people.find((p) => p.id === b.AtRetirement)?.retirement;
  if ("AtDeath" in b) {
    const person = plan.people.find((p) => p.id === b.AtDeath);
    if (!person) return undefined;
    return {
      year: person.birth.year + person.life_expectancy_age,
      month: person.birth.month,
    };
  }
  return undefined;
}

/**
 * Text for an `InfoTooltip` next to the boundary select itself: "That's
 * currently Jan 2043." on hover/focus of the "i" badge beside a "Alex
 * retires" choice, so seeing when a spending or income window actually
 * starts or ends doesn't require leaving the screen — or reading the
 * People pane's `retirement` field and doing the math by hand.
 */
export function boundaryDateHint(b: StreamBoundary, plan: Plan): string | undefined {
  const resolved = boundaryResolvedDate(b, plan);
  return resolved ? `That's currently ${yearMonth(resolved)}.` : undefined;
}

/**
 * A boundary as a clause — "plan start", "Jan 2027", "Alex retires (Jan
 * 2043)" — so a card with no name of its own can describe its window from
 * its data.
 */
export function boundaryPhrase(b: StreamBoundary, plan: Plan): string {
  if (b === "PlanStart") return "plan start";
  if (b === "PlanEnd") return "plan end";
  if ("Date" in b) return yearMonth(b.Date);
  const retires = "AtRetirement" in b;
  const id = retires ? b.AtRetirement : b.AtDeath;
  const name = plan.people.find((p) => p.id === id)?.name || "the owner";
  const resolved = boundaryResolvedDate(b, plan);
  const suffix = resolved ? ` (${yearMonth(resolved)})` : "";
  return `${retires ? `${name} retires` : `${name} dies`}${suffix}`;
}
