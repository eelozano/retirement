import type { AssetClass } from "../../types/generated/AssetClass";
import { usePlanStore } from "../../store/planStore";
import { NumberField, PercentField } from "./fields";

const ASSET_LABELS: Record<AssetClass, string> = {
  UsEquity: "US equity (VTI)",
  IntlEquity: "Intl equity (VXUS)",
  GlobalEquity: "Global equity (VT)",
  UsBonds: "US bonds (BND)",
};

export function AssumptionsSection() {
  const plan = usePlanStore((s) => s.plan);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  if (!plan) return null;

  const assumptions = plan.assumptions;
  return (
    <details className="drawer-section">
      <summary>Assumptions</summary>
      <fieldset>
        <legend>Economy &amp; taxes</legend>
        <PercentField
          label="Inflation"
          rate={assumptions.inflation}
          onChange={(rate) =>
            updatePlan((d) => {
              d.assumptions.inflation = rate;
            })
          }
        />
        <PercentField
          label="Flat tax rate"
          rate={assumptions.flat_tax_rate}
          onChange={(rate) =>
            updatePlan((d) => {
              d.assumptions.flat_tax_rate = rate;
            })
          }
        />
        <NumberField
          label="Plan to age"
          value={assumptions.plan_end_age}
          step={1}
          min={50}
          onChange={(age) =>
            updatePlan((d) => {
              d.assumptions.plan_end_age = Math.round(age);
            })
          }
        />
      </fieldset>
      <fieldset>
        <legend>Nominal returns / yr</legend>
        {(Object.keys(ASSET_LABELS) as AssetClass[]).map((asset) => (
          <PercentField
            key={asset}
            label={ASSET_LABELS[asset]}
            rate={assumptions.asset_returns[asset] ?? 0}
            onChange={(rate) =>
              updatePlan((d) => {
                d.assumptions.asset_returns[asset] = rate;
              })
            }
          />
        ))}
      </fieldset>
    </details>
  );
}
