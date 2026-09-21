import { currency } from "../../lib/format";
import {
  adjustmentFactor,
  formatFullRetirementAge,
  fullRetirementAgeForBirthYear,
  totalMonths,
} from "../../lib/socialSecurity";
import type { Plan } from "../../types/generated/Plan";
import { CheckboxField, NumberField, PercentField, SelectField } from "./fields";
import { FACT_VS_POLICY, ownedBy, type UpdatePlan } from "./shared";

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
  // The owner's birth year drives the derived full retirement age. An
  // unknown owner is already a validation error, so fall back to the
  // 1960-and-later cohort rather than inventing a birth year.
  const owner = plan.people.find((p) => p.id === benefit.owner);
  const derivedFra = owner
    ? fullRetirementAgeForBirthYear(owner.birth.year)
    : { years: 67, months: 0 };
  const fra = benefit.full_retirement_age ?? derivedFra;
  const annualBenefit =
    benefit.benefit_at_fra * adjustmentFactor(totalMonths(fra), benefit.claiming_age);

  // The owner's name, not a position in `plan.social_security` — that index
  // counts across the whole household, so the second person's only benefit
  // was headed "Benefit 2" on a card that showed them one benefit. Named the
  // same way the Refresh screen names them, and falling back to the card
  // title's "Person N" when the name is still blank.
  const ownerIndex = plan.people.findIndex((p) => p.id === benefit.owner);
  const ownerName =
    plan.people[ownerIndex]?.name ||
    (ownerIndex >= 0 ? `Person ${ownerIndex + 1}` : benefit.owner);
  // Nothing stops a person holding two benefits, so number them — but only
  // then, since "Alex's Social Security 1" over a lone benefit is the same
  // noise this replaces.
  const siblings = ownedBy(plan.social_security, benefit.owner);
  const ordinal =
    siblings.length > 1 ? ` ${siblings.findIndex((entry) => entry.index === i) + 1}` : "";

  return (
    <fieldset>
      <legend>{`${ownerName}'s Social Security${ordinal}`}</legend>
      <p className="field-hint">{FACT_VS_POLICY.benefit}</p>
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
      <CheckboxField
        label="Set full retirement age myself"
        hint="When off, this takes SSA's published age for the owner's birth year — which is not a whole number of years for births from 1938 to 1942 or 1955 to 1959."
        checked={benefit.full_retirement_age !== null}
        onChange={(checked) =>
          updatePlan((d) => {
            d.social_security[i].full_retirement_age = checked ? derivedFra : null;
          })
        }
      />
      {benefit.full_retirement_age === null ? (
        <p className="field-hint">
          {`Full retirement age: ${formatFullRetirementAge(derivedFra)}`}
          {owner ? ` — SSA's age for a ${owner.birth.year} birth.` : "."}
        </p>
      ) : (
        <>
          <NumberField
            label="Full retirement age (years)"
            value={benefit.full_retirement_age.years}
            step={1}
            min={60}
            max={70}
            onChange={(years) =>
              updatePlan((d) => {
                const own = d.social_security[i].full_retirement_age;
                if (own) own.years = years;
              })
            }
          />
          <NumberField
            label="…and months"
            value={benefit.full_retirement_age.months}
            step={1}
            min={0}
            max={11}
            onChange={(months) =>
              updatePlan((d) => {
                const own = d.social_security[i].full_retirement_age;
                if (own) own.months = months;
              })
            }
          />
        </>
      )}
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
