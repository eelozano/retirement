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
11. **Blind spots named up front so the schema would not fight them:** employer 401(k) match, RMDs (built in #49 — `Account::owner` plus `Person::birth` was all the age lookup needed), IRMAA/ACA cliffs, catch-up contributions, contribution-limit inflation indexing, capital gains vs ordinary income, rebalancing drift/glide paths, survivor scenarios, filing status. Naming them early is what made match, catch-up tiers, limit indexing, survivor scenarios, and filing status additive when they were built — none needed a schema migration.
12. **Data safety:** plans saved to a user-visible, user-configurable location (default: `~/Documents/Retirement Planner`, or `~/RetirementPlanner` if Documents can't be resolved) — outside the repo entirely; `data/` also git-ignored in case the user prefers keeping files next to the repo. Atomic writes (write temp + rename) and a `.bak` of the previous version on save. Legacy pre-#13 plans in the old `app_data_dir` are migrated forward automatically on first launch (copy, never delete).

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────┐
│  React/TS Frontend (src/)                           │
│  Rail ─► screens ─► Zustand store ─► debounced invoke│
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
│       │   ├── lib.rs             # simulate() entry, tax_model() assembly
│       │   ├── model/             # plan, person, account, stream, assumptions,
│       │   │                      # social_security, tax_profile, validation, year_month
│       │   ├── sim/               # mod.rs (setup + the loop), period (the
│       │   │                      # per-period steps), contributions,
│       │   │                      # survivor, monte_carlo, projection
│       │   ├── strategies/        # returns.rs, tax.rs, drawdown.rs (traits + impls)
│       │   ├── presets.rs         # allocations, default assumptions, limit table
│       │   └── state_tax_data.rs  # per-state bracket schedules
│       └── tests/                 # golden-file, micro-case, property, and
│                                  # per-feature tests (contributions,
│                                  # employer_match, mortality, survivor, …)
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
│   │   ├── layout/            # Dashboard shell, Rail, PlanScreen, CashFlowScreen,
│   │   │                      # ComparisonView, StatusBand, Modal, *Settings
│   │   ├── inputs/            # InputsScreen (two-pane) + People/Accounts/
│   │   │                      # Spending/Assumptions sections, StreamCard, fields
│   │   └── charts/            # ProjectionChart, CashFlowChart, ComparisonChart,
│   │                          # YearInspector, HeadlineTiles, DataTable, + the
│   │                          # pure *Data.ts view-model builders they consume
│   ├── store/                 # Zustand: plan, projection, and UI state
│   ├── lib/                   # invoke wrappers, formatters, warning text
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
    pub social_security: Vec<SocialSecurityBenefit>,  // resolved into streams at simulate time
    pub assumptions: Assumptions,
    pub sim_config: SimConfig,
}

pub struct Person {
    pub id: PersonId,
    pub name: String,               // "Enrique", "Claire"
    pub birth: YearMonth,           // 1983-08, 1987-06
    pub retirement: YearMonth,      // 2038-08, 2042-08
    // Mortality is per person, not per household: `AtDeath` resolves against
    // this directly, and `Plan::end_month` takes the max across everyone, so
    // the horizon runs to the last survivor. Plans written before this field
    // fall back to `Assumptions::plan_end_age` via `PersonWire`, resolved in
    // `Plan`'s custom `Deserialize` — the only place both are in scope.
    pub life_expectancy_age: u8,
}

pub enum AccountKind { Taxable, TraditionalPreTax, Roth }

// Orthogonal to AccountKind: tax treatment vs statutory bucket. A Roth 401(k)
// and a Roth IRA are taxed the same and capped separately; a traditional IRA
// and a Roth IRA are taxed differently and share one cap. 457(b) would be a
// fourth variant, not a rework.
pub enum PlanType { EmployerPlan, Ira, None }

pub enum ContributionRule {
    PercentOfSalary(f64),   // resolved against the owner's salary each period
    FlatAmount(f64),        // nominal by design; the UI says so
    FederalMaximum,         // intent, resolved against the indexed limit table
}

// Employer match, per account: a match belongs to one employer's plan
// document, and an account is what stands for a plan here. Vesting is
// deliberately deferred — every matched dollar is treated as vested.
pub struct MatchTier { pub employee_percent: f64, pub match_percent: f64 }
pub enum MatchDestination { PreTax, Roth }
pub struct EmployerMatch {
    pub tiers: Vec<MatchTier>,        // ordered: "first 3%", "next 2%"
    pub destination: MatchDestination,
}

pub struct Account {
    pub id: AccountId,
    pub owner: PersonId,
    pub kind: AccountKind,
    pub name: String,
    pub balance: f64,               // starting balance (nominal, as of plan start)
    pub cost_basis: Option<f64>,    // taxable only; splits withdrawals principal vs gains
    pub allocation: AllocationRef,  // preset id or custom weights
    pub plan_type: PlanType,        // limit bucket; cap shared per person per year
    pub contribution: ContributionRule,
    pub employer_match: Option<EmployerMatch>,
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
    // A pension's or annuity's survivor percentage. When set, it overrides
    // `end` in both directions at the owner's death: the full amount stops
    // there even if `end` runs later, and this fraction continues to plan end.
    pub survivor_percentage: Option<f64>,
}

pub struct Assumptions {
    pub inflation: f64,
    pub asset_returns: BTreeMap<AssetClass, f64>,  // nominal expected returns
    // Federal filing status: drives the bracket + standard-deduction table
    // and the Social Security taxability thresholds `BracketTax` reads.
    pub filing_status: FilingStatus,
    // State income tax as an editable bracket schedule. The state picker
    // prefills it, but the stored brackets — not the state selection — are
    // what `BracketTax` evaluates, so user edits always stick. This replaced
    // the old flat `flat_tax_rate`, which no longer exists on the model;
    // `FlatTax` survives only as a test fixture.
    pub state_tax: StateTaxProfile,
    // Legacy household-wide mortality figure, superseded by
    // `Person::life_expectancy_age`. Not read by `end_month` or `AtDeath` —
    // kept only as the migration fallback for plans predating that field.
    pub plan_end_age: u8,
    // When ordinary surplus starts being swept into the first Taxable
    // account: None never, Some(PlanStart) always, Some(AtRetirement(p))
    // from that person's retirement. See "Surplus has two regimes" below;
    // the pre-#50 bool migrates in `AssumptionsWire`.
    pub sweep_surplus_from: Option<StreamBoundary>,
    // Fraction of *household* spending that continues after the first death.
    // Defaults to 1.0 — no step-down — so the engine never assumes a number
    // the user did not choose; the UI carries the 0.70–0.80 convention as
    // guidance instead. Person-owned expenses are left alone.
    pub survivor_expense_factor: f64,
    // Plan-level default COLA for benefits without their own `cola_override`.
    pub social_security_cola: f64,
}

// PIA + claiming age, resolved into an income stream at simulate time so the
// claiming age stays interactively recomputable.
pub struct SocialSecurityBenefit {
    pub id: SocialSecurityBenefitId,
    pub owner: PersonId,
    pub benefit_at_fra: f64,        // today's dollars, from the SSA statement
    pub full_retirement_age: u8,    // user-supplied; varies by birth year
    pub claiming_age: u8,           // 62..=70
    pub cola_override: Option<f64>,
}

pub enum AssetClass { UsEquity, IntlEquity, GlobalEquity, UsBonds }
// presets.rs: Aggressive / Moderate / Conservative → VT/VTI/VXUS/BND weights

pub struct SimConfig {
    pub start: YearMonth,
    pub period: PeriodLength,        // Year (V1) | Month (V2) — engine iterates periods
    pub display_real_dollars: bool,  // UI hint; engine always outputs nominal + deflator
    pub show_monte_carlo_band: bool, // UI hint; whether the chart opens with the fan on
}

// `first_period_after(month)` is the survivor transition point: the period a
// death falls inside keeps the pre-death rules — the IRS lets a survivor file
// jointly for the whole year of the death — and the next one is the first
// that does not.
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
    // `base` is the period's income before the withdrawal, already taxed by
    // the caller: the gross-up stacks on it and reports only the *marginal*
    // cost, so a period's dollars meet the progressive schedule once (#54).
    fn withdraw(&self, net_needed: f64, accounts: &mut [AccountState],
                tax: &dyn TaxModel, base: &IncomeBreakdown,
                period: PeriodIndex) -> WithdrawalResult;
}

