import type { Plan } from "../../types/generated/Plan";

/** Matches `usePlanStore`'s `updatePlan` — a recipe applied to a mutable draft. */
export type UpdatePlan = (mutate: (draft: Plan) => void) => void;

/**
 * Items in a plan-level array (streams, accounts, benefits) that belong to one
 * person, paired with their index in the *original* array — the People pane
 * groups by owner for display, but every edit still has to address the item
 * by its real position in `plan.streams` / `plan.accounts` / etc.
 */
export function ownedBy<T extends { owner: string | null }>(
  items: T[],
  ownerId: string | null,
) {
  return items
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.owner === ownerId);
}
