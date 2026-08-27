# Retirement Planner

A local, privacy-first retirement projection app (inspired by ProjectionLab and
Boldin). Deterministic year-by-year cash flow and asset growth projections,
with the architecture ready for Monte Carlo simulation, tax bracket modeling,
and swappable drawdown strategies.

**All financial data stays on your machine.** Plans are JSON files in your OS
app-data directory (or the git-ignored `data/` folder). No cloud, no telemetry.

## Stack

- **Frontend:** React 19 + TypeScript + Vite, Recharts dashboard
- **Backend:** Tauri v2 with a pure-Rust simulation engine (`crates/engine`)
- **Types:** TypeScript interfaces generated from Rust structs via ts-rs

## Development

Prerequisites: Rust (stable), Node 22+, pnpm, and the
[Tauri platform prerequisites](https://tauri.app/start/prerequisites/)
(on Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`).

```sh
pnpm install
pnpm tauri dev        # run the app
cargo test -p engine  # engine tests
pnpm types:generate   # regenerate src/types/generated from Rust structs
pnpm typecheck        # tsc --noEmit
```

See `docs/ARCHITECTURE.md` for the design blueprint and `CLAUDE.md` for
project conventions (branch strategy, architecture invariants, roadmap).
