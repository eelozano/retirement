use crate::model::{bracket_tax, FilingStatus, StateTaxProfile, TaxBracket};
use crate::strategies::PeriodIndex;

/// Income for one period, split by character. `ordinary` covers wages and
/// pre-tax withdrawals; `social_security` is carried separately from
/// `ordinary` because its federal taxability depends on a provisional-income
/// formula rather than being fully taxable outright (see
/// [`federally_taxable_social_security`]).
#[derive(Clone, Copy, Debug, Default)]
pub struct IncomeBreakdown {
    /// Wages, pre-tax account withdrawals, (V2) interest.
    pub ordinary: f64,
    /// Realized capital gains from taxable-account withdrawals.
    pub capital_gains: f64,
    /// Roth withdrawals and returned principal — never taxed, carried for
    /// reporting.
    pub untaxed: f64,
    /// Gross Social Security benefit income for the period, before applying
    /// the federal partial-taxability rule.
    pub social_security: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TaxResult {
    pub tax: f64,
}

/// Computes tax owed on a period's income. `period` lets V2 models index
/// inflation-adjusted brackets; V1 ignores it.
pub trait TaxModel {
    fn tax(&self, income: &IncomeBreakdown, period: PeriodIndex) -> TaxResult;
}

/// A flat rate on ordinary income and realized gains alike, ignoring
/// standard deductions, Social Security taxability, and state tax entirely.
/// Not used by `run_deterministic` (see `BracketTax`) — kept as a trivial,
/// hand-computable `TaxModel` for engine-mechanics tests that want to
/// isolate contribution/withdrawal/growth arithmetic from real tax law.
pub struct FlatTax {
    pub rate: f64,
}

impl TaxModel for FlatTax {
    fn tax(&self, income: &IncomeBreakdown, _period: PeriodIndex) -> TaxResult {
        TaxResult {
            tax: (income.ordinary + income.capital_gains).max(0.0) * self.rate,
        }
    }
}

/// Federal ordinary-income brackets, standard deduction, and long-term
/// capital-gains brackets by filing status. 2025 tax year (standard
/// deduction reflects the One Big Beautiful Bill Act's July 2025 increase).
/// Fixed in code — unlike state tax, federal law is uniform across users, so
/// there's no per-plan editing surface for it; update these constants when
/// the IRS publishes new inflation adjustments.
mod federal {
    use super::{FilingStatus, TaxBracket};

    pub fn standard_deduction(status: FilingStatus) -> f64 {
        match status {
            FilingStatus::Single => 15_750.0,
            FilingStatus::MarriedFilingJointly => 31_500.0,
        }
    }

    pub fn ordinary_brackets(status: FilingStatus) -> Vec<TaxBracket> {
        let raw: &[(Option<f64>, f64)] = match status {
            FilingStatus::Single => &[
                (Some(11_925.0), 0.10),
                (Some(48_475.0), 0.12),
                (Some(103_350.0), 0.22),
                (Some(197_300.0), 0.24),
                (Some(250_525.0), 0.32),
                (Some(626_350.0), 0.35),
                (None, 0.37),
            ],
            FilingStatus::MarriedFilingJointly => &[
                (Some(23_850.0), 0.10),
                (Some(96_950.0), 0.12),
                (Some(206_700.0), 0.22),
                (Some(394_600.0), 0.24),
                (Some(501_050.0), 0.32),
                (Some(751_600.0), 0.35),
                (None, 0.37),
            ],
        };
        to_brackets(raw)
    }

    /// Long-term capital gains / qualified dividends brackets.
    pub fn ltcg_brackets(status: FilingStatus) -> Vec<TaxBracket> {
        let raw: &[(Option<f64>, f64)] = match status {
            FilingStatus::Single => &[(Some(48_350.0), 0.0), (Some(533_400.0), 0.15), (None, 0.20)],
            FilingStatus::MarriedFilingJointly => {
                &[(Some(96_700.0), 0.0), (Some(600_050.0), 0.15), (None, 0.20)]
            }
        };
        to_brackets(raw)
    }

