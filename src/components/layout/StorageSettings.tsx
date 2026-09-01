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

  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportedTo, setExportedTo] = useState<string | null>(null);

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

  return (
    <Modal open={open} onClose={onClose} title="Plan storage">
      {error && (
        <p role="alert" className="banner critical">
          {error}
        </p>
      )}
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
