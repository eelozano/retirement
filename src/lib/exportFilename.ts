import type { Plan } from "../types/generated/Plan";

/** Filesystem-safe stand-in for a plan name — shared by every export that
 * suggests a filename, so a plan called "Enrique's Plan / v2" always
 * sanitizes the same way regardless of which export built the name. */
export function sanitizedPlanName(plan: Plan): string {
  return (
    plan.name
      .trim()
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .replace(/\s+/g, "-") || "plan"
  );
}

/** Today's date as `YYYY-MM-DD`, for filenames. */
export function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