    /// Provisional-income thresholds for Social Security taxability: (base,
    /// additional). Unlike the brackets above, these are fixed by statute,
    /// not inflation-indexed — they haven't changed since 1993.
    pub fn social_security_thresholds(status: FilingStatus) -> (f64, f64) {
        match status {
            FilingStatus::Single => (25_000.0, 34_000.0),
            FilingStatus::MarriedFilingJointly => (32_000.0, 44_000.0),
        }
    }

    fn to_brackets(raw: &[(Option<f64>, f64)]) -> Vec<TaxBracket> {
        raw.iter()
            .map(|(up_to, rate)| TaxBracket {
                up_to: *up_to,
                rate: *rate,
            })
            .collect()
    }
}

/// The fraction of a Social Security benefit that's federally taxable,
/// applying the standard IRS provisional-income formula: up to 50% taxable
/// once provisional income (other ordinary income + half the benefit)
/// crosses the base threshold, up to 85% once it crosses the additional
/// threshold.
fn federally_taxable_social_security(
    other_ordinary: f64,
    benefit: f64,
    status: FilingStatus,
) -> f64 {
    if benefit <= 0.0 {
        return 0.0;
    }
    let (base, additional) = federal::social_security_thresholds(status);
    let provisional = other_ordinary.max(0.0) + 0.5 * benefit;

    if provisional <= base {
        return 0.0;
    }

    // The 50%-tier's contribution is capped three ways: half the benefit,
    // half of how far provisional income clears the base, and — once
    // provisional income has cleared the *additional* threshold too — half
    // the base-to-additional gap itself, since above that point every
    // further dollar is absorbed by the 85% tier instead.
    let tier1 = (0.5 * (provisional - base))
        .min(0.5 * benefit)
        .min(0.5 * (additional - base));
    if provisional <= additional {
        return tier1;
    }

    let tier2 = 0.85 * (provisional - additional);
    (tier1 + tier2).min(0.85 * benefit)
}

/// Federal + state tax from real bracket tables (#9), replacing the V1 flat
/// rate. Ordinary income and capital gains are taxed federally via their own
/// bracket schedules (gains stacked on top of ordinary taxable income, the
/// standard IRS stacking method); Social Security is taxed via the
/// provisional-income partial-taxability rule. State tax applies
/// `state_tax`'s bracket schedule to ordinary income plus capital gains —
/// Social Security is excluded from the state base as a simplification
/// (most states with an income tax exempt it, fully or in large part).
pub struct BracketTax {
    pub filing_status: FilingStatus,
    pub state_tax: StateTaxProfile,
}

impl TaxModel for BracketTax {
    fn tax(&self, income: &IncomeBreakdown, _period: PeriodIndex) -> TaxResult {
        let status = self.filing_status;
        let taxable_ss =
            federally_taxable_social_security(income.ordinary, income.social_security, status);
        let federal_ordinary_income = (income.ordinary + taxable_ss).max(0.0);

        let std_deduction = federal::standard_deduction(status);
        let taxable_ordinary = (federal_ordinary_income - std_deduction).max(0.0);
        let federal_ordinary_tax =
            bracket_tax(taxable_ordinary, &federal::ordinary_brackets(status));

        // Capital gains stack on top of ordinary taxable income: tax the
        // combined total through the LTCG schedule, then back out the
        // portion attributable to ordinary income alone.
        let gains = income.capital_gains.max(0.0);
        let ltcg_brackets = federal::ltcg_brackets(status);
        let federal_gains_tax = bracket_tax(taxable_ordinary + gains, &ltcg_brackets)
            - bracket_tax(taxable_ordinary, &ltcg_brackets);

        let state_base =
            (income.ordinary + income.capital_gains - self.state_tax.standard_deduction).max(0.0);
        let state_tax = bracket_tax(state_base, &self.state_tax.brackets);

        TaxResult {
            tax: federal_ordinary_tax + federal_gains_tax + state_tax,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f64, expected: f64, label: &str) {
        assert!(
            (actual - expected).abs() < 1e-6,
            "{label}: expected {expected}, got {actual}"
        );
    }

    #[test]
    fn ordinary_income_below_standard_deduction_owes_no_federal_tax() {
        let tax = BracketTax {
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
        };
        let result = tax.tax(
            &IncomeBreakdown {
                ordinary: 10_000.0,
                ..Default::default()
            },
            0,
        );
        assert_close(result.tax, 0.0, "tax below standard deduction");
    }

    #[test]
    fn ordinary_income_spans_multiple_federal_brackets() {
        let tax = BracketTax {
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
        };
        // taxable = 100_000 - 15_750 = 84_250, spanning 10/12/22% brackets.
        // 11_925*10% + (48_475-11_925)*12% + (84_250-48_475)*22%
        // = 1192.5 + 4386 + 7870.5 = 13449.0
        let result = tax.tax(
            &IncomeBreakdown {
                ordinary: 100_000.0,
                ..Default::default()
            },
            0,
        );
        assert_close(result.tax, 13_449.0, "multi-bracket ordinary tax");
    }

    #[test]
    fn capital_gains_stack_on_top_of_ordinary_income() {
        let tax = BracketTax {
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
        };
        // Ordinary alone (40k - 15,750 = 24,250 taxable) stays under the
        // 48,350 0%-LTCG ceiling; gains stack from 24,250 to 74,250 taxable,
        // so 24,100 of the 50k gain falls in the 0% band and 25,900 in 15%.
        let result = tax.tax(
            &IncomeBreakdown {
                ordinary: 40_000.0,
                capital_gains: 50_000.0,
                ..Default::default()
            },
            0,
        );
        let federal_ordinary =
            bracket_tax(24_250.0, &federal::ordinary_brackets(FilingStatus::Single));
        let expected_gains_tax = 25_900.0 * 0.15;
        assert_close(
            result.tax,
            federal_ordinary + expected_gains_tax,
            "stacked capital gains tax",
        );
    }

    #[test]
    fn social_security_untaxed_below_base_threshold() {
        // Provisional income = 0 + 0.5*20k = 10k, well under the 25k base.
        let taxable = federally_taxable_social_security(0.0, 20_000.0, FilingStatus::Single);
        assert_close(taxable, 0.0, "SS below base threshold");
    }

    #[test]
    fn social_security_partially_taxed_in_middle_tier() {
        // other_ordinary 20k + 0.5*20k = 30k provisional, between 25k/34k base/additional.
        // tier1 = min(0.5*(30k-25k), 0.5*20k) = min(2500, 10000) = 2500.
        let taxable = federally_taxable_social_security(20_000.0, 20_000.0, FilingStatus::Single);
        assert_close(taxable, 2_500.0, "SS middle tier");
    }

    #[test]
    fn social_security_capped_at_85_percent_when_provisional_income_is_high() {
        let taxable = federally_taxable_social_security(200_000.0, 20_000.0, FilingStatus::Single);
        assert_close(taxable, 20_000.0 * 0.85, "SS capped at 85%");
    }

    /// A large benefit with provisional income only modestly past the
    /// additional threshold: the 50%-tier must stop contributing at half the
    /// base-to-additional gap ($4,500 for Single) rather than at half the
    /// benefit, or this overshoots — and unlike the above case, the overall
    /// 85%-of-benefit cap doesn't happen to mask the difference here.
    #[test]
    fn social_security_fifty_percent_tier_caps_at_half_the_threshold_gap() {
        let taxable = federally_taxable_social_security(0.0, 100_000.0, FilingStatus::Single);
        // provisional = 50k; tier1 = min(12.5k, 50k, 4.5k) = 4.5k;
        // tier2 = 0.85*(50k-34k) = 13.6k; total = 18.1k, well under 85k cap.
        assert_close(taxable, 18_100.0, "SS 50%-tier capped by threshold gap");
    }

    #[test]
    fn state_tax_uses_its_own_bracket_schedule_and_deduction() {
        let tax = BracketTax {
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile {
                state: crate::model::StateCode::Other,
                brackets: vec![TaxBracket {
                    up_to: None,
                    rate: 0.05,
                }],
                standard_deduction: 5_000.0,
            },
        };
        let result = tax.tax(
            &IncomeBreakdown {
                ordinary: 15_750.0, // exactly the federal standard deduction: $0 federal tax
                ..Default::default()
            },
            0,
        );
        // State: (15,750 - 5,000) * 5% = 537.5; federal: 0.
        assert_close(result.tax, 537.5, "state-only tax");
    }
}
