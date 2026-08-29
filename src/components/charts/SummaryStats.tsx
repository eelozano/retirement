import { currencyCompact } from "../../lib/format";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";

// KPI row of stat tiles: label + value (compact figure). The depletion tile
// is status, not a series — reserved color plus icon + label, never color alone.

function netWorthAtYear(
  projection: Projection,
  year: number,
  realDollars: boolean,
): number | null {
  const snapshot = projection.snapshots.find((s) => s.period_start.year === year);
  if (!snapshot) return null;
  return snapshot.net_worth / (realDollars ? snapshot.deflator : 1);
}

export function SummaryStats(props: {
  plan: Plan;
  projection: Projection;
  realDollars: boolean;
  depletionYear: number | null;
}) {
  const { plan, projection, realDollars } = props;
  const last = projection.snapshots[projection.snapshots.length - 1];
  const finalNetWorth = last ? last.net_worth / (realDollars ? last.deflator : 1) : 0;

  return (
    <div className="stat-row">
      {plan.people.map((person) => {
        const value = netWorthAtYear(projection, person.retirement.year, realDollars);
        return (
          <div className="stat-tile" key={person.id}>
            <span className="stat-label">
              At {person.name}'s retirement ({person.retirement.year})
            </span>
            <span className="stat-value">
              {value !== null ? currencyCompact(value) : "—"}
            </span>
          </div>
        );
      })}
      <div className="stat-tile">
        <span className="stat-label">At plan end ({last?.period_start.year ?? "—"})</span>
        <span className="stat-value">{currencyCompact(finalNetWorth)}</span>
      </div>
      <div className={`stat-tile ${props.depletionYear !== null ? "stat-critical" : ""}`}>
        <span className="stat-label">Funds depleted</span>
        <span className="stat-value">
          {props.depletionYear !== null ? `⚠ ${props.depletionYear}` : "Never"}
        </span>
      </div>
    </div>
  );
}
