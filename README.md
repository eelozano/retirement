# Retirement Planner

A local, privacy-first retirement projection app (inspired by ProjectionLab and
Boldin). Deterministic year-by-year cash flow and asset growth projections,
Monte Carlo probability-of-success, bracket-level tax modeling, and side-by-side
scenario comparison — all computed by a pure-Rust engine on your own machine.

**All financial data stays on your machine.** Plans are YAML files in a folder
you choose. No cloud, no accounts, no telemetry, no network calls.


## What it looks like

![The Plan screen: a probability-of-success tile reading 80.6%, a fund-depletion
tile, and a stacked area chart of net worth and account balances through
2072, with a year inspector pinned to 2042.](docs/screenshots/plan.png)

Every screenshot here is the committed demo household — `fixtures/demo/`, an
invented family of four scenarios. None of it is anyone's real money.

<details>
<summary><b>More screens</b></summary>

**Monte Carlo.** The same projection across 1,000 randomized return paths,
as a percentile fan with the range for the pinned year broken out.

![The net worth chart showing 10th-90th and 25th-75th percentile bands around
a median line.](docs/screenshots/monte-carlo.png)

**Scenarios.** Branch a plan, then overlay them and read the differences off a
summary table — net worth at plan end, delta against the base, depletion year,
lifetime taxes.

![Four scenarios overlaid on one chart, with a table comparing net worth at
plan end and lifetime taxes.](docs/screenshots/scenarios.png)

**Cash flow.** Where the money actually went in a given year, as a Sankey —
salaries in on the left, spending, taxes and contributions out on the right.

![A Sankey diagram flowing two salaries and account withdrawals into a
household node, then out to spending, taxes and
contributions.](docs/screenshots/cash-flow-sankey.png)

**Inputs.** A two-pane editor rather than a wizard. Every edit re-projects and
autosaves.

![The Inputs screen with People, Accounts and Spending in a left rail, editing
a person's birth date, retirement date and salary.](docs/screenshots/inputs.png)

</details>

---

## Get it running

**There is no prebuilt download.** The releases page has no `.dmg` attached —
it's a changelog, not a distribution. Getting the app means building it from
source, which is about four commands once the toolchain is in place.

**Built and tested on macOS (Apple Silicon).** See
[Other platforms](#other-platforms) before you start if you're on Linux or
Windows — you can run it, but not package it as configured.

### 1. Install the toolchain

You need four things. Check what you already have:

```bash
rustc --version && node --version && pnpm --version && xcode-select -p
```

Any of those that error, install:

- **Xcode Command Line Tools** — provides the linker Rust needs. Without it
  the build fails partway through with linker errors, not with a clear
  "install this" message.

  ```bash
  xcode-select --install
  ```

- **Rust** (stable; the channel is pinned in `rust-toolchain.toml`, and rustup
  picks it up automatically):

  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```

- **Node 22** (pinned in `.nvmrc`). With [nvm](https://github.com/nvm-sh/nvm):

  ```bash
  nvm install && nvm use
  ```

- **pnpm 11** (the exact version is pinned in `package.json` under
  `packageManager`). The least fussy route is Corepack, which reads that pin
  and fetches the matching version:

  ```bash
  corepack enable
  ```

### 2. Build and install the app

```bash
git clone https://github.com/eelozano/retirement.git
cd retirement
pnpm install
pnpm app:build
```

`pnpm app:build` builds the frontend and then compiles the Rust engine in
release mode. **The first build compiles the entire dependency tree — several
minutes is normal, and quiet.** It is not hung. Later builds are much faster.

This produces a `.dmg` under `target/release/bundle/dmg/`. Note that the Cargo
workspace target directory lives at the **repo root**, not under `src-tauri/`,
which is the usual place people go looking for it.

Open the `.dmg` and drag **Retirement Planner** to Applications. That's it —
launch it from Applications like any other app.

### 3. First launch

The app bootstraps a seed plan on first run, so you land on a populated
projection rather than an empty form. Change the numbers to yours; every edit
re-projects and autosaves. Nothing is sent anywhere.

Your plans live outside the app bundle, so rebuilding and replacing the app
later never touches your data.

### A note on signing

The build is unsigned — there's no Apple Developer account behind this. It's
ad-hoc signed by the linker, with no Developer ID and no notarization.

An app **you build yourself** is not quarantined, so it opens normally; you do
not need to do anything about Gatekeeper. The quarantine flag is attached by
the thing that *downloads* a file, so it only becomes an issue if a built
`.dmg` travels between machines — AirDropped, downloaded, copied from another
Mac. In that case macOS refuses to open it, and you clear the flag once:

```bash
xattr -dr com.apple.quarantine "/Applications/Retirement Planner.app"
```

If you built locally and run that anyway, it reports that there's no such
attribute. That's the expected result, not a problem.

## Troubleshooting

**`pnpm: command not found`** — run `corepack enable`, then re-open your
shell. If Corepack itself is missing, your Node install is older than the
pinned 22.

**`cargo: command not found` after installing Rust** — rustup adds itself to
your shell profile, but not to the session you installed it from. Open a new
terminal, or `source "$HOME/.cargo/env"`.

**Linker errors, or `error: linking with cc failed`** — Xcode Command Line
Tools are missing or incomplete: `xcode-select --install`.

**The build sits there for minutes with no output** — that's the cold Rust
build. Let it finish.

**`pnpm app:build` succeeds but there's no `.dmg`** — check
`target/release/bundle/dmg/` at the repo root, not `src-tauri/target/`. On
Linux or Windows, see below.

**"Retirement Planner is damaged and can't be opened"** — a quarantined
`.dmg` that came from another machine. See [A note on signing](#a-note-on-signing).

**Node version errors during `pnpm install`** — the project pins Node 22 in
`.nvmrc`. Run `nvm use` in the repo.

## Other platforms

The simulation engine and frontend are portable, and `pnpm tauri dev` runs the
app anywhere Tauri does, once you have the
[Tauri platform prerequisites](https://tauri.app/start/prerequisites/) (on
Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`).

Packaging is the part that's macOS-shaped: `bundle.targets` in
`src-tauri/tauri.conf.json` is set to `["app", "dmg"]`, both macOS-only bundle
types, so `pnpm app:build` won't produce a Linux or Windows installer as
configured. Producing one means adding your platform's target (`deb`,
`appimage`, `rpm`, `msi`, `nsis`) to that list. That path is untested here.

