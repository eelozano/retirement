import { currency } from "../../lib/format";
import { adjustmentFactor } from "../../lib/socialSecurity";
import { usePlanStore } from "../../store/planStore";
import type { Plan } from "../../types/generated/Plan";
import { CheckboxField, NumberField, PercentField, SelectField } from "./fields";

const CLAIMING_AGES = Array.from({ length: 9 }, (_, i) => String(62 + i));

function ownerOptions(plan: Plan) {
  return plan.people.map((p) => ({ value: p.id, label: p.name }));
}

export function SocialSecuritySection() {
  const plan = usePlanStore((s) => s.plan);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  if (!plan) return null;

  const addBenefit = () =>
    updatePlan((d) => {
      d.social_security.push({
        id: `ss-${Date.now()}`,
        owner: d.people[0]?.id ?? "",
        benefit_at_fra: 0,
        full_retirement_age: 67,
        claiming_age: 67,
        cola_override: null,
      });
    });

  return (
    <details className="input-section" open>
      <summary>Social Security</summary>
      {plan.social_security.map((benefit, i) => {
        const owner = plan.people.find((p) => p.id === benefit.owner);
        const annualBenefit =
          benefit.benefit_at_fra *
          adjustmentFactor(benefit.full_retirement_age, benefit.claiming_age);

        return (
          <fieldset key={benefit.id}>
            <legend>
              {owner ? `${owner.name}'s Social Security` : `Benefit ${i + 1}`}
            </legend>
            <SelectField
              label="Owner"
              value={benefit.owner}
              options={ownerOptions(plan)}
              onChange={(id) =>
                updatePlan((d) => {
                  d.social_security[i].owner = id;
                })
              }
            />
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
      })}
      <button type="button" className="add" onClick={addBenefit}>
        Add Social Security benefit
      </button>
    </details>
  );
}
