//! `TaxFigures::built_in()` against the documents it was typed from. Each
//! value is a literal from the cited section; checking one is reading the
//! line beside it.

use engine::model::{TaxBracket, TaxFigures};

fn ceilings(table: &[TaxBracket]) -> Vec<(Option<f64>, f64)> {
    table.iter().map(|b| (b.up_to, b.rate)).collect()
}

#[test]
fn figures_are_for_2026() {
    assert_eq!(TaxFigures::built_in().tax_year, 2026);
}

/// Rev. Proc. 2025-32 §4.01, Table 1 — Married Individuals Filing Joint
/// Returns and Surviving Spouses.
#[test]
fn married_filing_jointly_brackets_match_rev_proc_2025_32_table_1() {
    let figures = TaxFigures::built_in();
    assert_eq!(
        ceilings(&figures.federal.ordinary_brackets.married_filing_jointly),
        vec![
            (Some(24_800.0), 0.10),
            (Some(100_800.0), 0.12),
            (Some(211_400.0), 0.22),
            (Some(403_550.0), 0.24),
            (Some(512_450.0), 0.32),
            (Some(768_700.0), 0.35),
            (None, 0.37),
        ]
    );
}

/// Rev. Proc. 2025-32 §4.01, Table 3 — Unmarried Individuals (other than
/// Surviving Spouses and Heads of Households).
#[test]
fn single_brackets_match_rev_proc_2025_32_table_3() {
    let figures = TaxFigures::built_in();
    assert_eq!(
        ceilings(&figures.federal.ordinary_brackets.single),
        vec![
            (Some(12_400.0), 0.10),
            (Some(50_400.0), 0.12),
            (Some(105_700.0), 0.22),
            (Some(201_775.0), 0.24),
            (Some(256_225.0), 0.32),
            (Some(640_600.0), 0.35),
            (None, 0.37),
        ]
    );
}

/// Rev. Proc. 2025-32 §4.03, Maximum Capital Gains Rate: the maximum zero
/// rate amount and maximum 15 percent rate amount. "All Other Individuals"
/// is the Single row.
#[test]
fn capital_gains_breakpoints_match_rev_proc_2025_32_section_4_03() {
    let figures = TaxFigures::built_in();
    assert_eq!(
        ceilings(
            &figures
                .federal
                .capital_gains_brackets
                .married_filing_jointly
        ),
        vec![(Some(98_900.0), 0.0), (Some(613_700.0), 0.15), (None, 0.20)]
    );
    assert_eq!(
        ceilings(&figures.federal.capital_gains_brackets.single),
        vec![(Some(49_450.0), 0.0), (Some(545_500.0), 0.15), (None, 0.20)]
    );
}

/// Rev. Proc. 2025-32 §4.14(1), standard deduction under §63(c)(2), and
/// §4.14(3), the additional amount under §63(f) for the aged: $1,650, raised
/// to $2,050 for an individual who is unmarried and not a surviving spouse.
#[test]
fn standard_deductions_match_rev_proc_2025_32_section_4_14() {
    let federal = TaxFigures::built_in().federal;
    assert_eq!(federal.standard_deduction.married_filing_jointly, 32_200.0);
    assert_eq!(federal.standard_deduction.single, 16_100.0);
    assert_eq!(
        federal
            .additional_standard_deduction_65
            .married_filing_jointly,
        1_650.0
    );
    assert_eq!(federal.additional_standard_deduction_65.single, 2_050.0);
}

/// IRS Notice 2025-67, the 2026 limitations. Section numbers are the ones
/// the Notice names for each figure.
#[test]
fn contribution_limits_match_notice_2025_67() {
    let l = TaxFigures::built_in().contribution_limits;
    // §402(g)(1) elective deferrals: "increased from $23,500 to $24,500".
    assert_eq!(l.employer_plan, 24_500.0);
    // §414(v)(2)(B)(i) catch-up, 50 and over: "from $7,500 to $8,000".
    assert_eq!(l.employer_plan_catch_up_50, 8_000.0);
    // §414(v)(2)(E)(i) catch-up for those attaining 60–63: "remains $11,250".
    assert_eq!(l.employer_plan_catch_up_60_63, 11_250.0);
    // §415(c)(1)(A) defined contribution limit: "from $70,000 to $72,000".
    assert_eq!(l.annual_additions, 72_000.0);
    // §457(e)(15) deferrals: "from $23,500 to $24,500".
    assert_eq!(l.plan_457b, 24_500.0);
    // §219(b)(5)(A) IRA deductible amount: "from $7,000 to $7,500".
    assert_eq!(l.ira, 7_500.0);
    // §219(b)(5)(B)(ii) IRA catch-up, 50 and over: "from $1,000 to $1,100".
    assert_eq!(l.ira_catch_up_50, 1_100.0);
    // A SEP is capped by §415(c)(1)(A), the same $72,000.
    assert_eq!(l.sep_ira, 72_000.0);
    // §408(p)(2)(E)(i)(III) SIMPLE deferrals: "from $16,500 to $17,000".
    // The Notice's higher §408(p)(2)(E)(i)(I)/(II) figure ($18,100), for
    // certain small employers, is not modelled; this is the general one.
    assert_eq!(l.simple_ira, 17_000.0);
    // §414(v)(2)(B)(ii) SIMPLE catch-up, 50 and over: "from $3,500 to
    // $4,000". (The (B)(iii) $3,850 variant pairs with the $18,100 limit.)
    assert_eq!(l.simple_ira_catch_up_50, 4_000.0);
    // §414(v)(2)(E)(ii) SIMPLE catch-up for those attaining 60–63:
    // "remains $5,250".
    assert_eq!(l.simple_ira_catch_up_60_63, 5_250.0);
}

/// Rev. Proc. 2025-19 §2(1): the §223(b)(2)(A) self-only limit "is $4,400"
/// and the §223(b)(2)(B) family limit "is $8,750".
#[test]
fn hsa_limits_match_rev_proc_2025_19() {
    let l = TaxFigures::built_in().contribution_limits;
    assert_eq!(l.hsa, 4_400.0);
    assert_eq!(l.hsa_family, 8_750.0);
}