// Impls in the crate today:
//   ReturnModel       FixedReturns, StochasticReturns (seeded, per-path)
//   TaxModel          BracketTax (federal + state tables), SurvivorTax
//                     (wraps two BracketTax and switches at a period index);
//                     FlatTax remains only as a test fixture — no plan field
//                     selects it since `flat_tax_rate` was dropped
//   DrawdownStrategy  ProportionalDrawdown
//
// Each of these landed as a new file behind an unchanged trait, with no edit
// to the simulation loop — which is the property the traits exist to buy.
// Anything further (a historical-sequence ReturnModel, an ordered drawdown)
// slots in the same way.
```

### Simulation core (`crates/engine/src/sim/`)

```rust
pub fn simulate(plan: &Plan, returns: &dyn ReturnModel, tax: &dyn TaxModel,
                drawdown: &dyn DrawdownStrategy, path_id: u64) -> Projection;

// Per-period loop, one function per step over PeriodState (sim/period.rs):
//   accrue stream income → contributions (respect limits) → required
//   minimum distributions (forced, once an owner is past their RMD age) →
//   settle (tax the period's whole income in one pass, then reinvest the
//   leftover or gross up a drawdown against that same income) → apply
//   growth → snapshot.

pub struct PeriodSnapshot {
    pub period_start: YearMonth,
    pub balances: BTreeMap<AccountId, f64>,   // nominal
    pub income: f64, pub expenses: f64, pub taxes: f64, pub contributions: f64,
    pub income_by_stream: BTreeMap<StreamId, f64>,        // sums to `income`
    pub expenses_by_stream: BTreeMap<StreamId, f64>,      // sums to `expenses`
    pub contributions_by_account: BTreeMap<AccountId, f64>, // sums to `contributions`
    pub withdrawal_taxes: f64,                // the gross-up's share of `taxes`
    pub required_distributions: f64,          // forced share of `withdrawals`
    pub withdrawals: BTreeMap<AccountId, f64>,
    pub net_worth: f64,
    pub deflator: f64,                        // cumulative inflation → real-dollar toggle
}

