import { useState } from "react";
import { exportTextFile } from "../../lib/api";
import { buildProjectionCsv, projectionCsvFilename } from "../../lib/csvExport";
import { usePlanStore } from "../../store/planStore";
import { Modal } from "./Modal";

// Entry point for both of #68's deliverables — a CSV escape hatch for
// spreadsheet work, and the full printable report — behind one rail button
// rather than two, since they share the same "get the projection out of the
// app" intent and the CSV is one click either way.

export function ReportMenu(props: {
  open: boolean;
  onClose: () => void;
  onOpenReport: () => void;
}) {
  const plan = usePlanStore((s) => s.plan);
  const projection = usePlanStore((s) => s.projection);
  const realDollars = usePlanStore((s) => s.realDollars);

  const [exporting, setExporting] = useState(false);
  const [exportedTo, setExportedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleExportCsv = async () => {
    if (!plan || !projection) return;
    setExporting(true);
    setError(null);
    setExportedTo(null);
    try {
      const csv = buildProjectionCsv(plan, projection, realDollars);
      const name = projectionCsvFilename(plan, realDollars);
      const dest = await exportTextFile(name, csv);
      if (dest) setExportedTo(dest);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal open={props.open} onClose={props.onClose} title="Report & export">
      {error && (
        <p role="alert" className="banner critical">
          {error}
        </p>
      )}
      <p className="storage-badge">
        Get this projection's numbers out of the app — as a spreadsheet, or as a printable
        document with the assumptions and charts behind them.
      </p>
      <div className="storage-actions">
        <button
          type="button"
          onClick={handleExportCsv}
          disabled={exporting || !plan || !projection}
        >
          {exporting ? "Exporting…" : "Export CSV…"}
        </button>
        <button
          type="button"
          onClick={props.onOpenReport}
          disabled={!plan || !projection}
        >
          Open printable report
        </button>
      </div>
      {exportedTo && <p className="storage-badge">Exported to {exportedTo}</p>}
    </Modal>
  );
}
