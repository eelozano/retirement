use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{AssetClass, PersonId};
use crate::presets::{ELECTIVE_DEFERRAL_LIMIT, IRA_CONTRIBUTION_LIMIT};

pub type AccountId = String;

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[ts(export)]
pub enum AccountKind {
    /// Brokerage: contributions form cost basis; withdrawals realize gains
    /// proportionally, taxed as capital gains.
    Taxable,
    /// 401(k)/Traditional IRA: withdrawals are ordinary income.
    TraditionalPreTax,
    /// Roth IRA/401(k): qualified withdrawals are untaxed.
    Roth,
    /// Cash savings: contributions form cost basis like `Taxable`, but the
    /// growth a savings account pays out is interest, not a capital gain —
    /// the withdrawn share above cost basis is taxed as ordinary income.
    Savings,
    /// Health Savings Account: pre-tax in like `TraditionalPreTax`, untaxed
    /// out like `Roth` — the one combination neither existing variant
    /// covers. Assumes withdrawals are qualified medical spending, the
    /// standard simplification; this app does not model the ordinary-income
    /// treatment (plus penalty pre-65) of a non-qualified withdrawal.
    Hsa,
}

/// Which statutory contribution bucket an account draws on.
///
/// Deliberately orthogonal to `AccountKind`, which is the *tax treatment*
/// axis: a Roth 401(k) and a Roth IRA are taxed identically and capped
/// separately, while a traditional IRA and a Roth IRA are taxed differently
/// and share one cap. Two axes, each with one job — folding a statutory
/// bucket distinction into `AccountKind` instead would force every `match`
/// in the tax and drawdown paths to grow for a distinction those paths do
/// not care about.
///
/// 457(b) has a statutorily separate limit from 401(k)/403(b), so it is a
/// variant here rather than folded into `EmployerPlan`; HSA, SEP-IRA, and
/// SIMPLE IRA each carry their own statutorily distinct limit for the same
/// reason.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[ts(export)]
pub enum PlanType {
    /// 401(k)/403(b)/401(a)/TSP elective deferrals, sharing one limit per
    /// person. 401(a) plans vary by employer and are not always subject to
    /// this cap in reality — approximated here rather than modeled exactly.
    EmployerPlan,
    /// Traditional and Roth IRAs, sharing one (much smaller) limit.
    Ira,
    /// 457(b) governmental deferred-compensation plans: statutorily separate
    /// from `EmployerPlan`, so a person can max out both in the same year.
    Plan457b,
    /// Health Savings Account contribution limit. One figure (the self-only
    /// coverage limit) rather than modeling the family-coverage limit
    /// separately — this app has no concept of HSA coverage type.
    Hsa,
    /// SEP-IRA: employer-only contributions, capped at the much higher
    /// 415(c) annual-additions figure. No employee catch-up.
    SepIra,
    /// SIMPLE IRA: its own elective-deferral limit, separate from a regular
    /// IRA, with its own SECURE 2.0 catch-up tiers.
    SimpleIra,
    /// No statutory cap — a taxable brokerage or a savings account.
    None,
}

impl PlanType {
    /// The bucket an account of this kind belongs to by default. Follows the
    /// convention the kind labels already imply: pre-tax means a
    /// 401(k)-style plan, Roth means a Roth IRA. Overridable per account.
    pub fn default_for(kind: AccountKind) -> Self {
        match kind {
            AccountKind::Taxable | AccountKind::Savings => PlanType::None,
            AccountKind::TraditionalPreTax => PlanType::EmployerPlan,
            AccountKind::Roth => PlanType::Ira,
            AccountKind::Hsa => PlanType::Hsa,
        }
    }
}