pub struct Projection {
    pub snapshots: Vec<PeriodSnapshot>,
    pub warnings: Vec<SimWarning>,   // e.g. DepletedFunds { period }, ContributionClamped
    pub streams: Vec<StreamInfo>,    // every stream the run accrued, synthesized ones included
}
```

#### Attribution (#67)

The scalar totals are enough to show *how much* moved each year and nothing about *which* stream or account. The per-stream and per-account maps are decompositions of the scalars beside them — `tests/properties.rs` pins that each sums to its total — recorded in the one step that still knows the answer: `accrue_streams` is the only place a dollar of income knows its stream, and `contribute` the only place a contribution knows its account. Keys are the ids of the streams *as the engine ran them*, so a Social Security benefit or survivor continuation synthesized in `sim/survivor.rs` appears under its own id; `Projection::streams` lists every one with a readable name, which is what lets a view label them without mirroring the engine's id formats.

`withdrawal_taxes` is the one split of `taxes` the snapshot can honestly claim. The period's dollars meet the progressive schedule as a single stack (#54), and the drawdown reports what its gross-up *added* over the bill on base income; that addition is recorded, and nothing further is allocated. The engine never decides that "salary paid the tax", and the cash-flow composition diagram built on these fields is a hub for that reason — every inflow pools in the household and flows out from there. Employer match is deliberately outside the `income = outflow + surplus` identity, so it is not a flow in that diagram either.

#### The period pipeline (`sim/period.rs`)

The loop was one 290-line body carrying ~10 mutable locals across six inlined steps, and the cost was not only length. With no shared picture of the period, the two places that reach for the tax model — the bill on stream income and the drawdown's gross-up — could not see each other, and drifted into taxing every period **twice**, adding the two results (#54). Against a progressive schedule that is strictly cheaper than one pass over the same dollars, and because the gross-up started from an empty `IncomeBreakdown` the provisional-income formula never saw a withdrawal, so no amount of drawdown could make a Social Security benefit taxable.

Four contexts now carry the loop, split by lifetime: `RunContext` (plan, resolved streams, strategies — fixed for the run), `RunState` (balances, warning-dedup sets, warnings — carried period to period), `PeriodContext` (one period's time coordinates) and `PeriodState` (what one period accumulates). `PeriodState::base_income` is the **single** definition of a period's income as the tax model sees it; `settle` taxes it and hands the same value to `withdraw`, which reports what the withdrawal *adds*.

This is what makes a **step** a real place to put a behavior, alongside the two the strategy traits already offer.

#### Required minimum distributions (`sim/required_distributions.rs`)

Every other outflow is demand-driven — `DrawdownStrategy::withdraw` is only reached when a period's cash is negative. A retiree whose Social Security and pension cover their spending would therefore never touch a seven-figure 401(k), and the plan would show a tax bill that never arrives. RMDs are the one step that moves money because the calendar says so, which is why they are a **step** rather than a strategy impl.

`presets::rmd_age` is the SECURE 2.0 birth-year lookup (73 for 1951–1959, 75 for 1960 and later; 72 for cohorts already distributing) and `presets::uniform_lifetime_divisor` is the IRS Uniform Lifetime Table. Neither goes through `index_to` — one is an age and the other a mortality divisor, and indexing them with inflation would be a quiet, plausible-looking error next to the dollar figures that *do* index.

The conventions, each a choice: age *attained during* the calendar year, matching the statute and the catch-up precedent; the **prior period's closing balance** as the stand-in for the prior 31 December balance, which means the first projection period takes nothing (there is no prior); `TraditionalPreTax` only, since Roth accounts have no lifetime RMD; and one figure per owner over their aggregate pre-tax balance, satisfied **pro rata** across their accounts — the model has no IRA-versus-401(k) grouping, so pro rata is the simplification that leaves the portfolio's shape undisturbed and does not depend on listing order. A deceased owner keeps distributing on their own schedule: wrong in detail, but the alternative is an inherited pre-tax balance compounding untaxed to the end of the projection. Beneficiary RMDs, the 25% excise tax, QCDs and IRMAA are deliberately out of scope.

**Reinvestment does not honour `sweep_surplus_from`, and that is the point.** For ordinary surplus the boundary is harmless: un-swept surplus is income that never entered an account, so leaving it out changes no balance. A distribution is the opposite case — the money has already left the pre-tax balance, and with nothing to receive it net worth would fall by the full distribution every year and the engine would report destroyed wealth as a failing plan. So the forced share is redeposited in the first `Taxable` account unconditionally (basis *and* balance: these are after-tax dollars, and skipping the basis taxes them again as gain), capped at the period's surplus because RMD dollars fund spending like any other income. With no taxable account the money genuinely has nowhere to go, and `RequiredDistributionUnallocated` says so — a louder warning than `SurplusUnallocated` for a materially worse outcome.

Because the distribution enters `base_income` before `settle` runs, it is taxed in the same single pass as everything else: it stacks on the household's real marginal rate and drags Social Security into taxability. That is the whole finding RMDs exist to surface, and it is only expressible because #54 landed first. In a shortfall year the distribution counts as cash *toward* the need rather than being taken on top of it, so the household draws `max(need, RMD)` and not their sum.

Downstream, `PeriodSnapshot::required_distributions` is the forced share of `withdrawals`, not an addition to it. The Plan screen's year inspector breaks it out beneath Withdrawals, and `cashFlowSummary` subtracts it before testing for the retirement crossover — otherwise the year an owner turns 73 would read as the year they started living off their portfolio, for a household that changed nothing.

#### Surplus has two regimes (`Assumptions::sweep_surplus_from`)

A period's leftover cash is one arithmetic result standing for two different quantities, and the boolean this replaced (#50) could only be right about one of them at a time.

**While the household is working, surplus is current spending.** This app takes savings as the input and lets spending fall out as the residual: contributions are budgeted exactly and typed in, the grocery bill is not, and nothing in the engine throttles a contribution for affordability. A plan with no expense streams is therefore not missing data — its working-phase surplus *is* the household budget, and sweeping it into a brokerage would invent wealth out of money already spent. **In retirement it is real**: income is largely fixed, spending is the thing being modelled, and leftover cash genuinely is reinvested — so not sweeping it understates the portfolio for every retirement year.

`Option<StreamBoundary>` states the split with no new vocabulary: `None` never sweeps, `Some(PlanStart)` always does, `Some(AtRetirement(p))` names *whose* retirement divides them — which a household with staggered dates has to answer, and a phase flag could not. `resolve_boundary` already turns any of them into a month; the sweep begins with the first period that *starts* on or after it, so a retirement landing mid-period does not bank the part of that period the household was still earning through. An unresolvable boundary (a deleted person) falls back to never, loudly, via `SweepBoundaryUnresolved` — the alternative fallback would quietly pour decades of working-phase spending into the portfolio.

The rejected alternative is asking for a full budget so the residual disappears. It demands budgeting work this tool deliberately does not ask for, in order to recover a number the engine already derives — and that number has a better use. `lib/currentSpending.ts` reads it back off the last full working period as the seed for the retirement expense stream, deflated to today's dollars, which turns the one input a projection cannot do without into a prefilled figure. It holds only if every dollar the household saves is modelled here, since the engine cannot tell unmodelled saving from spending; the UI carries that caveat wherever the number appears, and the same working/retired split renames the year inspector's surplus row.

#### Contribution limits (`sim/contributions.rs`)

Statutory limits are granted **per person per year**, shared across a bucket of that person's accounts — not per account. Clamping per account let one person defer the elective-deferral limit once for each employer plan they hold, overstating the ending balance and understating taxable income (the same figure feeds the pre-tax deduction).

Two independent buckets, named directly by `Account::plan_type`: **employer plans** (401(k)/403(b)/TSP elective deferrals) and **IRAs** (traditional and Roth share one cap with each other). `PlanType::None` accounts — taxable brokerages — join no bucket. The bucket used to be *inferred* from whichever statutory figure the account's user-typed limit sat nearer, which mis-bucketed a 457(b) and any hand-typed figure near neither; the engine now owns the limits and reads the bucket from a field.

When a person's accounts collectively ask for more than the shared cap, room is handed out **in plan account order**: the first account listed fills first. The split is resolved **per period**, not once: salaries grow, limits index, and catch-up tiers turn on with age, so what fits is a function of the year. Clamp warnings are deduplicated by account and report the first period the clamp bit.

#### Employer match (`sim/contributions.rs`)

Tiers apply in order, each consuming the employee's deferral percentage until it runs out: `[{3%, 100%}, {2%, 50%}]` on an 8% deferral pays 3% + 1% = 4% of salary. The gate is the **person's** deferral percentage across all their employer plans, derived from what actually went in post-clamp — so a `FlatAmount` or `FederalMaximum` contribution still produces an effective percentage, and splitting deferrals between a Roth and a traditional 401(k) at one employer still earns one match on the combined figure.

Matched dollars are **not** held to the employee elective-deferral limit — applying it to them would silently destroy most of the match, which is the failure mode this exists to prevent. They are held to the 415(c) annual-additions cap instead, shared with the employee's own deferrals, and only the match gives way when it binds. 415(c) is statutorily per employer plan; with no employer grouping in the model it is applied per person, which is the stricter reading.

`MatchDestination` selects *which account receives the money*, not just a label: `AccountKind` is what the tax and drawdown paths read, so pre-tax dollars parked in a Roth account would be withdrawn untaxed. The declared account is preferred when its kind already agrees; otherwise the owner's first other employer-plan account of that kind takes it, and a `MatchUnallocated` warning fires when there is none — a Roth deferral account plus a pre-tax match account is how a real statement splits the two sources.

Employer money never passes through household cash, so it is `PeriodSnapshot::employer_match` rather than part of `contributions` — folding it in would break the `income = outflow + surplus` identity that `tests/properties.rs` pins.

#### Plan horizon (`Plan::end_month`)

The projection runs to `max` over every person's `month_at_age(life_expectancy_age)` — the last survivor, not a single household age. `StreamBoundary::AtDeath(person)` resolves against that person's own figure. The household-wide `Assumptions::plan_end_age` it replaced survives only as the deserialization fallback for plans written before per-person expectancy existed.

#### The survivor transition (`sim/survivor.rs`)

Mortality here is an assumption (`Person::life_expectancy_age`), not a draw, so the first death is a known month before the loop starts — which is what lets the tax model precompute when filing status changes instead of threading household state through the loop. `Plan::first_death` is the first death *that leaves someone behind*: `None` for a one-person plan, and also when everyone's expectancy lands in the same month, since nothing transitions with no survivor.

Almost everything the transition does is expressed as `CashFlowStream`s the main loop already runs, so it adds **no branch to the simulation loop**. Two things cannot be: the expense step-down (a per-period factor) and the filing-status change (a `TaxModel`).

**Social Security.** The household stops drawing two benefits and the survivor keeps the larger. Four simplifications, stated because they are user-visible: the larger benefit is picked in today's dollars (the same ranking as at the transition month whenever both share a COLA, which they do unless one sets `cola_override`); a survivor who has their own benefit steps up no earlier than their own claiming month, since the real "survivor benefit at 60, delay your own to 70" move needs a reduction schedule this engine does not model, and claiming later is the conservative error; a survivor with *no* benefit of their own inherits the decedent's from the death itself, because modelling nothing would be plainly wrong for a one-earner household; and a household leaving *more than one* survivor is left alone entirely — a survivor benefit goes to a spouse, this model has no relationships in it, and handing it to each of two survivors is worse than not modelling it.

**Filing status.** `SurvivorTax` wraps two `BracketTax` and switches at `SimConfig::first_period_after(death)` — the period containing the death still files jointly, matching the IRS rule, and the next one does not. Only a joint filer has anything to lose, so a plan already filing Single gets no transition. The state schedule carries over unchanged: `StateTaxProfile` has no filing-status dimension, and inventing a survivor variant of the user's own brackets would be worse than leaving them alone.

**Expenses.** `survivor_expense_factor` scales the expense streams *no single person owns*. Expenses owned by a person are left alone — they are that person's own cost, and their `end` boundary already says when they stop. The default is 1.0, no step-down: the convention clusters at 0.70–0.80, and the engine deliberately does not seed one, so the number is always one the user chose.

**Pensions.** `CashFlowStream::survivor_percentage` overrides `end` in both directions at the owner's death: the full amount stops there even if `end` ran later, and the fraction continues to plan end under the same growth rule. A stream whose owner dies last is unaffected — there is no one for the continuation to run for.

#### Contribution limits, continued

`presets::CONTRIBUTION_LIMITS` carries the statutory figures for one tax year (`basis_year`, currently 2026 from IRS Notice 2025-67) and `ContributionLimits::annual_limit` indexes them forward at the plan's inflation rate, rounding down to the statutory increment ($500, or $100 for the IRA catch-up) so limits step the way the real schedule does. Catch-up is automatic from the owner's `birth`: the age-50 tier, and the SECURE 2.0 tier that replaces it for the years they turn 60 through 63. The app is local-first with no network, so the figures are only as current as the release — `basis_year` is surfaced in the UI rather than implying they are live.

Frontend consumes `Projection` directly (generated types); the real-dollar toggle divides by `deflator` client-side — no engine round-trip on toggle. `SimWarning` variants carry the numbers behind them (a clamp reports `period`, `requested`, and `allowed`) because the UI renders warnings as text — `src/lib/warnings.ts` — rather than a count.

### Tauri commands (`src-tauri/src/commands.rs`)

- `run_projection(plan: Plan) -> Projection` — stateless; frontend sends full plan (small payload, ~KB). `run_projections(plans: Vec<Plan>) -> Vec<Result<Projection, String>>` does the same for N scenarios in one round-trip, for the comparison view (#6) — one entry per plan, so one invalid scenario doesn't blank the rest.
- `save_plan(plan) / load_plan() / load_plan_named(id) / list_plans() -> Vec<PlanSummary>` — YAML in the resolved plans directory, keyed by each plan's stable `id` (not its editable `name`), atomic write + `.bak`, `schema_version` checked on load. `load_plan` loads the active scenario (see `set_active_plan`, falling back to the first stored plan or a fresh seed) and also runs the one-shot legacy-JSON migration check; plans saved before `id` existed are backfilled once from their pre-#6 filename slug.
- `duplicate_plan(id, new_name) / delete_plan(id) / set_active_plan(id)` — scenario management: branch a new plan off an existing one (deep copy, fresh id), remove a scenario (moved aside as `.deleted`, never unlinked — refused for the last remaining scenario), and record which scenario loads on next launch.
- `run_monte_carlo(plan, MonteCarloConfig { n_paths, seed }) -> MonteCarloResult` — the same `simulate` over N seeded paths in parallel (rayon), returning per-period net-worth percentiles plus probability of success. `seed` is `u32`, not `u64`, so ts-rs emits a plain `number`: a `bigint` would not survive `JSON.stringify` across the IPC boundary.
- `get_presets() -> Presets` — allocations, default assumptions, and the contribution-limit table, so defaults live in one place (Rust).
- `engine_version() -> String` — the engine crate version, surfaced in the UI.
- `get_storage_info() / choose_storage_dir() / set_storage_dir(path) / reveal_storage_dir()` — the Storage settings surface: report the effective/default plans dir, open a native folder picker, persist a new location (copying existing plans forward), and reveal the folder in Finder/Explorer.

---

## 3. How V1 Was Built

Kept as the record of the delivered milestones. Current and planned work is
tracked in GitHub issues (`gh issue list`), not here.

**M0 — Scaffold.** Tauri v2 app via `create-tauri-app` (React+TS+Vite, pnpm); Cargo workspace with `crates/engine`; ts-rs type-generation wired into build; `.gitignore` for `data/`; `cargo fmt/clippy/test` + `tsc --noEmit` clean. *Done: the empty app opened and generated types imported.*

**M1 — Engine core (pure Rust, no UI).** Domain model + presets; `simulate()` with FixedReturns/FlatTax/ProportionalDrawdown; seed scenario (Enrique + Claire, 3 accounts, salary/spending streams) as a fixture. Tests: golden-file projection snapshot, hand-computed 3-period micro-case, property tests (balances ≥ 0, cash conservation per period, depletion emits warning). *Done: `cargo test` proves the math.*

**M2 — IPC + persistence.** Commands, storage layer, load-on-launch/save flows, seed plan bootstrap on first run. *Done: a plan round-trips through the app and a projection returns to the frontend.*

**M3 — Dashboard UI.** Zustand store + debounced re-projection; input drawer (people, accounts w/ preset picker, streams, assumptions); Recharts stacked-area balances by account, net-worth line, summary stats (retirement-date net worth, depletion age if any); nominal/real toggle; responsive layout. *Done: editing any input live-updates the charts.*

**M4 — Polish & V1 close-out.** Input validation + friendly errors, empty/depleted states, number formatting, README (privacy model, how to back up data), first release tag.

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
- **Architecture invariants:** engine crate stays Tauri-free; TS types are generated by ts-rs, never hand-edited; all dates are `YearMonth`; engine outputs nominal dollars + deflator; new behaviors go behind the `ReturnModel`/`TaxModel`/`DrawdownStrategy` traits, or — when they fit none of them — become a new **step**: a function over `PeriodState` in `sim/`, never new statements inside `simulate`.
- **Privacy rule:** financial data never committed — plans live in a user-configurable location (Documents by default) or git-ignored `data/`; keep `.gitignore` covering it.
- **Dev commands:** `pnpm tauri dev`, `pnpm app:build`, `cargo test -p engine`, and `pnpm check` to run before pushing.
- **Status pointer:** what has shipped, and a pointer to GitHub issues for current work — deliberately not a copy of the issue list, which decays.

Repo-level `.claude/settings.json` will be added only if we later want shared hooks/permissions; CLAUDE.md covers conventions for now.

## Verification

- **Engine:** `cargo test -p engine` — golden files, micro-case with hand-checked arithmetic, property tests.
- **Type sync:** ts-rs generation runs in build/CI; `tsc --noEmit` fails on drift.
- **App:** `pnpm tauri dev` — edit inputs, watch charts update; save/reload plan; confirm the plan file exists in the resolved plans directory and nothing sensitive lands in the repo (`git status` clean of data).
- Each milestone lands via its own PR into `main` per the branch strategy above.
