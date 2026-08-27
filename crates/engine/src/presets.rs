//! Default assumptions, portfolio presets, and the seed plan. Defaults live
//! here (in Rust) so the frontend fetches them instead of duplicating them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{
    Account, AccountKind, AllocationRef, AssetClass, Assumptions, CashFlowStream, GrowthRule,
    PeriodLength, Person, Plan, SimConfig, StreamBoundary, StreamDirection, YearMonth,
    SCHEMA_VERSION,
};

/// Bundle the frontend fetches once at startup.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Presets {
    pub default_assumptions: Assumptions,
    /// Asset-class weights for each named `AllocationRef` preset.
    pub allocations: BTreeMap<String, BTreeMap<AssetClass, f64>>,
}

/// Boglehead-style three-fund weights for a named preset.
///
/// - Aggressive: 90/10 stocks/bonds — VTI 60%, VXUS 30%, BND 10%
/// - Moderate:   70/30 — VTI 45%, VXUS 25%, BND 30%
/// - Conservative: 50/50 — VT 50%, BND 50%
pub fn allocation_weights(alloc: &AllocationRef) -> BTreeMap<AssetClass, f64> {
    match alloc {
        AllocationRef::Aggressive => BTreeMap::from([
            (AssetClass::UsEquity, 0.60),
            (AssetClass::IntlEquity, 0.30),
            (AssetClass::UsBonds, 0.10),
        ]),
        AllocationRef::Moderate => BTreeMap::from([
            (AssetClass::UsEquity, 0.45),
            (AssetClass::IntlEquity, 0.25),
            (AssetClass::UsBonds, 0.30),
        ]),
        AllocationRef::Conservative => BTreeMap::from([
            (AssetClass::GlobalEquity, 0.50),
            (AssetClass::UsBonds, 0.50),
        ]),
        AllocationRef::Custom(weights) => weights.clone(),
    }
}

pub fn default_assumptions() -> Assumptions {
    Assumptions {
        inflation: 0.025,
        asset_returns: BTreeMap::from([
            (AssetClass::UsEquity, 0.08),
            (AssetClass::IntlEquity, 0.075),
            (AssetClass::GlobalEquity, 0.078),
            (AssetClass::UsBonds, 0.04),
        ]),
        flat_tax_rate: 0.22,
        plan_end_age: 95,
        sweep_surplus_to_taxable: false,
    }
}

pub fn presets() -> Presets {
    Presets {
        default_assumptions: default_assumptions(),
        allocations: BTreeMap::from([
            (
                "Aggressive".to_string(),
                allocation_weights(&AllocationRef::Aggressive),
            ),
            (
                "Moderate".to_string(),
                allocation_weights(&AllocationRef::Moderate),
            ),
            (
                "Conservative".to_string(),
                allocation_weights(&AllocationRef::Conservative),
            ),
        ]),
    }
}

/// Starter plan bootstrapped on first run. Balances, salaries, and spending
/// are editable placeholders — only the people and dates are real inputs.
pub fn seed_plan() -> Plan {
    let enrique = "enrique".to_string();
    let claire = "claire".to_string();
    Plan {
        schema_version: SCHEMA_VERSION,
        name: "Base plan".to_string(),
        people: vec![
            Person {
                id: enrique.clone(),
                name: "Enrique".to_string(),
                birth: YearMonth::new(1983, 8),
                retirement: YearMonth::new(2038, 8),
            },
            Person {
                id: claire.clone(),
                name: "Claire".to_string(),
                birth: YearMonth::new(1987, 6),
                retirement: YearMonth::new(2042, 8),
            },
        ],
        accounts: vec![
            Account {
                id: "taxable-brokerage".to_string(),
                owner: enrique.clone(),
                kind: AccountKind::Taxable,
                name: "Taxable Brokerage".to_string(),
                balance: 150_000.0,
                cost_basis: Some(110_000.0),
                allocation: AllocationRef::Aggressive,
                annual_contribution: 40_000.0,
                contribution_limit: None,
            },
            Account {
                id: "enrique-401k".to_string(),
                owner: enrique.clone(),
                kind: AccountKind::TraditionalPreTax,
                name: "Enrique 401(k)".to_string(),
                balance: 400_000.0,
                cost_basis: None,
                allocation: AllocationRef::Aggressive,
                annual_contribution: 23_000.0,
                contribution_limit: Some(23_000.0),
            },
            Account {
                id: "claire-roth".to_string(),
                owner: claire.clone(),
                kind: AccountKind::Roth,
                name: "Claire Roth IRA".to_string(),
                balance: 80_000.0,
                cost_basis: None,
                allocation: AllocationRef::Moderate,
                annual_contribution: 7_000.0,
                contribution_limit: Some(7_000.0),
            },
        ],
        streams: vec![
            CashFlowStream {
                id: "enrique-salary".to_string(),
                name: "Enrique salary".to_string(),
                owner: Some(enrique.clone()),
                direction: StreamDirection::Income,
                annual_amount: 140_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(enrique),
                growth: GrowthRule::Inflation,
            },
            CashFlowStream {
                id: "claire-salary".to_string(),
                name: "Claire salary".to_string(),
                owner: Some(claire.clone()),
                direction: StreamDirection::Income,
                annual_amount: 110_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(claire),
                growth: GrowthRule::Inflation,
            },
            CashFlowStream {
                id: "household-spending".to_string(),
                name: "Household spending".to_string(),
                owner: None,
                direction: StreamDirection::Expense,
                annual_amount: 96_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::PlanEnd,
                growth: GrowthRule::Inflation,
            },
        ],
        assumptions: default_assumptions(),
        sim_config: SimConfig {
            start: YearMonth::new(2026, 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}
