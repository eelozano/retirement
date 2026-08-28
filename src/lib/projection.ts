import type { Projection } from "../types/generated/Projection";

/** The year funds ran out, or `null` if the plan never depletes. */
export function depletionYear(projection: Projection): number | null {
  const depletion = projection.warnings.find(
    (w): w is { DepletedFunds: { period: number } } =>
      typeof w === "object" && "DepletedFunds" in w,
  );
  return depletion
    ? (projection.snapshots[depletion.DepletedFunds.period]?.period_start.year ?? null)
    : null;
}
