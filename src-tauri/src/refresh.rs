//! "I sat down and updated everything": one gesture that re-reads a
//! household's balances, dates them, and moves the projection's start to the
//! month it was done (#111).
//!
//! Three kinds of number live in a household, and a refresh has to treat
//! them differently — which is the whole reason this is not a loop over
//! fields:
//!
//! - A **balance** is a point-in-time observation. It is replaced, dated,
//!   and the previous reading is kept beside it. An account nobody re-read
//!   keeps its older reading *and its older date*: no estimate is rolled
//!   forward for it, now or later, because a stale number the app has
//!   labelled as stale is honest and an invented one is not.
//! - A **rate** — a salary, a spending figure, a flat contribution — is
//!   stated in start dollars. Moving the start forward re-denominates it
//!   without changing a digit: an untouched $150,000 that meant January
//!   dollars now means December dollars. So the screen shows every one of
//!   them and the user re-affirms or retypes; [`RateChange`] is what comes
//!   back. Nothing here grows a figure on its own.
//! - **Intent** — a percent of salary, a federal maximum, a step-up, a
//!   claiming age, an allocation — is untouched. It is not denominated in
//!   dollars of any month, so the start moving cannot make it wrong.
//!
//! And one thing the user cannot see has to be held still by hand. A
//! contribution entry that starts at `PlanStart` resolves to whatever the
//! plan start is, and `StepUp` counts whole years from that resolved start
//! (`sim::contributions::escalated`). Move the start to December and an
//! entry that had escalated to 12% would resolve to December and fall back
//! to 10%. So the refresh **pins** those entries to the *old* start before
//! moving it: `PlanStart` becomes `Date(old as_of)`, which is the same
//! month the entry already resolved to, and the escalation is untouched.
//! Streams need no equivalent — `PlanStart → AtRetirement` on a salary
//! means "already running" either way, and `FlatAmount` growth is measured
//! from the plan start regardless of the entry's own window.
//!
//! The engine is not involved and does not change: it reads `balance` as of
//! `sim_config.start` exactly as it always has. What this module does is
//! keep the two in step.

use std::fs;
use std::path::{Path, PathBuf};

use engine::model::{
    AccountId, ContributionId, ContributionRule, HouseholdFile, Observation, Plan, PlanId,
    Scenario, SocialSecurityBenefitId, StreamBoundary, StreamId, YearMonth,
};
use serde::Deserialize;

use crate::storage;

/// Where the household is copied to, whole, immediately before a refresh
/// rewrites it: `plans/.refreshes/<household id>/<the as-of it is leaving>.yaml`.
///
/// Deliberately **not** pruned, unlike `.history` — see `docs/BACKLOG.md`
/// **I**. Each copy is the projection the household was living with the last
/// time they looked, which is the baseline a plan-versus-actual view needs,
/// and it exists at exactly the moments that matter. A household refreshed
/// quarterly for thirty years leaves 120 files of a few kilobytes each.
fn refreshes_dir(base: &Path, household_id: &str) -> PathBuf {
    storage::plans_dir(base)
        .join(".refreshes")
        .join(household_id)
}

/// What the Refresh screen sends back: the month, the balances read off
/// statements, the statement's Social Security figures, and the rates the
/// user re-affirmed or retyped.
///
/// A command-only input shape, hand-declared like `NewPerson` — the screen
/// has no business supplying an observation's date per account (there is one
/// date for the sitting) or a previous figure (this module reads the stored
/// one).
#[derive(Deserialize)]
pub struct RefreshRequest {
    /// The scenario that was open: whose rates the screen listed, and the
    /// one the sibling rule reaches out *from*.
    pub scenario_id: PlanId,
    /// The month every reading below is as of, and the household's new
    /// `as_of` — therefore every scenario's new `sim_config.start`.
    pub as_of: YearMonth,
    /// Every account the screen showed, changed or not. Which ones actually
    /// gained an observation is decided here, by comparison, rather than
    /// trusted from the caller.
    pub accounts: Vec<AccountReading>,
    pub benefits: Vec<BenefitReading>,
    /// Only the rates the user changed. An untouched figure is kept as
    /// typed, which is the default and needs no entry.
    pub rates: Vec<RateChange>,
}

