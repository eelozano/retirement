# Retirement Planner

A local, privacy-first retirement projection app (inspired by ProjectionLab and
Boldin). Deterministic year-by-year cash flow and asset growth projections,
Monte Carlo probability-of-success, bracket-level tax modeling, and side-by-side
scenario comparison — all computed by a pure-Rust engine on your own machine.

**All financial data stays on your machine.** Plans are YAML files in a folder
you choose. No cloud, no accounts, no telemetry, no network calls.


## What it looks like

![The Plan screen: a probability-of-success tile reading 82% of 5,000 paths, a
fund-depletion tile reading Never, a notice that the balances are as of Jan
2026, and a stacked area chart of net worth and account balances through 2072,
with a year inspector pinned to 2042.](docs/screenshots/plan.png)

Every screenshot here is the committed demo household — `fixtures/demo/`, an
invented household and the scenarios branched from it. None of it is anyone's
real money. The notice across the top is real too: the demo's balances were
read in January, and the app says how old they are rather than projecting
from them as if they were today's.

<details>
<summary><b>More screens</b></summary>

**Monte Carlo.** The same projection across thousands of randomized return
paths, as a percentile fan, with the range for the pinned year broken out in
the inspector. Re-roll draws a fresh set of paths.

![The net worth chart showing 10th-90th and 25th-75th percentile bands around
a median line, with the pinned year's P10 to P90 net worth range in the
inspector.](docs/screenshots/monte-carlo.png)

**Why paths fail.** Below the chart, the paths that ran dry are read for what
they have in common — when they failed, what returns they drew in the first
years of retirement, and how hard they were withdrawing — next to the plan's
milestones.

![A "Why paths fail" card with a histogram of failure years, the median
returns of failed and surviving paths, and the median withdrawal rate against
the conventional 3-4% range, above tiles for net worth at each retirement, at
the first death, and at plan end.](docs/screenshots/why-paths-fail.png)

**Scenarios.** Branch a plan, then overlay them and read the differences off a
summary table — net worth at plan end, delta against the base, depletion year,
lifetime taxes and any early-withdrawal penalties, and a Monte Carlo run of
every scenario on the same paths for probability of success, its delta, and
the 10th percentile at the end.

![Five scenarios overlaid on one chart, above a table comparing each one's
deterministic projection and its Monte Carlo probability of
success.](docs/screenshots/scenarios.png)

**What-if.** A sandbox for questions you don't want to save yet: retire
earlier, spend less, assume worse returns or higher inflation, and read the
hypothetical against the plan it started from. Nothing is written until you
save it as a scenario of its own.

![The What-if screen with sliders for retirement dates, spending, returns,
volatility, inflation and life expectancy, comparing the Base plan to a
hypothetical where Alex retires two years earlier and spending is cut to 92%:
$769.6K less at plan end, and an 83% probability of success against the plan's
82%.](docs/screenshots/what-if.png)

**Cash flow.** Money in above the line and money out below it, year by year,
then where it actually went in the year you pick, as a Sankey — salaries and
withdrawals in on the left, spending, taxes and contributions out on the
right. An early-withdrawal penalty is its own outflow wherever tax is shown,
never folded into it.

![A chart of income, withdrawals, contributions, expenses and taxes stacked
above and below a zero line from 2026 to 2072, under tiles for the year
withdrawals overtake income, the largest withdrawal, and lifetime
taxes.](docs/screenshots/cash-flow.png)

![A Sankey diagram flowing two salaries and account withdrawals into a
household node, then out to spending, taxes and
contributions.](docs/screenshots/cash-flow-sankey.png)

**Growth.** How much of the plan is money you put in and how much is the
market's, per year and as a running total — and the year compounding overtakes
your own contributions.

![The Growth screen: tiles for the year market growth overtakes what you put
in, growth at plan end and growth per dollar, above a per-year bar chart and a
running-total line chart of contributions against market
growth.](docs/screenshots/growth.png)

**Inputs.** A two-pane editor rather than a wizard. Every edit re-projects and
autosaves.

