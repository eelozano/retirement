# Retirement Projection App — Architecture Blueprint & Roadmap

This is the approved design blueprint for the project. Milestone status is
tracked in `CLAUDE.md`; update both when the design evolves.

## Context

A local, privacy-first retirement projection tool (ProjectionLab/Boldin-inspired). Stack: Tauri (React/TypeScript frontend + Rust backend). Philosophy: **simple V1 MVP, modular for V2** — deterministic annual projections now, but data models and Rust traits designed so Monte Carlo, tax brackets, ordered drawdown, and monthly resolution slot in without refactoring core state.

**Foundational decisions:**
- Engine simulates in **nominal dollars**; UI offers a today's-dollars (real) display toggle.
- Persistence: **YAML files** (one per plan) with `schema_version`, stored in a user-configurable path (default: OS Documents folder, changeable in-app under Storage); a small JSON settings file in the app-config dir records the chosen location. No SQLite, no cloud.
- Income/expenses modeled as **generic dated cash-flow streams** (salary, retirement spending, contributions in V1; pensions fit the same shape, no schema change). Social Security is the exception: a first-class `SocialSecurityBenefit` (PIA + claiming age) resolved into a stream at simulate time, so claiming age stays interactively recomputable instead of a one-time manually-computed dollar entry.
- **Single plan** in V1; file format is scenario-ready (a scenario = another plan file). V2 multi-scenario comparison (#6) builds on this directly: each `Plan` carries a stable `id` (files are keyed by it, not by the editable `name`); the storage/IPC layer supports listing, duplicating, deleting, and switching the active scenario; and a Compare view overlays net worth across up to 5 scenarios plus a summary table (net worth at plan end, delta vs. the active scenario, depletion year, lifetime taxes) — see `run_projections`, `src/components/charts/compareData.ts`, and `ComparisonView`.

---

## 1. Critique & Recommendations (accepted into this design)

1. **Pure engine crate, zero Tauri deps.** The simulation engine lives in `crates/engine` as a plain Rust library; `src-tauri` is a thin adapter (commands + file I/O). This makes the engine unit-testable with `cargo test`, keeps Monte Carlo threading (rayon) isolated from the Tauri runtime, and leaves a future WASM compile path open.
2. **One source of truth for types.** Rust structs derive `serde` + **`ts-rs`** to generate TypeScript interfaces into `src/types/generated/`. Hand-maintaining parallel TS/Rust models is the biggest silent-drift risk in a Tauri app. (`ts-rs` over `tauri-specta`: simpler, stable, no macro coupling to Tauri v2 command signatures; revisit specta if we later want typed `invoke` bindings.)
3. **Month-native time, year-stepped V1.** All dates are a `YearMonth` type (year + month, comparable as month index). The engine iterates over abstract *periods*; V1 config sets period = 1 year. Moving to monthly resolution later is a config change + finer-grained stream proration, not a schema migration. This also makes "born Aug 1983, retires Aug 2038" exact instead of rounded to years.
4. **Engine as a pure function.** `simulate(&Plan, &dyn ReturnModel, &dyn TaxModel, &dyn DrawdownStrategy) -> Projection`. No mutable global state; each run owns its state. Monte Carlo in V2 = run the same function N times with a seeded stochastic `ReturnModel`, parallelized with rayon — embarrassingly parallel by construction.
5. **Strategy traits from day 1, one impl each in V1.** `ReturnModel` (V1: `FixedReturns`), `TaxModel` (V1: `FlatTax`), `DrawdownStrategy` (V1: `Proportional`). V2 adds `MonteCarloReturns`, `HistoricalSequence`, `BracketTax`, `OrderedDrawdown` as new impls behind the same traits.
6. **Track cost basis in taxable accounts from day 1** even though flat tax ignores it — V2 capital-gains modeling needs the ledger history, and retrofitting basis tracking into an engine that's been mutating balances is painful.
7. **Accounts have owners.** Every account references a `PersonId`. Staggered retirements, future RMD ages (73/75), catch-up contribution ages, and survivor modeling all depend on per-person ownership. Costs nothing now, unlocks everything later.
8. **`f64` for money.** This is projection math (compounding, random draws), not accounting; integer cents buy nothing and complicate Monte Carlo. Round at the display layer.
9. **Recharts is fine for V1** (~60 annual data points, stacked areas). If V2 Monte Carlo percentile fans strain it, swap the chart layer only — chart components will consume a stable `Projection` view-model, so the charting lib is not load-bearing.
10. **Zustand for frontend state** (small, no boilerplate). Inputs live in the store; a debounced effect calls the `run_projection` Tauri command; results are kept separate from inputs so stale results are detectable.
11. **Blind spots flagged for the backlog** (not V1, but the schema won't fight them): employer 401(k) match, RMDs, IRMAA/ACA cliffs, catch-up contributions, contribution-limit inflation indexing, capital gains vs ordinary income, rebalancing drift/glide paths, survivor scenarios, filing status.
12. **Data safety:** plans saved to a user-visible, user-configurable location (default: `~/Documents/Retirement Planner`, or `~/RetirementPlanner` if Documents can't be resolved) — outside the repo entirely; `data/` also git-ignored in case the user prefers keeping files next to the repo. Atomic writes (write temp + rename) and a `.bak` of the previous version on save. Legacy pre-#13 plans in the old `app_data_dir` are migrated forward automatically on first launch (copy, never delete).

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────┐
│  React/TS Frontend (src/)                           │
│  InputDrawer ─► Zustand store ─► debounced invoke   │
│  Dashboard charts ◄─ Projection view-model          │
└──────────────────────┬──────────────────────────────┘
                       │ Tauri IPC (serde JSON)
┌──────────────────────┴──────────────────────────────┐
│  src-tauri (thin adapter)                           │
│  commands: run_projection, load_plan, save_plan,    │
│            list_plans, get_presets, storage settings│
│  persistence: YAML files, atomic write, versioned,  │
│               user-configurable location            │
└──────────────────────┬──────────────────────────────┘
                       │ plain Rust call
┌──────────────────────┴──────────────────────────────┐
│  crates/engine (pure library, no Tauri)             │
│  domain model · simulate() · traits:                │
│  ReturnModel │ TaxModel │ DrawdownStrategy          │
└─────────────────────────────────────────────────────┘
```

### Directory layout

```
retirement/
├── Cargo.toml                 # workspace: crates/engine, src-tauri
├── package.json               # pnpm, Vite, React, TS
├── crates/
│   └── engine/
│       ├── src/
│       │   ├── lib.rs
│       │   ├── model/         # Plan, Person, Account, Stream, Assumptions, YearMonth
│       │   ├── sim/           # simulate(), PeriodState, Projection
│       │   ├── strategies/    # returns.rs, tax.rs, drawdown.rs (traits + V1 impls)
│       │   └── presets.rs     # Boglehead allocations, default assumptions
│       └── tests/             # golden-file + property tests
├── src-tauri/
│   ├── src/
│   │   ├── main.rs / lib.rs
│   │   ├── commands.rs        # run_projection, load/save/list_plan, get_presets, storage settings
│   │   ├── storage.rs         # YAML plan I/O (base dir passed in), atomic writes, schema_version
│   │   ├── settings.rs        # app-config-dir settings.json: user-chosen plans dir override
│   │   └── migrate.rs         # copy-forward migration: legacy JSON, and relocation via Settings
│   └── tauri.conf.json
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── layout/            # Dashboard shell, responsive drawer
│   │   ├── inputs/            # PersonForm, AccountForm, StreamForm, AssumptionsForm
│   │   └── charts/            # StackedBalancesChart, NetWorthChart, SummaryStats
│   ├── store/                 # Zustand: planSlice, projectionSlice, uiSlice
│   ├── lib/                   # invoke wrappers, real-dollar deflator, formatters
│   └── types/generated/       # ts-rs output — never hand-edited
└── data/                      # optional local plans dir, git-ignored
```

### Core Rust domain model (`crates/engine/src/model/`)

```rust
// All structs: #[derive(Serialize, Deserialize, TS, Clone, Debug)] — ts-rs exports TS twins.

pub struct YearMonth { pub year: i32, pub month: u8 }   // ordered; month-index arithmetic

pub struct Plan {
    pub id: PlanId,                  // stable identity; files are keyed by this, not `name` (#6)
    pub schema_version: u32,
    pub name: String,
    pub people: Vec<Person>,
    pub accounts: Vec<Account>,
    pub streams: Vec<CashFlowStream>,
    pub assumptions: Assumptions,
    pub sim_config: SimConfig,
}

pub struct Person {
    pub id: PersonId,
    pub name: String,               // "Enrique", "Claire"
    pub birth: YearMonth,           // 1983-08, 1987-06
    pub retirement: YearMonth,      // 2038-08, 2042-08
}

pub enum AccountKind { Taxable, TraditionalPreTax, Roth }

pub struct Account {
    pub id: AccountId,
    pub owner: PersonId,
    pub kind: AccountKind,
    pub name: String,
    pub balance: f64,               // starting balance (nominal, as of plan start)
    pub cost_basis: Option<f64>,    // taxable only; tracked from day 1, used by V2 tax
    pub allocation: AllocationRef,  // preset id or custom weights
    pub annual_contribution: f64,
    pub contribution_limit: Option<f64>,
}

// Generic dated stream — salary, retirement spending, pensions, one-offs.
// Social Security resolves into one of these from a SocialSecurityBenefit
// (PIA + claiming age), rather than being modeled as a stream directly.
pub struct CashFlowStream {
    pub id: StreamId,
    pub name: String,
    pub owner: Option<PersonId>,
    pub direction: Income | Expense,
    pub annual_amount: f64,             // in start-date dollars
    pub start: StreamBoundary,          // Date(YearMonth) | AtRetirement(PersonId) | PlanStart
    pub end: StreamBoundary,            //                  | AtDeath(PersonId) | PlanEnd
    pub growth: GrowthRule,             // Inflation | Fixed(rate) | None
}

pub struct Assumptions {
    pub inflation: f64,
    pub asset_returns: BTreeMap<AssetClass, f64>,  // nominal expected returns
    pub flat_tax_rate: f64,
    pub plan_end_age: u8,                          // e.g. 95, per eldest person
    pub sweep_surplus_to_taxable: bool,             // default false; see sim/mod.rs step 4
}

pub enum AssetClass { UsEquity, IntlEquity, GlobalEquity, UsBonds }
// presets.rs: Aggressive / Moderate / Conservative → VT/VTI/VXUS/BND weights

pub struct SimConfig {
    pub start: YearMonth,
    pub period: PeriodLength,        // Year (V1) | Month (V2) — engine iterates periods
    pub display_real_dollars: bool,  // UI hint; engine always outputs nominal + deflator
}
```

### Strategy traits (`crates/engine/src/strategies/`)

```rust
pub trait ReturnModel {
    // path_id threads Monte Carlo run index / seed; deterministic V1 ignores it.
    fn returns_for(&self, period: PeriodIndex, path_id: u64) -> AssetReturns;
}

pub trait TaxModel {
    fn tax(&self, income: &IncomeBreakdown, period: PeriodIndex) -> TaxResult;
    // IncomeBreakdown separates ordinary / capital-gains / Roth even though
    // FlatTax collapses them — BracketTax (V2) needs the split.
}

pub trait DrawdownStrategy {
    // Iterates: gross withdrawal → tax via TaxModel → check net covers shortfall.
    fn withdraw(&self, net_needed: f64, accounts: &mut [AccountState],
                tax: &dyn TaxModel, period: PeriodIndex) -> WithdrawalResult;
}

// V1 impls: FixedReturns, FlatTax, ProportionalDrawdown.
// V2 impls (new files, zero engine-loop changes): MonteCarloReturns(seeded),
// HistoricalSequence, BracketTax(federal+state tables), OrderedDrawdown(Vec<AccountKind>).
```

### Simulation core (`crates/engine/src/sim/`)

```rust
pub fn simulate(plan: &Plan, returns: &dyn ReturnModel, tax: &dyn TaxModel,
                drawdown: &dyn DrawdownStrategy, path_id: u64) -> Projection;

// Per-period loop: accrue stream income → contributions (respect limits) →
// spend → shortfall drawdown (taxed) → apply growth → snapshot.

pub struct PeriodSnapshot {
    pub period_start: YearMonth,
    pub balances: BTreeMap<AccountId, f64>,   // nominal
    pub income: f64, pub expenses: f64, pub taxes: f64,
    pub withdrawals: BTreeMap<AccountId, f64>,
    pub net_worth: f64,
    pub deflator: f64,                        // cumulative inflation → real-dollar toggle
}

pub struct Projection {
    pub snapshots: Vec<PeriodSnapshot>,
    pub warnings: Vec<SimWarning>,   // e.g. DepletedFunds { period }, ContributionClamped
}
```

Frontend consumes `Projection` directly (generated types); the real-dollar toggle divides by `deflator` client-side — no engine round-trip on toggle.

### Tauri commands (`src-tauri/src/commands.rs`)

- `run_projection(plan: Plan) -> Projection` — stateless; frontend sends full plan (small payload, ~KB). `run_projections(plans: Vec<Plan>) -> Vec<Result<Projection, String>>` does the same for N scenarios in one round-trip, for the comparison view (#6) — one entry per plan, so one invalid scenario doesn't blank the rest.
- `save_plan(plan) / load_plan() / load_plan_named(id) / list_plans() -> Vec<PlanSummary>` — YAML in the resolved plans directory, keyed by each plan's stable `id` (not its editable `name`), atomic write + `.bak`, `schema_version` checked on load. `load_plan` loads the active scenario (see `set_active_plan`, falling back to the first stored plan or a fresh seed) and also runs the one-shot legacy-JSON migration check; plans saved before `id` existed are backfilled once from their pre-#6 filename slug.
- `duplicate_plan(id, new_name) / delete_plan(id) / set_active_plan(id)` — scenario management: branch a new plan off an existing one (deep copy, fresh id), remove a scenario (moved aside as `.deleted`, never unlinked — refused for the last remaining scenario), and record which scenario loads on next launch.
- `get_presets() -> Presets` — allocations + default assumptions so defaults live in one place (Rust).
- `get_storage_info() / choose_storage_dir() / set_storage_dir(path) / reveal_storage_dir()` — the Storage settings surface: report the effective/default plans dir, open a native folder picker, persist a new location (copying existing plans forward), and reveal the folder in Finder/Explorer.

---

## 3. Phased Execution Roadmap

**M0 — Scaffold (first build session).** Tauri v2 app via `create-tauri-app` (React+TS+Vite, pnpm); Cargo workspace with `crates/engine`; ts-rs type-generation wired into build; `.gitignore` for `data/`; `cargo fmt/clippy/test` + `tsc --noEmit` clean. *Done when the empty app opens and generated types import.*

**M1 — Engine core (pure Rust, no UI).** Domain model + presets; `simulate()` with FixedReturns/FlatTax/ProportionalDrawdown; seed scenario (Enrique + Claire, 3 accounts, salary/spending streams) as a fixture. Tests: golden-file projection snapshot, hand-computed 3-period micro-case, property tests (balances ≥ 0, cash conservation per period, depletion emits warning). *Done when `cargo test` proves the math.*

**M2 — IPC + persistence.** Commands, storage layer, load-on-launch/save flows, seed plan bootstrap on first run. *Done when a plan round-trips through the app and a projection returns to the frontend.*

**M3 — Dashboard UI.** Zustand store + debounced re-projection; input drawer (people, accounts w/ preset picker, streams, assumptions); Recharts stacked-area balances by account, net-worth line, summary stats (retirement-date net worth, depletion age if any); nominal/real toggle; responsive layout. *Done when editing any input live-updates the charts.*

**M4 — Polish & V1 close-out.** Input validation + friendly errors, empty/depleted states, number formatting, README (privacy model, how to back up data), first release tag.

**V2 backlog (architected-for, not built):** Monte Carlo (rayon over `path_id`, percentile-fan chart), historical sequence backtesting, federal/state bracket `TaxModel`, `OrderedDrawdown`, monthly periods, RMDs, employer match, multi-scenario compare UI. (Social Security/pension income streams shipped — see `SocialSecurityBenefit`.)

## Branch & Delivery Strategy

- **`main` is always green and releasable.** No direct commits to main once M0 lands.
- **One short-lived branch + one squash-merged PR per milestone (M0–M4).** Claude Code sessions auto-create `claude/*` branches — those serve as the milestone branches. Each PR = one reviewable milestone diff; squash merge keeps main's history linear (one commit per milestone).
- **Within a branch**, commit freely in small logical steps; the squash collapses them on merge.
- **Tag a release on main** when a milestone PR merges, using the `0.x` scheme (`v0.1`, `v0.2`, …). Bump `package.json`, `Cargo.toml`, and `src-tauri/tauri.conf.json` together with the tag. V2 features continue the same pattern (`feat/monte-carlo`, etc.).
- No `develop` branch, no gitflow — unnecessary for a solo project.
- CI (GitHub Actions, added in M0): `cargo fmt --check`, `clippy -D warnings`, `cargo test`, ts-rs drift check, `biome check`, `tsc --noEmit`, `vite build`, and `vitest` as required checks on PRs to main. `pnpm check` runs the same chain locally.

### Persisted project conventions — `CLAUDE.md` (created in M0, committed to the repo)

The branch strategy and other session-spanning rules live in a root `CLAUDE.md`, which Claude Code auto-loads in every future session (and doubles as contributor docs). It will contain:
- **Branch/PR workflow** (the strategy above: PR per milestone, squash merge, main always green, tag at V1).
- **Architecture invariants:** engine crate stays Tauri-free; TS types are generated by ts-rs, never hand-edited; all dates are `YearMonth`; engine outputs nominal dollars + deflator; new behaviors go behind the `ReturnModel`/`TaxModel`/`DrawdownStrategy` traits.
- **Privacy rule:** financial data never committed — plans live in a user-configurable location (Documents by default) or git-ignored `data/`; keep `.gitignore` covering it.
- **Dev commands:** `pnpm tauri dev`, `pnpm app:build`, `cargo test -p engine`, and `pnpm check` to run before pushing.
- **Roadmap pointer:** current milestone status and the V2 backlog list, updated as milestones land.

Repo-level `.claude/settings.json` will be added only if we later want shared hooks/permissions; CLAUDE.md covers conventions for now.

## Verification

- **Engine:** `cargo test -p engine` — golden files, micro-case with hand-checked arithmetic, property tests.
- **Type sync:** ts-rs generation runs in build/CI; `tsc --noEmit` fails on drift.
- **App:** `pnpm tauri dev` — edit inputs, watch charts update; save/reload plan; confirm plan file exists in app data dir and nothing sensitive lands in the repo (`git status` clean of data).
- Each milestone lands via its own PR into `main` per the branch strategy above.
