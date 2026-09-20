import {
  bridgePolicy,
  defaultOrderPolicy,
  newPhaseId,
  penaltyWarning,
  phaseStartMonth,
  sameSource,
  sourceLabel,
} from "../../lib/drawdown";
import { yearMonth } from "../../lib/format";
import { usePlanStore } from "../../store/planStore";
import type { AccountKind } from "../../types/generated/AccountKind";
import type { DrawdownPhase } from "../../types/generated/DrawdownPhase";
import type { PhaseStart } from "../../types/generated/PhaseStart";
import type { Plan } from "../../types/generated/Plan";
import type { StackSource } from "../../types/generated/StackSource";
import { BoundaryDetail } from "./BoundaryDetail";
import { AmountInput, SelectField, TextField } from "./fields";
import { boundaryOptions, boundaryToChoice, choiceToBoundary } from "./streamBoundary";

const PROPORTIONAL = "Proportional";
const PHASED = "Phased";

const MODE_OPTIONS = [
  // Short: the select is the pane's fixed width, and the hint below says
  // what each one means.
  { value: PROPORTIONAL, label: "By balance" },
  { value: PHASED, label: "In my order" },
];

/** A phase start as a select value: a boundary choice, or `PenaltyFree:<id>`. */
function startToChoice(start: PhaseStart): string {
  return "PenaltyFree" in start
    ? `PenaltyFree:${start.PenaltyFree}`
    : boundaryToChoice(start.Boundary);
}

function choiceToStart(choice: string, prev: PhaseStart): PhaseStart {
  if (choice.startsWith("PenaltyFree:")) {
    return { PenaltyFree: choice.slice("PenaltyFree:".length) };
  }
  const prevBoundary = "Boundary" in prev ? prev.Boundary : "PlanStart";
  return { Boundary: choiceToBoundary(choice, prevBoundary) };
}

/** Where a later phase can start: any start boundary but plan start, which
 * belongs to the first phase, plus each person's 59½. */
function startOptions(plan: Plan) {
  return [
    ...boundaryOptions(plan, "start").filter((o) => o.value !== "PlanStart"),
    ...plan.people.map((p) => ({
      value: `PenaltyFree:${p.id}`,
      label: `${p.name} reaches 59½`,
    })),
  ];
}

const ADD_PROMPT = "__add__";
const KINDS: AccountKind[] = ["Savings", "Taxable", "TraditionalPreTax", "Roth", "Hsa"];

/** What a stack can still add: each account, then each kind, minus what the
 * stack already lists. */
function addOptions(plan: Plan, phase: DrawdownPhase) {
  const sources: StackSource[] = [
    ...plan.accounts.map((a) => ({ Account: a.id })),
    ...KINDS.filter((k) => plan.accounts.some((a) => a.kind === k)).map((k) => ({
      Kind: k,
    })),
  ];
  return [
    { value: ADD_PROMPT, label: "Choose…" },
    ...sources
      .filter((source) => !phase.stack.some((e) => sameSource(e.source, source)))
      .map((source) => ({
        value: JSON.stringify(source),
        label: sourceLabel(plan, source),
      })),
  ];
}

/**
 * Which accounts pay when spending outruns income, and in what order.
 *
 * The default is the one the engine has always used — every account, in
 * proportion to its balance — and a plan saved before this existed keeps
 * it. The alternative is phases: stretches of the plan, each with an ordered
 * list. The two presets cover the common cases so most households never
 * edit a list by hand: the default order, and a bridge to 59½ for anyone
 * retiring before it.
 */
