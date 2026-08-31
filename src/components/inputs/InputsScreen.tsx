import { usePlanStore } from "../../store/planStore";
import { AccountsSection } from "./AccountsSection";
import { AssumptionsSection } from "./AssumptionsSection";
import { PeopleSection } from "./PeopleSection";
import { SpendingSection } from "./SpendingSection";
import { ownedBy } from "./shared";

export type InputsSection = "people" | "accounts" | "spending" | "assumptions";

const DESTINATIONS: { id: InputsSection; label: string }[] = [
  { id: "people", label: "People" },
  { id: "accounts", label: "Accounts" },
  { id: "spending", label: "Spending" },
];

/**
 * Two-pane Inputs screen: a sub-list of destinations, editor pane filling
 * the rest. Replaces the five `<details>` panels that mapped one-to-one onto
 * `Plan`'s fields — a schema browser rather than an interface. Each
 * destination now gets a full pane instead of a slice of a masonry grid,
 * because the three have genuinely different shapes: People is a form,
 * Accounts is a table scanned across rows, Spending is a list that grows.
 */
export function InputsScreen(props: {
  section: InputsSection;
  onSectionChange: (section: InputsSection) => void;
}) {
  const plan = usePlanStore((s) => s.plan);
  if (!plan) return null;

  const counts: Record<InputsSection, number | string> = {
    people: plan.people.length,
    accounts: plan.accounts.length,
    spending: ownedBy(plan.streams, null).length,
    assumptions: "rarely",
  };

  const order: InputsSection[] = [...DESTINATIONS.map((d) => d.id), "assumptions"];

  const move = (from: InputsSection, delta: 1 | -1) => {
    const i = order.indexOf(from);
    const next = order[(i + delta + order.length) % order.length];
    props.onSectionChange(next);
    document.getElementById(`inputs-tab-${next}`)?.focus();
  };

  const onTabKeyDown = (e: React.KeyboardEvent, current: InputsSection) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(current, 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(current, -1);
    } else if (e.key === "Home") {
      e.preventDefault();
      props.onSectionChange(order[0]);
      document.getElementById(`inputs-tab-${order[0]}`)?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      const last = order[order.length - 1];
      props.onSectionChange(last);
      document.getElementById(`inputs-tab-${last}`)?.focus();
    }
  };

  const tab = (id: InputsSection, label: string, quiet = false) => (
    <button
      type="button"
      id={`inputs-tab-${id}`}
      className={`inputs-tab${quiet ? " inputs-tab-quiet" : ""}`}
      role="tab"
      aria-selected={props.section === id}
      aria-controls={`inputs-pane-${id}`}
      tabIndex={props.section === id ? 0 : -1}
      onClick={() => props.onSectionChange(id)}
      onKeyDown={(e) => onTabKeyDown(e, id)}
    >
      {label}
      <span className="inputs-tab-count">{counts[id]}</span>
    </button>
  );

  return (
    <div className="inputs-shell">
      <div
        className="inputs-sublist"
        role="tablist"
        aria-label="Inputs sections"
        aria-orientation="vertical"
      >
        <p className="inputs-sublist-label">Edit the plan</p>
        {DESTINATIONS.map((d) => tab(d.id, d.label))}
        <hr />
        {tab("assumptions", "Assumptions", true)}
      </div>

      <section
        className="inputs-pane"
        id="inputs-pane-people"
        role="tabpanel"
        aria-labelledby="inputs-tab-people"
        hidden={props.section !== "people"}
      >
        <PeopleSection />
      </section>
      <section
        className="inputs-pane"
        id="inputs-pane-accounts"
        role="tabpanel"
        aria-labelledby="inputs-tab-accounts"
        hidden={props.section !== "accounts"}
      >
        <AccountsSection />
      </section>
      <section
        className="inputs-pane"
        id="inputs-pane-spending"
        role="tabpanel"
        aria-labelledby="inputs-tab-spending"
        hidden={props.section !== "spending"}
      >
        <SpendingSection />
      </section>
      <section
        className="inputs-pane"
        id="inputs-pane-assumptions"
        role="tabpanel"
        aria-labelledby="inputs-tab-assumptions"
        hidden={props.section !== "assumptions"}
      >
        <AssumptionsSection />
      </section>
    </div>
  );
}
