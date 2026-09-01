# Retirement Planner

A local, privacy-first retirement projection app (inspired by ProjectionLab and
Boldin). Deterministic year-by-year cash flow and asset growth projections,
Monte Carlo probability-of-success, bracket-level tax modeling, and side-by-side
scenario comparison — all computed by a pure-Rust engine on your own machine.

**All financial data stays on your machine.** Plans are YAML files in a folder
you choose. No cloud, no accounts, no telemetry, no network calls.

## Features

- **A plan you edit as a screen, not a form.** Inputs is a two-pane editor —
  People, Accounts, Spending, plus Assumptions — and every edit re-projects
  and autosaves.
- **Contributions modeled the way you actually set them.** Percent of salary,
  a flat amount, or "the federal maximum," resolved each year against an
  inflation-indexed limit table with age-50 and SECURE 2.0 catch-up tiers.
  Limits are enforced *per person* across all their accounts, not per account,
  and clamps surface as readable warnings.
- **Employer match.** Tiered formulas ("100% of the first 3%, 50% of the next
  2%"), matched against your household deferral rate, landing in a pre-tax or
  Roth account and held to the annual-additions cap rather than your own
  deferral limit.
- **Social Security modeling.** Benefits are first-class (PIA + claiming age)
  rather than a hand-computed dollar figure, so changing the claiming age
  recomputes interactively.
- **Federal and state tax brackets.** Bracket-level modeling with filing
  status, standard deduction, and Social Security taxability thresholds.
- **Per-person life expectancy.** Each person carries their own, so the
  projection runs to the last survivor and streams that end at a death end at
  *that person's*.
- **What changes after the first death.** The household drops to the larger
  Social Security benefit, filing status switches to Single the year after,
  shared spending steps down by a factor you choose, and a pension can carry a
  survivor percentage.
- **Monte Carlo simulation.** Runs the projection across many randomized return
  paths in parallel and charts the percentile fan plus probability of success.
- **Multi-scenario comparison.** Duplicate a plan to branch a scenario, then
  overlay net worth across up to five of them with a summary table (net worth at
  plan end, delta vs. the active scenario, depletion year, lifetime taxes).
- **Charts and tables.** A Plan screen with headline tiles and a year-by-year
  inspector, a Cash flow screen, stacked account balances and net worth,
  retirement and fund-depletion markers, a nominal/today's-dollars toggle, and
  a table view of every plotted value.
- **Validation before simulation.** Plans are checked before they're simulated or
  saved, with plain-language error messages.

## Install it for real

For actual use, build and install the app rather than running a dev server:

```bash
pnpm app:build
```

This produces a `.dmg` under `target/release/bundle/dmg/` (the Cargo workspace
target dir lives at the repo root, not under `src-tauri/`). Open it and drag
**Retirement Planner** to Applications.

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
each plan is kept alongside it as `.yaml.bak`. Because every edit autosaves,
that slot is overwritten within seconds — it's crash protection, not a
backup, and deleting a plan moves it into `plans/.trash/` rather than
unlinking it.

For an actual backup, the app keeps its own history: the first time you edit
a plan in a session, it snapshots the pre-edit version into
`plans/.history/<id>/`, capped at the last 20 snapshots per plan. **Storage**
in the app lists a plan's snapshots by date and can restore one — restoring
snapshots the current state first, so a restore is itself undoable.

None of that leaves this machine, though. Use **Export all plans…** in
**Storage** to write a timestamped copy of the whole plans directory to a
folder you choose — an external drive or a synced folder — whenever you want
an off-machine copy. The app never does this on its own.

The plans directory is still an ordinary folder of small text files
underneath all of this, so copying it by hand works too, and Time Machine
already versions it.

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
