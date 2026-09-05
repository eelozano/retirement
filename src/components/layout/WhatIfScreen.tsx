import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  cancelMonteCarlo,
  type MonteCarloResultEntry,
  runMonteCarlos,
  runProjection,
} from "../../lib/api";
import { depletionYear as computeDepletionYear } from "../../lib/projection";
import {
  applyOverrides,
  applyOverridesTo,
  BASELINE,
  isBaseline,
  lifeExpectancyShiftBounds,
  MAX_INFLATION_SHIFT_BP,
  MAX_RETURN_SHIFT_BP,
  MAX_SPENDING_MULTIPLIER,
  MAX_VOLATILITY_MULTIPLIER,
  MIN_SPENDING_MULTIPLIER,
  MIN_VOLATILITY_MULTIPLIER,
  overrideLabels,
  retirementShiftBounds,
  suggestScenarioName,
  type WhatIfOverrides,
} from "../../lib/whatIf";
import { nextRunId, usePlanStore } from "../../store/planStore";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { Plan } from "../../types/generated/Plan";
import type { Projection } from "../../types/generated/Projection";
import { ComparisonChart } from "../charts/ComparisonChart";
import { ComparisonTable } from "../charts/ComparisonTable";
import {
  compareRows,
  compareSeriesDefs,
  comparisonSummary,
  mergeActiveBand,
} from "../charts/compareData";
import { WhyPathsFail } from "../charts/WhyPathsFail";

// The What-if destination: a hypothetical you can drag back.
//
// Everything on this screen is session state. The overrides live in
// `useState`, the draft plan is built by a pure function (`lib/whatIf.ts`),
// and the results come from `runProjection` / `runMonteCarlos` — none of
// which can write a file. There is deliberately no store slice: `updatePlan`
// debounces into `savePlan`, so anything that reached the store would be on
// disk 300 ms later, and the one thing this screen promises is that it isn't.
// The single path to disk is Save as scenario, which the user asks for by
// name and which lands as a *new* file (`promoteToScenario`).
//
// The readout is the comparison view's, reused wholesale: the draft is
// weighed against the saved plan exactly the way one scenario is weighed
// against another, and a success rate should not read one way here and
// another way there.

/** Both plans' Monte Carlo runs go through one batch at one seed and one
 * path count, so the two success rates are measured against the same draws
 * and their difference means something. Seed and path count are the store's,
 * not this screen's: Re-roll moves both sides together (`rerollSeed` re-runs
 * the saved plan; this screen's key changes with it), and the path count
 * stays the one setting the app has. */
const BASE_ID = "base";
const DRAFT_ID = "draft";

/** How long the sliders have to stop moving before the draft is rebuilt.
 * A drag fires a change per pixel; this is what makes "live on release"
 * out of a live control. */
const SETTLE_MS = 220;

/** Whether two versions of the same scenario differ in anything the draft is
 * built from. A rename comes through as a new plan object like any other
 * edit, but it moves no number — and "the plan changed while this was open"
 * over a typo in the title is a false alarm. */
function changedBeyondName(before: Plan, after: Plan): boolean {
  return (
    JSON.stringify({ ...before, name: "" }) !== JSON.stringify({ ...after, name: "" })
  );
}

/** The value once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** How many answers to keep. Dragging a slider back and forth should hit
 * cached results rather than re-run them, but a long session should not hold
 * every percentile fan it has ever computed. The two keys in play are never
 * evicted, so the cap only ever drops positions the user has left. */
const CACHE_CAP = 12;

type CacheEntry = MonteCarloResult | "failed";

function resultOf(entry: CacheEntry | undefined): MonteCarloResult | null {
  return entry === undefined || entry === "failed" ? null : entry;
}

/** One slider, with the saved plan's value marked on the track — the knob is
 * only legible as a *change* if where it started is visible. */