/// A balance as read off a statement this sitting.
#[derive(Deserialize)]
pub struct AccountReading {
    pub id: AccountId,
    pub balance: f64,
    /// Taxable accounts only, exactly as on [`Observation::cost_basis`].
    pub cost_basis: Option<f64>,
}

/// The one Social Security figure a statement restates: what the benefit
/// would be at full retirement age, which moves as the owner keeps earning.
/// The full retirement age itself is fixed by birth year and is not a
/// reading, so it is not refreshed here.
#[derive(Deserialize)]
pub struct BenefitReading {
    pub id: SocialSecurityBenefitId,
    pub benefit_at_fra: f64,
}

/// One re-affirmed start-dollar figure. `amount` is what it should now be —
/// the figure kept, the inflation-grown figure the screen offered, or one
/// the user typed. This module does not know which, and does not grow
/// anything on its own.
#[derive(Deserialize)]
pub struct RateChange {
    pub target: RateTarget,
    pub amount: f64,
    /// Write the same figure into every sibling scenario whose figure for
    /// this same target is still what the active scenario's was before this
    /// change. Offered per rate, because a household that deliberately gave
    /// one scenario a different salary meant it.
    pub apply_to_siblings: bool,
}

/// Which start-dollar figure a [`RateChange`] is about. The two kinds the
/// screen lists: a stream's annual amount, and a flat contribution's amount.
/// Percent-of-salary and federal-maximum entries are intent and have no
/// figure to re-affirm.
#[derive(Deserialize, PartialEq, Eq, Clone)]
pub enum RateTarget {
    Stream {
        id: StreamId,
    },
    Contribution {
        account: AccountId,
        id: ContributionId,
    },
}

/// Reads the figure a target currently holds in `scenario`, or `None` when
/// the scenario has no such entry (a sibling that never had this stream) or
/// when the entry is intent rather than a figure.
fn rate_of(scenario: &Scenario, target: &RateTarget) -> Option<f64> {
    match target {
        RateTarget::Stream { id } => scenario
            .streams
            .iter()
            .find(|s| &s.id == id)
            .map(|s| s.annual_amount),
        RateTarget::Contribution { account, id } => scenario
            .accounts
            .get(account)?
            .contributions
            .iter()
            .find(|c| &c.id == id)
            .and_then(|c| match c.rule {
                ContributionRule::FlatAmount { amount, .. } => Some(amount),
                _ => None,
            }),
    }
}

/// Writes `amount` into a target, leaving everything else about the entry —
/// its window, its growth rule — alone. Returns false when the scenario has
/// no such figure.
fn set_rate(scenario: &mut Scenario, target: &RateTarget, amount: f64) -> bool {
    match target {
        RateTarget::Stream { id } => match scenario.streams.iter_mut().find(|s| &s.id == id) {
            Some(stream) => {
                stream.annual_amount = amount;
                true
            }
            None => false,
        },
        RateTarget::Contribution { account, id } => {
            let Some(policy) = scenario.accounts.get_mut(account) else {
                return false;
            };
            let Some(entry) = policy.contributions.iter_mut().find(|c| &c.id == id) else {
                return false;
            };
            match &mut entry.rule {
                ContributionRule::FlatAmount { amount: slot, .. } => {
                    *slot = amount;
                    true
                }
                _ => false,
            }
        }
    }
}

fn describe(target: &RateTarget) -> String {
    match target {
        RateTarget::Stream { id } => format!("stream {id:?}"),
        RateTarget::Contribution { account, id } => {
            format!("contribution {id:?} on account {account:?}")
        }
    }
}

