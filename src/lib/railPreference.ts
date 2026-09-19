import { useCallback, useState } from "react";

// Whether the left rail is collapsed to icons. A per-user display preference,
// so it lives in the webview's own localStorage rather than in a plan or in
// settings.json: read synchronously, it is right on first paint (settings.json
// arrives over IPC, after the rail has already rendered at the wrong width),
// and it holds no financial data. Storage can throw — a blocked or cleared
// webview store — and the rail must still work, so every access is guarded and
// the default is expanded.

export const RAIL_COLLAPSED_KEY = "rail-collapsed";

export function readRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Not persisted; the preference still holds for this session.
  }
}

export function useRailCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readRailCollapsed);
  const toggle = useCallback(() => {
    writeRailCollapsed(!collapsed);
    setCollapsed(!collapsed);
  }, [collapsed]);
  return [collapsed, toggle];
}