/// How much goes into an account each year while its owner is still working.
///
/// A tagged enum rather than a number plus flags, so the combinations that
/// do not mean anything cannot be written down — the same approach
/// `StreamBoundary` and `GrowthRule` take.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq)]
#[ts(export)]
pub enum ContributionRule {
    /// Fraction of the owner's gross salary for the period (0.08 = 8%),
    /// resolved against their income streams. Grows with the salary, so it
    /// holds its real value without any indexing machinery — and it is the
    /// basis an employer match is expressed against.
    PercentOfSalary(f64),
    /// A flat annual amount, **nominal**: it does not index with inflation,
    /// so it buys less every year. Correct for an account funded by a fixed
    /// standing transfer; the UI says so rather than letting it decay
    /// silently.
    FlatAmount(f64),
    /// The statutory maximum for the account's `plan_type`, indexed forward
    /// and stepped up for the owner's catch-up tier. Stored as intent rather
    /// than a number so the plan stays correct as limits index and the owner
    /// ages — see `presets::ContributionLimits`.
    FederalMaximum,
}

impl Default for ContributionRule {
    fn default() -> Self {
        ContributionRule::FlatAmount(0.0)
    }
}

/// One tier of an employer match formula.
///
/// Real plan documents are tiered — "100% of the first 3% of salary, then
/// 50% of the next 2%" — which is `[{3%, 100%}, {2%, 50%}]`. A single flat
/// percentage is the one-tier case, so the ergonomic default costs nothing
/// and the shape still fits the plans people actually have.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq)]
#[ts(export)]
pub struct MatchTier {
    /// How wide this tier is, as a fraction of salary (0.03 = "the first
    /// 3%"). Tiers apply in order, each consuming the employee's deferral
    /// percentage until it runs out.
    pub employee_percent: f64,
    /// What fraction of the employee's deferral in this tier the employer
    /// adds (1.0 = "100% of", 0.5 = "50% of").
    pub match_percent: f64,
}

/// Tax treatment of matched dollars.
///
/// Traditionally the match lands pre-tax even when the employee defers Roth;
/// post-SECURE 2.0 a Roth match is permitted, so this is a choice rather than
/// an assumption. It selects *which account receives the money*, not just a
/// label: an account's `kind` is what the drawdown and tax paths read, so
/// pre-tax dollars sitting in a Roth account would be withdrawn untaxed. See
/// `sim::contributions::match_target`.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[ts(export)]
pub enum MatchDestination {
    PreTax,
    Roth,
}

/// Employer matching contributions on an employer plan.
///
/// Declared **per account**, not per person: the match belongs to an
/// employer's plan document, and an account is what stands for a plan here.
/// Someone with two jobs has two plans with two different formulas, which
/// a per-person field could not express.
///
/// Vesting is **deliberately deferred**, not forgotten. An unvested balance
/// that never vests is a real planning consideration for someone changing
/// jobs, and modelling it needs a schedule plus a leaving date — neither of
/// which exists yet. Until then every matched dollar is treated as vested.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct EmployerMatch {
    /// Applied in order. Empty means no match.
    pub tiers: Vec<MatchTier>,
    pub destination: MatchDestination,
}

/// Portfolio allocation: a named preset, explicit weights summing to 1, or a
/// fixed cash rate.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub enum AllocationRef {
    Aggressive,
    Moderate,
    Conservative,
    Custom(BTreeMap<AssetClass, f64>),
    /// A fixed nominal annual rate (0.045 = 4.5%) applied directly to the
    /// balance each period, bypassing `Assumptions::asset_returns` entirely
    /// — a savings/money-market account's rate, not a market return. Like
    /// `ContributionRule::FlatAmount`, this is nominal by design: it does
    /// not track inflation on its own.
    Cash(f64),
}