function Knob(props: {
  label: string;
  /** What the current value means, in words: the slider's own number is a
   * position, not a figure anyone wants to read. */
  display: string;
  hint?: string;
  value: number;
  baseline: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const locked = props.min === props.max;
  const span = props.max - props.min;
  const tick = span === 0 ? 50 : ((props.baseline - props.min) / span) * 100;

  return (
    <div className="knob">
      <div className="knob-head">
        <label htmlFor={id}>{props.label}</label>
        <span
          className={`knob-value ${props.value === props.baseline ? "" : "knob-moved"}`}
        >
          {props.display}
        </span>
      </div>
      <div className="knob-track">
        <input
          id={id}
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          disabled={locked}
          aria-valuetext={props.display}
          onChange={(e) => props.onChange(Number(e.currentTarget.value))}
        />
        <span className="knob-baseline" style={{ left: `${tick}%` }} aria-hidden="true" />
      </div>
      {props.hint && <p className="knob-hint">{props.hint}</p>}
    </div>
  );
}

export function WhatIfScreen() {
  const plan = usePlanStore((s) => s.plan);
  const baseProjection = usePlanStore((s) => s.projection);
  const baseMonteCarlo = usePlanStore((s) => s.monteCarlo);
  const baseMonteCarloStale = usePlanStore((s) => s.monteCarloStale);
  const realDollars = usePlanStore((s) => s.realDollars);
  const monteCarloPaths = usePlanStore((s) => s.monteCarloPaths);
  const monteCarloLimits = usePlanStore((s) => s.monteCarloLimits);
  const monteCarloSeed = usePlanStore((s) => s.monteCarloSeed);
  const rerollSeed = usePlanStore((s) => s.rerollSeed);
  const storeRun = usePlanStore((s) => s.monteCarloRun);
  const promoteToScenario = usePlanStore((s) => s.promoteToScenario);

  const [overrides, setOverrides] = useState<WhatIfOverrides>(BASELINE);
  // What the readout describes: the knobs after they have stopped moving.
  // Promotion reads this too, so the scenario saved is always the one whose
  // numbers were on screen.
  const draftOverrides = useSettled(overrides, SETTLE_MS);
  const atRest = isBaseline(draftOverrides);

  const [draftProjection, setDraftProjection] = useState<Projection | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [projecting, setProjecting] = useState(false);

  const [cache, setCache] = useState<ReadonlyMap<string, CacheEntry>>(new Map());
  const [run, setRun] = useState<{
    runId: number;
    completed: number;
    total: number;
  } | null>(null);
  const [mcStale, setMcStale] = useState(false);
  // Bumped by Run, and the value the effect last acted on: "run now, whatever
  // the threshold" has to be a one-shot, or the next knob move would inherit
  // the click. Same pair as the comparison view.
  const [runToken, setRunToken] = useState(0);
  const consumedToken = useRef(0);

  const [showBand, setShowBand] = useState(false);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [promoting, setPromoting] = useState(false);

  // The saved plan can move underneath this screen in two ways, and they want
  // opposite things.
  //
  // A different scenario: the knobs were dialled against a plan that is no
  // longer here, so they reset. (This is also what a promotion lands in — the
  // sandbox reopens on the scenario it just created, at rest.)
  //
  // The same scenario, edited elsewhere: the draft silently re-derives from
  // the new plan with the same knobs, which is right but startling. The notice
  // is what keeps "I didn't touch retirement, why did the draft change?" from
  // being a mystery.
  const [drift, setDrift] = useState(false);
  const seenPlan = useRef<Plan | null>(null);
  useEffect(() => {
    const previous = seenPlan.current;
    seenPlan.current = plan;
    if (!previous || !plan || previous === plan) return;
    if (previous.id !== plan.id) {
      setOverrides(BASELINE);
      setNameEdited(false);
      setDrift(false);
    } else if (!isBaseline(overrides) && changedBeyondName(previous, plan)) {
      setDrift(true);
    }
  }, [plan, overrides]);

  const draftPlan = useMemo(
    () => (plan ? applyOverrides(plan, draftOverrides) : null),
    [plan, draftOverrides],
  );

  // A content key rather than object identity: dragging a slider back to
  // where it was should show the answer it already has, not run it again.
  const planRevision = useRef(new WeakMap<Plan, number>());
  const nextRevision = useRef(0);
  let revision = 0;
  if (plan) {
    let known = planRevision.current.get(plan);
    if (known === undefined) {
      known = ++nextRevision.current;
      planRevision.current.set(plan, known);
    }
    revision = known;
  }
  const runConfig = `${monteCarloSeed}:${monteCarloPaths ?? 0}`;
  const baseKey = `${revision}:base:${runConfig}`;
  const draftKey = `${revision}:${JSON.stringify(draftOverrides)}:${runConfig}`;

  // Deterministic first and on its own: it is milliseconds of work where the
  // Monte Carlo pair is seconds, and the table's four left-hand columns
  // should not wait behind the three on the right.
  useEffect(() => {
    if (!draftPlan) return;
    let cancelled = false;
    setProjecting(true);
    runProjection(draftPlan)
      .then((projection) => {
        if (cancelled) return;
        setDraftProjection(projection);
        setDraftError(null);
      })
      .catch((e: unknown) => {
        // The previous draft stays on screen behind the message. The sliders
        // are clamped to the rules that are about the dates they move (see
        // `retirementShiftBounds`), so this is the engine reporting a rule
        // that clamp does not know about — rare, and worth reading rather
        // than replacing the screen with.
        if (!cancelled) setDraftError(String(e));
      })
      .finally(() => {
        if (!cancelled) setProjecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draftPlan]);

  useEffect(() => {
    // At rest the draft *is* the saved plan: both columns read the store's
    // own result, and the sandbox costs nothing until a knob moves.
    if (atRest || !plan || !draftPlan) return;
    if (monteCarloPaths === null || draftProjection === null || draftError !== null)
      return;

    // The backend keeps one run slot (`claim_slot`), so starting a batch here
    // while the saved plan's own run is in flight would cancel it — and after
    // a Re-roll, that run *is* the Plan screen's new number. Wait for it
    // instead: this effect re-runs when the slot frees.
    if (storeRun !== null) return;

    const work: { key: string; plan: Plan }[] = [];
    if (!cache.has(baseKey)) work.push({ key: baseKey, plan });
    if (!cache.has(draftKey)) work.push({ key: draftKey, plan: draftPlan });
    if (work.length === 0) {
      setMcStale(false);
      return;
    }

    // The threshold is a per-run test, and the first move of a knob is two
    // runs: the draft, and the saved plan at this seed to weigh it against.
    // Afterwards the saved plan's is cached and only the draft re-runs.
    const forced = runToken !== consumedToken.current;
    const cost = monteCarloPaths * work.length;
    const auto = monteCarloLimits === null || cost <= monteCarloLimits.auto_run_max_paths;
    if (!auto && !forced) {
      setMcStale(true);
      return;
    }
    consumedToken.current = runToken;

    const runId = nextRunId();
    const keys = work.map((w) => w.key);
    let superseded = false;
    setMcStale(false);
    setRun({ runId, completed: 0, total: cost });

    (async () => {
      let entries: MonteCarloResultEntry[] | null;
      try {
        entries = await runMonteCarlos(
          work.map((w) => w.plan),
          { n_paths: monteCarloPaths, seed: monteCarloSeed },
          runId,
          (progress) => {
            if (superseded || progress.run_id !== runId) return;
            setRun({ runId, completed: progress.completed, total: progress.total });
          },
        );
      } catch {
        // A failed sampling run must not blank a good projection: the three
        // Monte Carlo columns degrade to "—" and the four deterministic ones
        // still stand.
        entries = keys.map(() => ({ Err: "Monte Carlo run failed" }));
      }
      if (superseded) return;
      setRun(null);
      if (entries === null) {
        // Cancelled, or superseded by a run started elsewhere in the app.
        setMcStale(true);
        return;
      }
      const landed = entries;
      setCache((previous) => {
        const next = new Map(previous);
        keys.forEach((key, i) => {
          const entry = landed[i];
          next.set(key, entry && "Ok" in entry ? entry.Ok : "failed");
        });
        for (const key of [...next.keys()]) {
          if (next.size <= CACHE_CAP) break;
          if (key === baseKey || key === draftKey) continue;
          next.delete(key);
        }
        return next;
      });
    })();

    return () => {
      superseded = true;
      // Leaving the screen, or moving a knob again, should not leave paths
      // burning: the batch is abandoned, not awaited.
      void cancelMonteCarlo(runId).catch(() => {});
    };
  }, [
    atRest,
    plan,
    draftPlan,
    draftProjection,
    draftError,
    cache,
    baseKey,
    draftKey,
    monteCarloPaths,
    monteCarloLimits,
    monteCarloSeed,
    storeRun,
    runToken,
  ]);

  const onCancel = useCallback(() => {
    if (run) void cancelMonteCarlo(run.runId).catch(() => {});
  }, [run]);

  if (!plan || !baseProjection) return null;

  const baseMc = atRest ? baseMonteCarlo : resultOf(cache.get(baseKey));
  const draftMc = atRest ? baseMonteCarlo : resultOf(cache.get(draftKey));
  const stale = atRest ? baseMonteCarloStale : mcStale;

  const changes = overrideLabels(plan, draftOverrides);
  const suggestedName = suggestScenarioName(plan, draftOverrides);
  const scenarioName = nameEdited ? name : suggestedName;

  const setKnob = (patch: Partial<WhatIfOverrides>) => {
    setDrift(false);
    setOverrides((current) => ({ ...current, ...patch }));
  };
  const setRetirementShift = (personId: string, value: number) => {
    setDrift(false);
    setOverrides((current) => ({
      ...current,
      retirementShiftYears: { ...current.retirementShiftYears, [personId]: value },
    }));
  };

  const rows = draftProjection
    ? [
        { id: BASE_ID, projection: baseProjection },
        { id: DRAFT_ID, projection: draftProjection },
      ]
    : [{ id: BASE_ID, projection: baseProjection }];
  const series = compareSeriesDefs([
    { id: BASE_ID, name: plan.name },
    { id: DRAFT_ID, name: "What-if" },
  ]);
  const plainRows = compareRows(rows, realDollars);
  const bandOn = showBand && draftMc !== null;
  const chartRows = bandOn ? mergeActiveBand(plainRows, draftMc, realDollars) : plainRows;
  const summary = comparisonSummary(
    rows.map((r) => ({
      id: r.id,
      name: r.id === BASE_ID ? plan.name : "What-if",
      projection: r.projection,
      monteCarlo: r.id === BASE_ID ? baseMc : draftMc,
    })),
    BASE_ID,
    realDollars,
  );
  const draftDepletion = draftProjection ? computeDepletionYear(draftProjection) : null;

  const promote = async () => {
    setPromoting(true);
    try {
      await promoteToScenario(scenarioName.trim(), (copy) =>
        applyOverridesTo(copy, draftOverrides),
      );
    } finally {
      setPromoting(false);
    }
  };

  return (
    <main className="charts what-if">
      <section className="card what-if-knobs" aria-label="What-if controls">
        <div className="card-head">
          <h2>What-if</h2>
          <span className="card-spacer" />
          <button
            type="button"
            className="card-action"
            disabled={atRest && isBaseline(overrides)}
            onClick={() => setOverrides(BASELINE)}
          >
            Reset
          </button>
        </div>
        <p className="what-if-note">
          Nothing here is saved. {plan.name} on disk is untouched however far these go —
          until you save a hypothetical as a scenario of its own.
        </p>

        {drift && (
          <p className="banner what-if-drift" role="status">
            {plan.name} changed while this was open. The draft has been rebuilt from it,
            with the same knobs.
          </p>
        )}

        <div className="knob-grid">
          {plan.people.map((person) => {
            const bounds = retirementShiftBounds(plan, person.id);
            const shift = draftOverrides.retirementShiftYears[person.id] ?? 0;
            const live = overrides.retirementShiftYears[person.id] ?? 0;
            return (
              <Knob
                key={person.id}
                label={`${person.name} retires`}
                display={
                  live === 0
                    ? `${person.retirement.year} (as saved)`
                    : `${person.retirement.year + live} (${live > 0 ? "+" : "−"}${Math.abs(live)}y)`
                }
                hint={
                  shift !== 0
                    ? "Moves every stream anchored to this retirement with it."
                    : undefined
                }
                value={live}
                baseline={0}
                min={bounds.min}
                max={bounds.max}
                step={1}
                onChange={(value) => setRetirementShift(person.id, value)}
              />
            );
          })}

          <Knob
            label="Spending"
            display={`${Math.round(overrides.spendingMultiplier * 100)}% of plan`}
            value={overrides.spendingMultiplier}
            baseline={1}
            min={MIN_SPENDING_MULTIPLIER}
            max={MAX_SPENDING_MULTIPLIER}
            step={0.01}
            onChange={(value) => setKnob({ spendingMultiplier: value })}
          />

          <Knob
            label="Returns"
            display={
              overrides.returnShiftBp === 0
                ? "As assumed"
                : `${overrides.returnShiftBp > 0 ? "+" : "−"}${Math.abs(overrides.returnShiftBp)} bp`
            }
            hint="Every asset class, deterministic projection and Monte Carlo alike."
            value={overrides.returnShiftBp}
            baseline={0}
            min={-MAX_RETURN_SHIFT_BP}
            max={MAX_RETURN_SHIFT_BP}
            step={10}
            onChange={(value) => setKnob({ returnShiftBp: value })}
          />

          <Knob
            label="Volatility"
            display={`×${overrides.volatilityMultiplier.toFixed(2)}`}
            hint="Monte Carlo only — the deterministic projection, and the year it depletes, never read volatility."
            value={overrides.volatilityMultiplier}
            baseline={1}
            min={MIN_VOLATILITY_MULTIPLIER}
            max={MAX_VOLATILITY_MULTIPLIER}
            step={0.05}
            onChange={(value) => setKnob({ volatilityMultiplier: value })}
          />

          <Knob
            label="Inflation"
            display={
              overrides.inflationShiftBp === 0
                ? "As assumed"
                : `${overrides.inflationShiftBp > 0 ? "+" : "−"}${Math.abs(overrides.inflationShiftBp)} bp`
            }
            value={overrides.inflationShiftBp}
            baseline={0}
            min={-MAX_INFLATION_SHIFT_BP}
            max={MAX_INFLATION_SHIFT_BP}
            step={10}
            onChange={(value) => setKnob({ inflationShiftBp: value })}
          />

          <Knob
            label="Everyone lives"
            display={
              overrides.lifeExpectancyShiftYears === 0
                ? "To the ages on the plan"
                : `${overrides.lifeExpectancyShiftYears > 0 ? "+" : "−"}${Math.abs(overrides.lifeExpectancyShiftYears)} years`
            }
            hint="Moves the plan's horizon, and the survivor transition with it."
            value={overrides.lifeExpectancyShiftYears}
            baseline={0}
            min={lifeExpectancyShiftBounds(plan).min}
            max={lifeExpectancyShiftBounds(plan).max}
            step={1}
            onChange={(value) => setKnob({ lifeExpectancyShiftYears: value })}
          />
        </div>
      </section>

      <section className="card" aria-label="What-if results">
        <div className="card-head">
          <h2>{changes.length === 0 ? "Nothing changed yet" : "This hypothetical"}</h2>
          <span className="card-spacer" />
          <button
            type="button"
            className="card-action"
            disabled={run !== null || storeRun !== null}
            title="Draw a fresh set of random paths — both sides at once, so the comparison holds"
            onClick={rerollSeed}
          >
            Re-roll
          </button>
          <button
            type="button"
            role="switch"
            className="chart-switch"
            aria-checked={bandOn}
            disabled={draftMc === null}
            onClick={() => setShowBand(!showBand)}
          >
            Monte Carlo
            <span className="chart-switch-track" aria-hidden="true">
              <span className="chart-switch-knob" />
            </span>
          </button>
        </div>

        {changes.length === 0 ? (
          <p className="what-if-note">
            Move a knob above. Both sides are simulated at the same seed and path count,
            so the difference between them is the change and not the draw.
          </p>
        ) : (
          <ul className="what-if-changes">
            {changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        )}

        {draftError && (
          <p role="alert" className="banner critical">
            This combination isn't a plan the engine will run:
            {"\n"}
            {draftError}
          </p>
        )}

        <div className={projecting ? "refreshing" : ""}>
          <div className="compare-controls">
            <span className="what-if-basis">
              {realDollars ? "today's dollars · deflated" : "nominal dollars"}
            </span>
            {run ? (
              <span className="compare-run">
                <span
                  role="progressbar"
                  aria-label="Monte Carlo progress"
                  aria-valuenow={run.completed}
                  aria-valuemin={0}
                  aria-valuemax={run.total}
                >
                  {run.completed.toLocaleString()} of {run.total.toLocaleString()} paths
                </span>
                <button type="button" className="tile-button" onClick={onCancel}>
                  Cancel
                </button>
              </span>
            ) : (
              stale && (
                <span className="compare-run">
                  <span>
                    {monteCarloPaths !== null &&
                      `${monteCarloPaths.toLocaleString()} paths a side.`}
                  </span>
                  <button
                    type="button"
                    className="tile-button"
                    onClick={() => setRunToken((t) => t + 1)}
                  >
                    Run
                  </button>
                </span>
              )
            )}
          </div>

          <ComparisonChart
            rows={chartRows}
            series={series}
            showBand={bandOn}
            bandLabel="What-if: 10th–90th percentile"
          />
          <ComparisonTable rows={summary} monteCarloPending={run !== null} />
        </div>

        <div className="what-if-promote">
          <label htmlFor="what-if-name">Save as scenario</label>
          <input
            id="what-if-name"
            type="text"
            value={scenarioName}
            onChange={(e) => {
              setNameEdited(true);
              setName(e.currentTarget.value);
            }}
          />
          <button
            type="button"
            disabled={atRest || promoting || scenarioName.trim() === ""}
            onClick={() => void promote()}
          >
            Save
          </button>
          <p className="knob-hint">
            Copies {plan.name}, applies these changes to the copy, and switches to it. The
            plan you started from is left exactly as it is.
          </p>
        </div>
      </section>

      <WhyPathsFail result={draftMc} depletionYear={draftDepletion} stale={stale} />
    </main>
  );
}
