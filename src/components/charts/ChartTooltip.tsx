import { currency } from "../../lib/format";

// One tooltip, every series at the hovered X. Values lead (strong ink),
// series names follow; each row keyed by a short stroke of its series color.
// React inserts names as text nodes, so untrusted labels stay inert.

interface TooltipRow {
  name?: string | number;
  value?: number | string | Array<number | string>;
  color?: string;
}

export function ChartTooltip(props: {
  active?: boolean;
  label?: string | number;
  payload?: readonly TooltipRow[];
}) {
  if (!props.active || !props.payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{props.label}</div>
      {props.payload.map((row) => (
        <div className="chart-tooltip-row" key={String(row.name)}>
          <span className="line-key" style={{ background: row.color }} />
          <strong>{currency(Number(row.value ?? 0))}</strong>
          <span className="series-name">{row.name}</span>
        </div>
      ))}
    </div>
  );
}
