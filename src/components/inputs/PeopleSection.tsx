import { usePlanStore } from "../../store/planStore";
import { NumberField, TextField, YearMonthField } from "./fields";

export function PeopleSection() {
  const plan = usePlanStore((s) => s.plan);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  if (!plan) return null;

  return (
    <details className="input-section" open>
      <summary>People</summary>
      {plan.people.map((person, i) => (
        <fieldset key={person.id}>
          <legend>{person.name || `Person ${i + 1}`}</legend>
          <TextField
            label="Name"
            value={person.name}
            onChange={(name) =>
              updatePlan((d) => {
                d.people[i].name = name;
              })
            }
          />
          <YearMonthField
            label="Born"
            value={person.birth}
            onChange={(birth) =>
              updatePlan((d) => {
                d.people[i].birth = birth;
              })
            }
          />
          <YearMonthField
            label="Retires"
            value={person.retirement}
            onChange={(retirement) =>
              updatePlan((d) => {
                d.people[i].retirement = retirement;
              })
            }
          />
          <NumberField
            label="Life expectancy (age)"
            hint="The mortality assumption for this person — it sets when their own income and expense streams end, and the later of everyone's determines the projection's end year."
            value={person.life_expectancy_age}
            step={1}
            min={1}
            max={120}
            onChange={(age) =>
              updatePlan((d) => {
                d.people[i].life_expectancy_age = Math.round(age);
              })
            }
          />
        </fieldset>
      ))}
    </details>
  );
}
