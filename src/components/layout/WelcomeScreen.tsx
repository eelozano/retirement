import { useState } from "react";
import type { NewPerson } from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
import { TextField, YearMonthField } from "../inputs/fields";

// What a fresh install opens on, and what the app returns to when the last
// scenario is deleted.
//
// Before #103 this screen did not exist: first launch wrote an invented
// household to disk and opened it, so a new user's first screen was a
// complete projection — charts, a success rate, a retirement date — for
// people who do not exist, with nothing saying so. The only way to a real
// plan was to edit every field of someone else's, and a field you missed
// silently propped up the projection.
//
// So the two things a new user might actually want are offered as an
// explicit choice, and neither happens by default: describe your household
// and start empty, or load the example on purpose, knowing it is an example.

/** A sensible year to show in an empty birth-year box: a mid-career adult,
 * near enough that most users edit rather than retype. */
function defaultBirthYear(): number {
  return new Date().getFullYear() - 40;
}

/** Full retirement age for the same person, as a starting guess. */
function defaultRetirementYear(): number {
  return new Date().getFullYear() + 25;
}

interface Draft {
  name: string;
  birthYear: number;
  birthMonth: number;
  retirementYear: number;
  retirementMonth: number;
}

function emptyDraft(): Draft {
  return {
    name: "",
    birthYear: defaultBirthYear(),
    birthMonth: 1,
    retirementYear: defaultRetirementYear(),
    retirementMonth: 1,
  };
}

function toNewPerson(d: Draft): NewPerson {
  return {
    name: d.name.trim(),
    birth: { year: d.birthYear, month: d.birthMonth },
    retirement: { year: d.retirementYear, month: d.retirementMonth },
  };
}

export function WelcomeScreen() {
  const createPlan = usePlanStore((s) => s.createPlan);
  const loadSample = usePlanStore((s) => s.loadSample);
  const error = usePlanStore((s) => s.error);

  const [planName, setPlanName] = useState("My plan");
  const [people, setPeople] = useState<Draft[]>([emptyDraft()]);
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<Draft>) =>
    setPeople((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  // Every person needs a name, and a retirement date after their birth —
  // the same rules the engine validates, checked here so the form says so
  // before the backend has to.
  const problems = people.flatMap((p, i) => {
    const who = p.name.trim() || `Person ${i + 1}`;
    const out: string[] = [];
    if (p.name.trim() === "") out.push(`${who} needs a name.`);
    if (p.retirementYear * 12 + p.retirementMonth <= p.birthYear * 12 + p.birthMonth) {
      out.push(`${who}'s retirement date must be after their birth date.`);
    }
    return out;
  });
  const ready = planName.trim() !== "" && problems.length === 0;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      // The store has already put the message in `error`; this only stops
      // an unhandled rejection and re-enables the buttons.
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page welcome">
      <div className="welcome-inner">
        <header className="welcome-header">
          <h1>Retirement Planner</h1>
          <p className="welcome-lede">
            Your plans stay on this machine. Nothing is uploaded, and there is no account
            to create.
          </p>
        </header>

        {error && (
          <p role="alert" className="banner critical">
            {error}
          </p>
        )}

        <section className="card welcome-card" aria-labelledby="welcome-start">
          <h2 id="welcome-start">Start your plan</h2>
          <p className="welcome-note">
            Just the people to begin with. You will add accounts, income and spending
            yourself — this app will not invent them for you.
          </p>

          <TextField label="Plan name" value={planName} onChange={setPlanName} />

          {people.map((p, i) => (
            // Index-keyed on purpose: these rows have no identity yet (the
            // name is the thing being typed), and they are only ever
            // appended or removed from the end.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <fieldset className="welcome-person" key={i}>
              <legend>{p.name.trim() || `Person ${i + 1}`}</legend>
              <TextField
                label="Name"
                value={p.name}
                onChange={(name) => update(i, { name })}
              />
              <YearMonthField
                label="Born"
                value={{ year: p.birthYear, month: p.birthMonth }}
                onChange={(v) => update(i, { birthYear: v.year, birthMonth: v.month })}
              />
              <YearMonthField
                label="Retires"
                value={{ year: p.retirementYear, month: p.retirementMonth }}
                onChange={(v) =>
                  update(i, { retirementYear: v.year, retirementMonth: v.month })
                }
              />
              {people.length > 1 && (
                <button
                  type="button"
                  className="remove"
                  onClick={() => setPeople((prev) => prev.filter((_, j) => j !== i))}
                >
                  Remove {p.name.trim() || `person ${i + 1}`}
                </button>
              )}
            </fieldset>
          ))}

          {people.length < 2 && (
            <button
              type="button"
              className="add"
              onClick={() => setPeople((prev) => [...prev, emptyDraft()])}
            >
              Add a partner
            </button>
          )}

          {problems.length > 0 && (
            <ul className="welcome-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          <div className="welcome-actions">
            <button
              type="button"
              className="welcome-primary"
              disabled={busy || !ready}
              onClick={() =>
                run(() => createPlan(planName.trim(), people.map(toNewPerson)))
              }
            >
              Create plan
            </button>
          </div>
        </section>

        <section className="card welcome-card" aria-labelledby="welcome-sample">
          <h2 id="welcome-sample">Or look around first</h2>
          <p className="welcome-note">
            Loads an <strong>invented</strong> household — Alex and Jordan, and balances
            that belong to nobody — so you can see what a finished plan looks like. It
            stays labelled as an example, and you can delete it whenever you like.
          </p>
          <div className="welcome-actions">
            <button
              type="button"
              className="welcome-secondary"
              disabled={busy}
              onClick={() => run(loadSample)}
            >
              Load the example household
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
