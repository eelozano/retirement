# Architecture

How the Retirement Planner is built, and why. It covers the data model, the
engine's conventions, the adapter's files and commands, the frontend's
shape, what the design was shaped to accept, and where it would push back.
It describes code that exists; current and planned work lives in GitHub
issues. Read it before changing the engine, and when a change makes a
statement here untrue, update it in the same PR.

Field-level truth is the code: `crates/engine/src/model/*.rs` and the ts-rs
output in `src/types/generated/`. What follows is the shape and the reasons.

---

## 1. Foundational decisions

A local, privacy-first retirement projection tool (ProjectionLab- and
Boldin-inspired): Tauri v2, a React/TypeScript frontend, and a pure-Rust
engine. It started as a deterministic annual projection with data models and
traits shaped so Monte Carlo, bracket tax and survivor modelling would slot
in without refactoring core state, and they did.

1. **A pure engine crate, with no Tauri dependencies.** The simulation lives
   in `crates/engine` as a plain Rust library; `src-tauri` is a thin adapter
   (commands and file I/O). The engine is unit-testable with `cargo test`,
   Monte Carlo threading (rayon) stays isolated from the Tauri runtime, and a
   WASM compile path stays open.
2. **One source of truth for types.** Rust structs derive `serde` and
   **`ts-rs`**, which generates the TypeScript interfaces in
   `src/types/generated/`. Hand-maintained parallel TS/Rust models are the
   biggest silent-drift risk in a Tauri app. (`ts-rs` over `tauri-specta`:
   simpler and stable, with no macro coupling to Tauri command signatures.
   Revisit specta if typed `invoke` bindings are ever wanted.)
3. **Nominal dollars, with a deflator.** The engine simulates in nominal
   dollars and emits a cumulative inflation factor per period, at the period's
   start (`deflator`) and at its end (`deflator_end`); the today's-dollars
   view is a frontend division. `strategy_returns` are nominal *and
   arithmetic* annual means — see "The return is an arithmetic mean" below.
4. **Month-native time, year-stepped.** Every date is a `YearMonth`, so
   "born Aug 1983, retires Aug 2038" is exact rather than rounded to years.
   The engine iterates over periods laid on calendar-year boundaries: period
   0 runs from the plan's start month to the following January, a prorated
   stub when that month is not January, and every later period is a whole
   calendar year. Boundaries are prorated within a period by month. The
   original claim that monthly resolution would be "a config change, not a
   schema migration" is withdrawn: `PeriodLength::Month` is still in the
   schema, but the tax model, contribution limits, the filing-status switch
   and RMDs are calendar-year rules that would first have to be aggregated
   across periods. See "Time conventions".
5. **The engine is a pure function.** `simulate(&Plan, &TaxFigures, &dyn
   ReturnModel, &dyn TaxModel, &dyn DrawdownStrategy, path_id) ->
   Projection`. No mutable global state; each run owns its state. Monte
   Carlo is the same function run N times with a seeded stochastic
   `ReturnModel`, parallelized with rayon — embarrassingly parallel by
   construction.
6. **Strategy traits from the start.** `ReturnModel`, `TaxModel` and
   `DrawdownStrategy` each began with one impl. `StochasticReturns`,
   `BracketTax` and `SurvivorTax` each arrived later as a new impl behind an
   unchanged trait, with no edit to the simulation loop — the property the
   traits exist to buy.
7. **Cost basis is tracked in taxable accounts** from the first version,
   before any tax model read it: capital-gains modelling needs the ledger
   history, and retrofitting basis tracking into an engine that has been
   mutating balances is painful.
8. **Accounts have owners.** Every account references a `PersonId`.
   Staggered retirements, RMD ages, catch-up contribution ages and survivor
   modelling all depend on per-person ownership.
9. **`f64` for money.** This is projection math — compounding, random draws
   — not accounting; integer cents buy nothing and complicate Monte Carlo.
   Round at the display layer.
10. **Income and expenses are generic dated cash-flow streams** — salary,
    spending, pensions and one-offs share one shape. Social Security is the
    exception: a first-class `SocialSecurityBenefit` (PIA and claiming age)
    resolved into a stream at simulate time, so the claiming age stays
    interactively recomputable instead of being a hand-computed dollar
    figure.