![The Inputs screen with People, Accounts, Spending and Withdrawals in a left
rail, editing a person's birth month, retirement month — with the age it falls
at — life expectancy and salary.](docs/screenshots/inputs.png)

**Withdrawals.** Which accounts pay when spending outruns income, and in what
order. The default spreads each year's shortfall across every account in
proportion to its balance; the alternative is phases — stretches of the plan,
each with a list drawn top to bottom, and a balance you can keep back. A
phase can start when someone reaches 59½, which is the age the 10%
early-withdrawal penalty stops applying, so an early retirement can bridge on
taxable money and a 401(k) freed by the Rule of 55 while the rest waits. Rows
warn when the account they name would still be penalized, and one button
builds the bridge.

![The Withdrawals pane: a "Bridge to 59½" phase drawing the joint brokerage,
then Alex's 401(k), then emergency savings down to a $30,000 floor, with a
second phase starting when Jordan reaches
59½.](docs/screenshots/withdrawals.png)

**Pensions.** A pension is entered the way the statement quotes it: the
monthly check at its first payment, whether it has a cost-of-living
adjustment, and whether it is paid over one life or two — and if two, what
share continues to the survivor. It sits beside the same person's Social
Security. Its start, like any income's or expense's, can be a month, a
retirement or an age, and an end can also be a death.

![Jordan's Social Security benefit, its full retirement age taken from a 1981
birth rather than typed, above a pension card: $1,500 a month from Jordan's
retirement, no cost-of-living adjustment, paid over both lives with a 50%
survivor share.](docs/screenshots/pension.png)

**Assumptions.** One expected return and one volatility per investment
strategy — the level you would actually reason at, rather than a table of
asset classes. Each figure says what it means: the real return after the
plan's inflation, and what a Monte Carlo path compounds at once years vary.

![The Assumptions pane's investment strategies: Aggressive, Moderate and
Conservative, each with an expected return and a volatility, the accounts
using it, and a line giving the real return and the rate Monte Carlo paths
compound at.](docs/screenshots/assumptions.png)

**Accounts.** The balance sheet as a table, with the account under the cursor
open for editing beneath it. Each balance carries the month it was read, and
each account's growth is a strategy's return or a fixed rate of its own.
Saving is dated: the demo household's brokerage runs two overlapping
schedules, its 401(k) escalates from 10% to 15% of salary, and one Roth IRA
has a zero balance because it doesn't open until 2029.

![The Accounts table listing seven accounts with an allocation column reading
"Aggressive (7.5%)", "Moderate (6.7%)" and "Fixed 2.0%", a contributing column
reading "2 schedules", "10% → 15% of salary" and "Max", and an as-of column,
above the editor for the joint brokerage.](docs/screenshots/accounts.png)

**One-time contributions.** Money from outside the plan — a house sale, an
inheritance — named, dated, and landing in one account once. The demo's "Sell
the house at retirement" scenario puts $350,000 in today's dollars into the
brokerage the month Alex retires. Recurring contributions can carry a name
too.

![The joint brokerage's contribution cards: a recurring one named "Car paid
off", and a one-time contribution named "House sale" of $350,000 in today's
dollars landing when Alex retires.](docs/screenshots/one-time-contribution.png)

**Update balances.** Every balance off today's statements in one sitting,
dated to the month you did it, which moves the projection's start there for
every scenario of the household at once.

![The Update balances screen: a month picker, then a table of seven accounts
showing each one's last reading and date beside a field for the new balance
and cost basis.](docs/screenshots/update-balances.png)

**Tax figures.** The federal brackets, standard deduction (with the extra
amount for filers 65 and older) and contribution limits for one tax year, in
a file you can edit here or by hand when the IRS publishes the next year's.
Every plan is projected with them, indexed forward from their own tax year.

![The Tax figures editor from Settings: a tax year of 2026, a filing-status
switch, the standard deduction, and the ordinary-income brackets from 10% to
37% above the long-term capital-gains brackets.](docs/screenshots/tax-figures.png)

</details>

---

## Get it running