/// Records a sitting: the readings become observations, the household's
/// `as_of` moves to `as_of`, and every scenario keeps meaning what it meant.
///
/// `now` is the current month, from the caller's clock, and bounds the
/// refresh: a household cannot be observed in a month that has not happened.
/// The other bound is the household's own `as_of` — a refresh dated before
/// the balances it is replacing would put the ledger out of order and move
/// the projection backwards.
///
/// Returns the active scenario as a `Plan`, composed from the refreshed
/// household, so the caller can open it without a second round-trip.
pub fn refresh_household(
    base: &Path,
    request: &RefreshRequest,
    now: YearMonth,
) -> Result<Plan, String> {
    let mut file = storage::household_of(base, &request.scenario_id)?;
    let previous_as_of = file.as_of;

    if request.as_of < previous_as_of {
        return Err(format!(
            "These balances are dated {}, before the ones on file ({}). \
             Pick {} or later.",
            month_name(request.as_of),
            month_name(previous_as_of),
            month_name(previous_as_of),
        ));
    }
    if request.as_of > now {
        return Err(format!(
            "{} is in the future — balances can only be read for a month that has happened.",
            month_name(request.as_of),
        ));
    }

    // Observations. Only for an account whose reading actually differs: an
    // unchanged account keeps its last observation *and its older date*,
    // which is what the Accounts pane then shows (#110).
    for reading in &request.accounts {
        let Some(account) = file.accounts.iter_mut().find(|a| a.id == reading.id) else {
            return Err(format!("this household has no account {:?}", reading.id));
        };
        let unchanged = account
            .current()
            .is_some_and(|o| o.balance == reading.balance && o.cost_basis == reading.cost_basis);
        if unchanged {
            continue;
        }
        let observation = Observation {
            as_of: request.as_of,
            balance: reading.balance,
            cost_basis: reading.cost_basis,
        };
        // A refresh dated the same month as the last reading is a correction
        // to that reading, not a second one: amend, so the ledger keeps one
        // entry per month and stays strictly increasing in `as_of`.
        match account.observations.last_mut() {
            Some(last) if last.as_of == request.as_of => *last = observation,
            _ => account.observations.push(observation),
        }
    }

    // The statement's own figure, replaced in place. There is no ledger for
    // it: unlike a balance, a benefit at FRA is an estimate the SSA restates
    // rather than a reading of something that happened, so a history of past
    // estimates would not measure anything.
    for reading in &request.benefits {
        let Some(benefit) = file.social_security.iter_mut().find(|b| b.id == reading.id) else {
            return Err(format!(
                "this household has no Social Security benefit {:?}",
                reading.id
            ));
        };
        benefit.benefit_at_fra = reading.benefit_at_fra;
    }

    // Pin before the move takes the start out from under them. Every
    // scenario, not just the active one: they all compose their start from
    // this one `as_of`, so they would all lose the same escalation.
    for scenario in &mut file.scenarios {
        pin_plan_start(scenario, previous_as_of);
    }

    // The move itself. Every scenario's `sim_config.start` is composed from
    // this (`engine::model::compose`), so there is nothing else to write.
    file.as_of = request.as_of;

    // The re-affirmed rates.
    apply_rates(&mut file, &request.scenario_id, &request.rates)?;

    // Composed and checked *before* anything is written: a refresh moves the
    // start and rewrites figures the engine reads, and a household it would
    // leave unsimulatable must not reach the plans directory, where it would
    // fail to load on every launch after this. Same posture, and the same
    // user-facing messages, as `create_plan`.
    let plan = storage::compose_scenario(&file, &request.scenario_id)?;
    let errors = plan.validate();
    if !errors.is_empty() {
        return Err(errors
            .into_iter()
            .map(|e| e.message)
            .collect::<Vec<_>>()
            .join("\n"));
    }

    // Last read of the outgoing file, and then the write. The ordinary
    // `.history` snapshot is the caller's — taken before this function so it
    // captures the same pre-refresh state under the same once-per-session
    // gate every other edit obeys.
    keep_pre_refresh_copy(base, &file.id, previous_as_of)?;
    storage::save_household_file(base, &file)?;
    Ok(plan)
}

/// `plans/.refreshes/<id>/<old as-of>.yaml`. Named for the as-of it is
/// leaving rather than for the wall clock, because that is what identifies
/// the projection inside it. Two refreshes in the same month — allowed, and
/// what a correction the following week looks like — disambiguate with a
/// timestamp rather than overwrite: no copy is ever lost.
fn keep_pre_refresh_copy(
    base: &Path,
    household_id: &str,
    previous_as_of: YearMonth,
) -> Result<(), String> {
    let source = storage::household_path(base, household_id);
    if !source.exists() {
        return Ok(());
    }
    let dir = refreshes_dir(base, household_id);
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let mut dest = dir.join(format!("{previous_as_of}.yaml"));
    if dest.exists() {
        dest = dir.join(format!(
            "{previous_as_of}-{}.yaml",
            storage::iso_stamp_now()
        ));
    }
    fs::copy(&source, &dest).map_err(|e| format!("copying {}: {e}", source.display()))?;
    Ok(())
}

