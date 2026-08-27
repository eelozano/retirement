import { currency } from "../../lib/format";
import type { ChartRow, SeriesDef } from "./chartData";

// The WCAG-clean twin of both charts: every plotted value, readable without
// hover or color.

export function DataTable(props: { rows: ChartRow[]; series: SeriesDef[] }) {
  return (
    <details className="data-table">
      <summary>View data as table</summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Year</th>
              {props.series.map((s) => (
                <th key={s.key}>{s.label}</th>
              ))}
              <th>Net worth</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.year}>
                <td>{row.year}</td>
                {props.series.map((s) => (
                  <td key={s.key}>{currency(row[s.key] ?? 0)}</td>
                ))}
                <td>{currency(row.net_worth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
