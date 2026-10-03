//! Tests anchored to publications, not to the engine's own output (#154).
//!
//! Every expected value in this crate is **typed in from a primary source**
//! and cited beside it, or derived on paper in a comment from such values.
//! None is computed by calling the code under test. That is the whole
//! difference from the rest of the suite: a golden file or a test that asks
//! the tax model what the tax should be proves the engine has not changed,
//! not that it was ever right. Two federal tax errors (#142) got through on
//! exactly that.
//!
//! Each tax year's figures are a frozen `TaxFigures::tax_year_YYYY()` with
//! its own `tax_figures_YYYY.rs` and `worked_tax_years_YYYY.rs` here, and
//! `the_built_in_figures_are_the_latest_checked_year` says which one the app
//! ships. A new year is added, never retyped over the old one, and the
//! rest of the suite is written against a named year rather than
//! `built_in()`, so moving the built-ins breaks that one assertion and
//! nothing else. When a new statutory rule lands, its test goes
//! here.
//!
//! Sources, all verified against the documents themselves on 2026-10-03:
//! - IRS Rev. Proc. 2025-32 (2026 brackets, standard deduction, LTCG
//!   breakpoints, additional deduction for the aged)
//! - IRS Notice 2025-67 (2026 retirement plan limits)
//! - IRS Rev. Proc. 2025-19 (2026 HSA limits)
//! - IRS Publication 590-B (2025), Appendix B, Table III (Uniform Lifetime)
//! - IRS Publication 915 (2025), Worksheet 1 (taxable Social Security)
//! - 20 CFR 404.409 (full retirement age), 404.410 (early reduction),
//!   404.313 (delayed retirement credits)

mod analytic_floor;
mod social_security;
mod tax_figures_2026;
mod uniform_lifetime;
mod worked_tax_years_2026;

/// Equality to the cent, which is as exact as any published figure is.
#[track_caller]
pub fn assert_cents(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 0.005,
        "{label}: expected {expected}, got {actual}"
    );
}