#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Account {
    pub id: AccountId,
    pub owner: PersonId,
    pub kind: AccountKind,
    pub name: String,
    /// Starting balance in nominal dollars as of the simulation start.
    pub balance: f64,
    /// Taxable accounts only: cost basis of the starting balance. Tracked
    /// from day 1 so V2 capital-gains modeling needs no migration; the V1
    /// flat tax already uses it to split withdrawals into principal vs gains.
    pub cost_basis: Option<f64>,
    pub allocation: AllocationRef,
    /// Which statutory limit this account is held to. The cap is shared per
    /// person per year with the owner's other accounts in the same bucket
    /// rather than granted per account — see `sim::contributions`.
    pub plan_type: PlanType,
    /// What the owner puts in each year while still working.
    pub contribution: ContributionRule,
    /// Employer match on this plan, if any. Matched dollars are employer
    /// money: they do not count against the employee elective-deferral
    /// limit, only against the much higher 415(c) annual-additions cap.
    pub employer_match: Option<EmployerMatch>,
}

/// Deserialization shape for `Account`, carrying the pre-#32 fields so plans
/// written before contribution modes existed still load.
///
/// A wire struct rather than `#[serde(default)]` on the new fields because
/// neither default can be computed field-locally: `contribution` has to read
/// the legacy `annual_contribution`, and `plan_type` has to read `kind`.
/// Same migration intent as the `#[serde(default)]` precedent documented on
/// `sweep_surplus_from` and `social_security`.
///
/// The legacy per-account `contribution_limit` no longer survives as a
/// field — the engine owns statutory limits now, indexed and with catch-up
/// tiers, instead of reading a frozen user-typed number. It is still read
/// once, to pick the bucket: see `migrated_plan_type`.
#[derive(Deserialize)]
struct AccountWire {
    id: AccountId,
    owner: PersonId,
    kind: AccountKind,
    name: String,
    balance: f64,
    #[serde(default)]
    cost_basis: Option<f64>,
    allocation: AllocationRef,
    #[serde(default)]
    plan_type: Option<PlanType>,
    #[serde(default)]
    contribution: Option<ContributionRule>,
    /// `#[serde(default)]` so plans saved before #33 load with no match,
    /// unchanged — the same precedent as `social_security`.
    #[serde(default)]
    employer_match: Option<EmployerMatch>,
    /// Pre-#32: a flat nominal figure applied unchanged every period.
    #[serde(default)]
    annual_contribution: Option<f64>,
    /// Pre-#32: a user-typed statutory cap. Read only by
    /// `migrated_plan_type`.
    #[serde(default)]
    contribution_limit: Option<f64>,
}

/// The bucket a pre-#32 account belonged to, recovered from the limit it
/// carried.
///
/// `AccountKind` alone puts every pre-tax account in the employer-plan
/// bucket, which is wrong for a traditional IRA — and the old schema *did*
/// record enough to tell, in the limit the user typed. This is #31's
/// `bucket_for` heuristic, kept for exactly one job: reading a plan file
/// written before the field existed. It is strictly better than ignoring
/// the limit, and it never runs at simulate time, where the field is now
/// read directly.
///
/// A taxable account is `None` regardless of any stale limit — validation
/// requires the two axes to agree there.
fn migrated_plan_type(kind: AccountKind, contribution_limit: Option<f64>) -> PlanType {
    let default = PlanType::default_for(kind);
    let Some(limit) = contribution_limit else {
        return default;
    };
    if default == PlanType::None {
        return default;
    }
    if (limit - IRA_CONTRIBUTION_LIMIT).abs() <= (limit - ELECTIVE_DEFERRAL_LIMIT).abs() {
        PlanType::Ira
    } else {
        PlanType::EmployerPlan
    }
}

/// Hand-written rather than `#[serde(from = "AccountWire")]` only because
/// ts-rs cannot parse that container attribute and warns on every build; the
/// behavior is identical.
impl<'de> Deserialize<'de> for Account {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        AccountWire::deserialize(deserializer).map(Account::from)
    }
}

