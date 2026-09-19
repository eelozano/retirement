import { useEffect, useRef, useState } from "react";
import { type Destination, NAV_GROUPS } from "./Rail";

// Cmd/Ctrl-K: jump to any screen by name.
//
// The escape hatch for depth the rail should never grow to hold. It lists
// whatever the rail lists — NAV_GROUPS is the one source — plus the two
// actions that sit under it, so the two cannot disagree about what exists.
//
// Native <dialog> + showModal(), as in Modal.tsx, for Escape, the focus trap
// and focus restore. Not Modal itself: that adds a heading and a Close button
// a search box has no use for.
//
// The shortcut is registered here rather than in Dashboard. This component is
// only mounted inside the app shell, so the shortcut does not exist on the
// welcome or loading screens, where there is nothing to jump to.

interface Command {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

export function CommandPalette(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (to: Destination) => void;
  onOpenReport: () => void;
  onOpenStorage: () => void;
}) {
  const { open, onOpenChange } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const commands: Command[] = [
    ...NAV_GROUPS.flatMap((group) =>
      group.items.map((item) => ({
        id: item.id,
        label: item.label,
        hint: group.heading,
        run: () => props.onNavigate(item.id),
      })),
    ),
    { id: "report", label: "Report", hint: "Action", run: props.onOpenReport },
    { id: "settings", label: "Settings", hint: "Action", run: props.onOpenStorage },
  ];
  const needle = query.trim().toLowerCase();
  const results = commands.filter((c) => c.label.toLowerCase().includes(needle));
  const current = results[active];

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.repeat && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // showModal() on an already-open dialog throws, hence the guards.
    if (open && !dialog.open) {
      setQuery("");
      setActive(0);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const choose = (command: Command) => {
    onOpenChange(false);
    command.run();
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((active + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((active - 1 + results.length) % results.length);
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      choose(current);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: showModal() handles Escape natively; a key handler on the backdrop would be dead code
    <dialog
      ref={ref}
      className="palette"
      aria-label="Jump to"
      // Fires for Escape too, so React state follows the platform closing it.
      onClose={() => onOpenChange(false)}
      // A click on the dialog element itself came from ::backdrop.
      onClick={(e) => {
        if (e.target === ref.current) onOpenChange(false);
      }}
    >
      <input
        className="palette-input"
        type="text"
        role="combobox"
        aria-label="Jump to a screen"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-autocomplete="list"
        aria-activedescendant={current ? `palette-option-${current.id}` : undefined}
        placeholder="Jump to a screen…"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={onInputKeyDown}
      />
      <div className="palette-list" id="palette-list" role="listbox" aria-label="Screens">
        {results.map((command, i) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled on the combobox input, which keeps focus
          <div
            key={command.id}
            id={`palette-option-${command.id}`}
            role="option"
            aria-selected={i === active}
            // Focus stays on the input (aria-activedescendant); -1 only says
            // the option is focusable in principle, without joining the tab order.
            tabIndex={-1}
            className="palette-option"
            onMouseMove={() => setActive(i)}
            onClick={() => choose(command)}
          >
            <span>{command.label}</span>
            <span className="palette-hint">{command.hint}</span>
          </div>
        ))}
      </div>
      {results.length === 0 && (
        <p className="palette-empty" role="status">
          Nothing matches “{query}”.
        </p>
      )}
    </dialog>
  );
}