/// Holds every contribution entry that starts at the plan's start where it
/// already was, by naming that month outright.
///
/// Idempotent across refreshes by construction: the second refresh finds
/// `Date(...)` and has nothing left to pin, so an entry stays anchored to
/// the month it was actually opened rather than creeping forward one
/// refresh at a time.
///
/// Only `start` is pinned. An entry that *ends* at `PlanStart` has an empty
/// window before the move and an empty window after it, so re-dating it
/// would change nothing.
fn pin_plan_start(scenario: &mut Scenario, previous_as_of: YearMonth) {
    for policy in scenario.accounts.values_mut() {
        for entry in &mut policy.contributions {
            if entry.start == StreamBoundary::PlanStart {
                entry.start = StreamBoundary::Date(previous_as_of);
            }
        }
    }
}

/// Writes each re-affirmed figure into the active scenario, and — where the
/// user asked — into every sibling that still agreed with it.
///
/// "Still agreed" is exact equality on the stored figure. Both sides are
/// numbers a person typed and the app has only ever copied, never computed,
/// so there is no rounding for an epsilon to absorb; and a tolerance would
/// silently overwrite a scenario deliberately given a salary $1 different.
fn apply_rates(
    file: &mut HouseholdFile,
    scenario_id: &str,
    rates: &[RateChange],
) -> Result<(), String> {
    for change in rates {
        let active = file
            .scenarios
            .iter()
            .find(|s| s.id == scenario_id)
            .ok_or_else(|| format!("no scenario {scenario_id:?}"))?;
        // Read before writing: the sibling rule matches on the figure the
        // active scenario held *before* this change.
        let previous = rate_of(active, &change.target).ok_or_else(|| {
            format!(
                "scenario {scenario_id:?} has no figure to update on {}",
                describe(&change.target)
            )
        })?;

        for scenario in &mut file.scenarios {
            // The active scenario always; a sibling only where the user
            // asked and the sibling's figure still matches the one being
            // replaced.
            let wanted = scenario.id == scenario_id
                || (change.apply_to_siblings
                    && rate_of(scenario, &change.target) == Some(previous));
            if wanted {
                set_rate(scenario, &change.target, change.amount);
            }
        }
    }
    Ok(())
}

