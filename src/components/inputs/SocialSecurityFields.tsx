import { currency } from "../../lib/format";
import { adjustmentFactor } from "../../lib/socialSecurity";
import type { Plan } from "../../types/generated/Plan";
import { CheckboxField, NumberField, PercentField, SelectField } from "./fields";
import type { UpdatePlan } from "./shared";

const CLAIMING_AGES = Array.from({ length: 9 }, (_, i) => String(62 + i));

/**
 * One `SocialSecurityBenefit`'s fields, rendered inside its owner's card in
 * the People pane. No owner select: which person's card this sits in *is*
 * the ownership — the old flat panel's owner dropdown was the exact "foreign
 * key you have to read" this restructuring removes.
 */
export function SocialSecurityFields(props: {
  plan: Plan;
  benefitIndex: number;
  updatePlan: UpdatePlan;
}) {
  const { plan, benefitIndex: i, updatePlan } = props;
  const benefit = plan.social_security[i];
  const annualBenefit =
    benefit.benefit_at_fra *
    adjustmentFactor(benefit.full_retirement_age, benefit.claiming_age);

  return (
    <fieldset>
      <legend>Benefit {i + 1}</legend>
      <NumberField
        label="Benefit at full retirement age ($/yr, today's)"
        value={benefit.benefit_at_fra}
        step={100}
        min={0}
        onChange={(amount) =>
          updatePlan((d) => {
            d.social_security[i].benefit_at_fra = amount;
          })
        }
      />
      <NumberField
        label="Full retirement age"
        value={benefit.full_retirement_age}
        step={1}
        min={60}
        max={70}
        onChange={(age) =>
          updatePlan((d) => {
            d.social_security[i].full_retirement_age = age;
          })
        }
      />
      <SelectField
        label="Claiming age"
        value={String(benefit.claiming_age)}
        options={CLAIMING_AGES.map((age) => ({ value: age, label: age }))}
        onChange={(age) =>
          updatePlan((d) => {
            d.social_security[i].claiming_age = Number(age);
          })
        }
      />
      <CheckboxField
        label="Use a custom COLA for this benefit"
        hint="When off, this benefit grows with the plan's Social Security COLA assumption."
        checked={benefit.cola_override !== null}
        onChange={(checked) =>
          updatePlan((d) => {
            d.social_security[i].cola_override = checked
              ? d.assumptions.social_security_cola
              : null;
          })
        }
      />
      {benefit.cola_override !== null && (
        <PercentField
          label="COLA"
          rate={benefit.cola_override}
          onChange={(rate) =>
            updatePlan((d) => {
              d.social_security[i].cola_override = rate;
            })
          }
        />
      )}
      <p className="field-hint">
        At age {benefit.claiming_age}: {currency(annualBenefit)}/yr
      </p>
      <button
        type="button"
        className="remove"
        onClick={() =>
          updatePlan((d) => {
            d.social_security.splice(i, 1);
          })
        }
      >
        Remove benefit
      </button>
    </fieldset>
  );
}
