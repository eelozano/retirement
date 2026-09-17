import type { CashFlowStream } from "../../types/generated/CashFlowStream";
import type { GrowthRule } from "../../types/generated/GrowthRule";
import type { Plan } from "../../types/generated/Plan";
import { boundaryPhrase } from "./streamBoundary";

// A pension is a `CashFlowStream` with `kind: "Pension"`: the card asks the
// questions a pension statement answers — a monthly check, a COLA, whose
// life it runs for — and these write them onto the stream fields the engine
// already runs. Kept apart from the component so the mappings are testable
// without rendering it.

/** The monthly check, to the cent, for an amount stored per year. */
export function monthlyBenefit(stream: CashFlowStream): number {
  return Math.round((stream.annual_amount / 12) * 100) / 100;
}

/**
 * The COLA rate a pension grows at, or `null` for none. A saved `Inflation`
 * reads as a COLA at the plan's inflation rate; editing the rate turns it
 * into a fixed one.
 */
export function colaRate(growth: GrowthRule, inflation: number): number | null {
  if (growth === "None") return null;
  if (growth === "Inflation") return inflation;
  return growth.Fixed;
}

/**
 * How long the benefit is paid: until one named person dies (single life),
 * `Joint` — the owner's full check, then the survivor share for whoever
 * outlives them — or `Other` for an end the card did not write.
 */
export type Lifespan = `Death:${string}` | "Joint" | "Other";

export function lifespanOf(stream: CashFlowStream): Lifespan {
  if (stream.survivor_percentage !== null) return "Joint";
  if (typeof stream.end === "object" && "AtDeath" in stream.end)
    return `Death:${stream.end.AtDeath}`;
  return "Other";
}

/** The `end` and `survivor_percentage` a lifespan choice writes. */
export function applyLifespan(stream: CashFlowStream, lifespan: Lifespan): void {
  if (lifespan === "Other") return;
  if (lifespan === "Joint") {
    // The survivor share already stops the full check at the owner's
    // death; `PlanEnd` is the last death, so the share runs until both
    // have died.
    stream.end = "PlanEnd";
    stream.survivor_percentage ??= 1;
    return;
  }
  stream.end = { AtDeath: lifespan.slice("Death:".length) };
  stream.survivor_percentage = null;
}

export function lifespanOptions(plan: Plan, stream: CashFlowStream) {
  const current = lifespanOf(stream);
  const options: { value: Lifespan; label: string }[] = plan.people.map((p) => ({
    value: `Death:${p.id}`,
    label: `Until ${p.name || "this person"} dies (single life)`,
  }));
  if (plan.people.length > 1 || current === "Joint") {
    const label =
      plan.people.length === 2
        ? `Until ${plan.people[0].name} and ${plan.people[1].name} have both died (joint)`
        : "Until the last survivor dies (joint)";
    options.push({ value: "Joint", label });
  }
  if (current === "Other") {
    options.push({ value: "Other", label: `Until ${boundaryPhrase(stream.end, plan)}` });
  }
  return options;
}
