import { useEffect } from "react";
// Self-hosted via @fontsource — the design specifies IBM Plex, and this app
// makes no network calls, so a Google Fonts <link> is not an option. Only the
// weights the design actually uses; latin subset only.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import { Dashboard } from "./components/layout/Dashboard";
import { usePlanStore } from "./store/planStore";
import "./App.css";

function App() {
  const init = usePlanStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  return <Dashboard />;
}

export default App;
