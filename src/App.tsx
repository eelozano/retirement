import { useEffect, useState } from "react";
import type { Plan } from "./types/generated/Plan";
import type { Projection } from "./types/generated/Projection";
import { loadPlan, runProjection } from "./lib/api";
import "./App.css";

// Minimal round-trip shell: load plan → project → show summary numbers.
// Replaced by the full dashboard (input drawer + charts) in M3.

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function App() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadPlan()
      .then((loaded) => {
        setPlan(loaded);
        return runProjection(loaded);
      })
      .then(setProjection)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) {
    return (
      <main className="container">
        <h1>Retirement Planner</h1>
        <p role="alert">Failed to load plan: {error}</p>
      </main>
    );
  }
  if (!plan || !projection) {
    return (
      <main className="container">
        <h1>Retirement Planner</h1>
        <p>Loading…</p>
      </main>
    );
  }

  const last = projection.snapshots[projection.snapshots.length - 1];
  return (
    <main className="container">
      <h1>Retirement Planner</h1>
      <h2>{plan.name}</h2>
      <p>{plan.people.map((p) => p.name).join(" & ")}</p>
      <p>
        Projected net worth in {last.period_start.year} (nominal):{" "}
        <strong>{currency.format(last.net_worth)}</strong>
      </p>
      <p>
        In today's dollars:{" "}
        <strong>{currency.format(last.net_worth / last.deflator)}</strong>
      </p>
      {projection.warnings.length > 0 && (
        <p role="alert">{projection.warnings.length} warning(s) — see console</p>
      )}
    </main>
  );
}

export default App;
