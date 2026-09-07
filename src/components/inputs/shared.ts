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

/**
 * Which of an editor's fields are **household facts** and which are this
 * scenario's **policy** (#109).
 *
 * One line at the head of the card rather than a hint repeated on every
 * fact field: an account editor has six of them, and six identical hints
 * stacked down the pane say less than one sentence that draws the line and
 * names both sides. Naming both sides is the part that carries — "shared"
 * alone leaves the reader to guess what is not.
 */
export const FACT_VS_POLICY = {
  person:
    "Name and birth month belong to the household and are shared by every scenario. " +
    "The retirement date and life expectancy are this scenario's alone.",
  account:
    "Name, type, owner, allocation and balance belong to the household and are shared " +
    "by every scenario — editing one here changes it everywhere. What goes in is this " +
    "scenario's alone.",
  benefit:
    "The benefit at full retirement age and the full retirement age are from the " +
    "statement, and shared by every scenario. When to claim, and any custom COLA, are " +
    "this scenario's alone.",
} as const;