Two ways in: download the `.dmg` attached to the latest release, or build it
from source. **Building is the path that's actually been exercised** — it's
how the app is developed and run every day, it works on any Mac, and it's
about four commands once the toolchain is in place. The download is shorter,
but it is Apple Silicon only and the install steps for it are written from how
macOS is documented to behave rather than from a run-through on a clean
machine.

**Built and tested on macOS (Apple Silicon).** See
[Other platforms](#other-platforms) before you start if you're on Linux or
Windows — you can run it, but not package it as configured.

### Option A — download the release

> **This path hasn't been tested.** The app has never actually been installed
> from a downloaded `.dmg` on a Mac that didn't build it, so treat the steps
> below as expected-to-work rather than verified. If anything doesn't match
> what you see, [build from source](#option-b--build-from-source) — that's the
> route that's known to work.

Take the `.dmg` from the [latest
release](https://github.com/eelozano/retirement/releases/latest), open it, and
drag **Retirement Planner** to Applications.

The attached build is `aarch64` — **Apple Silicon only.** On an Intel Mac,
build from source instead.

The build is unsigned, so macOS quarantines it on download and then refuses to
open it, reporting that the app "is damaged and can't be opened." It isn't
damaged. Clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine "/Applications/Retirement Planner.app"
```

It opens normally from then on. [A note on signing](#a-note-on-signing)
explains what's going on there.

### Option B — build from source

#### 1. Install the toolchain

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

#### 2. Build and install the app

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

### First launch

The app starts empty. You are asked for your household — names, birth dates,
target retirement dates — and it creates a plan holding just that; accounts,
income and spending are yours to add under Inputs. Every edit re-projects and
autosaves. Nothing is sent anywhere.

If you would rather see a finished plan before building your own, the welcome
screen also offers an invented example household. It stays labelled **Example**
for as long as it exists, and you can delete it whenever you like — including
when it is the only plan you have.

Your plans live outside the app bundle, so rebuilding and replacing the app
later never touches your data.

### A note on signing

The build is unsigned — there's no Apple Developer account behind this. It's
ad-hoc signed by the linker, with no Developer ID and no notarization. That
goes for the `.dmg` on the releases page as much as for one you build
yourself.

The quarantine flag is attached by whatever *downloads* a file, so which case
you're in depends on how the app reached you:

- **Downloaded from the releases page** — or AirDropped, or copied from
  another Mac: quarantined. macOS refuses to open it and calls it damaged.
  Clear the flag once and it opens normally from then on:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Retirement Planner.app"
  ```

- **Built on the machine you run it on**: not quarantined, so it opens
  normally and there's nothing to do about Gatekeeper. Run the command anyway
  and it reports no such attribute — the expected result, not a problem.

The Control-click → Open trick you may remember doesn't apply: current macOS
routes unidentified-developer apps through System Settings → Privacy &
Security → **Open Anyway**, and an ad-hoc-signed app tends to report itself as
damaged rather than offering that button at all. Removing the quarantine
attribute is the route that works.

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
`.dmg`, downloaded from the releases page or carried from another machine. It
isn't damaged. See [A note on signing](#a-note-on-signing).

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
  a flat amount (per month or per year), or "the federal maximum," resolved
  each year against an inflation-indexed limit table with age-50 and SECURE
  2.0 catch-up tiers. Limits are enforced *per person* across all their
  accounts, not per account, and clamps surface as readable warnings.
- **Contributions are dated, and they escalate.** An account carries a list of
  entries, each with its own start and end — "$500 a month now, $1,200 from
  January", an account you don't open until 2029, an IRA funded past
  retirement. A percent-of-salary entry can auto-escalate the way a plan
  document writes it (up a point a year to a cap), and a flat amount can be
  set to keep pace with inflation instead of quietly decaying. Any entry can
  carry a name.
- **One-time contributions from outside the plan.** A house sale or an
  inheritance, named and dated — a specific month, or someone's retirement —
  landing in a brokerage or savings account, in today's dollars or as a fixed
  figure. Unlike a contribution it isn't paid out of that year's income, so the
  plan doesn't sell investments to fund it, and it isn't taxed: enter what
  actually arrives.
- **Employer contributions.** A percent of salary the employer adds whether or
  not you contribute — safe-harbor non-elective or profit-sharing — plus tiered
  match formulas ("100% of the first 3%, 50% of the next 2%") matched against
  your household deferral rate. Either alone or both together, landing in a
  pre-tax or Roth account and held to the annual-additions cap rather than your
  own deferral limit.
- **Social Security modeling.** Benefits are first-class (PIA + claiming age)
  rather than a hand-computed dollar figure, so changing the claiming age
  recomputes interactively. Full retirement age is taken from your birth year
  off SSA's published table, months and all — it is 66 years 6 months for a
  1957 birth, not 66 or 67 — and you can override it if your statement says
  otherwise.
- **Pensions.** The monthly benefit at its first payment, an optional
  cost-of-living adjustment, and single-life or joint payment with the share
  that continues to the survivor.
- **Dates that follow the plan.** Any income, expense or contribution can
  start or end at a specific month, at someone's retirement, or at an age
  ("Alex turns 65"), and can end at a death, so moving a retirement date or
  a life expectancy moves everything tied to it. Each retirement date shows
  the age it falls at.
- **Federal and state tax brackets.** Bracket-level modeling with filing
  status, the standard deduction, long-term capital-gains brackets, and
  Social Security taxability thresholds. Federal figures index with the
  plan's inflation rate from the tax year they were published for, so a
  flat real income doesn't creep into higher brackets.
- **Tax figures you can update.** The federal brackets, standard deduction
  and contribution limits live in one file, editable under **Settings → Tax
  figures** or by hand, so a new tax year doesn't have to wait for a new
  release.
- **Growth at the level you think about it.** Three investment strategies,
  each one expected return and one volatility you can edit, or a fixed rate
  on any single account. The pane says what each return means — nominal, the
  real return after inflation, and what a year-by-year path actually
  compounds at.
- **Leftover cash, handled on purpose.** You choose when surplus income
  starts being invested — never, from the start, or from a later point such
  as a retirement — and which account it goes into.
- **Required minimum distributions.** Forced pre-tax withdrawals once an owner
  reaches the applicable age.
- **Which accounts pay, and when.** By default a year's shortfall is spread
  across every account in proportion to its balance. The alternative is
  phases: stretches of the plan, each with accounts listed in the order they
  are drawn, and a balance you can hold back from each. A phase can begin when
  someone reaches 59½ — the age the 10% early-withdrawal penalty stops
  applying — so an early retirement can bridge on taxable money and a 401(k)
  freed by the Rule of 55 while the rest waits. The penalty is modelled where
  it is owed, shown as its own outflow rather than folded into tax, and rows
  warn when the account they name would still be penalized.
- **Per-person life expectancy.** Each person carries their own, so the
  projection runs to the last survivor and streams that end at a death end at
  *that person's*.
- **What changes after the first death.** The household drops to the larger
  Social Security benefit, filing status switches to Single the year after,
  shared spending steps down by a factor you choose, and a pension can carry a
  survivor percentage.
- **Monte Carlo simulation.** Runs the projection across many randomized return
  paths in parallel and charts the percentile fan plus probability of success,
  with its margin of error. The path count is a setting, a large run can be
  cancelled, and Re-roll draws fresh paths. A "Why paths fail" card reads the
  paths that ran dry for when they failed, the returns they drew early in
  retirement, and how hard they were withdrawing.
- **What-if sandbox.** Sliders for retirement dates, spending, returns,
  volatility, inflation and life expectancy, projected and Monte Carlo'd
  against the saved plan on the same paths, so the difference is the change
  and not the draw. Nothing touches the plan on disk until you save the
  hypothetical as a scenario of its own.
- **Update balances in one sitting.** A screen that takes every
  balance off today's statements at once, dates them to the month you did it,
  and moves the projection's start there — so the plan is about today rather
  than about whenever you last looked. Balances you don't re-read keep their
  own older date rather than being estimated forward, and every figure stated
  in start dollars (a salary, a spending figure, a flat or one-time contribution) is
  listed with what it would take to hold its purchasing power, to keep, grow
  or retype. One refresh moves every scenario of the household, because they
  all project from the same balances.
- **Multi-scenario comparison.** Duplicate a plan to branch a scenario, then
  overlay net worth across up to five of them with a summary table (net worth
  at plan end, delta vs. the active scenario, depletion year, lifetime taxes),
  plus a Monte Carlo run of each on the same paths for probability of success,
  its delta, and the 10th percentile at plan end.
- **Charts and tables.** A Plan screen with headline tiles and a year-by-year
  inspector, a Cash flow screen with a per-year composition Sankey, a Growth
  screen splitting the plan into what you put in and what the market added,
  stacked account balances and net worth, retirement and fund-depletion
  markers, a nominal/today's-dollars toggle, and a table view of every plotted
  value. The Plan screen, the comparison and the report each say how old the
  balances behind them are.
- **Getting around.** A labelled sidebar that collapses to icons, and a
  Cmd/Ctrl-K palette that jumps to any screen by name.
- **Export.** CSV of the projection, and a paginated printable PDF report.
- **Validation before simulation.** Plans are checked before they're simulated
  or saved, with plain-language error messages.

The yearly tax figures — federal brackets, the standard deduction, and every
contribution limit — are never fetched; the app makes no network calls. The
first time it runs it writes its built-in set to `tax-figures.yaml`, and from
then on that file is what every plan uses: editable under **Settings → Tax
figures** or by hand, and indexed forward from its own tax year. **A new
release never overwrites it**, so your numbers don't move when you upgrade;
they are as current as you keep them. To take a newer release's built-in
figures, use **Reset to built-in** in the editor and save, or delete the file.
If the file can't be read, the built-in figures stand in and Settings says
why. The figures that aren't published yearly — the Social Security
taxability thresholds, the RMD ages and table, the HSA age-55 catch-up — are
compiled in.

## What it doesn't model

A projection is only as honest as its gaps, so here are the ones that are
known. Each is tracked as an
[open issue](https://github.com/eelozano/retirement/issues); none is a
rounding detail, and any of them can matter more than the return assumption
you spent an afternoon on.

- **Payroll tax (FICA).** Social Security and Medicare withholding is not
  taken out of a salary at all, so working years show more take-home money
  than they will have. It does not touch retirement years.
- **ACA premium subsidies.** Health insurance before Medicare is whatever you
  enter as an expense. The subsidy is a cliff-free but steep function of MAGI,
  which means the withdrawal order you choose silently moves your premiums —
  and the app will not show it.
- **Dividends and distributions in a taxable account.** Growth there is
  treated as entirely deferred until you sell, so a taxable brokerage compounds
  a little faster here than a real one paying out dividends each year, and the
  tax on those dividends never appears.
- **Spousal Social Security while both are alive.** Each person's benefit is
  their own. A spouse entitled to up to half the higher earner's benefit
  instead of their own record will be understated. The *survivor* transition
  after a death is modelled.
- **HSA family coverage.** The contribution limit is always the self-only
  one, so a family-coverage HSA is capped well below what you could actually
  put in.
- **The 2026 Roth catch-up mandate.** High earners must make catch-up
  contributions as Roth; the app still treats them as pre-tax, which overstates
  the deduction in those years.
- **Illiquid assets.** A house is not in net worth. You can model selling one
  as a one-time contribution, but until that year it isn't there — so compare
  such scenarios on probability of success and depletion year rather than on
  net worth.

Smaller deliberate omissions — the Roth five-year clock, the additional
standard deduction for blindness, the OBBBA senior deduction and its
2025–2028 window — are stated with their reasoning in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Where your data lives

Your data is one YAML file per **household**, in
`~/Documents/Retirement Planner/plans/` by default. A household file holds the
facts — who you are, your accounts, and each balance with the month it is as
of — plus every scenario you have branched from them. A scenario carries only
what varies: retirement dates, contributions, spending, claiming ages.

That means a balance is written down once, however many scenarios you keep.
Correct it in one and it is corrected in all of them, because there was never
more than one copy — which is also what makes comparing two scenarios honest,
since they cannot differ on anything but the decisions you were comparing.

Beside `plans/`, not in it, sits `tax-figures.yaml`: the yearly tax figures
every household is projected with (see [Features](#features)). There is one,
because tax law doesn't vary by household.

You can move that folder anywhere from **Settings → Plan storage** inside the
app; the chosen location is recorded in a small settings file in the OS config
dir, and existing files are copied forward when you change it. The tax
figures come along too, unless the new folder already has a file of its own,
which is left alone.

If you used a version before this one, your existing plans are converted to
households on first launch. Nothing is deleted: the old files move to
`plans/.v1/` untouched, and if two of your scenarios disagreed about a fact,
the app writes a `plans/migration-<date>.txt` listing what it kept and what it
dropped.

The files are plain YAML, deliberately readable and hand-editable outside the
app. They are stored outside the repository on purpose — never commit them.
`.gitignore` covers both the default location and the optional `data/` folder
next to the repo.

### Backups

Saves are atomic (write a temp file, then rename), and the previous version of
each household file is kept alongside it as `.yaml.bak`. Because every edit
autosaves, that slot is overwritten within seconds — it's crash protection,
not a backup. Deleting a scenario leaves the household where it is; deleting
its last one moves the file into `plans/.trash/` rather than unlinking it.

Each balance carries the month it was read, so a household refreshed in
December and left alone until March says so on screen rather than projecting
March from December's numbers. **Update balances** does the whole sitting at
once and moves the projection's start with it; before it rewrites anything it
keeps a copy of the household as it stood in
`plans/.refreshes/<household id>/<the month it is leaving>.yaml`. Those are
never pruned — a few kilobytes each, one per refresh — because they are the
record of what the plan said the last time you looked.

For an actual backup, the app keeps its own history: the first time you edit
a household in a session, it snapshots the pre-edit version into
`plans/.history/<household id>/`, capped at the last 20 snapshots per
household. **Settings → Snapshot history** lists them by date and can
restore one.
A snapshot is of the whole household — the balances *and* every scenario — so
restoring brings all of them back as they were; restoring snapshots the
current state first, so it is itself undoable.

Snapshots cover households, not the tax figures: saving `tax-figures.yaml`
from the editor keeps just the version before it, as `tax-figures.yaml.bak`.

None of that leaves this machine, though. Use **Export all plans…** in
**Settings** to write a timestamped copy of the whole plans directory — tax
figures included — to a folder you choose, such as an external drive or a
synced folder, whenever you want an off-machine copy. The app never does this
on its own.

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
pnpm demo             # run the app against the invented demo household
pnpm tauri dev        # run the app against your real plans
pnpm check            # every gate CI runs — run this before pushing
```

`pnpm check` chains the CI gates in the same order CI runs them: fmt, clippy,
cargo test, type regeneration + drift check, Biome lint, tsc, the production
Vite build, vitest. Green here means green in CI.

### Running against demo data

`pnpm tauri dev` opens your real plans. To run against the committed demo
household instead — for a screenshot, a bug report, or just to poke at it
without touching your own finances — point `RETIREMENT_DATA_DIR` at a
throwaway copy. It relocates settings, plans *and* the tax figures, so nothing
reaches the real directory:

```bash
pnpm demo
```

That seeds `/tmp/retirement-demo` from the fixtures and runs against it. Seeding
is conditional, so a restart keeps whatever you changed; `pnpm demo:reset` puts
the committed scenarios back, and `pnpm demo:seed` seeds without running. Add,
edit and delete plans in there as freely as you like — it's a throwaway copy,
and reset is one command.

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

See `docs/ARCHITECTURE.md` for how it is built and why, and `CLAUDE.md` for
project conventions (branch strategy, architecture invariants).

## License

MIT — see [LICENSE](LICENSE).
