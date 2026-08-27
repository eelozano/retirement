import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { YearMonth } from "./types/generated/YearMonth";
import "./App.css";

// Placeholder shell proving the generated-types + IPC pipeline.
// Replaced by the dashboard (input drawer + charts) in M3.
const planStart: YearMonth = { year: 2026, month: 1 };

function App() {
  const [engineVersion, setEngineVersion] = useState<string | null>(null);

  useEffect(() => {
    invoke<string>("engine_version")
      .then(setEngineVersion)
      .catch(() => setEngineVersion(null));
  }, []);

  return (
    <main className="container">
      <h1>Retirement Planner</h1>
      <p>
        Engine: {engineVersion ?? "not connected"} · Plan start:{" "}
        {planStart.year}-{String(planStart.month).padStart(2, "0")}
      </p>
    </main>
  );
}

export default App;