export function DrawdownSection() {
  const plan = usePlanStore((s) => s.plan);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  if (!plan) return null;

  const policy = plan.assumptions.drawdown;
  const phases = policy === "Proportional" ? null : policy.Phased;
  const bridge = bridgePolicy(plan);

  const updatePhase = (index: number, mutate: (phase: DrawdownPhase) => void) =>
    updatePlan((d) => {
      const drawdown = d.assumptions.drawdown;
      if (drawdown !== "Proportional") mutate(drawdown.Phased[index]);
    });

  return (
    <div className="pane-section">
      <div className="pane-head">
        <h3>Withdrawals</h3>
        <p>Which accounts pay when spending outruns income, and in what order.</p>
      </div>

      <fieldset className="input-card">
        <legend>Order</legend>
        <SelectField
          label="Withdraw"
          value={phases ? PHASED : PROPORTIONAL}
          options={MODE_OPTIONS}
          hint={
            phases
              ? "Each phase draws its list top to bottom. Anything a list leaves out is drawn after it: money that carries no early-withdrawal penalty first, then by type — savings, taxable, pre-tax, Roth, HSA."
              : "Every account pays its share of each year's shortfall, in proportion to its balance — including a 401(k) or IRA before 59½, which pays the 10% early-withdrawal penalty."
          }
          onChange={(mode) =>
            updatePlan((d) => {
              d.assumptions.drawdown =
                mode === PROPORTIONAL ? "Proportional" : defaultOrderPolicy();
            })
          }
        />
        {phases && (
          <div className="preset-row">
            <button
              type="button"
              className="add"
              onClick={() =>
                updatePlan((d) => {
                  d.assumptions.drawdown = defaultOrderPolicy();
                })
              }
            >
              Use the default order
            </button>
            <button
              type="button"
              className="add"
              disabled={bridge === null}
              title={
                bridge === null ? "Nobody in this plan retires before 59½." : undefined
              }
              onClick={() =>
                updatePlan((d) => {
                  const next = bridgePolicy(d);
                  if (next) d.assumptions.drawdown = next;
                })
              }
            >
              Bridge to 59½
            </button>
          </div>
        )}
      </fieldset>

      {phases?.map((phase, index) => {
        const from = phaseStartMonth(plan, phase.start);
        return (
          <fieldset className="input-card" key={phase.id}>
            <legend>{phase.name || "Untitled phase"}</legend>
            <TextField
              label="Name"
              value={phase.name}
              onChange={(name) =>
                updatePhase(index, (p) => {
                  p.name = name;
                })
              }
            />
            {index === 0 ? (
              <p className="field-hint">
                From the start of the plan
                {phases.length > 1 ? " until the next phase begins." : "."}
              </p>
            ) : (
              <>
                <SelectField
                  label="Starts"
                  value={startToChoice(phase.start)}
                  options={startOptions(plan)}
                  hint={from ? `That's ${yearMonth(from)}.` : undefined}
                  onChange={(choice) =>
                    updatePhase(index, (p) => {
                      p.start = choiceToStart(choice, p.start);
                    })
                  }
                />
                {"Boundary" in phase.start && (
                  <BoundaryDetail
                    label="Start"
                    boundary={phase.start.Boundary}
                    onChange={(boundary) =>
                      updatePhase(index, (p) => {
                        p.start = { Boundary: boundary };
                      })
                    }
                  />
                )}
              </>
            )}

            <div className="band">
              <p className="band-label">Draw from, in order</p>
              {phase.stack.length === 0 ? (
                <p className="field-hint">
                  Nothing listed — every account is drawn in the default order.
                </p>
              ) : (
                <table className="drawdown-stack">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>From</th>
                      <th>Keep at least (today's $)</th>
                      <th>
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {phase.stack.map((entry, i) => {
                      const label = sourceLabel(plan, entry.source);
                      const penalized = penaltyWarning(plan, entry.source, from);
                      return (
                        <tr key={JSON.stringify(entry.source)}>
                          <td>{i + 1}</td>
                          <td>
                            {label}
                            {penalized && (
                              <small className="penalty-note">
                                10% penalty until {yearMonth(penalized)}
                              </small>
                            )}
                          </td>
                          <td>
                            <AmountInput
                              ariaLabel={`Keep at least in ${label}`}
                              value={entry.floor}
                              onChange={(floor) =>
                                updatePhase(index, (p) => {
                                  p.stack[i].floor = floor;
                                })
                              }
                            />
                          </td>
                          <td className="stack-actions">
                            <button
                              type="button"
                              className="remove"
                              aria-label={`Move ${label} up`}
                              disabled={i === 0}
                              onClick={() =>
                                updatePhase(index, (p) => {
                                  [p.stack[i - 1], p.stack[i]] = [
                                    p.stack[i],
                                    p.stack[i - 1],
                                  ];
                                })
                              }
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="remove"
                              aria-label={`Move ${label} down`}
                              disabled={i === phase.stack.length - 1}
                              onClick={() =>
                                updatePhase(index, (p) => {
                                  [p.stack[i], p.stack[i + 1]] = [
                                    p.stack[i + 1],
                                    p.stack[i],
                                  ];
                                })
                              }
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="remove"
                              aria-label={`Remove ${label}`}
                              onClick={() =>
                                updatePhase(index, (p) => {
                                  p.stack.splice(i, 1);
                                })
                              }
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <SelectField
                label="Add to the list"
                value={ADD_PROMPT}
                options={addOptions(plan, phase)}
                onChange={(value) => {
                  if (value === ADD_PROMPT) return;
                  const source = JSON.parse(value) as StackSource;
                  updatePhase(index, (p) => {
                    p.stack.push({ source, floor: 0 });
                  });
                }}
              />
              <p className="field-hint">
                A balance to keep is held back until everything else is spent, then used
                rather than letting the plan run out with money in the bank. An entry for
                a whole type — "All Roth accounts" — draws every account of that type
                together, in proportion to balance.
              </p>
            </div>

            {index > 0 && (
              <button
                type="button"
                className="remove"
                onClick={() =>
                  updatePlan((d) => {
                    const drawdown = d.assumptions.drawdown;
                    if (drawdown !== "Proportional") drawdown.Phased.splice(index, 1);
                  })
                }
              >
                Remove phase
              </button>
            )}
          </fieldset>
        );
      })}

      {phases && (
        <button
          type="button"
          className="add"
          onClick={() =>
            updatePlan((d) => {
              const drawdown = d.assumptions.drawdown;
              if (drawdown === "Proportional") return;
              const first = d.people[0];
              drawdown.Phased.push({
                id: newPhaseId(),
                name: "New phase",
                start: first ? { PenaltyFree: first.id } : { Boundary: "PlanEnd" },
                stack: [],
              });
            })
          }
        >
          Add phase
        </button>
      )}
    </div>
  );
}
