# Backlog — shaped ideas, not yet work

Feature ideas worked up far enough to be judged, but not committed to. Nothing
here is scheduled, and nothing here is a decision.

**How this file relates to the other two:**

- **GitHub issues** (`gh issue list`) are current and planned work. An entry
  here becomes an issue when it is actually going to be built — at which point
  the entry is **deleted from this file**, not left behind as a stale copy.
- **`docs/ARCHITECTURE.md`** is the approved blueprint: what exists, why it was
  built that way, and which extensions the traits and schema were shaped to
  accept. It describes code that is there. Nothing in this file belongs in it
  until the corresponding code lands.

Entries keep their letter as a stable handle. Two of the original set have
already been filed and are gone from here: **J** became
[#67](https://github.com/eelozano/retirement/issues/67) (cash-flow composition)
and **K** became [#68](https://github.com/eelozano/retirement/issues/68)
(reports and export).

`file:line` references are accurate as of the commit that added or last touched
each entry, and will drift. Treat them as a pointer to the right function, not a
cursor position.

---

## Risks, before any of this gets built

Four of these push on assumptions the engine currently gets to make for free.

**1. Two of them redefine numbers the app already displays.** `net_worth` is
`accounts.iter().map(|a| a.balance).sum()` (`sim/period.rs`). Introducing
liabilities changes that figure for every existing plan, and it propagates into
the headline tiles, the comparison table's net-worth and delta columns, the
Monte Carlo percentile fan, and every golden file. The change is correct, but it
is not additive the way `employer_match` or `growth` were, and it needs
announcing in the UI rather than silently producing a smaller number than the
user saw last week.

**2. `ProportionalDrawdown` iterates every account, so any new asset container
is a liquidity question first.** `withdraw` (`strategies/drawdown.rs`) sums
`AccountState` balances and sells proportionally. Put a house in that array and
the engine sells 8% of it to cover a bad year — and counts home equity as
spendable in every depletion test and every Monte Carlo success rate.
Probability of success would be overstated, which is the one number in the app
people act on.

**3. Cliffs break the withdrawal gross-up, and this is the subtle one.** The
gross-up is a fixed-point iteration: `gross = net_needed + marginal(gross)`, run
up to 100 times and stopped when successive values converge
(`strategies/drawdown.rs`). It is correct because every tax rule currently
modeled is continuous and monotone in income. IRMAA is a step function — one
dollar of MAGI can add roughly $1,000/yr — and an ACA subsidy cliff is worse.
Near an edge the iteration can oscillate between two values, exhaust its 100
rounds, and return a `gross` that does not satisfy the equation, silently. The
equation can also have *no* solution: the extra dollar drawn to pay the
surcharge is what triggers the surcharge.

This is the same shape of failure as #54 — an implementation that looks
plausible and is quietly wrong in exactly the case the feature exists to
illuminate. It must be settled before the first cliff lands, not after. Note
that it is not specific to the entries below: **any** future income-tested rule
hits it, including a phase-out or a state credit.

**4. Historical returns collide with inflation being a scalar.**
`Assumptions::inflation` is one number, and `PeriodContext::inflation`
(`sim/period.rs`) feeds three unrelated things: the deflator, every
`GrowthRule::Inflation` stream, and contribution-limit indexing. A historical
sequence is only honest with its own year's inflation — 1970s equity returns
without 1970s inflation flatters the plan badly — and making inflation
path-dependent means it stops being a field read once at setup.

**5. Bracket-targeted behavior needs structure the tax model does not expose.**
`TaxResult` is `{ tax: f64 }` (`strategies/tax.rs`). Nothing can ask it for a
marginal rate or where the next threshold sits, which is the one question a Roth
conversion or a bracket-filling withdrawal is built on.

**What is not risky, and is worth saying:** schema migration. The `AccountWire`
/ `AssumptionsWire` / `PersonWire` pattern is well established and every new
field has an obvious home in it. Real work, but cost rather than risk — none of
these entries needs a breaking schema change.

**Difficulty, roughly.** Low: G (ordered drawdown), and the vocabulary half of C
(healthcare). Medium: A (liabilities), B (real estate), E (long-term care), F
(historical backtesting — medium only if the inflation question is answered
first, otherwise high). High: D (IRMAA) and H (Roth conversions), both because
of the cross-cutting problems in points 3 and 5 rather than their own surface
area.

**Verification.** All of this increases the surface where the app can be
confidently wrong about tax law with no test that would catch it. The existing
golden-file and property tests pin engine *mechanics*; they say nothing about
whether an IRMAA threshold or a §121 exclusion is right. Each entry should land
with hand-computed micro-cases in the style of `strategies/tax.rs`'s test
module, where the arithmetic is checkable by reading.

**Suggested order.** A → B (real estate needs a mortgage). C → D (IRMAA needs
Medicare enrollment; C also gives E its boundary). G before H (conversions are
much less interesting under a proportional drawdown). F is independent.

---

# Real estate & debt

Split in two. Liabilities stand alone and are useful alone — a student-loan
payoff is a complete feature. Real estate needs a mortgage to exist first, and
carries a much larger set of design questions.

---

## A — Liabilities: net worth counts only what the household owns, never what it owes

### Scope

Add amortizing debt — mortgage, student loan, auto, credit card — as a
first-class model concept: subtract it from net worth, and run its payment as a
real cash outflow with a real interest/principal split.

### Problem

`PeriodSnapshot::net_worth` is the sum of account balances (`sim/period.rs`),
and there is no representation of a liability anywhere in `model/`. A household
with $800k of accounts and a $400k mortgage reads as $800k. That is not a
rounding issue — it is the headline number, the comparison view's primary
column, and the thing every scenario is judged on.

The available workaround is a flat `CashFlowStream` expense, and it fails in
three specific ways:

- `GrowthRule` cannot express amortization. A mortgage payment is constant while
  its interest/principal split changes every period; `Inflation`, `Fixed` and
  `None` (`model/stream.rs`) can express none of that.
- `StreamBoundary` cannot express "when the balance reaches zero"
  (`model/stream.rs`). The payment either runs forever or stops on a
  hand-computed date that desynchronizes the moment a rate or an extra payment
  changes.
- The balance itself stays invisible, so net worth is wrong for the entire term
  and there is no payoff year to show.

### Design decisions to settle

**A `Liability` type, parallel to `Account`, not a variant of it.**
`AccountState` is what `DrawdownStrategy` iterates; a negative balance in that
array would have the proportional drawdown "withdraw" from a debt and reduce a
shortfall by borrowing. Keep the two containers separate and let net worth do
the subtraction.

**Fields.** `id`, `owner: PersonId` (same reasoning as `Account::owner` —
staggered retirements and per-person attribution), `name`, `balance`, annual
`rate`, and either `payment` or `term` with the other derived. Plus whether the
interest is deductible: mortgage and student-loan interest reduce the tax base,
and the engine has a tax base to reduce.

**Amortization is a step, not a strategy.** It belongs in `sim/liabilities.rs`
as a function over `PeriodState`, for the same reason
`sim/required_distributions.rs` is one: it moves money because the calendar says
so, not because a period's cash went negative. It runs before `settle`, so the
payment is inside the period's cash and any deductible interest is inside
`base_income` for the single tax pass.

**Snapshot shape.** `PeriodSnapshot` gains `liability_balances:
BTreeMap<LiabilityId, f64>` and the period's payment split into interest and
principal. `net_worth` becomes assets minus liabilities — see risk 1; this
changes a displayed number and the golden files churn.

**What happens when the household cannot make the payment.** Nothing special:
the payment is an expense like any other, it flows into the period's shortfall,
and the drawdown covers it. Do not model default, missed payments, or penalty
interest — a projection that models default is answering a different question.

**Deliberately out of scope**, named so they are known omissions: extra payments
and payoff-order strategies (avalanche/snowball), variable-rate debt,
refinancing, and the mortgage-interest deduction's interaction with the standard
deduction. On the last one: the engine applies the standard deduction
unconditionally (`strategies/tax.rs`), so a deductible-interest field will
overstate the benefit for most households — say so in the UI rather than
modeling itemization.

---

## B — Real estate: an appreciating asset the drawdown must not be able to sell

> **Depends on A.** A property without its mortgage is not worth modeling.

### Scope

Model a primary residence and rental property: value, appreciation, carrying
costs, rental income, and the sale event — as an *illiquid* asset, distinct from
the investable portfolio.

### Problem

There is no way to say "we own a $700k house." The only asset container is
`Account`, and every `Account` becomes an `AccountState` that
`ProportionalDrawdown` iterates and withdraws from in proportion to balance
(`strategies/drawdown.rs`).

Modeling a house as a `Taxable` account therefore does two wrong things, and the
second is the serious one: it sells a slice of the house every time a period's
cash goes negative, and it counts home equity as spendable in every depletion
test and every Monte Carlo success rate. For most households the house is a
large fraction of net worth, so probability of success comes out materially
overstated — the app would be most wrong about the number people actually act
on.

### Design decisions to settle

**A `Property` type that contributes to net worth and to nothing else.**
Explicitly not an `AccountState`, and not reachable from any
`DrawdownStrategy`. Fields: `value`, its own `appreciation` rate (housing and
CPI diverge for decades at a time — this must not read
`Assumptions::inflation`), and the `LiabilityId` of its mortgage.

**The sale is the interesting event and the hard part.** It converts an illiquid
asset into portfolio cash, realizes a capital gain, and pays off the remaining
mortgage in one period. Three sub-decisions:

- The §121 primary-residence exclusion ($250k single / $500k joint) is real
  money on a long-held house. Without it the plan shows a large tax bill that
  never arrives; with it the plan needs to know which property is the residence.
- Where the proceeds land. `Assumptions::reinvest_into` already exists for
  exactly this kind of "money has to go somewhere" question — reuse it rather
  than inventing a second answer, and reuse its warning shape when there is
  nowhere to put it.
- Cost basis. A house bought decades ago has a basis the user has to supply;
  defaulting it to the current value silently zeroes the gain, and defaulting it
  to zero silently maximizes it. Neither default is safe — require it, or refuse
  to compute the gain and say so.

**Carrying costs and rental income** are expressible as `CashFlowStream`s today,
but a stream does not know the property was sold. Decide whether they become
fields on `Property` (ends automatically, less flexible) or stay streams with a
property-relative boundary (more general, another `StreamBoundary` variant).

**Rent-vs-buy is not a feature to build.** It falls out of the existing scenario
comparison (#6) the moment a property can be modeled at all: two plans, one with
a property and a mortgage, one with a higher rent expense. Stated here so nobody
builds a dedicated comparison view for it.

**Out of scope:** depreciation and recapture on rentals, 1031 exchanges, reverse
mortgages, HELOCs, and property-tax reassessment rules. Each is a real thing;
none is needed for a first version to be useful. A reverse mortgage in
particular deserves its own entry, because it is a liability that accrues rather
than amortizes.

---

# Healthcare, Medicare & long-term care

Split in three. They sound like one topic and are three different problems: a
vocabulary gap, a tax-architecture problem, and an event-timing problem.

---

## C — Healthcare is the expense that decides whether early retirement works, and there is no way to model it

### Scope

Give healthcare costs their own inflation behavior and a phase change at
Medicare eligibility — by adding two small, general pieces of vocabulary rather
than a healthcare-specific type.

### Problem

Healthcare is currently an ordinary `CashFlowStream`, and two things about it
cannot be expressed:

**Its own inflation.** `GrowthRule::Fixed(rate)` (`model/stream.rs`) can be set
to a medical-inflation figure, but it is then a *nominal* fixed rate
disconnected from `Assumptions::inflation`. Change the inflation assumption in a
scenario and the healthcare stream does not follow — so the one expense that
should respond most strongly to an inflation what-if responds not at all. What
is needed is "inflation plus a spread."

**The phase change at 65.** Pre-Medicare coverage (employer, COBRA,
marketplace) and Medicare Part B + Part D + a supplement are different numbers
with different growth. Expressing that takes two streams with hand-computed date
boundaries per person, which silently desynchronizes the moment a retirement
date moves — the exact failure `StreamBoundary`'s person-relative variants exist
to prevent.

For a household retiring before 65 this is not a detail. The gap years between
retirement and Medicare are frequently the largest controllable expense in the
plan, and the app currently has no honest way to represent them.

### Design decisions to settle

**Add `GrowthRule::InflationPlus(f64)`.** Small, general, and useful well beyond
healthcare — it is also how you say "spending drifts 1% below inflation as we
age," which is a mainstream planning assumption the model cannot currently
express either.

**Medicare eligibility is an age, so add `StreamBoundary::AtAge(PersonId, u8)`
rather than anything healthcare-specific.** `Person::birth` already exists and
`month_at_age` is already the mechanism `Plan::end_month` uses. One variant buys
Medicare at 65, "part-time work until 62," and "spending steps down at 80"; the
long-term-care boundary in E is its sibling. A `HealthcareExpense` type, by
contrast, would be a `CashFlowStream` with a narrower name and its own
proration, survivor, and growth handling to keep in sync.

**Recommendation: do not add a first-class healthcare type.** The two additions
above cover the modeling need. What healthcare deserves is UI affordance — a
guided way to enter the two phases with sensible starting figures — not a
parallel model concept.

**Dependency:** D (IRMAA) needs to know who is enrolled in Medicare and from
when, which is what `AtAge` establishes.

**Out of scope:** employer retiree-coverage subsidies, HSA-funded premium
modeling beyond the existing `AccountKind::Hsa` treatment, and ACA premium tax
credits — the last is a cliff and belongs with D's decision, not here.

---

## D — IRMAA is a cliff, and the withdrawal gross-up is a fixed-point iteration that assumes there are none

> **Depends on C** for Medicare enrollment timing.
> **Contains a cross-cutting prerequisite** that will outlive this feature.

### Scope

Model the Medicare income-related monthly adjustment amount: a Part B and Part D
premium surcharge, determined by modified AGI from **two years prior**, applied
as a step function.

### Problem

Two distinct architectural obstacles. Both need answering before any code.

**1. The two-year lookback breaks `TaxModel`'s signature.**
`fn tax(&self, income: &IncomeBreakdown, period: PeriodIndex) -> TaxResult`
(`strategies/tax.rs`) is a pure function of *one* period's income. IRMAA in
period N is determined by MAGI in period N−2. `SurvivorTax` solved a
structurally similar problem by precomputing — mortality is an assumption, so
the transition period is known before the loop starts. That escape is not
available here: MAGI is an *output* of the simulation, not an input to it.
Either the trait widens to carry prior-period income, or IRMAA becomes a step
reading `RunState`.

**2. IRMAA is discontinuous, and the gross-up is a fixed-point iteration.** See
risk 3 above; this is where that problem first bites. Near a tier edge the
iteration can oscillate, exhaust its 100 rounds, and return a `gross` that does
not satisfy the equation — with no error, no warning, and a plausible-looking
number.

### Design decisions to settle

**Where IRMAA lives. Recommendation: a step, not the tax model** — precisely
because of obstacle 2. A surcharge computed outside the gross-up loop cannot
destabilize it. The cost is real and must be stated: a withdrawal is then not
grossed up for the IRMAA it triggers, so the draw is understated in the year a
household crosses a tier. That is a bounded, explainable error. Non-convergence
is not.

**If it goes in the tax model instead**, the gross-up must stop being a
fixed-point iteration and become a bracketed search — bisection over a monotone
but discontinuous function — with a defined answer for "no exact solution" (take
the smaller gross and report the shortfall, or the larger and report the
overshoot; pick one). Do not leave the existing loop in place with a cliff
underneath it.

**The first two periods have no N−2 MAGI.** Same shape as `prior_balances` being
`None` in the first period, and the reason no RMD is taken there. Say what
happens — most likely no surcharge, because the projection has no basis to
assert one — rather than letting a default decide.

**Thresholds and amounts go in `presets.rs`, indexed forward** like
`CONTRIBUTION_LIMITS`. Note the contrast with the RMD work: the Uniform Lifetime
divisors deliberately do *not* go through `index_to` because they are mortality
figures, but IRMAA thresholds and premiums *are* dollar amounts and *do* index.
Carry a `basis_year` and surface it, per the existing convention for figures
that are only as current as the release.

**MAGI is not the engine's `ordinary`.** It is AGI plus tax-exempt interest, and
AGI is not taxable income — the engine's `base_income` is a different quantity.
Define the approximation explicitly and label it as one in the UI, rather than
letting a field named `magi` imply a precision the model does not have.

**Out of scope:** life-changing-event appeals (form SSA-44), the
married-filing-separately schedule, and the Part D late-enrollment penalty.

---

## E — Long-term care is a late-life expense shock with no way to say when it starts

### Scope

Model a long-term-care episode — a large expense concentrated in the final years
of life — and, optionally, insurance that offsets it.

### Problem

An LTC episode is defined *backwards from death*: "the last two to three years."
`StreamBoundary` can name `AtDeath(PersonId)` (`model/stream.rs`) but has
nothing for "N years before death." The only way to model it today is to
hand-compute a calendar year from `life_expectancy_age` — which desynchronizes
the moment that assumption changes, in exactly the scenarios where LTC matters
most. "What if we live to 100?" is both the most valuable stress test in the app
and the one that silently invalidates a hand-dated LTC stream.

The stakes are specific. LTC is the largest single expense most plans will ever
face, and it lands at the point of maximum vulnerability: the portfolio is at
its smallest, and for a couple it frequently coincides with the survivor
transition (#34), when filing status has already halved the bracket widths and
the standard deduction.

### Design decisions to settle

**A boundary that resolves relative to death:
`StreamBoundary::BeforeDeath(PersonId, years)`.** Prefer this over a signed
offset on `AtDeath` — a signed offset invites `AtDeath(p, +5)`, which resolves
past the end of the plan and means nothing. Sibling to the `AtAge` variant in C;
both are the same kind of gap.

**LTC is a stream, not a new type.** A `LongTermCare` type would duplicate
`CashFlowStream` and need its own proration, growth, and survivor handling to
keep in sync. What it actually needs is the boundary above plus
`GrowthRule::InflationPlus` from C — LTC cost inflation runs well above CPI, and
modeling it at CPI understates the shock badly over a 30-year horizon.

**It must be person-owned, and that has a consequence worth naming.**
`survivor_expense_factor` scales only the expense streams no single person owns
(`sim/period.rs`). An owned LTC stream is therefore correctly left alone by the
survivor step-down — which is right: one person's care costs do not fall because
the other died. This falls out of the existing design rather than needing new
logic.

**Insurance as a percentage offset for the first pass.** A daily-benefit policy
with an elimination period, a benefit-period cap, and an inflation rider is the
realistic shape, and it is a lot of schema for a first version. Model "X%
covered" and state plainly that it approximates a policy rather than
representing one.

**The default must not be an invented number.** Follow the
`survivor_expense_factor` precedent exactly — its 1.0 default and the reasoning
behind it: if LTC is not configured, it does not happen. Do not seed a
convention like "the last 28 months at 20% of cost" into the engine. Put
conventions in the UI as guidance, so the number in the plan is always one the
user chose.

**Out of scope:** Medicaid spend-down and asset tests, hybrid life/LTC policies,
and any attempt to model the *probability* of needing care. The last one is
tempting and wrong for this engine — mortality here is an assumption rather than
a draw (`sim/survivor.rs`), and a probabilistic care event would put a
stochastic element in the one place the design deliberately keeps
deterministic.

---

# Historical backtesting

---

## F — Monte Carlo draws returns that never happened, in an order that never happens

### Scope

A `HistoricalSequence` implementation of `ReturnModel` that runs the plan against
real historical return sequences, reported per starting year rather than as a
percentile band.

### Problem

`StochasticReturns` draws each (period, asset class) independently from a Normal
(`strategies/returns.rs`). The comment on that type already admits most of what
follows. Three consequences:

- **No correlation across asset classes.** Equities and bonds are drawn
  independently, so the model cannot produce 2022 (both down together) and
  cannot correctly price the diversification benefit either. The fan's width is
  wrong in both directions, not just one.
- **No serial correlation.** Real returns cluster and mean-revert. An
  independent draw cannot produce a *sequence* like 1966–1982 or 2000–2009 — a
  decade of bad returns arriving immediately at retirement. That sequence is the
  single risk a retirement plan most needs to survive, and it is the one the
  current model structurally cannot generate.
- **Normality.** Real returns have fat tails; a Normal understates the frequency
  of exactly the outcomes that break plans.

Sequence-of-returns risk is not a refinement of Monte Carlo. It is a different
question, and it is closer to the one a retiree actually faces.

### Design decisions to settle

**Inflation is the load-bearing decision — settle it before adding any data.**
See risk 4. Decide between historical inflation with a path-dependent deflator
(correct, invasive — and note it changes what the real-dollar toggle means,
since "today's dollars" would then differ between paths) and historical *real*
returns with the plan's own inflation assumption layered back on (simpler, and
defensible if documented). Do not leave it implicit.

**Dataset and start years.** An annual series per asset class, shipped in the
crate — `historical_data.rs`, following the `state_tax_data.rs` precedent for a
large static table. Coverage decides the usable range: US equity and US bond
series run from 1928, but international equity series do not usefully start
before about 1970. Decide what a plan holding `IntlEquity` does for earlier
start years. Recommend restricting the offered start years to those with full
coverage for the plan's actual allocation, rather than substituting a proxy
series — a silent substitution is a data-quality lie in a tool whose whole
argument is that the numbers are yours.

**Path enumeration, and why this should not be a percentile fan.** With ~95
years of record and a 60-year horizon, only about 35 distinct rolling sequences
exist. That is far too few for a meaningful percentile band, and presenting it
as one would borrow Monte Carlo's visual language for a sample that cannot
support it. Recommend reporting each start year individually, with the finding
stated directly: "this plan survives every historical starting year except 1966
and 1968." More legible than a percentile *and* more honest about the sample
size. Block bootstrapping is the alternative if a fan is genuinely wanted; it is
a different feature and should be a different entry.

**No trait change is needed.** `path_id` already threads through
`ReturnModel::returns_for` and maps directly onto a start-year index. This is
the property the trait was designed to buy, and this entry is a good test of
whether it did.

**UI implication, flagged but out of scope for the engine work:** a historical
result is not a Monte Carlo result and must not render as a percentile band. It
needs its own presentation, and `SimConfig::show_monte_carlo_band` is not the
flag for it.

---

# Withdrawal & tax optimization

Split in two. Ordered drawdown is a clean trait implementation. Roth conversions
need a capability the tax model does not have, and that capability will be
needed again.

---

## G — Every withdrawal sells a proportional slice of every account, which no one does

### Scope

A `DrawdownStrategy` that draws from accounts in a configured order, behind the
existing trait.

### Problem

`ProportionalDrawdown` withdraws from every funded account in proportion to
balance (`strategies/drawdown.rs`). So a household covering a shortfall in their
first retirement year sells Roth dollars alongside pre-tax dollars, at 62, with
decades of tax-free compounding left. Conventional sequencing — taxable first,
then pre-tax, then Roth — exists because it defers the tax bill and preserves
the tax-free compartment longest.

Two consequences, and the second is easy to miss: the app cannot answer "does
withdrawal order matter for us?", and every lifetime-tax figure the comparison
view reports (#6) is computed under a strategy no one actually follows. The
comparison is internally consistent and externally misleading.

### Design decisions to settle

**Order as a plan field, not a constant.** A list of `AccountKind` with a
documented within-kind tiebreak (plan order) is preferable to a list of
`AccountId` — an id list silently breaks when an account is deleted or a
scenario is duplicated and edited, and #6 makes duplication a normal operation.

**Preserve the gross-up exactly, and test it at the boundaries.** The fixed
point converges because `marginal(gross)` is monotone in `gross`. Under an
ordered strategy the *character* of a marginal dollar changes as one account
empties and the next takes over — `breakdown_for` currently computes character
from fixed proportional shares, and becomes piecewise. Piecewise-monotone still
converges, but the piece boundaries are where an off-by-one lives. Test
explicitly at the point an account empties mid-withdrawal, and at full
depletion, where the existing code already documents floating-point residue.

**The RMD interaction is where this will actually break.** `distribute`
(`sim/period.rs`) has already forced money out of pre-tax accounts *before* the
drawdown runs, has already reduced those balances, and has already put the
amount into `base_income`. An ordered strategy that reaches pre-tax accounts
must not re-derive or double-count that. Write the test first.

**Out of scope:** tax-aware *dynamic* ordering (fill this bracket from pre-tax,
then switch to Roth) — that needs H's bracket headroom and should follow it.
Also out of scope: guardrails and dynamic spending rules, which are a
spending-side feature, not a drawdown-side one.

---

## H — Roth conversions: the plan can hold a pre-tax balance for 30 years and never convert a dollar of it

> **Has a prerequisite inside it.** The bracket-headroom capability below is
> needed by every bracket-targeted behavior, not just this one. Decide whether it
> ships first as its own change.

### Scope

Model deliberate pre-tax → Roth conversions, and give the engine the bracket
information needed to size them.

### Problem

There is no way to move money between accounts at all. A conversion is the
central tax lever available to an early retiree: in the years between retiring
and claiming Social Security — and before RMDs begin at 73 or 75 — taxable
income falls into a trough, and filling that trough at 12% or 22% is worth six
figures against distributions later taxed at a higher rate.

The app now models both ends of that argument and can act on neither. #49 made
the RMD cost visible; #54 made the marginal rate honest. The conversion is the
move those two findings imply, and it is unrepresentable.

### The prerequisite: bracket headroom

Sizing a conversion means answering "how much more ordinary income fits before
the 24% bracket starts?" `TaxResult` is `{ tax: f64 }` (`strategies/tax.rs`) — a
single number with no structure. Nothing can ask a `TaxModel` where the next
threshold sits. Two options:

- **Widen `TaxResult`** with the marginal rate and next threshold. Cheap at the
  call site, but every implementation has to answer — including `FlatTax`, which
  has no thresholds and would have to return something false, and `SurvivorTax`,
  which would have to delegate correctly across the transition.
- **Add a trait method with a default implementation** that locates the next
  threshold by numeric search over `tax()`. Correct for every implementation for
  free, including ones not yet written, and `FlatTax` is not forced to lie.
  Slower, and it runs inside a per-period loop.

**Recommend the second**, and measure it — the search is a handful of `tax()`
calls, against a gross-up that already makes up to 100.

### Other design decisions to settle

**How a conversion is specified.** Support a fixed annual amount and a target
bracket ceiling ("convert up to the top of the 22%"). Defer target-MAGI
conversions until the cliffs from D exist — a MAGI target whose binding
constraint is an unmodeled IRMAA tier is worse than no target.

**A conversion is a step**, in `sim/period.rs`, running before `settle` so the
converted amount is ordinary income inside the period's single tax pass. Same
discipline `distribute` follows, and the reason #54 had to land first.

**The conversion tax has to be paid from somewhere, and the default matters.**
Paying it out of the converted amount is the wrong default — it defeats much of
the benefit and quietly makes the feature look worse than it is. Paying from a
taxable account is the standard approach. Decide, and warn when there is no
taxable account to pay from, following the `RequiredDistributionUnallocated`
precedent — a louder warning for a materially worse outcome.

**The five-year rule is out of scope, and that has a direction.** Converted
principal is not penalty-free for five years. Omitting it means the model
understates the cost of converting and then needing the money soon — an error
that flatters conversions. Name it in the warning text, not just in a comment.

**An optimizer that searches for the best conversion schedule is explicitly out
of scope.** This entry makes conversions *expressible*. Searching over them is a
different problem, and it probably belongs to the scenario layer — which already
compares up to five plans — rather than inside the simulation loop.
