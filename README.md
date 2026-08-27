# Retirement Planner

A local, privacy-first retirement projection app (inspired by ProjectionLab and
Boldin). Deterministic year-by-year cash flow and asset growth projections,
with the architecture ready for Monte Carlo simulation, tax bracket modeling,
and swappable drawdown strategies.

**All financial data stays on your machine.** Plans are JSON files in your OS
app-data directory (or the git-ignored `data/` folder). No cloud, no telemetry.

## Features (V1)

- Edit people (staggered retirement dates supported), accounts (taxable,
  pre-tax, Roth) with Boglehead allocation presets, income/expense streams,
  and market/tax assumptions — every input drives a live re-projection.
- Stacked account-balance and net-worth charts, with retirement and
  fund-depletion markers, a nominal/today's-dollars toggle, and a table view
  of every plotted value.
- Plans are validated before they're simulated or saved, with plain-language
  error messages.

## Stack

- **Frontend:** React 19 + TypeScript + Vite, Zustand, Recharts dashboard
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
