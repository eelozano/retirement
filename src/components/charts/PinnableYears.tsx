import { type ReactNode, useRef } from "react";

// The year-pin interaction shared by every chart whose x-axis is the
// projection's years: hovering reads a year, clicking pins it, and the arrow
// keys step the pin — the keyboard equivalent of clicking the chart.
//
// The hovered year is derived from pointer position, not from Recharts. In
// Recharts 3 the chart's own `onMouseMove` never fires, `onClick` arrives
// with `activeIndex: null` and `activeLabel` undefined, and the tooltip's
// `label` lags a click by a render. Reading the pointer against the plotting
// area is deterministic and needs none of that — at the cost that the
// wrapper has to be told where the plotting area sits: `plotLeft` and
// `plotRight` must agree with the chart's own margins and y-axis width.

export function PinnableYears(props: {
  years: number[];
  pinnedYear: number;
  /** Chart left margin plus y-axis width: where the plotting area starts. */
  plotLeft: number;
  /** Chart right margin: where the plotting area ends. */
  plotRight: number;
  ariaLabel: string;
  className?: string;
  onHoverYear?: (year: number | null) => void;
  onPinYear: (year: number) => void;
  children: ReactNode;
}) {
  const first = props.years[0];
  const last = props.years[props.years.length - 1];

  const box = useRef<HTMLDivElement>(null);
  /** Year under the pointer, or null when it is outside the plotting area. */
  const yearAtPointer = (clientX: number): number | null => {
    const el = box.current;
    if (!el || last === first) return null;
    const rect = el.getBoundingClientRect();
    const plotWidth = rect.width - props.plotLeft - props.plotRight;
    if (plotWidth <= 0) return null;
    const t = (clientX - rect.left - props.plotLeft) / plotWidth;
    if (t < 0 || t > 1) return null;
    return Math.round(first + t * (last - first));
  };

  const movePin = (delta: number) => {
    const next = Math.min(last, Math.max(first, props.pinnedYear + delta));
    props.onPinYear(next);
  };

  return (
    // Focusable so the pinned year is reachable without a mouse.
    <div
      className={props.className}
      role="slider"
      tabIndex={0}
      aria-label={props.ariaLabel}
      aria-valuemin={first}
      aria-valuemax={last}
      aria-valuenow={props.pinnedYear}
      aria-valuetext={String(props.pinnedYear)}
      ref={box}
      onMouseMove={(e) => props.onHoverYear?.(yearAtPointer(e.clientX))}
      onMouseLeave={() => props.onHoverYear?.(null)}
      onClick={(e) => {
        const year = yearAtPointer(e.clientX);
        if (year !== null) props.onPinYear(year);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          movePin(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          movePin(1);
        } else if (e.key === "Home") {
          e.preventDefault();
          props.onPinYear(first);
        } else if (e.key === "End") {
          e.preventDefault();
          props.onPinYear(last);
        }
      }}
    >
      {props.children}
    </div>
  );
}