/// "December 2026" — the one place this crate spells a month out, for error
/// messages the user reads. Everywhere else a `YearMonth` is either a
/// filename (`2026-12`) or the frontend's job to format.
fn month_name(date: YearMonth) -> String {
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    match MONTHS.get(date.month as usize - 1) {
        Some(name) => format!("{name} {}", date.year),
        None => date.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use engine::model::{compose, Contribution, GrowthRule, Plan, StepUp};

    use super::*;

    struct TempBase(PathBuf);

    impl TempBase {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "retirement-refresh-test-{tag}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempBase(dir)
        }
    }

    impl Drop for TempBase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A clock far enough ahead that no test date is "in the future". The
    /// future bound has its own test; every other one is about the ledger.
    const LATER: YearMonth = YearMonth {
        year: 2099,
        month: 12,
    };

    fn store(base: &Path, plan: Plan) -> Plan {
        storage::create_plan(base, plan).unwrap()
    }

    /// A refresh that changes nothing but the month — the "I looked, and
    /// everything is where it was" case, and the baseline the other tests
    /// add readings to.
    fn sitting(scenario_id: &str, as_of: YearMonth) -> RefreshRequest {
        RefreshRequest {
            scenario_id: scenario_id.to_string(),
            as_of,
            accounts: Vec::new(),
            benefits: Vec::new(),
            rates: Vec::new(),
        }
    }

    fn reading(id: &str, balance: f64, cost_basis: Option<f64>) -> AccountReading {
        AccountReading {
            id: id.to_string(),
            balance,
            cost_basis,
        }
    }

    fn stream_rate(id: &str, amount: f64, apply_to_siblings: bool) -> RateChange {
        RateChange {
            target: RateTarget::Stream { id: id.to_string() },
            amount,
            apply_to_siblings,
        }
    }

    fn observations(base: &Path, scenario: &str, account: &str) -> Vec<Observation> {
        storage::load_household(base, scenario)
            .unwrap()
            .accounts
            .into_iter()
            .find(|a| a.id == account)
            .expect("this household has the account")
            .observations
    }

    fn stream_amount(plan: &Plan, id: &str) -> f64 {
        plan.streams
            .iter()
            .find(|s| s.id == id)
            .expect("this scenario has the stream")
            .annual_amount
    }

    fn count_yaml(dir: &Path) -> usize {
        fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("yaml"))
                    .count()
            })
            .unwrap_or(0)
    }

    #[test]
    fn every_scenario_projects_from_the_new_month_and_the_new_balances() {
        let base = TempBase::new("compose");
        store(&base.0, household_plan());
        storage::duplicate_plan(&base.0, "base-plan", "Retire early").unwrap();

        let december = YearMonth::new(2026, 12);
        let mut request = sitting("base-plan", december);
        request.accounts = vec![reading("taxable-brokerage", 165_000.0, Some(118_000.0))];
        refresh_household(&base.0, &request, LATER).unwrap();

        // The point of the household split: one refresh, and the branch
        // nobody was looking at is projecting from the same month and the
        // same balance as the one that was open.
        for scenario in storage::list_plans(&base.0).unwrap() {
            let plan = storage::load_plan(&base.0, &scenario.id).unwrap();
            assert_eq!(plan.sim_config.start, december, "{}", scenario.name);
            let account = plan
                .accounts
                .iter()
                .find(|a| a.id == "taxable-brokerage")
                .unwrap();
            assert_eq!(account.balance, 165_000.0, "{}", scenario.name);
            assert_eq!(account.cost_basis, Some(118_000.0), "{}", scenario.name);
        }
    }

    /// The invisible side effect the pin exists for. A 401(k) auto-escalation
    /// counts whole years from the entry's *resolved* start, so an untouched
    /// `PlanStart` entry would fall back a step every time the household
    /// refreshed — the percentage on screen would still read 10%, and the
    /// projection would quietly disagree with it.
    ///
    /// Asserted as a percentage of the salary actually earned, not in
    /// dollars: moving the start also moves how far that salary has grown by
    /// 2028, so the dollar figures legitimately differ.
    #[test]
    fn a_step_up_reaches_the_same_percentage_after_a_refresh() {
        let base = TempBase::new("stepup");
        store(&base.0, escalating_plan());

        let before = escalated_share(&storage::load_plan(&base.0, "base-plan").unwrap());
        refresh_household(
            &base.0,
            &sitting("base-plan", YearMonth::new(2026, 12)),
            LATER,
        )
        .unwrap();
        let after = escalated_share(&storage::load_plan(&base.0, "base-plan").unwrap());

        // Two whole years from January 2026: 10% + 2 points.
        assert!((before - 0.12).abs() < 1e-9, "{before}");
        assert!(
            (after - before).abs() < 1e-9,
            "the escalation fell back to {after} — the entry re-resolved to the new start"
        );
    }

    #[test]
    fn the_pin_names_the_old_start_and_leaves_a_flat_amount_alone() {
        let base = TempBase::new("pin");
        store(&base.0, household_plan());
        let january = YearMonth::new(2026, 1);

        refresh_household(
            &base.0,
            &sitting("base-plan", YearMonth::new(2026, 12)),
            LATER,
        )
        .unwrap();

        let entry = flat_entry(&storage::load_plan(&base.0, "base-plan").unwrap());
        assert_eq!(
            entry.start,
            StreamBoundary::Date(january),
            "the entry is held at the month it actually opened"
        );
        // The amount is in start dollars and grows from *plan* start, not
        // from the entry's window, so re-dating the window cannot move it.
        // Only a `RateChange` can, and this refresh sent none.
        assert_eq!(
            entry.rule,
            ContributionRule::FlatAmount {
                amount: 40_000.0,
                growth: GrowthRule::Inflation,
            }
        );
    }

    /// Pinning is idempotent: a second refresh finds a date rather than
    /// `PlanStart`, so the entry stays anchored to the month it opened
    /// instead of creeping forward one sitting at a time.
    #[test]
    fn a_second_refresh_leaves_the_first_pin_where_it_is() {
        let base = TempBase::new("pin-twice");
        store(&base.0, household_plan());

        for month in [6, 12] {
            refresh_household(
                &base.0,
                &sitting("base-plan", YearMonth::new(2026, month)),
                LATER,
            )
            .unwrap();
        }

        assert_eq!(
            flat_entry(&storage::load_plan(&base.0, "base-plan").unwrap()).start,
            StreamBoundary::Date(YearMonth::new(2026, 1))
        );
    }

    #[test]
    fn only_re_read_accounts_gain_an_observation() {
        let base = TempBase::new("ledger");
        store(&base.0, household_plan());
        let january = YearMonth::new(2026, 1);
        let december = YearMonth::new(2026, 12);

        let mut request = sitting("base-plan", december);
        request.accounts = vec![
            reading("taxable-brokerage", 165_000.0, Some(110_000.0)),
            // Re-read and found unchanged — a real thing to do, and it must
            // not date a reading that is still the old one.
            reading("alex-401k", 400_000.0, None),
        ];
        refresh_household(&base.0, &request, LATER).unwrap();

        let changed = observations(&base.0, "base-plan", "taxable-brokerage");
        assert_eq!(changed.len(), 2);
        assert_eq!(changed[0].as_of, january);
        assert_eq!(changed[0].balance, 150_000.0);
        assert_eq!(changed[1].as_of, december);
        assert_eq!(changed[1].balance, 165_000.0);

        let unchanged = observations(&base.0, "base-plan", "alex-401k");
        assert_eq!(unchanged.len(), 1, "no reading, no entry");
        assert_eq!(unchanged[0].as_of, january, "and no new date either");

        // An account the sitting never mentioned is in the same position:
        // its number stands, dated when it was read (#110 shows the date).
        let untouched = observations(&base.0, "base-plan", "jordan-roth");
        assert_eq!(untouched.len(), 1);
        assert_eq!(untouched[0].as_of, january);
    }

    #[test]
    fn the_ledger_is_monotone_in_as_of() {
        let base = TempBase::new("monotone");
        store(&base.0, household_plan());

        for (month, balance) in [(4, 155_000.0), (8, 160_000.0), (12, 172_000.0)] {
            let mut request = sitting("base-plan", YearMonth::new(2026, month));
            request.accounts = vec![reading("taxable-brokerage", balance, Some(110_000.0))];
            refresh_household(&base.0, &request, LATER).unwrap();
        }

        let ledger = observations(&base.0, "base-plan", "taxable-brokerage");
        assert_eq!(ledger.len(), 4);
        assert!(
            ledger.windows(2).all(|w| w[0].as_of < w[1].as_of),
            "{:?}",
            ledger.iter().map(|o| o.as_of).collect::<Vec<_>>()
        );
    }

    /// A correction the week after a refresh is an amendment, not a second
    /// reading of the same month.
    #[test]
    fn a_refresh_in_the_month_already_recorded_amends_it() {
        let base = TempBase::new("amend");
        store(&base.0, household_plan());
        let december = YearMonth::new(2026, 12);

        for balance in [165_000.0, 156_000.0] {
            let mut request = sitting("base-plan", december);
            request.accounts = vec![reading("taxable-brokerage", balance, Some(110_000.0))];
            refresh_household(&base.0, &request, LATER).unwrap();
        }

        let ledger = observations(&base.0, "base-plan", "taxable-brokerage");
        assert_eq!(ledger.len(), 2, "January's reading, then December's");
        assert_eq!(ledger[1].balance, 156_000.0);
    }

    #[test]
    fn the_statement_figure_for_a_benefit_is_replaced_in_place() {
        let base = TempBase::new("benefit");
        store(&base.0, household_plan());

        let mut request = sitting("base-plan", YearMonth::new(2026, 12));
        request.benefits = vec![BenefitReading {
            id: "alex-social-security".to_string(),
            benefit_at_fra: 34_500.0,
        }];
        refresh_household(&base.0, &request, LATER).unwrap();

        let plan = storage::load_plan(&base.0, "base-plan").unwrap();
        assert_eq!(plan.social_security[0].benefit_at_fra, 34_500.0);
        // Claiming age is intent, not a statement figure, and is untouched.
        assert_eq!(plan.social_security[0].claiming_age, 70);
    }

    #[test]
    fn every_refresh_leaves_a_copy_and_none_of_them_are_pruned() {
        let base = TempBase::new("copies");
        store(&base.0, household_plan());
        let sittings = 25;
        assert!(
            sittings > 20,
            "more than `.history` keeps, which is the point"
        );

        for n in 0..sittings {
            // The command takes this snapshot; here it stands in for the
            // ordinary session edit, so the two histories can be compared.
            storage::snapshot_plan(&base.0, "base-plan").unwrap();
            let as_of = YearMonth::new(2026, 1).add_months(n + 1);
            refresh_household(&base.0, &sitting("base-plan", as_of), LATER).unwrap();
        }

        let kept = refreshes_dir(&base.0, "base-plan");
        assert_eq!(
            count_yaml(&kept),
            sittings as usize,
            "a refresh copy is the baseline a plan-versus-actual view reads (backlog I) \
             and is never pruned"
        );
        assert!(
            count_yaml(
                &storage::plans_dir(&base.0)
                    .join(".history")
                    .join("base-plan")
            ) <= 20,
            "`.history` is still bounded"
        );

        // Named for the as-of it left behind, and a working household in its
        // own right — not a fragment.
        let first = kept.join("2026-01.yaml");
        let file = storage::load_household_file(&first).unwrap();
        assert_eq!(file.as_of, YearMonth::new(2026, 1));
        let plan = compose(&file.household(), &file.scenarios[0]).unwrap();
        assert_eq!(plan.sim_config.start, YearMonth::new(2026, 1));
        assert!(plan.validate().is_empty());
    }

    #[test]
    fn an_untouched_rate_is_kept_exactly_as_typed() {
        let base = TempBase::new("keep");
        store(&base.0, household_plan());

        refresh_household(
            &base.0,
            &sitting("base-plan", YearMonth::new(2026, 12)),
            LATER,
        )
        .unwrap();

        // The default is keep: the screen shows what the figure would be if
        // grown, and applies nothing unless the user says so.
        let plan = storage::load_plan(&base.0, "base-plan").unwrap();
        assert_eq!(stream_amount(&plan, "alex-salary"), 140_000.0);
        assert_eq!(stream_amount(&plan, "household-spending"), 96_000.0);
    }

    #[test]
    fn the_sibling_rule_reaches_only_scenarios_that_still_agreed() {
        let base = TempBase::new("siblings");
        store(&base.0, household_plan());
        storage::duplicate_plan(&base.0, "base-plan", "Agrees").unwrap();
        let mut differs = storage::duplicate_plan(&base.0, "base-plan", "Differs").unwrap();
        // A branch that was deliberately given a different salary. The whole
        // reason the rule matches on the figure and not just the id.
        differs
            .streams
            .iter_mut()
            .find(|s| s.id == "alex-salary")
            .unwrap()
            .annual_amount = 120_000.0;
        storage::save_plan(&base.0, &differs).unwrap();

        let mut request = sitting("base-plan", YearMonth::new(2026, 12));
        request.rates = vec![
            stream_rate("alex-salary", 152_800.0, true),
            // Changed, but not offered to the siblings.
            stream_rate("household-spending", 99_000.0, false),
        ];
        refresh_household(&base.0, &request, LATER).unwrap();

        let salary =
            |id: &str| stream_amount(&storage::load_plan(&base.0, id).unwrap(), "alex-salary");
        assert_eq!(salary("base-plan"), 152_800.0);
        assert_eq!(salary("agrees"), 152_800.0);
        assert_eq!(
            salary("differs"),
            120_000.0,
            "it never agreed, so it is not overwritten"
        );

        let spending = |id: &str| {
            stream_amount(
                &storage::load_plan(&base.0, id).unwrap(),
                "household-spending",
            )
        };
        assert_eq!(spending("base-plan"), 99_000.0);
        assert_eq!(spending("agrees"), 96_000.0, "not offered, not written");
    }

    #[test]
    fn a_flat_contribution_is_a_rate_the_sitting_can_re_affirm() {
        let base = TempBase::new("contribution-rate");
        store(&base.0, household_plan());
        storage::duplicate_plan(&base.0, "base-plan", "Agrees").unwrap();

        let mut request = sitting("base-plan", YearMonth::new(2026, 12));
        request.rates = vec![RateChange {
            target: RateTarget::Contribution {
                account: "taxable-brokerage".to_string(),
                id: "taxable-brokerage-contribution".to_string(),
            },
            amount: 44_000.0,
            apply_to_siblings: true,
        }];
        refresh_household(&base.0, &request, LATER).unwrap();

        for id in ["base-plan", "agrees"] {
            let entry = flat_entry(&storage::load_plan(&base.0, id).unwrap());
            assert_eq!(
                entry.rule,
                ContributionRule::FlatAmount {
                    amount: 44_000.0,
                    // The growth rule is intent and survives the re-affirm.
                    growth: GrowthRule::Inflation,
                },
                "{id}"
            );
        }
    }

    #[test]
    fn a_refresh_before_the_balances_it_replaces_is_refused() {
        let base = TempBase::new("backwards");
        store(&base.0, household_plan());
        refresh_household(
            &base.0,
            &sitting("base-plan", YearMonth::new(2026, 12)),
            LATER,
        )
        .unwrap();

        let error = refresh_household(
            &base.0,
            &sitting("base-plan", YearMonth::new(2026, 6)),
            LATER,
        )
        .expect_err("June is before the December balances on file");
        assert!(error.contains("December 2026"), "{error}");

        // And nothing moved.
        let plan = storage::load_plan(&base.0, "base-plan").unwrap();
        assert_eq!(plan.sim_config.start, YearMonth::new(2026, 12));
    }

    #[test]
    fn a_refresh_in_the_future_is_refused() {
        let base = TempBase::new("future");
        store(&base.0, household_plan());

        let error = refresh_household(
            &base.0,
            &sitting("base-plan", YearMonth::new(2027, 3)),
            YearMonth::new(2026, 9),
        )
        .expect_err("balances cannot be read for a month that has not happened");
        assert!(error.contains("March 2027"), "{error}");
        assert_eq!(
            count_yaml(&refreshes_dir(&base.0, "base-plan")),
            0,
            "a refused refresh leaves nothing behind"
        );
    }

    // --- fixtures ---------------------------------------------------------

    /// The seed household, plus a percent-of-salary entry that escalates a
    /// point a year from the plan's start. `seed_plan` has no escalating
    /// entry, and the pin is entirely about what escalation does.
    fn escalating_plan() -> Plan {
        let mut plan = household_plan();
        let account = plan
            .accounts
            .iter_mut()
            .find(|a| a.id == "taxable-brokerage")
            .unwrap();
        account.contributions = vec![Contribution::until_retirement(
            "escalating",
            ContributionRule::PercentOfSalary {
                percent: 0.10,
                step_up: Some(StepUp {
                    points_per_year: 0.01,
                    cap: 0.20,
                }),
            },
            &"alex".to_string(),
        )];
        plan
    }

    /// The seed household, with its one flat contribution given an inflation
    /// growth rule. `seed_plan` leaves that entry nominal, and nominal is the
    /// uninteresting case here: an amount in *start dollars* is exactly the
    /// kind the pin has to be shown not to disturb.
    fn household_plan() -> Plan {
        let mut plan = engine::presets::seed_plan();
        plan.accounts
            .iter_mut()
            .find(|a| a.id == "taxable-brokerage")
            .unwrap()
            .contributions[0]
            .rule = ContributionRule::FlatAmount {
            amount: 40_000.0,
            growth: GrowthRule::Inflation,
        };
        plan
    }

    /// The share of Alex's 2028 salary that reached the escalating account —
    /// the percentage in force that year, read out of a real projection
    /// rather than off the entry.
    fn escalated_share(plan: &Plan) -> f64 {
        let projection = engine::run_deterministic(plan);
        let snapshot = projection
            .snapshots
            .iter()
            .find(|s| s.period_start.year == 2028)
            .expect("2028 is inside the horizon");
        let contributed = snapshot
            .contributions_by_account
            .get("taxable-brokerage")
            .copied()
            .unwrap_or(0.0);
        let salary = snapshot
            .income_by_stream
            .get("alex-salary")
            .copied()
            .expect("Alex is still working in 2028");
        contributed / salary
    }

    /// The seed household's one flat-amount contribution, given an
    /// inflation growth rule so the "in start dollars" case is the one under
    /// test.
    fn flat_entry(plan: &Plan) -> Contribution {
        plan.accounts
            .iter()
            .find(|a| a.id == "taxable-brokerage")
            .unwrap()
            .contributions[0]
            .clone()
    }
}
