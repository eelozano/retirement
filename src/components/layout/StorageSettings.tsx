import { useEffect, useState } from "react";
import {
  chooseStorageDir,
  exportPlans,
  getStorageInfo,
  listSnapshots,
  revealStorageDir,
  type StorageInfo,
  setStorageDir,
} from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
import { Modal } from "./Modal";

interface StorageSettingsProps {
  open: boolean;
  onClose: () => void;
}

/** The offered path counts, and roughly what each costs.
 *
 * Presets rather than a free number: the meaningful axis is "how much
 * precision do you want", not an arbitrary integer, and each step here
 * meaningfully narrows the margin on the success rate.
 *
 * The timings are medians measured in release against the seed plan on an
 * Apple-silicon laptop. They scale slightly worse than linearly, so don't
 * re-derive them from a per-path figure — and they will differ on other
 * machines, hence "approximately" wherever they are shown. The ceiling
 * matches `MAX_MONTE_CARLO_PATHS` in `src-tauri/src/settings.rs`, which
 * clamps regardless of what is sent. */
const PATH_PRESETS: { paths: number; label: string; cost: string }[] = [
  { paths: 1_000, label: "1,000", cost: "~50 ms" },
  { paths: 5_000, label: "5,000", cost: "~330 ms" },
  { paths: 10_000, label: "10,000", cost: "~720 ms" },
  { paths: 25_000, label: "25,000", cost: "~1.7 s" },
  { paths: 50_000, label: "50,000", cost: "~2.4 s" },
  { paths: 100_000, label: "100,000", cost: "~4.8 s" },
];

/** "2026-09-01T14-23-45-123Z" (a filesystem-safe stand-in for a colon-bearing
 * ISO timestamp) into a locale-formatted date, falling back to the raw
 * string if it doesn't match — the display is best-effort, not load-bearing. */
function formatSnapshotTimestamp(timestamp: string): string {
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!match) return timestamp;
  const [, date, h, m, s, ms] = match;
  const parsed = new Date(`${date}T${h}:${m}:${s}.${ms}Z`);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toLocaleString();
}

export function StorageSettings({ open, onClose }: StorageSettingsProps) {
  const plan = usePlanStore((s) => s.plan);
  const restoreSnapshot = usePlanStore((s) => s.restoreSnapshot);
  const monteCarloPaths = usePlanStore((s) => s.monteCarloPaths);
  const monteCarloLimits = usePlanStore((s) => s.monteCarloLimits);
  const setMonteCarloPaths = usePlanStore((s) => s.setMonteCarloPaths);

  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportedTo, setExportedTo] = useState<string | null>(null);

  const [savingPaths, setSavingPaths] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    getStorageInfo()
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, [open]);

  useEffect(() => {
    if (!open || !plan) return;
    listSnapshots(plan.id)
      .then(setSnapshots)
      .catch((e) => setError(String(e)));
  }, [open, plan]);

  const handleChangeLocation = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await chooseStorageDir();
      if (picked) {
        await setStorageDir(picked);
        setInfo(await getStorageInfo());
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleReveal = async () => {
    setError(null);
    try {
      await revealStorageDir();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRestore = async (timestamp: string) => {
    if (!plan) return;
    setRestoring(timestamp);
    setError(null);
    try {
      await restoreSnapshot(timestamp);
      setSnapshots(await listSnapshots(plan.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setRestoring(null);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    setExportedTo(null);
    try {
      const dest = await exportPlans();
      if (dest) setExportedTo(dest);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  };

  const handleChangePaths = async (paths: number) => {
    if (paths === monteCarloPaths) return;
    setSavingPaths(true);
    setError(null);
    try {
      // Through the store, not the API directly: it persists the choice and
      // starts a Monte Carlo run, so the headline behind this modal updates.
      // Resolves once saved; the run itself reports progress on the tile.
      await setMonteCarloPaths(paths);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingPaths(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Settings">
      {error && (
        <p role="alert" className="banner critical">
          {error}
        </p>
      )}
      <h3>Plan storage</h3>
      {info ? (
        <>
          <p className="storage-path">{info.effective_dir}</p>
          <p className="storage-badge">
            {info.is_default ? "Default location" : "Custom location"}
          </p>
          <div className="storage-actions">
            <button type="button" onClick={handleChangeLocation} disabled={busy}>
              Change location…
            </button>
            <button type="button" onClick={handleReveal}>
              Reveal in Finder
            </button>
          </div>
        </>
      ) : (
        <p>Loading…</p>
      )}

      <h3>Simulation</h3>
      <p className="storage-badge">
        How many randomised paths each projection is tested against. More paths narrow the
        margin on the probability of success; they also take longer to run.
      </p>
      {/* A segmented control, like the dollar-basis toggle: these are mutually
          exclusive settings of one value, not four separate actions. */}
      <fieldset className="segmented">
        <legend className="visually-hidden">Monte Carlo paths</legend>
        {PATH_PRESETS.map((preset) => (
          <button
            key={preset.paths}
            type="button"
            aria-pressed={monteCarloPaths === preset.paths}
            disabled={savingPaths || monteCarloPaths === null}
            onClick={() => handleChangePaths(preset.paths)}
          >
            {preset.label}
          </button>
        ))}
      </fieldset>
      <p className="storage-badge">
        {savingPaths
          ? "Saving…"
          : monteCarloPaths === null
            ? "Loading…"
            : `${PATH_PRESETS.find((p) => p.paths === monteCarloPaths)?.cost ?? "—"} per run, approximately.`}
      </p>
      {monteCarloLimits && (
        <p className="storage-badge">
          Up to {monteCarloLimits.auto_run_max_paths.toLocaleString()} paths, the
          simulation re-runs after every edit. Above that it runs on demand: an edit marks
          the last result as stale, and you run it from the Plan screen when ready.
        </p>
      )}

      <h3>Snapshot history</h3>
      {plan && snapshots.length > 0 ? (
        <ul className="scenario-list">
          {snapshots.map((timestamp) => (
            <li key={timestamp}>
              <span className="scenario-name">{formatSnapshotTimestamp(timestamp)}</span>
              <button
                type="button"
                disabled={restoring !== null}
                onClick={() => handleRestore(timestamp)}
              >
                {restoring === timestamp ? "Restoring…" : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="storage-badge">
          No snapshots of "{plan?.name}" yet — one is captured the first time you edit it
          each session.
        </p>
      )}

      <h3>Export</h3>
      <p className="storage-badge">
        Write a timestamped copy of every plan to a folder of your choice — an external
        drive or your own sync folder.
      </p>
      <div className="storage-actions">
        <button type="button" onClick={handleExport} disabled={exporting}>
          {exporting ? "Exporting…" : "Export all plans…"}
        </button>
      </div>
      {exportedTo && <p className="storage-badge">Exported to {exportedTo}</p>}
    </Modal>
  );
}
