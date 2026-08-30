use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{AssetClass, PersonId};

pub type AccountId = String;

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[ts(export)]
pub enum AccountKind {
    /// Brokerage: contributions form cost basis; withdrawals realize gains
    /// proportionally.
    Taxable,
    /// 401(k)/Traditional IRA: withdrawals are ordinary income.
    TraditionalPreTax,
    /// Roth IRA/401(k): qualified withdrawals are untaxed.
    Roth,
}

/// Which statutory contribution bucket an account draws on.
///
/// Deliberately orthogonal to `AccountKind`, which is the *tax treatment*
/// axis: a Roth 401(k) and a Roth IRA are taxed identically and capped
/// separately, while a traditional IRA and a Roth IRA are taxed differently
/// and share one cap. Two axes, each with one job — exploding `AccountKind`
/// into five variants would force every `match` in the tax and drawdown
/// paths to grow for a distinction those paths do not care about.
///
/// 457(b) has a statutorily separate limit from 401(k)/403(b) and would be a
/// fourth variant here, not a rework.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[ts(export)]
pub enum PlanType {
    /// 401(k)/403(b)/TSP elective deferrals, sharing one limit per person.
    EmployerPlan,
    /// Traditional and Roth IRAs, sharing one (much smaller) limit.
    Ira,
    /// No statutory cap — a taxable brokerage.
    None,
}

impl PlanType {
    /// The bucket an account of this kind belongs to by default. Follows the
    /// convention the kind labels already imply: pre-tax means a
    /// 401(k)-style plan, Roth means a Roth IRA. Overridable per account.
    pub fn default_for(kind: AccountKind) -> Self {
        match kind {
            AccountKind::Taxable => PlanType::None,
            AccountKind::TraditionalPreTax => PlanType::EmployerPlan,
            AccountKind::Roth => PlanType::Ira,
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

/// Portfolio allocation: a named preset or explicit weights summing to 1.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub enum AllocationRef {
    Aggressive,
    Moderate,
    Conservative,
    Custom(BTreeMap<AssetClass, f64>),
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
}

/// Deserialization shape for `Account`, carrying the pre-#32 fields so plans
/// written before contribution modes existed still load.
///
/// A wire struct rather than `#[serde(default)]` on the new fields because
/// neither default can be computed field-locally: `contribution` has to read
/// the legacy `annual_contribution`, and `plan_type` has to read `kind`.
/// Same migration intent as the `#[serde(default)]` precedent documented on
/// `sweep_surplus_to_taxable` and `social_security`.
///
/// The legacy per-account `contribution_limit` is accepted and dropped: the
/// engine now owns statutory limits (indexed, with catch-up tiers) instead of
/// reading a frozen user-typed number, so there is nothing to migrate it to.
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
    /// Pre-#32: a flat nominal figure applied unchanged every period.
    #[serde(default)]
    annual_contribution: Option<f64>,
    /// Pre-#32: a user-typed statutory cap. Accepted so old plans parse;
    /// deliberately unused.
    #[serde(default)]
    #[allow(dead_code)]
    contribution_limit: Option<f64>,
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
            plan_type: w.plan_type.unwrap_or_else(|| PlanType::default_for(w.kind)),
            contribution,
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
    }

    #[test]
    fn legacy_plan_type_defaults_follow_the_account_kind() {
        for (kind, expected) in [
            (AccountKind::Taxable, PlanType::None),
            (AccountKind::TraditionalPreTax, PlanType::EmployerPlan),
            (AccountKind::Roth, PlanType::Ira),
        ] {
            assert_eq!(PlanType::default_for(kind), expected);
        }
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
        };
        let json = serde_json::to_string(&account).unwrap();
        let back: Account = serde_json::from_str(&json).unwrap();
        assert_eq!(back.contribution, ContributionRule::PercentOfSalary(0.08));
        assert_eq!(back.plan_type, PlanType::Ira);
    }
}
