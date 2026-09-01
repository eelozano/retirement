import { usePlanStore } from "../../store/planStore";
import type { AssetClass } from "../../types/generated/AssetClass";
import type { FilingStatus } from "../../types/generated/FilingStatus";
import type { Plan } from "../../types/generated/Plan";
import type { StateCode } from "../../types/generated/StateCode";
import { PercentField, SelectField, YearMonthField } from "./fields";
import { boundaryOptions, boundaryToChoice, choiceToBoundary } from "./streamBoundary";
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

/**
 * Sweep start, offered as the same boundary vocabulary the stream editors
 * use — plus "never", which is what `sweep_surplus_from: null` means. Plan
 * end and the death boundaries are left out: a sweep that starts when the
 * plan does is "always", one that starts when it ends is nothing, and a
 * sweep beginning at a death answers a question nobody is asking.
 */
const NEVER = "Never";

const SWEEP_OPTIONS = (plan: Plan) => [
  // Read as a sentence with the field label: "Invest leftover cash from
  // never / plan start / Enrique retires". Kept short because the select is
  // the same fixed width as every other one in this pane.
  { value: NEVER, label: "Never" },
  ...boundaryOptions(plan, "start").map((o) =>
    o.value === "PlanStart" ? { value: o.value, label: "Plan start (always)" } : o,
  ),
];

/**
 * Where the sweep and any RMD remainder land, offered as the plan's taxable
 * accounts plus a sentinel for "unset" — `reinvest_into: null`, which means
 * the first taxable account in plan order (#58). All taxable accounts are
 * offered, not just the account owner's: today, receiving reinvested cash
 * has no owner-specific consequence the way RMD age or contribution limits
 * do.
 */
const DEFAULT_DESTINATION = "Default";

const REINVEST_OPTIONS = (plan: Plan) => {
  const taxable = plan.accounts.filter((a) => a.kind === "Taxable");
  const firstName = taxable[0]?.name || "the first taxable account";
  return [
    { value: DEFAULT_DESTINATION, label: `First taxable account (${firstName})` },
    ...taxable.map((a) => ({ value: a.id, label: a.name || "Untitled account" })),
  ];
};

export function AssumptionsSection() {
  const plan = usePlanStore((s) => s.plan);
  const presets = usePlanStore((s) => s.presets);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  if (!plan) return null;

  const assumptions = plan.assumptions;
  const sweep = assumptions.sweep_surplus_from;
  const sweepChoice = sweep === null ? NEVER : boundaryToChoice(sweep);
  const sweepDate =
    sweep !== null && typeof sweep === "object" && "Date" in sweep ? sweep.Date : null;
  const reinvestChoice = assumptions.reinvest_into ?? DEFAULT_DESTINATION;
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
        <SelectField
          label="Invest leftover cash from"
          hint="Leftover cash each year is income minus contributions, taxes, and modelled spending — and it means two different things. While you're working it's what you live on: you enter what you save, not what you spend, so sweeping it into a brokerage would invest money you've already spent. In retirement it's genuinely left over, and leaving it out understates the portfolio every year. Starting the sweep at a retirement date says both."
          value={sweepChoice}
          options={SWEEP_OPTIONS(plan)}
          onChange={(choice) =>
            updatePlan((d) => {
              d.assumptions.sweep_surplus_from =
                choice === NEVER
                  ? null
                  : choiceToBoundary(
                      choice,
                      d.assumptions.sweep_surplus_from ?? "PlanStart",
                    );
            })
          }
        />
        {sweepDate && (
          <YearMonthField
            label="Sweep starts"
            value={sweepDate}
            onChange={(date) =>
              updatePlan((d) => {
                d.assumptions.sweep_surplus_from = { Date: date };
              })
            }
          />
        )}
        <SelectField
          label="Reinvest leftover cash into"
          hint="Where swept surplus and the after-tax remainder of a required minimum distribution land. Left at the default, it's the first taxable account in plan order — whichever happens to be listed first. With more than one taxable account, naming one directly keeps that from being an accident: which account it is changes how the money grows and what later withdrawals cost in tax."
          value={reinvestChoice}
          options={REINVEST_OPTIONS(plan)}
          onChange={(choice) =>
            updatePlan((d) => {
              d.assumptions.reinvest_into =
                choice === DEFAULT_DESTINATION ? null : choice;
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
      {plan.people.length > 1 && (
        <fieldset>
          <legend>After the first death</legend>
          <p className="field-hint">
            From the first death the projection draws one Social Security benefit — the
            larger of the two — and a joint filer becomes a single filer the following
            year, against roughly half the brackets and half the standard deduction.
          </p>
          <PercentField
            label="Surviving household's spending"
            hint="Share of household spending (the expenses no single person owns) that continues for the survivor. Planners commonly use 70–80%: one person doesn't cost what two did, but housing, utilities, and property tax barely move. Left at 100% until you set it. Expenses owned by a person are left alone — their own end date says when they stop."
            rate={assumptions.survivor_expense_factor}
            minPercent={0}
            maxPercent={100}
            onChange={(rate) =>
              updatePlan((d) => {
                d.assumptions.survivor_expense_factor = rate;
              })
            }
          />
        </fieldset>
      )}
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
      <fieldset>
        <legend>Volatility (annualized std. dev.)</legend>
        <p className="field-hint">
          The return above sets where the Monte Carlo fan is centered; this sets how wide
          it is — and therefore how much of it lands below zero. Approximate historical
          figures, prefilled but yours to change.
        </p>
        {(Object.keys(ASSET_LABELS) as AssetClass[]).map((asset) => (
          <PercentField
            key={asset}
            label={ASSET_LABELS[asset]}
            rate={assumptions.asset_volatility[asset] ?? 0}
            minPercent={0}
            maxPercent={100}
            onChange={(rate) =>
              updatePlan((d) => {
                d.assumptions.asset_volatility[asset] = rate;
              })
            }
          />
        ))}
      </fieldset>
    </div>
  );
}
