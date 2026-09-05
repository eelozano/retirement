// Left icon rail — the app's primary navigation.
//
// Replaces the previous flat row of six identically-styled header buttons,
// where navigation, settings, and a display option were all peers. Kind now
// decides placement: destinations live here, settings sit at the bottom, and
// display options stayed in the header as a segmented control.

export type Destination =
  | "plan"
  | "cashflow"
  | "growth"
  | "inputs"
  | "whatif"
  | "scenarios";

interface RailProps {
  active: Destination;
  onNavigate: (to: Destination) => void;
  onOpenStorage: () => void;
  onOpenReport: () => void;
}

const ICON = {
  plan: <path d="M3 20h18M4 16l5-6 4 3 6-8" />,
  cashflow: (
    <>
      <path d="M7 20V8m0 0L4 11m3-3l3 3" />
      <path d="M17 4v12m0 0l3-3m-3 3l-3-3" />
    </>
  ),
  growth: (
    <>
      <path d="M4 17l5-5 4 3 7-8" />
      <path d="M15 6h5v5" />
    </>
  ),
  inputs: (
    <>
      <path d="M5 7h14M5 12h14M5 17h14" />
      <circle cx="9" cy="7" r="2" fill="var(--surface-1)" />
      <circle cx="15" cy="12" r="2" fill="var(--surface-1)" />
      <circle cx="8" cy="17" r="2" fill="var(--surface-1)" />
    </>
  ),
  // Two futures out of one point — the sandbox's whole proposition, and the
  // one glyph here that is about a fork rather than a document.
  whatif: (
    <>
      <path d="M3 12h6" />
      <path d="M9 12c5 0 5-7 12-7" />
      <path d="M9 12c5 0 5 7 12 7" />
    </>
  ),
  scenarios: (
    <>
      <path d="M12 3l8 4-8 4-8-4 8-4z" />
      <path d="M4 12l8 4 8-4" />
      <path d="M4 17l8 4 8-4" />
    </>
  ),
  storage: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>
  ),
  report: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 12h6M9 16h6" />
    </>
  ),
};

function RailIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function RailButton(props: {
  label: string;
  icon: React.ReactNode;
  current?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rail-button ${props.current ? "rail-current" : ""}`}
      // The label is the only accessible name — these are icon-only buttons.
      aria-label={props.label}
      title={props.label}
      aria-current={props.current ? "page" : undefined}
      onClick={props.onClick}
    >
      <RailIcon>{props.icon}</RailIcon>
    </button>
  );
}

export function Rail(props: RailProps) {
  return (
    <nav className="rail" aria-label="Screens">
      <div className="rail-mark" aria-hidden="true">
        R
      </div>
      <RailButton
        label="Plan"
        icon={ICON.plan}
        current={props.active === "plan"}
        onClick={() => props.onNavigate("plan")}
      />
      <RailButton
        label="Cash flow"
        icon={ICON.cashflow}
        current={props.active === "cashflow"}
        onClick={() => props.onNavigate("cashflow")}
      />
      <RailButton
        label="Growth"
        icon={ICON.growth}
        current={props.active === "growth"}
        onClick={() => props.onNavigate("growth")}
      />
      <RailButton
        label="Inputs"
        icon={ICON.inputs}
        current={props.active === "inputs"}
        onClick={() => props.onNavigate("inputs")}
      />
      <RailButton
        label="What-if"
        icon={ICON.whatif}
        current={props.active === "whatif"}
        onClick={() => props.onNavigate("whatif")}
      />
      <RailButton
        label="Scenarios"
        icon={ICON.scenarios}
        current={props.active === "scenarios"}
        onClick={() => props.onNavigate("scenarios")}
      />
      <div className="rail-spacer" />
      <RailButton label="Report" icon={ICON.report} onClick={props.onOpenReport} />
      <RailButton label="Settings" icon={ICON.storage} onClick={props.onOpenStorage} />
    </nav>
  );
}
