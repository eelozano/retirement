# Retirement Planner

A local, privacy-first retirement projection app (inspired by ProjectionLab and
Boldin). Deterministic year-by-year cash flow and asset growth projections,
Monte Carlo probability-of-success, bracket-level tax modeling, and side-by-side
scenario comparison — all computed by a pure-Rust engine on your own machine.

**All financial data stays on your machine.** Plans are YAML files in a folder
you choose. No cloud, no accounts, no telemetry, no network calls.

## Features

- **Plan inputs that drive a live re-projection.** People (staggered retirement
  dates supported), accounts (taxable, pre-tax, Roth) with Boglehead allocation
  presets, income/expense streams, and market/tax assumptions. Every edit
  re-projects and autosaves.
- **Social Security modeling.** Benefits are first-class (PIA + claiming age)
  rather than a hand-computed dollar figure, so changing the claiming age
  recomputes interactively.
- **Federal and state tax brackets.** Bracket-level modeling with filing status,
  alongside the simpler flat-rate model.
- **Monte Carlo simulation.** Runs the projection across many randomized return
  paths in parallel and charts the percentile fan plus probability of success.
- **Multi-scenario comparison.** Duplicate a plan to branch a scenario, then
  overlay net worth across up to five of them with a summary table (net worth at
  plan end, delta vs. the active scenario, depletion year, lifetime taxes).
- **Charts and tables.** Stacked account balances and net worth, retirement and
  fund-depletion markers, a nominal/today's-dollars toggle, and a table view of
  every plotted value.
- **Validation before simulation.** Plans are checked before they're simulated or
  saved, with plain-language error messages.

## Install it for real

For actual use, build and install the app rather than running a dev server:

```bash
pnpm app:build
```

This produces a `.dmg` under `src-tauri/target/release/bundle/dmg/`. Open it and
drag **Retirement Planner** to Applications.

The build is unsigned — there's no Apple Developer account behind this — so
macOS will refuse to open it the first time. Clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine "/Applications/Retirement Planner.app"
```

Your plans live outside the app bundle, so rebuilding and replacing the app
never touches your data.

## Where your data lives

Plans are one YAML file per plan, in `~/Documents/Retirement Planner/plans/` by
default. You can move that folder anywhere from **Storage** inside the app; the
chosen location is recorded in a small settings file in the OS config dir, and
existing plans are copied forward when you change it.

The files are plain YAML, deliberately readable and hand-editable outside the
app. They are stored outside the repository on purpose — never commit them.
`.gitignore` covers both the default location and the optional `data/` folder
next to the repo.

### Backups

Saves are atomic (write a temp file, then rename), and the previous version of
each plan is kept alongside it as `.yaml.bak`. Deleting a plan moves the file
aside as `.yaml.deleted` rather than unlinking it.

**That is crash protection, not a backup.** Because every edit autosaves, the
`.bak` slot is overwritten within seconds — there's no way to recover a plan as
it stood yesterday, and nothing is copied off this machine. Snapshot history,
in-app restore, and export are tracked in
[#19](https://github.com/eelozano/retirement/issues/19) and not built yet.

Until then: the plans directory is an ordinary folder of small text files, so
copying it *is* the backup, and Time Machine already versions it.

## Stack

- **Frontend:** React 19 + TypeScript + Vite, Zustand, Recharts
- **Backend:** Tauri v2 with a pure-Rust simulation engine (`crates/engine`)
- **Types:** TypeScript interfaces generated from Rust structs via ts-rs

## Development

Prerequisites: Rust stable (pinned in `rust-toolchain.toml`), Node 22 (pinned in
`.nvmrc`), pnpm 11, and the
[Tauri platform prerequisites](https://tauri.app/start/prerequisites/)
(on Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`).

```bash
pnpm install
pnpm tauri dev        # run the app against a dev server
pnpm check            # every gate CI runs — run this before pushing
```

Individual pieces, when you want to run just one:

```bash
cargo test -p engine  # engine tests
pnpm types:generate   # regenerate src/types/generated from the Rust structs
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check
pnpm format           # biome check --write
pnpm test             # vitest
```

See `docs/ARCHITECTURE.md` for the design blueprint and `CLAUDE.md` for project
conventions (branch strategy, architecture invariants, roadmap).

## License

MIT — see [LICENSE](LICENSE).
