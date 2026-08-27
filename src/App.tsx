import { useEffect } from "react";
import { usePlanStore } from "./store/planStore";
import { Dashboard } from "./components/layout/Dashboard";
import "./App.css";

function App() {
  const init = usePlanStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  return <Dashboard />;
}

export default App;
