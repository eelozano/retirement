// Left icon rail — the app's primary navigation.
//
// Replaces the previous flat row of six identically-styled header buttons,
// where navigation, settings, and a display option were all peers. Kind now
// decides placement: destinations live here, settings sit at the bottom, and
// display options stayed in the header as a segmented control.

export type Destination = "plan" | "inputs";

interface RailProps {
  active: Destination;
  onNavigate: (to: Destination) => void;
  onOpenScenarios: () => void;
  onOpenStorage: () => void;
}

const ICON = {
  plan: <path d="M3 20h18M4 16l5-6 4 3 6-8" />,
  inputs: (
    <>
      <path d="M5 7h14M5 12h14M5 17h14" />
      <circle cx="9" cy="7" r="2" fill="var(--surface-1)" />
      <circle cx="15" cy="12" r="2" fill="var(--surface-1)" />
      <circle cx="8" cy="17" r="2" fill="var(--surface-1)" />
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
        label="Inputs"
        icon={ICON.inputs}
        current={props.active === "inputs"}
        onClick={() => props.onNavigate("inputs")}
      />
      <RailButton
        label="Scenarios"
        icon={ICON.scenarios}
        onClick={props.onOpenScenarios}
      />
      <div className="rail-spacer" />
      <RailButton label="Storage" icon={ICON.storage} onClick={props.onOpenStorage} />
    </nav>
  );
}