11. **Persistence is YAML files**, one per *household* (its facts plus every
    scenario branched from them, #109), with a `schema_version`, in a
    user-visible and user-configurable folder — `~/Documents/Retirement
    Planner` by default, or `~/RetirementPlanner` if Documents cannot be
    resolved. No SQLite, no cloud. Writes are atomic (temp file, then
    rename) with a `.bak` of the previous version. `data/` next to the repo
    is git-ignored for anyone who keeps files there.
12. **Scenarios have stable identity.** Each carries an `id` distinct from
    its editable `name`; the adapter lists, duplicates, deletes and switches
    them, and the Scenarios screen overlays up to five with a comparison
    table.
13. **Recharts and Zustand.** Recharts draws ~60 annual points of stacked
    areas and the Monte Carlo fan comfortably. Chart components consume
    pure view-model builders, not the charting library's shapes, so the
    library is not load-bearing and could be swapped. Zustand holds inputs
    and results separately, so a stale result is detectable.
14. **Blind spots were named up front** so the schema would not fight them:
    employer match, RMDs, IRMAA and ACA cliffs, catch-up contributions,
    limit indexing, capital gains versus ordinary income, rebalancing,
    survivor scenarios and filing status. Naming them early is what made
    match, catch-up tiers, limit indexing, survivors, filing status and RMDs
    additive when they were built — none needed a schema migration. RMDs
    needed nothing beyond `Account::owner` and `Person::birth`. IRMAA, ACA
    cliffs and rebalancing are still unbuilt; see "Where the current design
    pushes back".

---

## 2. System overview

```
┌──────────────────────────────────────────────────────┐
│  React/TS frontend (src/)                            │
│  Rail ─► screens ─► Zustand store ─► debounced invoke│
│  charts ◄─ pure *Data.ts view-models ◄─ Projection   │
└──────────────────────┬───────────────────────────────┘
                       │ Tauri IPC (serde JSON)
┌──────────────────────┴───────────────────────────────┐
│  src-tauri (thin adapter)                            │
│  commands: projection · Monte Carlo · plans and      │
│    scenarios · household refresh · tax figures ·     │
│    storage and settings · export                     │
│  persistence: YAML households, atomic writes,        │
│    versioned, user-configurable location             │
└──────────────────────┬───────────────────────────────┘
                       │ plain Rust call
┌──────────────────────┴───────────────────────────────┐
│  crates/engine (pure library, no Tauri)              │
│  model · simulate() · TaxFigures · traits:           │
│  ReturnModel │ TaxModel │ DrawdownStrategy           │
└──────────────────────────────────────────────────────┘
```

### Directory layout

```
retirement/
├── Cargo.toml                 # workspace: crates/engine, src-tauri
├── package.json               # pnpm scripts: demo, check, app:build, …
├── crates/engine/
│   ├── src/
│   │   ├── lib.rs             # run_deterministic, run_monte_carlo(_with), tax_model()
│   │   ├── model/             # plan, person, account, stream, assumptions,
│   │   │                      # strategy (StrategyRates), social_security,
│   │   │                      # tax_profile, tax_figures, household
│   │   │                      # (facts/policy split, compose/decompose),
│   │   │                      # validation, year_month, legacy (pre-#129
│   │   │                      # asset classes, read only by migration)
│   │   ├── sim/               # mod.rs (simulate: setup + the loop), period
│   │   │                      # (the per-period steps), contributions,
│   │   │                      # required_distributions, survivor,
│   │   │                      # monte_carlo, projection (snapshot types)
│   │   ├── strategies/        # returns.rs, tax.rs, drawdown.rs (traits + impls)
│   │   ├── presets.rs         # index_to, rmd_age, Uniform Lifetime table,
│   │   │                      # default assumptions, seed_plan, new_plan
│   │   └── state_tax_data.rs  # per-state bracket schedules
│   └── tests/                 # golden-file, micro-case, property, and
│                              # per-feature tests
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs             # command registration
│   │   ├── commands.rs        # every #[tauri::command]
│   │   ├── storage.rs         # household YAML I/O, compose/decompose at the edge
│   │   ├── refresh.rs         # the balance-refresh sitting (#111)
│   │   ├── tax_figures.rs     # tax-figures.yaml: load, save, copy
│   │   ├── settings.rs        # settings.json; RETIREMENT_DATA_DIR
│   │   ├── migrate.rs         # copy-forward migrations
│   │   └── pdf.rs             # macOS: headless paginated PDF of the report
│   ├── tests/demo_fixtures.rs # generates and checks fixtures/demo/
│   └── tauri.conf.json
├── src/
│   ├── components/
│   │   ├── layout/            # the shell (Dashboard, Rail, StatusBand), one
│   │   │                      # screen per rail destination, WelcomeScreen,
│   │   │                      # the Settings dialog and TaxFiguresEditor,
│   │   │                      # ReportView
│   │   ├── inputs/            # InputsScreen and its People / Accounts /
│   │   │                      # Spending / Assumptions sections and cards
│   │   └── charts/            # chart components, and the pure *Data.ts
│   │                          # view-model builders they consume
│   ├── store/planStore.ts     # Zustand: plan, projection, Monte Carlo, UI state
│   ├── lib/                   # invoke wrappers (api.ts), formatting,
│   │                          # warnings, whatIf, returns, yearBoundary, …
│   └── types/generated/       # ts-rs output — never hand-edited
├── fixtures/demo/             # the committed, invented demo household
├── scripts/warm-actool.sh     # release bundling workaround; see CLAUDE.md
└── data/                      # optional local plans dir, git-ignored
```

---

## 3. Data model

### Household, scenario, and the `Plan` between them

`Plan` is what the engine simulates and what crosses IPC. Since #109 it is
not what a file holds. A file holds one household's **facts** — written
once, observed, dated — and every **scenario** branched from them, which
carries only **policy**: what varies between branches. `compose` and
`decompose` are the only road between the two, and nothing under `sim/`
imports any of this.

```rust
pub struct HouseholdFile {       // one YAML file per household
    pub schema_version: u32,
    pub id: HouseholdId, pub name: String, pub sample: bool,
    pub as_of: YearMonth,        // the month the balances are as of ==
                                 // every scenario's sim_config.start
    pub people: Vec<HouseholdPerson>,           // id, name, birth
    pub accounts: Vec<HouseholdAccount>,        // identity, kind, allocation,
                                                // + observations, newest last
    pub social_security: Vec<HouseholdBenefit>, // the statement's figures
    pub scenarios: Vec<Scenario>,
}

pub struct Observation { pub as_of: YearMonth, pub balance: f64, pub cost_basis: Option<f64> }

pub struct Scenario {            // only what varies between branches
    pub id: PlanId, pub name: String, pub display_real_dollars: bool,
    pub people: BTreeMap<PersonId, PersonPolicy>,       // retirement, life expectancy
    pub accounts: BTreeMap<AccountId, AccountPolicy>,   // contributions, one-time
                                                        // contributions, employer match
    pub social_security: BTreeMap<SocialSecurityBenefitId, BenefitPolicy>, // claiming age, COLA
    pub streams: Vec<CashFlowStream>,
    pub assumptions: Assumptions,
}

pub fn compose(&Household, &Scenario) -> Result<Plan, ComposeError>;
pub fn decompose(&Plan, previous: &Household) -> (Household, Scenario);
```

`decompose` destructures `Plan` exhaustively on purpose: a new field is a
compile error until it has been given a side. The rule for choosing one: a
figure read off a statement — a balance, a birth month, how an account is
invested today — is a household fact; a choice or an assumption is scenario
policy. A balance is therefore written once however many scenarios exist,
and two scenarios can differ only on the decisions being compared.

### The `Plan`

```rust
pub struct YearMonth { pub year: i32, pub month: u8 }   // ordered; month-index arithmetic

pub struct Plan {
    pub id: PlanId,                  // the scenario's stable identity (#6)
    pub schema_version: u32,
    pub name: String,
    pub sample: bool,                // the invented example household; survives a rename (#103)
    pub people: Vec<Person>,
    pub accounts: Vec<Account>,
    pub streams: Vec<CashFlowStream>,
    pub social_security: Vec<SocialSecurityBenefit>,  // resolved into streams at simulate time
    pub assumptions: Assumptions,
    pub sim_config: SimConfig,
}

pub struct Person {                  // + id, name
    pub birth: YearMonth,
    pub retirement: YearMonth,
    // Mortality is per person, not per household: `AtDeath` resolves against
    // this directly, and `Plan::end_month` takes the max across everyone, so
    // the horizon runs to the last survivor.
    pub life_expectancy_age: u8,
}

pub enum AccountKind { Taxable, Savings, TraditionalPreTax, Roth, Hsa }
// Orthogonal to AccountKind: tax treatment versus statutory bucket. A Roth
// 401(k) and a Roth IRA are taxed the same and capped separately; a
// traditional IRA and a Roth IRA are taxed differently and share one cap.
// 457(b) was a new variant when it arrived, not a rework.
pub enum PlanType { EmployerPlan, Plan457b, Ira, SimpleIra, SepIra, Hsa, None }

pub struct Account {                 // + id, name
    pub owner: PersonId,
    pub kind: AccountKind,
    pub plan_type: PlanType,         // limit bucket; the cap is shared per person per year
    pub balance: f64,                // nominal, as of the household's as_of
    // After-tax dollars in the balance: a taxable account's basis, a Roth's
    // contributions to date. Splits a withdrawal into principal and gains,
    // and on a Roth into what comes back free before 59½ and what does not.
    pub cost_basis: Option<f64>,
    pub allocation: AllocationRef,   // a strategy, or a fixed rate of its own
    pub contributions: Vec<Contribution>,               // dated entries; they sum
    pub one_time_contributions: Vec<OneTimeContribution>,
    pub employer_match: Option<EmployerMatch>,
    // Elects the Rule of 55, which the engine then checks against the
    // owner's dates — see "Early withdrawal".
    pub rule_of_55: bool,
}

// See "Growth is one number per strategy" for why this is not a
// per-asset-class table with per-account weights over it (#129).
pub enum AllocationRef { Aggressive, Moderate, Conservative, FixedRate(f64) }
pub struct StrategyRates { pub aggressive: f64, pub moderate: f64, pub conservative: f64 }

pub enum ContributionRule {
    // resolved against the owner's salary each period; step_up escalates it
    PercentOfSalary { percent: f64, step_up: Option<StepUp> },
    // annual figure, nominal by default; growth is the transfer the owner
    // raises each year, in simulation-start dollars like a stream's amount
    FlatAmount { amount: f64, growth: GrowthRule },
    FederalMaximum,                  // intent, resolved against the indexed limits
}
// A 401(k) plan document's auto-escalation: "10% now, up a point a year
// until 15%". Inside PercentOfSalary, so escalating a flat amount or a
// federal maximum — neither a percentage — cannot be written down.
pub struct StepUp { pub points_per_year: f64, pub cap: f64 }

// One dated contribution: a rule over a window in the stream vocabulary.
pub struct Contribution {            // + id, name (optional; what it is for)
    pub rule: ContributionRule,
    pub start: StreamBoundary,
    pub end: StreamBoundary,         // exclusive
}

// A lump sum from outside the plan — a house sale — landing once. Not paid
// out of household cash, so not a Contribution; brokerage or savings only.
pub struct OneTimeContribution {     // + id (shares the account's id space), name
    pub amount: f64,                 // start dollars under Inflation, nominal under None
    pub growth: GrowthRule,          // grown from plan start to the landing period's start
    pub date: StreamBoundary,        // Date | AtRetirement | AtAge | AtDeath
}

// Per account, because a match belongs to one employer's plan document.
// Vesting is deliberately deferred: every matched dollar counts as vested.
pub struct EmployerMatch {
    pub tiers: Vec<MatchTier>,       // ordered: "first 3%", "next 2%"
    pub destination: MatchDestination,   // PreTax | Roth
}

// Generic dated stream: salary, spending, pensions, one-offs.
pub struct CashFlowStream {          // + id, name
    pub owner: Option<PersonId>,
    pub direction: StreamDirection,  // Income | Expense
    pub annual_amount: f64,          // start dollars (a pension: its first check)
    pub start: StreamBoundary,
    pub end: StreamBoundary,
    pub growth: GrowthRule,          // Inflation | Fixed(rate) | None
    // A pension's or annuity's survivor share. When set, it overrides `end`
    // in both directions at the owner's death: the full amount stops there
    // even if `end` runs later, and this fraction continues to plan end.
    pub survivor_percentage: Option<f64>,
    // General | Pension. A pension's amount is its first check, so its
    // `growth` (COLA) compounds from its resolved start, not the plan start.
    pub kind: StreamKind,
}

// One vocabulary for every dated edge in the model: streams, contribution
// windows, one-time dates, the surplus sweep. Person-relative variants mean
// editing a retirement date moves everything tied to it. Every variant is
// valid on either side; the UI offers AtDeath only as an end.
pub enum StreamBoundary {
    PlanStart, PlanEnd, Date(YearMonth),
    AtRetirement(PersonId),
    AtAge(PersonId, u8),             // the birth month, that many years on (#131)
    AtDeath(PersonId),
}

pub struct Assumptions {
    pub inflation: f64,
    pub strategy_returns: StrategyRates,     // nominal arithmetic mean per strategy
    pub strategy_volatility: StrategyRates,  // annualized std. dev. per strategy
    // Drives the bracket and standard-deduction schedule and the Social
    // Security taxability thresholds `BracketTax` reads.
    pub filing_status: FilingStatus,
    // State income tax as an editable bracket schedule. The state picker
    // prefills it, but the stored brackets — not the state selection — are
    // what `BracketTax` evaluates, so user edits always stick.
    pub state_tax: StateTaxProfile,
    // When ordinary surplus starts being reinvested: None never,
    // Some(PlanStart) always, Some(AtRetirement(p)) from that retirement.
    pub sweep_surplus_from: Option<StreamBoundary>,
    // Where swept surplus and an RMD's reinvested remainder land. None means
    // the first Taxable account in plan order (#58).
    pub reinvest_into: Option<AccountId>,
    // Fraction of *household* spending that continues after the first death.
    // Defaults to 1.0 — no step-down — so the engine never assumes a number
    // the user did not choose.
    pub survivor_expense_factor: f64,
    pub social_security_cola: f64,   // default for benefits without their own override
    pub plan_end_age: u8,            // legacy; read only as a migration fallback
    // Which accounts fund a shortfall, and in what order. Proportional is
    // the default and what every plan saved before it loads as.
    pub drawdown: DrawdownPolicy,
}

pub enum DrawdownPolicy { Proportional, Phased(Vec<DrawdownPhase>) }
pub struct DrawdownPhase {           // + id, name
    pub start: PhaseStart,           // runs until the next phase's start
    pub stack: Vec<StackEntry>,      // drawn top to bottom
}
// A boundary, or the month a person reaches 59½ — statute the engine holds,
// rather than an age the user has to know to type.
pub enum PhaseStart { Boundary(StreamBoundary), PenaltyFree(PersonId) }
pub struct StackEntry { pub source: StackSource, pub floor: f64 }  // floor: today's dollars
pub enum StackSource { Account(AccountId), Kind(AccountKind) }

// PIA and claiming age, resolved into an income stream at simulate time.
pub struct SocialSecurityBenefit {   // + id
    pub owner: PersonId,
    pub benefit_at_fra: f64,         // today's dollars, from the SSA statement
    pub full_retirement_age: Option<FullRetirementAge>, // None derives it from
                                     // the owner's birth year (#149)
    pub claiming_age: u8,            // 62..=70
    pub cola_override: Option<f64>,
}

pub struct SimConfig {
    pub start: YearMonth,            // composed from the household's as_of
    pub period: PeriodLength,        // Year. Month is in the schema, unsupported,
                                     // and unread by the loop since #106
    pub display_real_dollars: bool,  // UI hint; the engine always outputs nominal + deflators
}
```

The Monte Carlo band toggle on the chart is session-only by design (see
`planStore.ts`), so there is deliberately no `show_monte_carlo_band` on the
plan.

### Tax figures

The federal brackets, the standard deduction and every contribution limit
change each tax year, so they are one value for one tax year —
`TaxFigures { tax_year, federal: FederalTax, contribution_limits }`
(`model/tax_figures.rs`) — passed to `simulate` as an argument rather than
held as constants (#135). `FederalTax` carries both filing statuses'
standard deduction, the additional deduction for filers 65 and older,
ordinary brackets and long-term capital-gains brackets;
`ContributionLimits` carries every statutory cap and catch-up. Each figure
indexes forward from `tax_year` at the plan's inflation rate, so an
out-of-date year still projects sensibly; it just starts from older numbers.

The adapter keeps the figures in force in `tax-figures.yaml`
(`src-tauri/src/tax_figures.rs`), beside `plans/` rather than in it, since
every `.yaml` in `plans/` is read as a household. The app writes the file
from `TaxFigures::built_in()` the first time it is missing and **never
overwrites it after that**, so a release with newer built-in figures does
not move a user's numbers — the same promise a schema migration makes.
Deleting the file, or resetting it in the editor, is how a user takes new
built-ins. The file is re-read on every projection (it is a few hundred
bytes), so an edit applies at the next recalculation. A file that fails to
parse or `TaxFigures::validate` never stops a projection: the built-in
figures stand in, and the reason goes to the Settings dialog, the one place
the user is told. The in-app editor (#136) saves through the same validator,
atomically, keeping the previous file as `tax-figures.yaml.bak`.

Law with no annual publication stays in code: the Social Security
provisional-income thresholds (fixed since 1993) and full-retirement-age
table (`FullRetirementAge::for_birth_year`, fixed by the 1983 amendments),
the HSA age-55 catch-up (`HSA_CATCH_UP_55`) and the RMD ages and Uniform
Lifetime table. The legacy
contribution-bucket migration keeps its own frozen limits, so opening an old
file never depends on which year's figures are loaded.

---

## 4. Engine

### `simulate` and the strategy traits

```rust
// sim/mod.rs
pub fn simulate(plan: &Plan, figures: &TaxFigures, returns: &dyn ReturnModel,
                tax: &dyn TaxModel, drawdown: &dyn DrawdownStrategy,
                path_id: u64) -> Projection;

// strategies/
pub trait ReturnModel {
    // path_id threads the Monte Carlo path index; FixedReturns ignores it.
    fn returns_for(&self, period: PeriodIndex, path_id: u64) -> StrategyReturns;
}

pub trait TaxModel {
    fn tax(&self, income: &IncomeBreakdown, period: PeriodIndex) -> TaxResult;
    // IncomeBreakdown separates ordinary / capital gains / untaxed / Social
    // Security even though FlatTax collapses them — BracketTax needs the split.
}

pub trait DrawdownStrategy {
    // Iterates: gross withdrawal → tax via TaxModel → check net covers shortfall.
    // `base` is the period's income before the withdrawal, already taxed by
    // the caller: the gross-up stacks on it and reports only the *marginal*
    // cost, so a period's dollars meet the progressive schedule once (#54).
    fn withdraw(&self, net_needed: f64, accounts: &mut [AccountState],
                tax: &dyn TaxModel, base: &IncomeBreakdown,
                period: PeriodIndex) -> WithdrawalResult;

    // The phase in force at a period's start, for the snapshot to report.
    // Defaulted to None: a strategy without phases answers nothing.
    fn phase(&self, period: PeriodIndex) -> Option<&str> { None }
}

// Impls in the crate:
//   ReturnModel       FixedReturns, StochasticReturns (seeded, per path)
//   TaxModel          BracketTax (federal + state), SurvivorTax (two
//                     BracketTax switching at a period index); FlatTax
//                     survives only as a test fixture
//   DrawdownStrategy  ProportionalDrawdown, PhasedDrawdown — the plan's
//                     `DrawdownPolicy` picks which, in `lib.rs`
```

Both drawdown impls share one solver, `gross_up` (`strategies/drawdown.rs`):
the fixed-point gross-up, the income character of a withdrawn dollar, and
applying the draw to balances and basis live there, and an impl supplies
only the allocation — how much of a gross amount each account supplies. An
allocation has to be continuous and non-decreasing in the gross, which is
what makes the fixed point converge.

`PhasedDrawdown` (`strategies/phased.rs`) is a **waterfall over tranches**: a
tranche is a slice of one or more accounts' balances with a capacity, and a
gross amount fills each in turn, split within a tranche in proportion to the
balances behind it. In order: the phase's stack, entry by entry, down to each
entry's floor; then every account the stack does not name — penalty-free
money before penalized, and by kind within each (savings, taxable, pre-tax,
Roth, HSA), with a Roth IRA's contributions counting as penalty-free before
59½; then the floors. A floor is **soft**: released once everything else is
spent, rather than reporting a plan as failed with money still in the bank,
and reported as `FloorReleased`.

A period a phase boundary falls inside is split at the month, as every
boundary splits a period: the need is divided by the months each phase
covers, each part is drawn down its own phase's stack, and the second stacks
on the income of the first so the period still meets the tax schedule once.
Each part is judged early or not over its own months, so a draw from the
phase that begins at 59½ is never penalized in the year of the birthday.

`lib.rs` assembles the standard configuration: `run_deterministic` (fixed
returns, `SurvivorTax`, and the plan's own drawdown policy) and `run_monte_carlo` /
`run_monte_carlo_with` (the same over `StochasticReturns`, the second
observable and cancellable through a `RunControl`).

### The period pipeline (`sim/period.rs`)

The loop was one 290-line body carrying ~10 mutable locals across six
inlined steps, and the cost was not only length. With no shared picture of
the period, the two places that reach for the tax model — the bill on stream
income and the drawdown's gross-up — could not see each other, and drifted
into taxing every period **twice**, adding the two results (#54). Against a
progressive schedule that is strictly cheaper than one pass over the same
dollars, and because the gross-up started from an empty `IncomeBreakdown`
the provisional-income formula never saw a withdrawal, so no amount of
drawdown could make a Social Security benefit taxable.

Four contexts now carry the loop, split by lifetime: `RunContext` (the plan,
resolved streams, strategies, tax figures, and the reinvestment, sweep and
survivor settings resolved up front — fixed for the run), `RunState`
(balances, warning-dedup sets, warnings — carried period to period),
`PeriodContext` (one period's time coordinates) and `PeriodState` (what one
period accumulates). `PeriodState::base_income` is the **single** definition
of a period's income as the tax model sees it; `settle` taxes it and hands
the same value to `withdraw`, which reports what the withdrawal *adds*.

One period, in order (`period::run`):

1. `accrue_streams` — income and expenses, prorated by months active.
2. `contribute` — dated contribution entries, held to per-person limits.
3. `deposit_one_time` — money from outside the plan, straight into an account.
4. `distribute` — required minimum distributions, forced once an owner is
   past their RMD age.
5. `mark_early_access` — record, on each account, the share of this
   period's withdrawals that would fall before its owner may take them
   freely. See "Early withdrawal".
6. `accrue_interest` — Savings accounts earn their rate and are taxed on it
   this same period, unlike every other account's growth, which stays
   unrealized until withdrawn. It runs before `settle` so the interest is in
   `base_income` for the one tax pass. `AccountKind::Savings` is the only
   switch: this step and `grow` are exact complements, so every account is
   priced by exactly one of them.
7. `settle` — tax the period's whole income in one pass, then reinvest the
   leftover or gross up a drawdown against that same income.
8. `grow` — apply the period's return, then snapshot.

This is what makes a **step** a real place to put a behavior, alongside the
impls the strategy traits already offer.

### Time conventions

Every timing bug shipped so far (#29, #43, #50, #78, #92, and the survivor work in #34) came from a consumer re-deriving "which year does this belong to" on its own. The engine has one answer to each of these questions; this is the list, so a reviewer can hold a change against it.

- **Periods are calendar years, and period 0 may be a stub.** Period *n* is calendar year `start.year + n`, truncated at the front for *n* = 0, so `PeriodContext::year` is always a tax year. `new_plan_start` in the adapter puts a plan's start at the month it was created, because that is the month its balances were observed; a plan written in September therefore opens with a four-month period whose `fraction` is 4/12, and January plans are unchanged (#106). Everything scaled by a period is scaled by that fraction — flows through `overlap_fraction`, contribution caps, the RMD, and the period's return, which is compounded to the fraction rather than applied whole. The start has no editor on purpose: it is the date the balances are from, and letting the two disagree would be this bug in a new place. Since #109 it is not even a per-plan field — it is the household's `as_of`, one date for one set of balances, which every scenario composes its `sim_config.start` from. Moving it is the refresh's job, and only the refresh's (#111): `refresh_household` is the one writer that touches it, it can only move forwards and never past the current month, and it holds the two things a moved start would otherwise change silently — a `StepUp`'s escalation, which is pinned to the old start, and every start-dollar rate, which is re-stated in the new month's dollars and so is shown for the household to keep, grow or retype.
- **Boundaries are month-exact and end-exclusive.** A retirement dated 2038-08 means August is the first retired month: a salary ending `AtRetirement` pays January through July (7/12), spending starting there pays the other 5/12, and the two always sum to a whole year. A death at `month_at_age(life_expectancy_age)` works the same way, and so does `AtAge`. `overlap_fraction` in `sim/mod.rs` is the one proration primitive; every stream, contribution entry, working share and the survivor step-down goes through it.
- **Two words for the year a boundary falls in.** The *stub year* is the calendar year containing the boundary, prorated; the *first full year* is the first period starting at or after it. `SimConfig::first_full_period_at_or_after` returns the latter and is what "at retirement" figures use, so a stub year is never read as a full year of spending (#29). It answers the same way about a stub *period 0*: a month at or before the plan start maps to period 0 only when the plan starts in January, so a household already retired when they wrote a September plan has its first full retirement year in period 1. `SimConfig::first_period_after` is strict and exists for one case: the survivor tax switch, where the year of the death still files jointly and the *next* period is the first that does not. The frontend mirrors the inclusive helper twice: `planData.ts`'s `firstFullPeriodAtOrAfter`, stub clause included, searches `projection.snapshots` directly for a case that needs it (a retirement predating the plan); everything else names a boundary's two years by calendar math alone, through `yearBoundary` in `src/lib/yearBoundary.ts`, since a real snapshot is not always in scope where a milestone or a year's status is labelled. The Plan screen's tiles (#107) each say which year they show: the milestone reads "end of `stubYear`" for a mid-year retirement, the year inspector's ages panel gets a `retires` status in the stub year (paralleling `dies`) and `retired` from the first full year, and the cover tile and "Why paths fail" card read at the first full year.
- **A stub period's tax is not scaled, and that is a decision.** `BracketTax` applies annual brackets and the whole standard deduction to whatever income a period holds, so a four-month period pays a lower effective rate than the household really pays on those months — in the world they are part of a full tax year. `tests/mid_year_start.rs` pins the figures on its test household. Scaling the thresholds would need the period's fraction inside `TaxModel::tax`, which the trait does not carry. Decided: document it and pin it with a test, so it is a stated choice rather than an oversight. It affects the one year the household is living through, and it is the same class of one-year convention as the final period running to December.
- **Statutory ages are "age attained during the calendar year"**, `year - birth.year`. Catch-up tiers, the SECURE 2.0 60–63 tier and the RMD beginning age all use it, which is the statutory rule.
- **Growth, tax and RMDs are whole-period operations.** Growth applies to the whole period's post-flow balance no matter when in the period a flow landed — for a stub, that is the period's own months: `compound(rate, fraction)` raises the period's return to its share of a year. Tax is one pass over the period's totals (#54); the RMD divides the prior period's closing balance, and period 0 has no prior period so it never takes one.
- **A one-time contribution lands once, in the period its month falls in**, and is grown to that period's start rather than to its month — the deflator's own exponent, so an amount typed in today's dollars reads back exactly in the real-dollar view. Like any other flow it then earns the whole period's return: $400,000 arriving in October at 7% is credited about $21,000 it did not earn that year. Documented rather than prorated, as for contributions. A month outside `[start, horizon)` never lands at all.
- **A snapshot carries two price levels, and a figure is divided by the one for the moment it describes** (#146). `deflator` is the price level at the period's start, `(1 + inflation)^years_elapsed`; `deflator_end` is at its end, `(1 + inflation)^(years_elapsed + fraction)`, which is the next period's `deflator` because periods tile the timeline (for a stub period 0 it is the factor at the January the stub runs to, not a year on). Flows — income, expenses, taxes, contributions, growth — are grown by the same exponent as `deflator`, so they deflate exactly by it. `balances` and `net_worth` are end-of-period figures and take `deflator_end`: divided by the start factor they would carry a year of inflation the factor does not remove, reading every real balance about 3% high at the default assumption. An account earning exactly the inflation rate is the pin — flat in real dollars, in every period including a stub — and `tests/real_dollars.rs` holds it to 1e-9. `PeriodPercentiles` carries the same pair, and its percentiles are net worth, so they take the end factor. The frontend picks by name, `flowDivisor` or `balanceDivisor` in `src/lib/deflate.ts`, never by field, because the wrong one type-checks and looks plausible on screen. `coverYears` is the one ratio of the two and is deliberately taken from the nominal figures.
- **The final period runs to December.** The horizon is `Plan::end_month`, the last survivor's death month, which is rarely January; the last period is the calendar year it falls in. Streams stop at the horizon, but that year's growth, tax and any required distribution are computed for the whole year, so "at plan end" figures include the months after the last death. Documented rather than fixed: it moves one figure, on one year, by a few percent. The fraction-scaled growth #106 added does *not* reach it — the last period is a whole calendar year by construction, so its fraction is 1; making the tail exact would mean truncating the final period the way period 0 is truncated, which is a separate change and not one anything currently needs.
- **Monthly periods are not supported.** `PeriodLength::Month` stays in the schema so nothing migrates, but running it would apply annual brackets to one month of income, cut every contribution cap to a twelfth, switch filing status the month after a death, and compute RMDs on the prior month's balance.

### Returns

#### Growth is one number per strategy

Growth was originally modelled in two layers: four per-asset-class returns and
volatilities on `Assumptions` (`UsEquity`, `IntlEquity`, `GlobalEquity`,
`UsBonds`), and per-account weights over those classes, which the growth step
averaged every period. Picking "Moderate" therefore never set a return — it
selected a weighting recipe over four numbers that had to be kept true
separately, in order to derive three that could have been typed directly.

That layer was removed in #129, for two reasons.

**Nothing read it.** No tax, drawdown, RMD, dividend or rebalancing logic ever
branched on an asset class: the ordinary-versus-capital-gains split is keyed to
`AccountKind` and cost basis, and there is no rebalancing code at all. The
engine only ever consumed the weighted average, so the four numbers bought no
behaviour the three could not express.

**The blend was less honest than a portfolio-level figure.** `StochasticReturns`
drew each asset class independently, which implied portfolio standard
deviations of about 12.4 / 9.7 / 9.0 — roughly three points too narrow at the
aggressive end, because independent draws let equity diversify against equity.
Stating a whole-portfolio figure directly cannot make that mistake.

Two consequences worth knowing:

- **Strategies are perfectly correlated in Monte Carlo**, by one shared market
  shock per `(period, path)` scaled by each strategy's own sigma. Real
  portfolios of the same funds run about 0.95–0.99, so 1.0 is the better of the
  two approximations available without a correlation matrix, and it errs
  towards caution. Drawing strategies independently was measured at +7.5 points
  of success rate on the seed household — a household spanning two strategies
  diversifying against itself.
- **Volatility stays user-editable**, one figure per strategy, preserving what
  #52 established: the fan's width must not come from numbers nobody can see.

Old files still say `UsEquity` and friends; `model/legacy.rs` reads them, once,
through `AssumptionsWire` and `AllocationRefWire`, and nothing at simulate time
touches it. `AllocationRef::FixedRate` prices an account on its own nominal
rate instead of a strategy's — a savings rate, a CD ladder, or a blend the three
strategies don't describe.

#### The return is an arithmetic mean, not a compound rate

`Assumptions::strategy_returns` is the expected return of a **single year**, and
`StochasticReturns` uses it that way: each `(period, path)` draws one market
shock and *adds* `σ · shock` to the period mean, so the draws are symmetric
about the typed figure and their average is it. Periods are calendar years
(`MONTHS_PER_PERIOD = 12`), so no rescaling hides this.

A sequence of such years does not compound at that figure. The median of a
product of independent draws is `exp(E[ln(1+r)])`, and to second order
`E[ln(1+r)] ≈ ln(1+μ) − σ²/(2(1+μ)²)`. At the aggressive defaults (μ = 7.5%,
σ = 15.5%) that is **6.4%** — over a point below the 7.5% the deterministic
projection compounds directly, because the deterministic run reads the same
number as a certainty and has no variance to drag on it.

So the deterministic line is not the Monte Carlo median, and is not meant to
be: the two answer "what if every year is average" and "what does the middle
path do when years vary". The gap is variance drag, and it is the honest
consequence of having stated a volatility at all.

**What that is worth in dollars.** Measured on `presets::seed_plan` — 58
periods, 20,000 paths — the deterministic run ends at **$29.2M** while the
Monte Carlo median ends at **$6.6M** and the 10th percentile at zero. The
line is **4.4× the median**, on a plan whose probability of success is
**61%**. Drag alone explains less than half of that: at the aggressive
strategy's 7.5% against its 6.4% median CAGR, `(1.075/1.064)^58 ≈ 1.8×`. The
remaining 2.4× is spending: a portfolio being drawn on has a floor and no
ceiling above it, so a path that dips early depletes, *stays* at zero, and
no later good decade brings it back. Both numbers are true, about different
things, and a screen showing both has to say which is which (#144).

**And how it compares to the published studies.** Configured to the Trinity
study's setup — 4% inflation-adjusted withdrawal, 30 years, one 50/50
portfolio, no tax — the engine reports **85.7%** success at Trinity-era
return assumptions (7.7% nominal, 11.0% volatility, 3.1% inflation), against
the study's published ~95%; **71.5%** at the shipped conservative defaults
(5.9% / 9.0% / 3.0%); and **100%** at those same means with the volatility
taken out. The withdrawal-rate ladder at Trinity-era assumptions runs 3.0% →
97.5%, 3.5% → 93.4%, 4.0% → 85.7%, 4.5% → 75.3%, 5.0% → 62.0%.

Those are two different gaps. The **nine points** at matched assumptions are
i.i.d.-normal draws against historical sequences: real markets mean-revert
and the engine's do not, so it has no mechanism for recovering from a bad
decade, and it errs towards caution. The drop from there to 71.5% is not the
model at all — it is the shipped conservative return sitting about two points
of *real* return below what Trinity's historical window delivered. Neither is
a defect to fix. But anyone who has internalised "4% is 95% safe" will find
this app alarming for reasons that are modelling choices rather than facts
about their plan. (The comparison reconstructs the study's assumptions from
its published description. Nine points is the right order of magnitude for
i.i.d. against historical sequence, not a precise measurement of it.)

Two alternatives were weighed and rejected:

- **Draw log-normally** — `(1+μ)·exp(σZ − σ²/2)` — so the median path compounds
  at μ. That changes the answer rather than the explanation, and it would move
  every saved plan's reported probability of success. `default_strategy_volatility`
  documents paying that cost once, deliberately, because the old number was
  *wrong*; the arithmetic convention is not wrong, only undocumented, and does
  not earn the same exception.
- **Treat the typed figure as geometric** and add `σ²/2` back before drawing.
  That quietly makes the aggressive strategy an 8.7% arithmetic mean while the
  pane says 7.5% — the exact opposite of the #52 rule that the fan's width must
  not come from numbers nobody can see.

The convention therefore stays arithmetic and the UI says so instead, in
three places (#132, #144):

- **At the input.** `src/lib/returns.ts` derives the implied median
  compounded rate and the implied real return, and `AssumptionsSection`
  prints both next to the figure they qualify.
- **At the chart.** `DETERMINISTIC_LINE_NOTE` (`charts/planData.ts`) names
  the net-worth line, under the legend on the Plan screen and above the same
  chart in the printable report — the two surfaces that draw that line, the
  report being the one that travels away from the Monte Carlo toggle. It is
  gated on `hasVolatility`: at σ = 0 the deterministic run *is* the median
  path and the sentence would be false.
- **At the year.** `medianGapNote` restates it as a measured multiple in the
  year inspector, under the percentile block, where that year's
  deterministic figure and its median path are already side by side. A
  median of zero is reported as depletion rather than divided by.

None of this is said near the success rate itself. The tile already reports
a count of paths ("61% · of 20,000 paths"), which is what it is about; the
number that needed qualifying is the one drawn as a single confident line.

### Contributions

#### Limits (`sim/contributions.rs`)

Statutory limits are granted **per person per year**, shared across a bucket of that person's accounts — not per account. Clamping per account let one person defer the elective-deferral limit once for each employer plan they hold, overstating the ending balance and understating taxable income (the same figure feeds the pre-tax deduction).

Two independent buckets, named directly by `Account::plan_type`: **employer plans** (401(k)/403(b)/TSP elective deferrals) and **IRAs** (traditional and Roth share one cap with each other). `PlanType::None` accounts — taxable brokerages — join no bucket. The bucket used to be *inferred* from whichever statutory figure the account's user-typed limit sat nearer, which mis-bucketed a 457(b) and any hand-typed figure near neither; the engine now owns the limits and reads the bucket from a field.

When a person's accounts collectively ask for more than the shared cap, room is handed out **in plan account order**: the first account listed fills first. The split is resolved **per period**, not once: salaries grow, limits index, and catch-up tiers turn on with age, so what fits is a function of the year. Clamp warnings are deduplicated by account and report the first period the clamp bit.

The figures come from `TaxFigures::contribution_limits` (see "Tax figures"), and `TaxFigures::annual_limit` indexes them forward from `tax_year` at the plan's inflation rate, rounding down to the statutory increment ($500, or $100 for the IRA catch-up) so limits step the way the real schedule does. Catch-up is automatic from the owner's `birth`: the age-50 tier, and the SECURE 2.0 tier that replaces it for the years they turn 60 through 63. The figures' `tax_year` is surfaced in the UI rather than implying they are live.

#### Dated contributions (`sim/contributions.rs`)

An account's contributions are a **list of dated entries** (#78), each a `ContributionRule` over a `StreamBoundary` window — the vocabulary streams already had. `simulate` resolves every entry's boundaries once, up front, exactly as it does streams; an entry pinned to a person who has since been deleted contributes nothing and reports `ContributionBoundaryUnresolved` for its account. Per period each entry is prorated by `active`, its overlap with the period, and entries on one account sum before the clamp — so `contributions_by_account`, the clamp, and its warning stay per account and no consumer had to change.

**The owner's working share is no longer a gate on their own contributions.** It used to be applied implicitly to every account; now the entry's `end` is the single source of truth, and the migration writes `AtRetirement(owner)` as that end so an older plan projects identically. A spousal IRA on the working spouse's compensation, or an HSA under HDHP coverage, can therefore be written down by ending later; validation refuses that only for the plan types that need an employer (`EmployerPlan`, `Plan457b`, `SimpleIra`, `SepIra`), since those dollars come out of a paycheck.

`PercentOfSalary` is the mode with a trap. The salary it resolves against is already prorated to the months the owner worked, so an entry is scaled by `min(1, active / working_share)` — months of salary the entry covers over months of salary earned — not by `active` a second time, which would dock a partial retirement year twice. A full working year gives 1; an entry ending at retirement gives 1 in the retirement year; an entry starting in July of a full year gives ½; with no working months there is no salary for a percentage to be of, whatever owned income (a pension) the period holds. `FlatAmount` and `FederalMaximum` are simply the annual figure times `active`.

The **statutory cap is not prorated by the working share** either — only by the period length. The statute does not prorate a limit for a partial year of work, and an IRA funded after retirement needs a non-zero cap. The employer match and the 415(c) cap keep the working share: both are bound to salary, and a match on months not worked is not a thing.

Migration goes through `AccountWire` like every shape change before it: the tuple-shaped pre-#78 rule survives as a private `LegacyContributionRule` read only there, `SCHEMA_VERSION` is unchanged because nothing migrates behind it, and the dated list wins whenever present.

**Escalation (#79)** is two typed fields, each inside the one variant it belongs to — no generic schedule DSL, and nothing that can be written on a mode it does not mean anything for.

`PercentOfSalary::step_up` is 401(k) auto-escalation, the "10% now, up a point a year until 15%" a plan document literally says: `percent_in_period = min(cap, percent + points_per_year × whole_years_since(entry start))`. Whole years, because a plan escalates on an anniversary rather than continuously, and from the **entry's** resolved start rather than the plan's — so "open a Roth in 2029 at 5%, +1/yr" is 5% in 2029, not 5% plus the steps it never took. Validation refuses a step-up that cannot step: `points_per_year > 0` and `percent ≤ cap ≤ 1`, since a cap below the starting percentage is exactly the silent no-op a typed escalation must not become. Stepping *down* is not modelled, and `FederalMaximum` has no equivalent — the statutory table already indexes and steps up at 50 and 60.

`FlatAmount::growth` is the standing transfer the owner actually raises each year. It uses `growth_factor` from **plan** start, the same convention `CashFlowStream::annual_amount` follows: the amount is in simulation-start dollars, so `Inflation` means "holds what it buys today" whichever year the entry begins, rather than "holds what it buys in the entry's first year". The default is `GrowthRule::None` — the nominal transfer `FlatAmount` has always been — and `Fixed` is accepted by the model but not offered by the UI, as for streams.

Both fields are `#[serde(default)]` members of the struct variants #78 introduced, which is what makes escalation purely additive: a plan written with neither key loads as the unescalated rules it meant, and `SCHEMA_VERSION` does not move.

**The UI edits entries on the account** (#80–#82): contributions and the employer match live on the account card rather than in a separate pane, each entry carrying its own rule, window and escalation controls. One convention is display-only and deliberately not persisted — a flat amount can be typed per month or per year, but `AmountField` always reads and writes the **annual** figure, so the unit toggle is local component state and the schema stays one number per entry.

The demo household (#83) is the worked example of all three: the joint brokerage runs two overlapping entries that sum ($6,000/yr from plan start, plus $8,400/yr from January 2027), Alex's 401(k) steps up a point a year from 10% to 15%, and Alex's Roth IRA is an account with a zero balance and a `FederalMaximum` entry that does not open until 2029.

#### One-time contributions (`sim/period.rs`)

A house sale or an inheritance: money that arrives from outside the plan, once, into one account. It is deliberately **not** a `Contribution` with a one-month window. A contribution is paid out of household cash — `settle` subtracts it from the period's income, and a year whose income cannot cover it draws the difference from the portfolio — so a $350,000 sale entered that way would sell investments to fund itself and leave net worth roughly where it was. `OneTimeContribution` takes the employer match's shape instead. `deposit_one_time`, a step run right after `contribute`, adds the amount to the account's balance, and to its cost basis when the account is `Taxable`: these are after-tax dollars, and without basis a later withdrawal would tax them again as gain. It touches nothing else — not income, not tax, not `contributions`, not surplus — so the `income = outflow + surplus` identity is untouched, and `PeriodSnapshot::one_time_contributions` sits outside it beside `employer_match`.

**Only a brokerage or savings account can receive one.** Every other account caps what can go in each year, and a lump sum held to that cap would silently lose the rest, so validation refuses the combination rather than modelling a rollover. Anything the money carried with it — tax on a gain beyond the §121 exclusion, a mortgage paid off at closing, selling costs — is the household's to net out before typing the amount, and the card says so.

**The date is a `StreamBoundary`, narrowed by validation.** A specific month, or someone's retirement, age or death, so "sell when we retire" moves with the retirement date, in the What-if sandbox too. `PlanStart` is refused: the start moves forward at every refresh, past money the refreshed balances already hold, and the same sum would land again — the class of problem the `PlanStart` pin in `refresh.rs` exists for. `PlanEnd` is refused because the horizon is exclusive and nothing lands there. A month outside `[start, horizon)` is never deposited and raises no warning, since before the start is exactly where a sale ends up once it has happened and the balances holding it are refreshed; the editor says so in words, and the Refresh screen names any entry a new start is about to move past.

**The amount follows the stream convention.** Under `GrowthRule::Inflation` it is in start dollars — "what we would net if we sold today" — grown by `growth_factor` to the start of the period it lands in. `None` is the exact nominal figure. New entries default to `Inflation`, unlike `FlatAmount`'s `None`: a standing transfer is a fixed number of dollars, but a sale years away is estimated from what the house would fetch now. Being a start-dollar figure, it is listed on the Refresh screen as a rate to keep, grow or retype (`RateTarget::OneTimeContribution`).

**It is scenario policy.** Selling the house is a choice one branch makes and another does not, so the list lives on `AccountPolicy` beside the recurring entries — `#[serde(default)]`, so every household file written before it loads unchanged and `SCHEMA_VERSION` does not move.

**The engine says what landed when.** `Projection::one_time` lists each deposit — account, entry, name, period, nominal amount — so the year inspector (which shows it beside market growth, the other figure that explains net worth without passing through household cash), the cash-flow notes and the CSV export never re-derive which year a retirement-dated sale falls in.

**Names, and the #78 decision they reverse.** A one-time entry carries a `name`, because "$350,000 in April 2042" says when and how much but never why. Recurring entries gained an optional `name` at the same time. They were deliberately left unnamed when #78 dated them — a name would be one more thing to keep true after the dates change — but the legend still derives the rule and window and shows a name beside them rather than instead of them, so a name only ever says what the entry is for and moving its dates cannot make it wrong.

**Known omissions.** The asset the money came from is not modelled before it is sold, so net worth jumps in the year a sale lands against a scenario that never counted the house; compare such scenarios on probability of success and depletion rather than on net worth. Modelling the house itself — in net worth, with its basis, the §121 exclusion and its mortgage — needs an illiquid asset container the drawdown cannot reach (see "Where the current design pushes back"), and its sale event should deposit through this path. The demo household's *Sell the house at retirement* scenario is the worked example, and its 2027 brokerage transfer is named *Car paid off*.

#### Employer match (`sim/contributions.rs`)

Tiers apply in order, each consuming the employee's deferral percentage until it runs out: `[{3%, 100%}, {2%, 50%}]` on an 8% deferral pays 3% + 1% = 4% of salary. The gate is the **person's** deferral percentage across all their employer plans, derived from what actually went in post-clamp — so a `FlatAmount` or `FederalMaximum` contribution still produces an effective percentage, and splitting deferrals between a Roth and a traditional 401(k) at one employer still earns one match on the combined figure.

Matched dollars are **not** held to the employee elective-deferral limit — applying it to them would silently destroy most of the match, which is the failure mode this exists to prevent. They are held to the 415(c) annual-additions cap instead, shared with the employee's own deferrals, and only the match gives way when it binds. 415(c) is statutorily per employer plan; with no employer grouping in the model it is applied per person, which is the stricter reading.

`MatchDestination` selects *which account receives the money*, not just a label: `AccountKind` is what the tax and drawdown paths read, so pre-tax dollars parked in a Roth account would be withdrawn untaxed. The declared account is preferred when its kind already agrees; otherwise the owner's first other employer-plan account of that kind takes it, and a `MatchUnallocated` warning fires when there is none — a Roth deferral account plus a pre-tax match account is how a real statement splits the two sources.

Employer money never passes through household cash, so it is `PeriodSnapshot::employer_match` rather than part of `contributions` — folding it in would break the `income = outflow + surplus` identity that `tests/properties.rs` pins.

### Taxes: bracket indexing (`strategies/tax.rs`)

`BracketTax` carries the plan's `inflation` rate and indexes its dollar figures forward by `(1 + inflation)^years`. The federal figures index from their own `TaxFigures::tax_year` — `federal_years_at_start + period`, so a plan starting in 2027 on 2026 figures is taxed on 2026's table grown a year — exactly as the contribution limits do (#135). The state schedule is the plan's own and has no tax year, so it indexes from period 0. Without indexing, a household with flat *real* income drifted into ever-higher *nominal* brackets against a standard deduction that never grew, which was the largest numerical error the month/year audit found: bracket creep alone pushed the seed plan's effective rate from 17.7% to 27.6% over the projection (#105).

The federal ordinary brackets, the standard deduction and the capital-gains brackets floor to a $25 increment as they index (`indexed_federal_amount`/`indexed_federal_brackets`), so a table steps the way the real statutory schedule does rather than drifting continuously — the same intent as the contribution limits' $500 rounding, reusing `presets::index_to`. $25, not the $50 the IRS uses for a joint return: every built-in federal figure is an exact multiple of $25 for *both* filing statuses (Married figures split evenly at $50; Single figures — `$201,775`, `$256,225` for 2026 — are the real published thresholds and only divide evenly at $25). Flooring to $50 would clip those the moment indexing started. In the figures' own tax year the value is returned untouched, so the table a user typed is the table in force.

The state schedule (`StateTaxProfile`) indexes too, by the raw compounding factor with **no floor** (`scaled_state_amount`/`scaled_state_brackets`). State figures are approximate presets (`state_tax_data`) or a user's own hand-edited numbers, not a table with a known statutory rounding rule — California's real `$11,079` first rung is not a multiple of any round increment, and flooring it to an invented one would clip it the same way a $50 federal floor would have. A per-state flag to disable indexing (some states do not index) is out of scope.

**How one period's federal tax is assembled.** Realized gains count toward Social Security provisional income (Pub 915 Worksheet 1 line 3 is *all* other income in AGI, not ordinary income alone), so the benefit's taxable share is computed on `ordinary + capital_gains`. The standard deduction then comes off **total** income — ordinary plus taxable Social Security plus gains — as Form 1040 line 15 does, and the gain actually taxed is bounded by what is left: `gains_taxed = min(gains, taxable_income)`, the ordinary remainder being `taxable_income - gains_taxed`. So a deduction that ordinary income cannot absorb is not lost; it shelters gain, and a household with no ordinary income and $200,000 of gains is taxed on $167,800, not $200,000. The gain is then stacked on the ordinary remainder through the LTCG schedule, which is the Qualified Dividends and Capital Gain Tax Worksheet's own order. When ordinary income already reaches the deduction this is identical to subtracting the deduction from ordinary income alone, which is why the error went unseen for households that draw pre-tax money or a salary (#142). The state base was already `ordinary + capital_gains` against the state deduction and is unchanged.

**The standard deduction has an age dimension (#143).** Each filer who has attained 65 by the end of the tax year adds the additional standard deduction (IRC 63(f)) to the base one: $1,650 each on a joint return and $2,050 on a Single one for 2026, so a couple both 65+ deduct $35,500 and a Single filer $18,150. The dollar amounts are published annually and so live in `TaxFigures::federal.additional_standard_deduction_65` (`ByFilingStatus`, per person), indexed and floored on their own like the base; the age itself is statute and is `SENIOR_AGE` in `strategies/tax.rs`. A `tax-figures.yaml` written before the figure existed still loads, taking the published 2026 amounts through a `serde(default)` — the alternative is a file that fails to parse and drops every figure the user edited back to the built-ins.

`BracketTax` therefore has to know who is on the return: it carries `start_year` and the `filer_birth_years` of the people it files for, the same plumbing `inflation` needed in #105. Age is the age *attained during* the calendar year (`year - birth year`), the rule the catch-up contributions already use, so a filer takes the amount for the whole of the year they turn 65. At most one amount per signer is taken — two on a joint return, one otherwise — because the filing status is an assumption, not derived from how many people the plan lists. `tax_model` in `lib.rs` hands the household's `BracketTax` everyone, which is right through the year of the first death (the survivor still files jointly that year), and the survivor's Single one only the people who outlive that death. The decedent's birth year does not follow the household onto the Single return, and the Single figure is the larger per head. Not modelled: the extra amount for blindness, and a spouse a joint-filing plan does not list, whose age is unknown and so contributes nothing.

**The OBBBA senior deduction is deliberately not modelled.** The One Big Beautiful Bill Act added $6,000 per person 65+ ($12,000 joint), but for tax years 2025–2028 only, not indexed, and phasing out at 6% of MAGI over $75,000 single / $150,000 joint. It would put a sunset and a phase-out into `TaxFigures` to serve a four-year window that has closed before the retired years of a household whose 65th birthdays fall in the 2040s, which is what this app's plans are typically about. The cost of leaving it out is stated rather than hidden: a household already 65+ in 2025–2028 pays $1,800–$3,650 a year more in those years than the law asks, and nobody else is affected. Revisit only if the window is extended.

**Deliberately not indexed:** the Social Security provisional-income thresholds (`social_security_thresholds` in `strategies/tax.rs`) — fixed by statute, unchanged since 1993. Both of `SurvivorTax`'s `BracketTax`es carry the same `inflation` and figures, so indexing runs identically on either side of the filing-status switch.

### Early withdrawal (`sim/early_access.rs`)

Money taken out of a retirement account before the owner may take it freely costs more, and the engine did not charge it until the drawdown order arrived: any plan retiring before 59½ drew pre-tax dollars for free and projected better than it should. Two rules, asked separately because the statute asks them separately:

- **Non-qualified.** A Roth's *earnings* drawn before 59½ are ordinary income. Nothing short of the age exempts them, the Rule of 55 included. Contributions — `Account::cost_basis` on a Roth — come back untaxed at any age: a Roth IRA pays them out first, a Roth employer plan pro rata, and a blank figure reads as zero, so the whole balance is earnings. The five-year clock is not modelled.
- **Penalized.** The 10% additional tax of IRC §72(t), on pre-tax dollars and on non-qualified Roth earnings. It has exemptions the income tax does not: a 457(b) is never subject to it, and the **Rule of 55** frees an employer plan whose owner separates from service in or after the calendar year they turn 55.

The Rule of 55 is **opt-in per account** (`Account::rule_of_55`) and checked rather than taken on trust — the model cannot tell which employer an account came from, so the election says "this one", and the engine verifies the account is a `PlanType::EmployerPlan` and that the owner's `retirement` falls in or after that year. An election that does not hold is reported as `Rule55Ineligible` with its reason and **not** honoured; a mistyped retirement date should not quietly waive a penalty. A rollover into an IRA loses the exemption, which is why `PlanType::Ira` never qualifies.

Each rule resolves once per run to the month it stops applying — an `EarlyAccess` on each `AccountState` — and `mark_early_access` turns it into a share of each period, so a period straddling the month is split at it on the same assumption every proration makes: that a year's withdrawals are spread evenly through it. A strategy drawing for only part of a period narrows the share to its own months, which is how the phase beginning at 59½ avoids the penalty in the year of the birthday.

The penalty is charged **inside the gross-up but outside the `TaxModel`**: it is a flat 10% of a known amount, so it never interacts with the brackets, no `TaxModel` impl has to know about it, and `PeriodSnapshot::early_withdrawal_penalty` is an exact share of the bill rather than an allocation. Because it is linear in the draw, the fixed point converges exactly as before.

Out of scope, and each a place a plan would read better than reality: 72(t)/SEPP, the public-safety age-50 rule, the SIMPLE IRA's 25% first-two-years rule, the Roth five-year clock, state additional taxes, and HSA non-medical withdrawals — which `AccountKind::Hsa` already assumes do not happen.

### Required minimum distributions (`sim/required_distributions.rs`)

Every other outflow is demand-driven — `DrawdownStrategy::withdraw` is only reached when a period's cash is negative. A retiree whose Social Security and pension cover their spending would therefore never touch a seven-figure 401(k), and the plan would show a tax bill that never arrives. RMDs are the one step that moves money because the calendar says so, which is why they are a **step** rather than a strategy impl.

`presets::rmd_age` is the SECURE 2.0 birth-year lookup (73 for 1951–1959, 75 for 1960 and later; 72 for cohorts already distributing) and `presets::uniform_lifetime_divisor` is the IRS Uniform Lifetime Table. Neither goes through `index_to` — one is an age and the other a mortality divisor, and indexing them with inflation would be a quiet, plausible-looking error next to the dollar figures that *do* index.

The conventions, each a choice: age *attained during* the calendar year, matching the statute and the catch-up precedent; the **prior period's closing balance** as the stand-in for the prior 31 December balance, which means the first projection period takes nothing (there is no prior); `TraditionalPreTax` only, since Roth accounts have no lifetime RMD; and one figure per owner over their aggregate pre-tax balance, satisfied **pro rata** across their accounts — the model has no IRA-versus-401(k) grouping, so pro rata is the simplification that leaves the portfolio's shape undisturbed and does not depend on listing order. A deceased owner keeps distributing on their own schedule: wrong in detail, but the alternative is an inherited pre-tax balance compounding untaxed to the end of the projection. Beneficiary RMDs, the 25% excise tax, QCDs and IRMAA are deliberately out of scope.

**Reinvestment does not honour `sweep_surplus_from`, and that is the point.** For ordinary surplus the boundary is harmless: un-swept surplus is income that never entered an account, so leaving it out changes no balance. A distribution is the opposite case — the money has already left the pre-tax balance, and with nothing to receive it net worth would fall by the full distribution every year and the engine would report destroyed wealth as a failing plan. So the forced share is redeposited unconditionally into the reinvestment account — `reinvest_into`, or the first `Taxable` account when that is unset — basis *and* balance: these are after-tax dollars, and skipping the basis taxes them again as gain. It is capped at the period's surplus, because RMD dollars fund spending like any other income. With nowhere to put the money, `RequiredDistributionUnallocated` says so — a louder warning than `SurplusUnallocated` for a materially worse outcome.

Because the distribution enters `base_income` before `settle` runs, it is taxed in the same single pass as everything else: it stacks on the household's real marginal rate and drags Social Security into taxability. That is the whole finding RMDs exist to surface, and it is only expressible because #54 landed first. In a shortfall year the distribution counts as cash *toward* the need rather than being taken on top of it, so the household draws `max(need, RMD)` and not their sum.

Downstream, `PeriodSnapshot::required_distributions` is the forced share of `withdrawals`, not an addition to it. The Plan screen's year inspector breaks it out beneath Withdrawals, and `cashFlowSummary` subtracts it before testing for the retirement crossover — otherwise the year an owner turns 73 would read as the year they started living off their portfolio, for a household that changed nothing.

### Social Security (`model/social_security.rs`)

A benefit is the PIA from the user's statement plus a claiming age, resolved
into a plain income stream by `to_stream` so the sim loop never knows Social
Security exists. `adjustment_factor` is SSA's graduated schedule — +2/3 of 1%
per month delayed past FRA, −5/9 of 1% for each of the first 36 months early
and −5/12 of 1% beyond that — and it works in **months**, not years.

That matters because full retirement age is not a whole number of years for
everyone. The 1983 amendments raised it from 65 to 67 in two-month steps, so
births in 1938–1942 and 1955–1959 land mid-year: someone born in 1957 reaches
FRA at 66 years 6 months. Until #149 the field was a `u8`, which gave those
cohorts no way to enter their own age — rounding to 66 overstated a benefit
claimed at 62 by 3.4%, rounding to 67 understated it by 3.6%, for life, on one
of the largest levers the app has.

`FullRetirementAge` therefore carries years *and* months, and
`full_retirement_age` is an `Option`: `None` takes
`FullRetirementAge::for_birth_year`, the published table, from the birth month
already on `Person`. This is the same shape of birth-year lookup as
`presets::rmd_age` and lives in code for the same reason — fixed law with no
annual publication. Deriving it removes an input rather than adding one, which
is also how the wrong value stops being enterable in the first place; `Some` is
kept as an override for a user whose statement says something else.

The `Option` is what preserves the upgrade invariant. Every plan saved before
#149 wrote the field out, so its whole-year scalar deserializes (through
`FullRetirementAgeWire`, the same hand-written-`Deserialize` idiom as
`AllocationRef`) to N years and **zero** months — exactly the age it was
already projected with. Only a new benefit, or one the user clears the
override on, picks up the corrected table.

### Surplus has two regimes (`Assumptions::sweep_surplus_from`)

A period's leftover cash is one arithmetic result standing for two different quantities, and the boolean this replaced (#50) could only be right about one of them at a time.

**While the household is working, surplus is current spending.** This app takes savings as the input and lets spending fall out as the residual: contributions are budgeted exactly and typed in, the grocery bill is not, and nothing in the engine throttles a contribution for affordability. A plan with no expense streams is therefore not missing data — its working-phase surplus *is* the household budget, and sweeping it into a brokerage would invent wealth out of money already spent. **In retirement it is real**: income is largely fixed, spending is the thing being modelled, and leftover cash genuinely is reinvested — so not sweeping it understates the portfolio for every retirement year.

`Option<StreamBoundary>` states the split with no new vocabulary: `None` never sweeps, `Some(PlanStart)` always does, `Some(AtRetirement(p))` names *whose* retirement divides them — which a household with staggered dates has to answer, and a phase flag could not. `resolve_boundary` already turns any of them into a month; the sweep begins with the first period that *starts* on or after it, so a retirement landing mid-period does not bank the part of that period the household was still earning through. An unresolvable boundary (a deleted person) falls back to never, loudly, via `SweepBoundaryUnresolved` — the alternative fallback would quietly pour decades of working-phase spending into the portfolio. Where the swept money lands is `reinvest_into`: an explicit account, or the first `Taxable` account in plan order when unset (#58). With more than one taxable account, naming one keeps "which account" from being an accident of listing order, and it changes how the money grows and what later withdrawals cost in tax.

The rejected alternative is asking for a full budget so the residual disappears. It demands budgeting work this tool deliberately does not ask for, in order to recover a number the engine already derives — and that number has a better use. `lib/currentSpending.ts` reads it back off the last full working period as the seed for the retirement expense stream, deflated to today's dollars, which turns the one input a projection cannot do without into a prefilled figure. It holds only if every dollar the household saves is modelled here, since the engine cannot tell unmodelled saving from spending; the UI carries that caveat wherever the number appears, and the same working/retired split renames the year inspector's surplus row.

### Plan horizon (`Plan::end_month`)

The projection runs to `max` over every person's `month_at_age(life_expectancy_age)` — the last survivor, not a single household age. `StreamBoundary::AtDeath(person)` resolves against that person's own figure. The household-wide `Assumptions::plan_end_age` it replaced survives only as the deserialization fallback for plans written before per-person expectancy existed, resolved in `Plan`'s custom `Deserialize` via `PersonWire`. The last period is the calendar year that month falls in and runs to its December — see "The final period runs to December" under Time conventions.

### The survivor transition (`sim/survivor.rs`)

Mortality here is an assumption (`Person::life_expectancy_age`), not a draw, so the first death is a known month before the loop starts — which is what lets the tax model precompute when filing status changes instead of threading household state through the loop. `Plan::first_death` is the first death *that leaves someone behind*: `None` for a one-person plan, and also when everyone's expectancy lands in the same month, since nothing transitions with no survivor.

Almost everything the transition does is expressed as `CashFlowStream`s the main loop already runs, so it adds **no branch to the simulation loop**. Two things cannot be: the expense step-down (a per-period factor) and the filing-status change (a `TaxModel`).

**Social Security.** The household stops drawing two benefits and the survivor keeps the larger. Four simplifications, stated because they are user-visible: the larger benefit is picked in today's dollars (the same ranking as at the transition month whenever both share a COLA, which they do unless one sets `cola_override`); a survivor who has their own benefit steps up no earlier than their own claiming month, since the real "survivor benefit at 60, delay your own to 70" move needs a reduction schedule this engine does not model, and claiming later is the conservative error; a survivor with *no* benefit of their own inherits the decedent's from the death itself, because modelling nothing would be plainly wrong for a one-earner household; and a household leaving *more than one* survivor is left alone entirely — a survivor benefit goes to a spouse, this model has no relationships in it, and handing it to each of two survivors is worse than not modelling it.

**Filing status.** `SurvivorTax` wraps two `BracketTax` and switches at `SimConfig::first_period_after(death)` — the period containing the death still files jointly, matching the IRS rule, and the next one does not. Only a joint filer has anything to lose, so a plan already filing Single gets no transition. The state schedule carries over unchanged: `StateTaxProfile` has no filing-status dimension, and inventing a survivor variant of the user's own brackets would be worse than leaving them alone.

**Expenses.** `survivor_expense_factor` scales the expense streams *no single person owns*. Expenses owned by a person are left alone — they are that person's own cost, and their `end` boundary already says when they stop. The default is 1.0, no step-down: the convention clusters at 0.70–0.80, and the engine deliberately does not seed one, so the number is always one the user chose.

**Pensions.** `CashFlowStream::survivor_percentage` overrides `end` in both directions at the owner's death: the full amount stops there even if `end` ran later, and the fraction continues to plan end under the same growth rule. A stream whose owner dies last is unaffected — there is no one for the continuation to run for. The UI's pension card is this same stream with `kind: Pension`: single life is an `AtDeath` end with no percentage, joint is `PlanEnd` plus a percentage (100% by default). The kind changes one thing in the engine — `growth` compounds from the pension's first payment (or the plan start, if it is already paying), and a survivor continuation keeps that anchor rather than restarting at the death — because a pension statement quotes the check at commencement, not in plan-start dollars. `General` streams are untouched, so no saved plan projects differently.

### What a run returns (`sim/projection.rs`)

```rust
pub struct PeriodSnapshot {
    pub period: usize,
    pub period_start: YearMonth,
    pub balances: BTreeMap<AccountId, f64>,              // nominal, end of period
    pub income: f64,
    pub income_by_stream: BTreeMap<StreamId, f64>,       // sums to `income`
    pub expenses: f64,
    pub expenses_by_stream: BTreeMap<StreamId, f64>,     // sums to `expenses`
    pub taxes: f64,
    pub withdrawal_taxes: f64,                           // the gross-up's share of `taxes`
    pub early_withdrawal_penalty: f64,                   // the 10%'s share of `withdrawal_taxes`
    pub drawdown_phase: Option<String>,                  // the phase in force at period start
    pub contributions: f64,
    pub contributions_by_account: BTreeMap<AccountId, f64>, // sums to `contributions`
    pub employer_match: f64,                  // outside the cash identity
    pub one_time_contributions: f64,          // outside the cash identity, like the match
    pub required_distributions: f64,          // the forced share of `withdrawals`
    pub surplus: f64,
    pub withdrawals: BTreeMap<AccountId, f64>,
    pub growth: f64,                          // market growth and savings interest (#61)
    pub net_worth: f64,
    pub deflator: f64,                        // price level at period start: divide flows by it
    pub deflator_end: f64,                    // at period end: divide balances and net worth by it
}

pub struct Projection {
    pub snapshots: Vec<PeriodSnapshot>,
    pub warnings: Vec<SimWarning>,   // DepletedFunds, ContributionClamped, …
    pub streams: Vec<StreamInfo>,    // every stream the run accrued, synthesized ones included
    pub one_time: Vec<OneTimeInfo>,  // each one-time deposit: account, entry, period, amount
}
```

`SimWarning` variants carry the numbers behind them (a clamp reports `period`, `requested` and `allowed`) because the UI renders warnings as text — `src/lib/warnings.ts` — rather than a count.

#### Attribution (#67)

The scalar totals are enough to show *how much* moved each year and nothing about *which* stream or account. The per-stream and per-account maps are decompositions of the scalars beside them — `tests/properties.rs` pins that each sums to its total — recorded in the one step that still knows the answer: `accrue_streams` is the only place a dollar of income knows its stream, and `contribute` the only place a contribution knows its account. Keys are the ids of the streams *as the engine ran them*, so a Social Security benefit or survivor continuation synthesized in `sim/survivor.rs` appears under its own id; `Projection::streams` lists every one with a readable name, which is what lets a view label them without mirroring the engine's id formats.

`withdrawal_taxes` is the one split of `taxes` the snapshot can honestly claim. The period's dollars meet the progressive schedule as a single stack (#54), and the drawdown reports what its gross-up *added* over the bill on base income; that addition is recorded, and nothing further is allocated. The engine never decides that "salary paid the tax", and the cash-flow composition diagram built on these fields is a hub for that reason — every inflow pools in the household and flows out from there. Employer match is deliberately outside the `income = outflow + surplus` identity, so it is not a flow in that diagram either.

`growth` records how much of each period's balance change was the market's (#61), which is what the Growth screen splits the plan into — money put in versus money the market added.

### Monte Carlo (`sim/monte_carlo.rs`)

A Monte Carlo run is `simulate` over `n_paths` values of `path_id`, in parallel with rayon. `StochasticReturns` holds no RNG state — the trait takes `&self` and paths run concurrently — so each call derives a fresh, reproducible seed from `(seed, path_id, period)`. Periods are independent draws; strategies share one market shock per `(period, path)` (see "Growth is one number per strategy"). `MonteCarloConfig { n_paths, seed }` has a `u32` seed so ts-rs emits a plain `number`: a `bigint` would not survive `JSON.stringify` over IPC.

`MonteCarloResult` carries the success rate (the fraction of paths that never depleted), per-period net-worth percentiles for the fan, and `MonteCarloDiagnostics`: when failed paths ran dry, and how failed and surviving paths compared on returns in the first five years of retirement and on withdrawal rate, anchored on the household's first full retirement year (#92). The "Why paths fail" card reads it. Every diagnostic is descriptive, not causal, and because draws are independent the model under-produces the clustered bad decade that sequence-of-returns risk is — so sequence-shaped failure is a floor here, not an estimate.

`RunControl` is the engine's whole interface to a run in flight: a progress counter of completed paths and a cancel flag, both plain atomics, so the engine stays free of IPC. The adapter samples the counter on a timer and sends it down a Tauri channel, and starting a run cancels the one before it.

The path count is a user setting in `settings.json` (Settings → Simulation): 5,000 by default, clamped to 100–100,000. Up to 5,000 paths the frontend re-runs after every edit; above that an edit marks the last result stale and the user runs on demand (#91). `run_monte_carlos` measures several scenarios at the **same config, seed included** — common random numbers, so the difference between two success rates is far less noisy than either rate's own margin. The Scenarios table and the What-if sandbox both use it; its scenarios run one after another, sharing one `RunControl`, so batch progress is one climbing number. The frontend's seed starts at 1 and is never persisted, so the same saved plan shows the same success rate on every launch; Re-roll draws a new one.

---

## 5. Adapter (`src-tauri`)

### Files on disk

```
<data root>/                         ~/Documents/Retirement Planner by default;
│                                    Settings → Plan storage moves it
├── tax-figures.yaml (+ .bak)        the yearly tax figures every household uses
└── plans/
    ├── <household id>.yaml (+ .bak) one household: facts and every scenario
    ├── .history/<household id>/     a pre-edit snapshot per session, last 20 kept
    ├── .refreshes/<household id>/   the household as it stood before each refresh,
    │                                named for the month it left; never pruned
    ├── .trash/                      a household whose last scenario was deleted
    ├── .v1/                         version-1 plan files, moved aside by #109
    └── migration-<date>.txt         what the v1 → v2 migration kept and dropped
```

`settings.json` lives in the OS app-config directory: the plans-folder override, the active scenario id, and the Monte Carlo path count. `RETIREMENT_DATA_DIR` (`settings.rs`) relocates *all* of this under one root — settings under `<root>/config`, data at the root — and has to cover settings too, since `settings.json` is where a chosen plans location is recorded: redirecting only the plans folder would let the real settings point a demo run straight back at real data. `pnpm demo` sets it to a throwaway copy of `fixtures/demo/`.

Moving the storage folder copies the household files forward, and the tax-figures file too unless the destination already has one of its own, which may be the user's and is left alone. Legacy pre-#13 JSON plans in the old app-data folder are copied forward on first launch (copy, never delete), and version-1 plan files become version-2 households (#109), with the originals moved to `.v1/`.

### Storage and composition (`storage.rs`)

Every plan command still takes and returns a `Plan`; `storage` composes one out of its household on the way out and decomposes it back on the way in. Files are keyed by the household's stable `id`, written atomically with a `.bak`, and `schema_version` is checked on load. Saving also fills siblings in: a scenario with no policy for an entity the save has gets a copy of the saved scenario's, and one for an entity the save no longer has is pruned — so an account opened in one scenario exists in all of them, at the policy it was opened with, and `compose` never has to invent a retirement date. Duplicating a scenario copies its *policy*; the balances are shared, not duplicated. A snapshot is the whole household file, so restoring one brings back the balances and every scenario together, and snapshots the current state first so the restore is itself undoable.

A fresh install bootstraps nothing: `load_plan` returns `None` and the frontend shows the welcome screen, which either creates a plan from the household the user describes (`create_plan`) or writes the invented example (`create_sample_plan`, from `presets::seed_plan`, carrying `Plan::sample` so it stays labelled as an example) (#103).

### The refresh (`refresh.rs`)

`refresh_household(request: RefreshRequest) -> Plan` is one sitting: the balances the household has just re-read, the month they read them, and the start-dollar rates they re-affirmed (#111). It is the only writer that moves `as_of`. In order:

1. Refuse a month before the balances on file or after this one.
2. **Append** a dated `Observation` for each account whose reading actually differs, leaving the rest at their own older dates. No estimate is rolled forward, now or later.
3. Replace each benefit's statement figure.
4. **Pin** every `PlanStart` contribution entry to `Date(old as_of)` before the start moves, so a `StepUp` that had escalated to 12% does not re-resolve to the new start and fall back to 10%.
5. Move `as_of`, which every scenario composes its `sim_config.start` from.
6. Write the re-affirmed rates — a stream's amount, a flat contribution's, a one-time contribution's — into the active scenario and, where asked, into every sibling whose figure for the same target still matched.
7. Validate the composed plan, copy the outgoing household whole into `plans/.refreshes/<household id>/<the month it is leaving>.yaml`, and save.

The pre-refresh copies are deliberately unpruned, unlike `.history`: each is the projection the household was living with the last time they looked, recorded at the only moments that matter, and together they are the baseline a plan-versus-actual view would read. Nothing here grows a figure on its own: the screen shows the inflation-grown number beside each rate and sends whichever one the user chose, so "keep" is the default and the honest act is typing the real one.

### Commands (`commands.rs`)

Every command is registered in `generate_handler!` in `src-tauri/src/lib.rs`. Grouped by what they serve:

- **Projection.** `run_projection(plan) -> Result<Projection, String>` is stateless: the frontend sends the whole plan (a few KB), the adapter validates it first and reads `tax-figures.yaml` on every call. `run_projections(plans) -> Vec<Result<Projection, String>>` does the same for several scenarios in one round-trip, one result each, so one invalid scenario does not blank the rest.
- **Monte Carlo.** `run_monte_carlo(plan, config, run_id, on_progress) -> Result<Option<MonteCarloResult>, String>` is async and runs on a blocking thread so the window stays live; it clamps `n_paths`, and `None` means cancelled. `run_monte_carlos` is the batch form described above. `cancel_monte_carlo(run_id)`, `get_monte_carlo_limits()` (the clamp range and the auto-run threshold), and `get_monte_carlo_paths()` / `set_monte_carlo_paths(paths)`.
- **Plans and scenarios.** `load_plan() -> Option<Plan>` loads the active scenario, falling back to the first stored one, after running the one-shot migrations; `load_plan_named(id)`, `save_plan(plan)`, `list_plans() -> Vec<PlanSummary>` (with `household_id`, `household_name` and `sample`, so the switcher groups by household without loading anything), `create_plan(name, people)`, `create_sample_plan()`, `duplicate_plan(id, new_name)`, `delete_plan(id)` (the household file moves to `.trash` when its last scenario goes, never unlinked) and `set_active_plan(id)`.
- **Household.** `get_household(id)` — the facts behind a scenario, including each balance's as-of date, which the `Plan` does not carry (#110) — and `refresh_household(request)`.
- **Snapshots.** `list_snapshots(id)` / `restore_snapshot(id, timestamp)`, for the household holding scenario `id`.
- **Tax figures.** `get_tax_figures()` returns the path, the figures in force, the built-in set and any load error; `save_tax_figures(figures)` validates and writes.
- **Presets and version.** `get_presets()` returns the default assumptions, the tax figures in force and the state tax profiles, so defaults live in one place (Rust) and the frontend never hardcodes a statutory figure. `engine_version()` is surfaced in the UI.
- **Storage.** `get_storage_info()`, `choose_storage_dir()` (a native folder picker), `set_storage_dir(path)` (copying plans and tax figures forward) and `reveal_storage_dir()`.
- **Export.** `export_plans()` writes a timestamped copy of the plans folder, tax figures included, to a folder the user picks. `export_text_file(suggested_name, contents)` is the CSV export's write side; the formatting lives on the frontend, which knows the display basis. `export_report_pdf(suggested_name)` (macOS only, `pdf.rs`) drives WKWebView's print pipeline headlessly — `@media print` in `App.css` decides what is isolated and how it paginates — because there is no cross-platform print-to-file API.

---

## 6. Frontend (`src/`)

- **One store.** `store/planStore.ts` (Zustand) holds the active scenario's plan and projection, the scenario list for the switcher, Monte Carlo state and UI state. Inputs and results are separate, so a stale projection is detectable. Edits debounce (300 ms) into a re-projection and an autosave, and the previous projection stays on screen while the next computes. Only the active scenario is held in memory; switching, duplicating and deleting round-trip through the backend.
- **Monte Carlo runs beside the deterministic projection**, never awaited with it, on the path count and auto-run threshold the backend reports. The chart's Monte Carlo band toggle is session-only.
- **Pure view-models.** Chart components draw from `*Data.ts` builders in `components/charts/` — plain functions from a `Projection` to chart rows, tested with vitest — so the charting library is not load-bearing.
- **The rail is labelled, and collapses to icons.** `Rail.tsx` holds the destinations in two named groups (`NAV_GROUPS`, Plan and Setup) with Report and Settings below them; collapsing is the same component with the labels dropped, not a second one. Which destination is current is `Dashboard`'s `destination` state — there is no router. Whether the rail is collapsed is a per-user display preference kept in the webview's `localStorage` (`lib/railPreference.ts`), not in `settings.json`: it is read synchronously, so the first paint is already the right width, where a value fetched over IPC would arrive after the rail had rendered at the default. It holds no financial data, so it sits outside the `RETIREMENT_DATA_DIR` root on purpose.
- **Real dollars are a division.** The today's-dollars toggle divides each flow by its snapshot's `deflator` and each balance or net worth by its `deflator_end` client-side (`lib/deflate.ts`); no engine round-trip.
- **Warnings are text.** `src/lib/warnings.ts` renders each `SimWarning` from the numbers it carries.
- **The What-if sandbox** (`lib/whatIf.ts`, `WhatIfScreen`) is a pure function from the saved plan and a set of knobs — whole-year retirement shifts, a spending scale, return, volatility and inflation shifts, longevity — to a hypothetical `Plan`. It has no store, no IPC and no persistence, because its one invariant is that a hypothetical never reaches disk; the only path to a file is `promoteToScenario`, which the user asks for by name. Both sides run at the same seed and path count, so the difference is the change and not the draw.
- **The report** (`ReportView`) is the Plan screen assembled once for printing or filing, exported to PDF through `export_report_pdf`. The CSV export is built on the frontend and written through `export_text_file`.
- **Staleness.** `lib/staleness.ts` tones the balances' as-of cue: plain under three months, a warning from three, a nudge to refresh from six (#110).
- **Generated types only.** Every engine type the frontend touches comes from `src/types/generated/`.

---

## 7. Extending the engine

### What slots in

- **A new trait impl.** A historical-sequence `ReturnModel` needs no trait change: `path_id` already threads through `returns_for` and maps onto a start-year index, and a blended per-strategy series carries that year's real cross-asset correlation for free. The ordered `DrawdownStrategy` this predicted — `PhasedDrawdown` — did land as another impl behind the trait, which gained one defaulted method (`phase`) so a snapshot can name the phase in force.
- **A new step.** A behavior that moves money because the calendar says so — as RMDs do — is a function over `PeriodState` in `sim/period.rs`, placed in the pipeline where its money has to be. One that feeds the period's income runs before `settle`, so it is inside the single tax pass.
- **A new field.** Schema changes go through the `*Wire` deserializers (`AccountWire`, `AssumptionsWire`, `PersonWire`) with `#[serde(default)]`, so a file written before the field loads as exactly what it meant and projects identically. That pattern is well established, and none of the extensions below needs a breaking schema change. Each new fact or choice has two possible homes since #109: a figure read off a statement — a loan balance, a property value — goes on the household with a dated observation, and a choice or an assumption — an appreciation rate, a sale year — goes on the scenario. An observation on the scenario side, or a scenario variable on the household, is the mistake to look for in review.
- **Tests for tax law.** The golden-file and property tests pin engine *mechanics*; they say nothing about whether a threshold is right. Anything that models a rule of tax law lands with hand-computed micro-cases in the style of `strategies/tax.rs`'s test module, where the arithmetic is checkable by reading.

### Where the current design pushes back

Five places where the engine currently gets to assume something for free, and a new feature would take that away.

1. **`net_worth` is the sum of account balances** (`PeriodState::snapshot`, `sim/period.rs`). Liabilities — a mortgage, a student loan — would redefine that figure for every existing plan, and it feeds the headline tiles, the comparison table's net-worth and delta columns, the Monte Carlo fan and every golden file. The change would be correct, but it is not additive the way a new field is: under the saved-output rule in `CLAUDE.md` it has to be announced and measured, not shipped as a quietly smaller number. Debt should be a container parallel to `Account`, never a negative balance in the account array, and amortization a step.
2. **Every drawdown can reach every account it is given.** `ProportionalDrawdown` sells from all of them in proportion to balance; `PhasedDrawdown` draws a stack first but falls back to everything the stack leaves out, and even a floor is released rather than held (`strategies/`). That is deliberate — a household with money left has not failed — but it means any new asset container is a liquidity question first: a house modelled as an account would be sold a slice at a time to cover a bad year, and counted as spendable in every depletion test and every success rate, overstating the one number people act on. An illiquid asset needs a container that contributes to net worth and to nothing the drawdown can reach. A **hard** floor is the same question in miniature, and the answer here was to make floors soft.
3. **The withdrawal gross-up assumes tax is continuous.** It is a fixed-point iteration, `gross = net_needed + marginal(gross)`, run up to 100 times and stopped when successive values converge (`strategies/drawdown.rs`). That is correct because every tax rule modelled today is continuous and monotone in income — the early-withdrawal penalty included, which is linear in the amount drawn, and an allocation is required to be continuous and non-decreasing for the same reason. A cliff — IRMAA, where one dollar of income can add about $1,000 a year of premium, or an ACA subsidy — can make the iteration oscillate, exhaust its rounds and return a `gross` that does not satisfy the equation, silently; and the equation can have *no* solution, when the extra dollar drawn to pay a surcharge is what triggers it. This is the same shape of failure as #54, and it applies to any income-tested rule, including a phase-out or a state credit. Settle it before the first cliff lands: either compute the cliff outside the gross-up as a step, accepting a bounded, explainable understatement in the year a household crosses a tier, or replace the iteration with a bracketed search that has a defined answer for "no exact solution".
4. **Inflation is one scalar.** `Assumptions::inflation` is read once and feeds four unrelated things: the deflator (`PeriodContext::inflation`), every `GrowthRule::Inflation` amount, contribution-limit indexing and bracket indexing. A historical return sequence is only honest with its own years' inflation — 1970s returns without 1970s inflation flatter a plan badly — so a historical `ReturnModel` must first decide between a path-dependent deflator (correct and invasive, and "today's dollars" would then differ between paths) and historical *real* returns with the plan's own inflation layered back on (simpler, and defensible if documented).
5. **`TaxResult` has no structure.** It is `{ tax: f64 }` (`strategies/tax.rs`); nothing can ask a `TaxModel` for a marginal rate or where the next threshold sits, which is the question a Roth conversion or any bracket-filling withdrawal is built on. The least invasive answer is a trait method with a default implementation that locates the next threshold by searching over `tax()` — correct for every impl, including ones not yet written — rather than widening `TaxResult`, which would force `FlatTax` to invent thresholds it does not have.
