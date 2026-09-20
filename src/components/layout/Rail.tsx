// Left rail — the app's primary navigation.
//
// Replaces the previous flat row of six identically-styled header buttons,
// where navigation, settings, and a display option were all peers. Kind now
// decides placement: destinations live here, settings sit at the bottom, and
// display options stayed in the header as a segmented control.
//
// Labelled by default, collapsible to icons. Icons identify nothing on their
// own — there is no shared picture for "Update balances" — so the label is
// the identifier and the icon is only its echo. Collapsing is the same
// component with the labels dropped, never a second one, and the choice is
// remembered per user (lib/railPreference.ts).

export type Destination =
  | "plan"
  | "cashflow"
  | "growth"
  | "inputs"
  | "refresh"
  | "whatif"
  | "scenarios";

interface RailProps {
  active: Destination;
  onNavigate: (to: Destination) => void;
  onOpenStorage: () => void;
  onOpenReport: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
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
  // Every account ticked off in one sitting. The tick is the point: the
  // screen is not a document, it is the confirmation that each figure has
  // been read again this month. Deliberately not a clock or a calendar —
  // the month is what the screen asks for, not what it is for — and
  // deliberately not another folded sheet, which is Report's silhouette.
  refresh: (
    <>
      <path d="M9.2 4.5H7.5A1.5 1.5 0 006 6v13.5A1.5 1.5 0 007.5 21h9a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5h-1.7" />
      <rect x="9" y="2.6" width="6" height="3.4" rx="1.2" />
      <path d="M9.2 12.3l1.7 1.7 3.9-3.9" />
      <path d="M9.2 17.3h5.6" />
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

/** The rail's destinations, in two named groups. Group before you add: a new
 * destination joins one of these or justifies a third, it never lands at the
 * bottom of an undifferentiated list. Also the source for the command palette,
 * so the two cannot list different screens. */
export const NAV_GROUPS: {
  id: string;
  heading: string;
  items: { id: Destination; label: string; icon: keyof typeof ICON }[];
}[] = [
  {
    id: "plan",
    heading: "Plan",
    items: [
      { id: "plan", label: "Plan", icon: "plan" },
      { id: "cashflow", label: "Cash flow", icon: "cashflow" },
      { id: "growth", label: "Growth", icon: "growth" },
      { id: "whatif", label: "What-if", icon: "whatif" },
      { id: "scenarios", label: "Scenarios", icon: "scenarios" },
    ],
  },
  {
    id: "setup",
    heading: "Setup",
    items: [
      { id: "inputs", label: "Inputs", icon: "inputs" },
      { id: "refresh", label: "Update balances", icon: "refresh" },
    ],
  },
];

function RailIcon(props: {
  children: React.ReactNode;
  size: number;
  className?: string;
}) {
  return (
    <svg
      className={props.className}
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

function RailItem(props: {
  label: string;
  icon: React.ReactNode;
  collapsed: boolean;
  current?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rail-item ${props.current ? "rail-current" : ""}`}
      // With the label gone the icon is the only thing left, so the name has
      // to be stated. Expanded, the visible label is the name and a tooltip
      // repeating it would only get in the way.
      aria-label={props.collapsed ? props.label : undefined}
      title={props.collapsed ? props.label : undefined}
      aria-current={props.current ? "page" : undefined}
      onClick={props.onClick}
    >
      <RailIcon size={props.collapsed ? 19 : 17}>{props.icon}</RailIcon>
      {!props.collapsed && <span className="rail-label">{props.label}</span>}
    </button>
  );
}

export function Rail(props: RailProps) {
  const { collapsed } = props;
  return (
    <nav className={`rail ${collapsed ? "rail-collapsed" : ""}`} aria-label="Screens">
      <div className="rail-brand">
        <div className="rail-mark" aria-hidden="true">
          R
        </div>
        {!collapsed && <span className="rail-brand-name">Retirement Planner</span>}
      </div>

      {NAV_GROUPS.map((group) => (
        <fieldset key={group.id} aria-label={group.heading} className="rail-group">
          {!collapsed && (
            <legend className="rail-group-heading" aria-hidden="true">
              {group.heading}
            </legend>
          )}
          {group.items.map((item) => (
            <RailItem
              key={item.id}
              label={item.label}
              icon={ICON[item.icon]}
              collapsed={collapsed}
              current={props.active === item.id}
              onClick={() => props.onNavigate(item.id)}
            />
          ))}
        </fieldset>
      ))}

      <div className="rail-spacer" />

      <RailItem
        label="Report"
        icon={ICON.report}
        collapsed={collapsed}
        onClick={props.onOpenReport}
      />
      <RailItem
        label="Settings"
        icon={ICON.storage}
        collapsed={collapsed}
        onClick={props.onOpenStorage}
      />
      <button
        type="button"
        className="rail-collapse"
        aria-label={collapsed ? "Expand sidebar" : undefined}
        title={collapsed ? "Expand sidebar" : undefined}
        onClick={props.onToggleCollapsed}
      >
        <RailIcon size={15} className="rail-collapse-icon">
          <path d="M14 6l-6 6 6 6" />
          <path d="M20 4v16" />
        </RailIcon>
        {!collapsed && <span className="rail-label">Collapse</span>}
      </button>
    </nav>
  );
}