CI builds and tests on Linux, so the engine and frontend are known to work
there — it just doesn't bundle an installer.

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
- **Required minimum distributions.** Forced pre-tax withdrawals once an owner
  reaches the applicable age.
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
  overlay net worth across up to five of them with a summary table (net worth
  at plan end, delta vs. the active scenario, depletion year, lifetime taxes).
- **Charts and tables.** A Plan screen with headline tiles and a year-by-year
  inspector, a Cash flow screen with a per-year composition Sankey, stacked
  account balances and net worth, retirement and fund-depletion markers, a
  nominal/today's-dollars toggle, and a table view of every plotted value.
- **Export.** CSV of the projection, and a paginated printable PDF report.
- **Validation before simulation.** Plans are checked before they're simulated
  or saved, with plain-language error messages.

The statutory figures (contribution limits, brackets, thresholds) are compiled
in, not fetched — the app makes no network calls. They carry the tax year they
were published for, surfaced in the UI, so a projection never implies the
numbers are live. They go stale between releases.

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

Same prerequisites as [Get it running](#get-it-running), plus the
[Tauri platform prerequisites](https://tauri.app/start/prerequisites/) if
you're not on macOS.

```bash
pnpm install
pnpm tauri dev        # run the app against a dev server
pnpm check            # every gate CI runs — run this before pushing
```

`pnpm check` chains the CI gates in the same order CI runs them: fmt, clippy,
cargo test, type regeneration + drift check, Biome lint, tsc, vitest. Green
here means green in CI.

### Running against demo data

The app opens your real plans by default. To run it against the committed demo
household instead — for a screenshot, a bug report, or just to poke at it
without touching your own finances — point `RETIREMENT_DATA_DIR` at a
throwaway copy. It relocates settings *and* plans, so nothing reaches the real
directory:

```bash
mkdir -p /tmp/retirement-demo/plans && cp fixtures/demo/*.yaml /tmp/retirement-demo/plans/
RETIREMENT_DATA_DIR=/tmp/retirement-demo pnpm tauri dev
```

The fixtures under `fixtures/demo/` are generated from
`src-tauri/tests/demo_fixtures.rs`, which also asserts they still parse,
validate, and simulate — so a schema change fails CI rather than quietly
rotting them. Regenerate after an intentional change:

```bash
UPDATE_FIXTURES=1 cargo test -p retirement --test demo_fixtures
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

Types in `src/types/generated/` are generated from the Rust structs and
committed; CI fails on drift. Never hand-edit them.

See `docs/ARCHITECTURE.md` for the design blueprint and `CLAUDE.md` for project
conventions (branch strategy, architecture invariants).

## License

MIT — see [LICENSE](LICENSE).