impl From<AccountWire> for Account {
    fn from(w: AccountWire) -> Self {
        let contribution = w
            .contribution
            .unwrap_or_else(|| ContributionRule::FlatAmount(w.annual_contribution.unwrap_or(0.0)));
        Account {
            plan_type: w
                .plan_type
                .unwrap_or_else(|| migrated_plan_type(w.kind, w.contribution_limit)),
            contribution,
            employer_match: w.employer_match,
            id: w.id,
            owner: w.owner,
            kind: w.kind,
            name: w.name,
            balance: w.balance,
            cost_basis: w.cost_basis,
            allocation: w.allocation,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plan file written before #32 carries `annual_contribution` and
    /// `contribution_limit` and neither new field.
    #[test]
    fn legacy_account_migrates_to_a_flat_amount() {
        let json = r#"{
            "id": "401k",
            "owner": "p1",
            "kind": "TraditionalPreTax",
            "name": "401k",
            "balance": 100000.0,
            "cost_basis": null,
            "allocation": "Aggressive",
            "annual_contribution": 23000.0,
            "contribution_limit": 23000.0
        }"#;
        let account: Account = serde_json::from_str(json).expect("legacy account parses");
        assert_eq!(account.contribution, ContributionRule::FlatAmount(23_000.0));
        assert_eq!(account.plan_type, PlanType::EmployerPlan);
        assert_eq!(account.employer_match, None, "no match until one is set");
    }

    /// The old schema could not name the bucket, but the limit the user
    /// typed says which one it was — a traditional IRA is `TraditionalPreTax`
    /// like a 401(k), and only its $7,500-ish limit tells them apart.
    #[test]
    fn a_legacy_ira_limit_migrates_into_the_ira_bucket() {
        let account = |kind, limit: f64| {
            let json = format!(
                r#"{{"id":"a","owner":"p1","kind":"{kind}","name":"a","balance":0.0,
                    "cost_basis":null,"allocation":"Moderate","annual_contribution":0.0,
                    "contribution_limit":{limit}}}"#
            );
            serde_json::from_str::<Account>(&json).expect("legacy account parses")
        };
        assert_eq!(
            account("TraditionalPreTax", IRA_CONTRIBUTION_LIMIT).plan_type,
            PlanType::Ira,
        );
        assert_eq!(
            account("TraditionalPreTax", ELECTIVE_DEFERRAL_LIMIT).plan_type,
            PlanType::EmployerPlan,
        );
        // A Roth 401(k) is the mirror case: `Roth` alone would say IRA.
        assert_eq!(
            account("Roth", ELECTIVE_DEFERRAL_LIMIT).plan_type,
            PlanType::EmployerPlan,
        );
    }

    #[test]
    fn legacy_plan_type_defaults_follow_the_account_kind() {
        // An uncapped account carries no signal, so the kind decides. A
        // taxable account stays `None` even if a stale limit says otherwise.
        for (kind, expected) in [
            (AccountKind::Taxable, PlanType::None),
            (AccountKind::TraditionalPreTax, PlanType::EmployerPlan),
            (AccountKind::Roth, PlanType::Ira),
            (AccountKind::Savings, PlanType::None),
            (AccountKind::Hsa, PlanType::Hsa),
        ] {
            assert_eq!(PlanType::default_for(kind), expected);
            assert_eq!(migrated_plan_type(kind, None), expected);
        }
        assert_eq!(
            migrated_plan_type(AccountKind::Taxable, Some(IRA_CONTRIBUTION_LIMIT)),
            PlanType::None,
        );
    }

    /// Round-tripping a current account leaves both new fields alone.
    #[test]
    fn current_account_round_trips() {
        let account = Account {
            id: "a".into(),
            owner: "p1".into(),
            kind: AccountKind::Roth,
            name: "Roth IRA".into(),
            balance: 1.0,
            cost_basis: None,
            allocation: AllocationRef::Moderate,
            plan_type: PlanType::Ira,
            contribution: ContributionRule::PercentOfSalary(0.08),
            employer_match: None,
        };
        let json = serde_json::to_string(&account).unwrap();
        let back: Account = serde_json::from_str(&json).unwrap();
        assert_eq!(back.contribution, ContributionRule::PercentOfSalary(0.08));
        assert_eq!(back.plan_type, PlanType::Ira);
    }
}
