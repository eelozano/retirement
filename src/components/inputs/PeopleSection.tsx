import { usePlanStore } from "../../store/planStore";
import { TextField, YearMonthField } from "./fields";

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
        </fieldset>
      ))}
    </details>
  );
}
