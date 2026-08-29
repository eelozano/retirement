import { useState } from "react";
import { runMonteCarlo } from "../../lib/api";
import { currencyCompact } from "../../lib/format";
import { usePlanStore } from "../../store/planStore";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import { MonteCarloChart } from "../charts/MonteCarloChart";
import { fanRows, successTone } from "../charts/monteCarloData";

// Run on demand, not on every plan edit: hundreds of paths is orders of
// magnitude more work than the deterministic projection that re-runs on the
// input debounce.

const PATH_CHOICES = [100, 500, 1000, 5000];
const DEFAULT_SEED = 1;

export function MonteCarloView() {
  const plan = usePlanStore((s) => s.plan);
  const realDollars = usePlanStore((s) => s.realDollars);

  const [nPaths, setNPaths] = useState(500);
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!plan) return null;

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await runMonteCarlo(plan, { n_paths: nPaths, seed: DEFAULT_SEED }));
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const rows = result ? fanRows(result, realDollars) : [];
  const last = rows[rows.length - 1];

  return (
    <section className="card monte-carlo-view">
      <h2>Monte Carlo</h2>
      <p className="compare-hint">
        Re-runs {plan.name} across many random market sequences, using the same expected
        returns with historical volatility applied. Success means the portfolio never runs
        out before plan end.
      </p>

      <div className="mc-controls">
        <label>
          Paths
          <select
            value={nPaths}
            onChange={(e) => setNPaths(Number(e.currentTarget.value))}
            disabled={running}
          >
            {PATH_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={run} disabled={running}>
          {running ? "Running…" : result ? "Re-run" : "Run simulation"}
        </button>
      </div>

      {error && (
        <p role="alert" className="banner critical">
          {error}
        </p>
      )}

      {!result ? (
        <p className="empty-state">
          {running ? "Simulating…" : "Run the simulation to see a range of outcomes."}
        </p>
      ) : (
        <>
          <div className="stat-row">
            <div className={`stat-tile stat-${successTone(result.success_rate)}`}>
              <span className="stat-label">Probability of success</span>
              <span className="stat-value">
                {(result.success_rate * 100).toFixed(0)}%
              </span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">Median at plan end</span>
              <span className="stat-value">{last ? currencyCompact(last.p50) : "—"}</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">Range at plan end (10th–90th)</span>
              <span className="stat-value">
                {last
                  ? `${currencyCompact(last.p10)} – ${currencyCompact(last.p90)}`
                  : "—"}
              </span>
            </div>
          </div>
          <MonteCarloChart rows={rows} plan={plan} />
        </>
      )}
    </section>
  );
}
