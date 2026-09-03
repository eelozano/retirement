import type { Plan } from "../types/generated/Plan";
import type { Projection } from "../types/generated/Projection";
import type { SimWarning } from "../types/generated/SimWarning";
import { currency } from "./format";

/** A `SimWarning` rendered for a human: a headline plus what to do about it. */
export interface ReadableWarning {
  /** Stable within one projection — used as a React key. */
  key: string;
  title: string;
  detail: string;
}

function accountName(plan: Plan, id: string): string {
  return plan.accounts.find((a) => a.id === id)?.name || id;
}

function streamName(plan: Plan, id: string): string {
  const stream = plan.streams.find((s) => s.id === id);
  if (stream) return stream.name || id;
  return plan.social_security.find((b) => b.id === id) ? "a Social Security benefit" : id;
}

function periodYear(projection: Projection, period: number): number | null {
  return projection.snapshots[period]?.period_start.year ?? null;
}

/**
 * Turns a projection's warnings into text.
 *
 * Warnings used to surface as a bare count, which meant a plan could quietly
 * run on materially different numbers than the ones entered with no way to
 * find out which. Every variant gets a sentence naming the thing it happened
 * to and what the simulation did instead.
 */
export function readableWarnings(plan: Plan, projection: Projection): ReadableWarning[] {
  return projection.warnings.map((warning: SimWarning, i): ReadableWarning => {
    const key = `warning-${i}`;
    // The payload-free variants come first: ts-rs emits them as bare
    // strings rather than objects, and the `in` checks below need an
    // object. Each is matched by value, not by `typeof`, so a new one is
    // never silently rendered as an existing one.
    if (warning === "SurplusUnallocated") {
      return {
        key,
        title: "Surplus cash is not being invested",
        detail:
          "Leftover cash is set to be swept into a taxable account, but the plan has no taxable account for it to land in. The surplus is reported but left uninvested.",
      };
    }
    if (warning === "SweepBoundaryUnresolved") {
      return {
        key,
        title: "Leftover cash is not being invested",
        detail:
          "The sweep is set to start at the retirement of someone who is no longer in this plan, so there is no date to start it from and nothing is being swept. Pick when the sweep should start under Assumptions.",
      };
    }
    if ("ContributionClamped" in warning) {
      const { account, period, requested, allowed } = warning.ContributionClamped;
      const name = accountName(plan, account);
      const year = periodYear(projection, period);
      // Statutory limits index and salaries grow, so a clamp starts in a
      // particular year rather than applying flatly to every year — the
      // engine reports the first one and the headline names it.
      const from = year !== null ? ` from ${year}` : "";
      return {
        key,
        title: `${name}: contributing ${currency(allowed)}/yr, not ${currency(requested)}/yr${from}`,
        detail:
          allowed === 0
            ? `The limit for this kind of account is shared per person per year, and ${name}'s owner already fills it from accounts listed above this one. Nothing is being contributed here.`
            : `Contributions were held to the federal maximum for this account's plan type, shared per person per year with their other accounts in the same bucket.`,
      };
    }
    if ("MatchUnallocated" in warning) {
      const name = accountName(plan, warning.MatchUnallocated.account);
      return {
        key,
        title: `${name}: the employer match has nowhere to go`,
        detail:
          "Its match is set to land pre-tax, but this owner has no pre-tax employer-plan account (or Roth, if that is the destination). Putting the money in an account with the wrong tax treatment would tax the withdrawals wrongly for the rest of the plan, so no match is being paid. Add an account of the right kind, or change the destination.",
      };
    }
    if ("AnnualAdditionsClamped" in warning) {
      const { account, period, requested, allowed } = warning.AnnualAdditionsClamped;
      const name = accountName(plan, account);
      const year = periodYear(projection, period);
      return {
        key,
        title: `${name}: match cut to ${currency(allowed)}/yr${year !== null ? ` from ${year}` : ""}`,
        detail: `Contributions and match together hit the federal cap on everything that can go into one employer plan in a year, so the match was trimmed from ${currency(requested)}. Your own contributions are untouched — only the match gives way.`,
      };
    }
    if ("RequiredDistributionUnallocated" in warning) {
      const year = periodYear(projection, warning.RequiredDistributionUnallocated.period);
      return {
        key,
        title: `Required withdrawals have nowhere to go${year !== null ? ` from ${year}` : ""}`,
        detail:
          "From this year the IRS forces a minimum withdrawal out of a pre-tax account, but the plan has no taxable account to hold what is left after tax. That money leaves the pre-tax balance and lands nowhere, so net worth drops by it every year and the projection understates the plan. Add a taxable brokerage account to hold it.",
      };
    }
    if ("DepletedFunds" in warning) {
      const year = periodYear(projection, warning.DepletedFunds.period);
      return {
        key,
        title: `Funds run out${year !== null ? ` in ${year}` : ""}`,
        detail:
          "From this year on, the accounts cannot cover spending. Balances stop at zero rather than going negative, so later years understate the shortfall.",
      };
    }
    if ("ContributionBoundaryUnresolved" in warning) {
      const name = accountName(plan, warning.ContributionBoundaryUnresolved.account);
      return {
        key,
        title: `${name}: a contribution was skipped`,
        detail:
          "One of its contributions starts or ends at the retirement or death of someone who is no longer in this plan, so there is no window to apply it over and nothing is being contributed from it. Pick a new start or end for it.",
      };
    }
    const name = streamName(plan, warning.UnknownPersonRef.stream);
    return {
      key,
      title: `${name} was skipped`,
      detail:
        "It refers to a person who is not in the plan, so its income or expense is missing from every year of the projection.",
    };
  });
}
