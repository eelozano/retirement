import { useEffect, useRef } from "react";

// Native <dialog> + showModal(), not a hand-rolled div backdrop.
//
// The previous implementation was a `.modal-backdrop` div with an onClick.
// It had a reachable Close button, but Escape did nothing, focus was never
// moved into the dialog or restored on close, and Tab walked straight out
// into the page behind it — which stayed fully interactive. showModal() gives
// all four behaviors, plus role="dialog"/aria-modal and the ::backdrop
// pseudo-element, from the platform.

export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** "lg" for content that outgrows the small settings-panel width — a
   * report full of charts and a year table, not a form. */
  size?: "sm" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // showModal() on an already-open dialog throws, hence the guards.
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: showModal() handles Escape natively; a key handler on the backdrop would be dead code
    <dialog
      ref={ref}
      className={`modal ${props.size === "lg" ? "modal-lg" : ""}`}
      aria-label={props.title}
      // Fires for Escape too, so React state stays in sync with the platform
      // closing the dialog out from under it.
      onClose={props.onClose}
      // A click landing on the dialog element itself came from ::backdrop —
      // clicks on the content hit a child and stop here.
      onClick={(e) => {
        if (e.target === ref.current) props.onClose();
      }}
    >
      <div className="modal-body">
        <h2>{props.title}</h2>
        {props.children}
        <button type="button" className="modal-close" onClick={props.onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
