import { useEffect, useState } from "react";
import {
  chooseStorageDir,
  getStorageInfo,
  revealStorageDir,
  type StorageInfo,
  setStorageDir,
} from "../../lib/api";

interface StorageSettingsProps {
  open: boolean;
  onClose: () => void;
}

export function StorageSettings({ open, onClose }: StorageSettingsProps) {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    getStorageInfo()
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, [open]);

  if (!open) return null;

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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Plan storage</h2>
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
        <button type="button" className="modal-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
