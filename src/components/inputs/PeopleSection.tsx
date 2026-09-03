import { usePlanStore } from "../../store/planStore";
import { NumberField, TextField, YearMonthField } from "./fields";
import { SocialSecurityFields } from "./SocialSecurityFields";
import { StreamCard } from "./StreamCard";
import { ownedBy } from "./shared";

/**
 * One card per person, readable top to bottom as one story: dates, their
 * income, and their Social Security. Replaces the old flat panel where a
 * person's salary sat in a different column with "Owner" as a dropdown the
 * reader had to resolve by hand.
 *
 * What they *save* is not here: a contribution carries its own dates and can
 * outlive a retirement, so it is edited on the account in the Accounts pane.
 */
export function PeopleSection() {
  const plan = usePlanStore((s) => s.plan);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  if (!plan) return null;

  const addPerson = () =>
    updatePlan((d) => {
      d.people.push({
        id: `person-${Date.now()}`,
        name: "New person",
        birth: { year: 1990, month: 1 },
        retirement: { year: 2055, month: 1 },
        life_expectancy_age: 90,
      });
    });

  return (
    <div className="pane-section">
      <div className="pane-head">
        <h3>People</h3>
        <p>
          Who they are, when they stop working, and every dollar that moves through them.
        </p>
      </div>

      {plan.people.map((person, i) => {
        const streams = ownedBy(plan.streams, person.id);
        const benefits = ownedBy(plan.social_security, person.id);

        const addStream = () =>
          updatePlan((d) => {
            d.streams.push({
              id: `stream-${Date.now()}`,
              name: "New stream",
              owner: person.id,
              direction: "Income",
              annual_amount: 0,
              start: "PlanStart",
              end: { AtRetirement: person.id },
              growth: "Inflation",
              survivor_percentage: null,
            });
          });

        const addBenefit = () =>
          updatePlan((d) => {
            d.social_security.push({
              id: `ss-${Date.now()}`,
              owner: person.id,
              benefit_at_fra: 0,
              full_retirement_age: 67,
              claiming_age: 67,
              cola_override: null,
            });
          });

        return (
          <div className="input-card person-card" key={person.id}>
            <div className="input-card-title">{person.name || `Person ${i + 1}`}</div>
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

            <div className="band band-income">
              <p className="band-label">Income &amp; expenses</p>
              {streams.map(({ index: streamIndex }) => (
                <StreamCard
                  key={plan.streams[streamIndex].id}
                  plan={plan}
                  streamIndex={streamIndex}
                  updatePlan={updatePlan}
                  removeLabel="Remove stream"
                />
              ))}
              <button type="button" className="add" onClick={addStream}>
                Add stream
              </button>
            </div>

            <div className="band band-social-security">
              <p className="band-label">Social Security</p>
              {benefits.map(({ index: benefitIndex }) => (
                <SocialSecurityFields
                  key={plan.social_security[benefitIndex].id}
                  plan={plan}
                  benefitIndex={benefitIndex}
                  updatePlan={updatePlan}
                />
              ))}
              <button type="button" className="add" onClick={addBenefit}>
                Add Social Security benefit
              </button>
            </div>
          </div>
        );
      })}

      <button type="button" className="add" onClick={addPerson}>
        Add person
      </button>
    </div>
  );
}
