import { usePlanStore } from "../../store/planStore";
import type { AssetClass } from "../../types/generated/AssetClass";
import type { FilingStatus } from "../../types/generated/FilingStatus";
import type { StateCode } from "../../types/generated/StateCode";
import { CheckboxField, PercentField, SelectField } from "./fields";
import { TaxBracketEditor } from "./TaxBracketEditor";

const ASSET_LABELS: Record<AssetClass, string> = {
  UsEquity: "US equity (VTI)",
  IntlEquity: "Intl equity (VXUS)",
  GlobalEquity: "Global equity (VT)",
  UsBonds: "US bonds (BND)",
};

const FILING_STATUS_OPTIONS: { value: FilingStatus; label: string }[] = [
  { value: "Single", label: "Single" },
  { value: "MarriedFilingJointly", label: "Married filing jointly" },
];

const STATE_LABELS: Record<StateCode, string> = {
  Alabama: "Alabama",
  Alaska: "Alaska",
  Arizona: "Arizona",
  Arkansas: "Arkansas",
  California: "California",
  Colorado: "Colorado",
  Connecticut: "Connecticut",
  Delaware: "Delaware",
  Florida: "Florida",
  Georgia: "Georgia",
  Hawaii: "Hawaii",
  Idaho: "Idaho",
  Illinois: "Illinois",
  Indiana: "Indiana",
  Iowa: "Iowa",
  Kansas: "Kansas",
  Kentucky: "Kentucky",
  Louisiana: "Louisiana",
  Maine: "Maine",
  Maryland: "Maryland",
  Massachusetts: "Massachusetts",
  Michigan: "Michigan",
  Minnesota: "Minnesota",
  Mississippi: "Mississippi",
  Missouri: "Missouri",
  Montana: "Montana",
  Nebraska: "Nebraska",
  Nevada: "Nevada",
  NewHampshire: "New Hampshire",
  NewJersey: "New Jersey",
  NewMexico: "New Mexico",
  NewYork: "New York",
  NorthCarolina: "North Carolina",
  NorthDakota: "North Dakota",
  Ohio: "Ohio",
  Oklahoma: "Oklahoma",
  Oregon: "Oregon",
  Pennsylvania: "Pennsylvania",
  RhodeIsland: "Rhode Island",
  SouthCarolina: "South Carolina",
  SouthDakota: "South Dakota",
  Tennessee: "Tennessee",
  Texas: "Texas",
  Utah: "Utah",
  Vermont: "Vermont",
  Virginia: "Virginia",
  Washington: "Washington",
  WashingtonDc: "Washington, DC",
  WestVirginia: "West Virginia",
  Wisconsin: "Wisconsin",
  Wyoming: "Wyoming",
  Other: "Other / custom",
};

const STATE_OPTIONS = (Object.keys(STATE_LABELS) as StateCode[]).map((value) => ({
  value,
  label: STATE_LABELS[value],
}));

export function AssumptionsSection() {
  const plan = usePlanStore((s) => s.plan);
  const presets = usePlanStore((s) => s.presets);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  if (!plan) return null;

  const assumptions = plan.assumptions;
  return (
    <div className="pane-section">
      <div className="pane-head">
        <h3>Assumptions</h3>
        <p>Set once, revisited rarely.</p>
      </div>
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
        <SelectField
          label="Filing status"
          value={assumptions.filing_status}
          options={FILING_STATUS_OPTIONS}
          onChange={(filing_status: FilingStatus) =>
            updatePlan((d) => {
              d.assumptions.filing_status = filing_status;
            })
          }
        />
        <SelectField
          label="State"
          value={assumptions.state_tax.state}
          options={STATE_OPTIONS}
          onChange={(state: StateCode) =>
            updatePlan((d) => {
              // Prefill from the preset table; the brackets below stay
              // fully editable afterward regardless of this pick.
              const preset = presets?.state_tax_profiles[state];
              d.assumptions.state_tax = preset
                ? { ...preset, brackets: preset.brackets.map((b) => ({ ...b })) }
                : { state, brackets: [{ up_to: null, rate: 0 }], standard_deduction: 0 };
            })
          }
        />
        <TaxBracketEditor
          value={assumptions.state_tax}
          onChange={(state_tax) =>
            updatePlan((d) => {
              d.assumptions.state_tax = state_tax;
            })
          }
        />
        <CheckboxField
          label="Sweep leftover income into taxable brokerage"
          hint="When off, leftover cash each year (income minus contributions, taxes, and spending) is left out of the plan — assume it's going toward other goals. When on, it's automatically invested in your first taxable account."
          checked={assumptions.sweep_surplus_to_taxable}
          onChange={(checked) =>
            updatePlan((d) => {
              d.assumptions.sweep_surplus_to_taxable = checked;
            })
          }
        />
        <PercentField
          label="Social Security COLA"
          rate={assumptions.social_security_cola}
          onChange={(rate) =>
            updatePlan((d) => {
              d.assumptions.social_security_cola = rate;
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
    </div>
  );
}
