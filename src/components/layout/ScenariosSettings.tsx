import { useEffect, useState } from "react";
import { usePlanStore } from "../../store/planStore";

interface ScenariosSettingsProps {
  open: boolean;
  onClose: () => void;
}

export function ScenariosSettings({ open, onClose }: ScenariosSettingsProps) {
  const scenarios = usePlanStore((s) => s.scenarios);
  const plan = usePlanStore((s) => s.plan);
  const switchScenario = usePlanStore((s) => s.switchScenario);
  const duplicateActive = usePlanStore((s) => s.duplicateActive);
  const deleteScenario = usePlanStore((s) => s.deleteScenario);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && plan) setNewName(`${plan.name} copy`);
  }, [open, plan]);

  if (!open || !plan) return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Scenarios</h2>
        <ul className="scenario-list">
          {scenarios.map((s) => (
            <li key={s.id} className={s.id === plan.id ? "scenario-active" : ""}>
              <span className="scenario-name">{s.name}</span>
              {s.id === plan.id ? (
                <span className="scenario-badge">Current</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => switchScenario(s.id))}
                >
                  Switch
                </button>
              )}
              <button
                type="button"
                disabled={busy || scenarios.length <= 1}
                onClick={() => run(() => deleteScenario(s.id))}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
        <div className="scenario-new">
          <input
            type="text"
            aria-label="New scenario name"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
          />
          <button
            type="button"
            disabled={busy || newName.trim() === ""}
            onClick={() => run(() => duplicateActive(newName.trim()))}
          >
            Duplicate current as new scenario
          </button>
        </div>
        <button type="button" className="modal-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
