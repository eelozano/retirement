//! Federal tax for whole tax years, worked on paper from Rev. Proc. 2025-32,
//! Publication 915 and the Form 1040 capital gain worksheet, and compared
//! with `BracketTax`. No state tax, no inflation, tax year 2026 itself, so
//! every figure is the published one untouched by indexing.

use engine::model::{FilingStatus, PriceLevel, StateTaxProfile, TaxFigures};
use engine::strategies::{BracketTax, IncomeBreakdown, TaxModel};

use crate::assert_cents;

fn federal_tax(status: FilingStatus, filer_birth_years: Vec<i32>, income: IncomeBreakdown) -> f64 {
    let figures = TaxFigures::tax_year_2026();
    let model = BracketTax::new(
        &figures,
        status,
        StateTaxProfile::none(),
        PriceLevel::Constant(0.0),
        2026,
        filer_birth_years,
    );
    model.tax(&income, 0).tax
}

fn ordinary(amount: f64) -> IncomeBreakdown {
    IncomeBreakdown {
        ordinary: amount,
        ..Default::default()
    }
}

/// Rev. Proc. 2025-32 §4.01 prints the tax owed at each bracket threshold
/// ("Over $211,400 ... $35,932 plus 24% of the excess"), which checks the
/// bracket arithmetic against the IRS's own sums rather than ours. Taxable
/// income lands exactly on a threshold when ordinary income is that
/// threshold plus the $32,200 joint standard deduction (§4.14).
#[test]
fn joint_tax_at_each_threshold_matches_rev_proc_2025_32_table_1() {
    let deduction = 32_200.0;
    for (threshold, published_tax) in [
        (24_800.0, 2_480.0),
        (100_800.0, 11_600.0),
        (211_400.0, 35_932.0),
        (403_550.0, 82_048.0),
        (512_450.0, 116_896.0),
        (768_700.0, 206_583.50),
    ] {
        let tax = federal_tax(
            FilingStatus::MarriedFilingJointly,
            vec![],
            ordinary(threshold + deduction),
        );
        assert_cents(tax, published_tax, &format!("MFJ taxable {threshold}"));
    }
}

/// The same for Table 3 (unmarried), on the $16,100 Single deduction.
#[test]
fn single_tax_at_each_threshold_matches_rev_proc_2025_32_table_3() {
    let deduction = 16_100.0;
    for (threshold, published_tax) in [
        (12_400.0, 1_240.0),
        (50_400.0, 5_800.0),
        (105_700.0, 17_966.0),
        (201_775.0, 41_024.0),
        (256_225.0, 58_448.0),
        (640_600.0, 192_979.25),
    ] {
        let tax = federal_tax(
            FilingStatus::Single,
            vec![],
            ordinary(threshold + deduction),
        );
        assert_cents(tax, published_tax, &format!("Single taxable {threshold}"));
    }
}

/// Inside a bracket, from Table 3's formula: taxable income $150,000 is
/// "over $105,700 but not over $201,775", so $17,966 plus 24% of
/// (150,000 - 105,700 = 44,300) = 17,966 + 10,632 = $28,598.
#[test]
fn single_tax_inside_a_bracket() {
    let tax = federal_tax(FilingStatus::Single, vec![], ordinary(150_000.0 + 16_100.0));
    assert_cents(tax, 28_598.0, "Single taxable 150,000");
}

/// A retired joint return: both spouses born 1955 (71 in 2026), $50,000 of
/// Social Security, $30,000 drawn from pre-tax accounts, $20,000 of
/// long-term gains.
///
/// Taxable Social Security (Pub 915 Worksheet 1; IRC 86 base amounts
/// $32,000 and $44,000 for a joint return):
///   provisional income = 30,000 + 20,000 + 50,000 / 2 = 75,000
///   over the $32,000 base: 43,000; over the $44,000 adjusted base: 31,000
///   85% x 31,000 + lesser of (6,000, half the benefit 25,000)
///     = 26,350 + 6,000 = 32,350
///   capped at 85% of the benefit, 42,500 -> taxable 32,350
/// Deduction (Rev. Proc. 2025-32 §4.14): 32,200 + 2 x 1,650 = 35,500
/// Taxable income: 30,000 + 32,350 + 20,000 - 35,500 = 46,850, of which
///   20,000 is gain and 26,850 ordinary
/// Ordinary tax (Table 1): 2,480 + 12% x (26,850 - 24,800) = 2,480 + 246
///   = 2,726
/// Gains: stacked from 26,850 to 46,850, all under the $98,900 maximum
///   zero rate amount (§4.03) -> 0
/// Total: $2,726
#[test]
fn retired_couple_with_social_security_and_gains() {
    let tax = federal_tax(
        FilingStatus::MarriedFilingJointly,
        vec![1955, 1955],
        IncomeBreakdown {
            ordinary: 30_000.0,
            capital_gains: 20_000.0,
            social_security: 50_000.0,
            ..Default::default()
        },
    );
    assert_cents(tax, 2_726.0, "retired MFJ year");
}

/// The deduction exceeds ordinary income, the region #142 got wrong. Single,
/// under 65: $10,000 ordinary, $60,000 of gains.
///   Taxable income: 10,000 + 60,000 - 16,100 = 53,900
///   Gain taxed: lesser of 60,000 and 53,900 = 53,900; ordinary part 0
///   0% to the $49,450 maximum zero rate amount, 15% above:
///   15% x (53,900 - 49,450) = 15% x 4,450 = $667.50
/// Discarding the unused $6,100 of deduction instead would tax all 60,000
/// of gain: 15% x 10,550 = $1,582.50.
#[test]
fn deduction_left_over_from_ordinary_income_shelters_gains() {
    let tax = federal_tax(
        FilingStatus::Single,
        vec![],
        IncomeBreakdown {
            ordinary: 10_000.0,
            capital_gains: 60_000.0,
            ..Default::default()
        },
    );
    assert_cents(tax, 667.50, "Single, deduction over ordinary income");
}

/// Gains stacked across the zero-rate boundary. Joint, under 65: $100,000
/// ordinary, $50,000 of gains.
///   Taxable income: 150,000 - 32,200 = 117,800; ordinary part 67,800
///   Ordinary tax: 2,480 + 12% x (67,800 - 24,800) = 2,480 + 5,160 = 7,640
///   Gains fill 67,800 -> 117,800: 0% up to 98,900 (31,100 of gain), 15% on
///   the other 18,900 = 2,835
///   Total: $10,475
#[test]
fn gains_straddling_the_zero_rate_boundary() {
    let tax = federal_tax(
        FilingStatus::MarriedFilingJointly,
        vec![],
        IncomeBreakdown {
            ordinary: 100_000.0,
            capital_gains: 50_000.0,
            ..Default::default()
        },
    );
    assert_cents(tax, 10_475.0, "MFJ gains across 98,900");
}
