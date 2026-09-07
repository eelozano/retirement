use crate::model::{bracket_tax, FilingStatus, StateTaxProfile, TaxBracket};
use crate::presets::index_to;
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
/// deduction reflects the One Big Beautiful Bill Act's July 2025 increase),
/// treated as the figures in force at simulation start (period 0) and
/// indexed forward from there by `BracketTax` — see `indexed_federal_amount`.
/// Fixed in code — unlike state tax, federal law is uniform across users, so
/// there's no per-plan editing surface for it; re-basis these constants
/// every few years against the latest published IRS table, since indexing
/// from a stale basis compounds the same drift this module exists to fix.
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

/// The federal ordinary brackets, standard deduction and LTCG brackets round
/// to this increment as they index. $25, not the $50 the IRS uses for a
/// *joint* return: every constant in `federal` below is already an exact
/// multiple of $25 for both filing statuses (Married figures split evenly
/// at $50; Single figures — `$11,925`, `$48,475`, `$250,525` — are the real
/// published thresholds and only divide evenly at $25). Flooring to $50
/// instead would clip those Single thresholds down before any inflation had
/// run, moving `years == 0` off the actual current-year table.
const FEDERAL_ROUNDING: f64 = 25.0;

/// `base` indexed forward by `years` at `inflation`, rounded to
/// [`FEDERAL_ROUNDING`] — the same `(1 + inflation)^years` convention
/// `ContributionLimits::annual_limit` applies to statutory contribution
/// caps, reused via `presets::index_to`.
fn indexed_federal_amount(base: f64, years: f64, inflation: f64) -> f64 {
    index_to(base, FEDERAL_ROUNDING, years, inflation)
}

/// A federal bracket schedule with every finite `up_to` indexed; rates are
/// untouched and the unbounded top bracket has nothing to index.
fn indexed_federal_brackets(
    brackets: &[TaxBracket],
    years: f64,
    inflation: f64,
) -> Vec<TaxBracket> {
    brackets
        .iter()
        .map(|bracket| TaxBracket {
            up_to: bracket
                .up_to
                .map(|v| indexed_federal_amount(v, years, inflation)),
            rate: bracket.rate,
        })
        .collect()
}

/// `base` scaled by the same `(1 + inflation)^years` factor, with no floor
/// to a step increment. State schedules (`state_tax_data`) are approximate
/// presets or a user's own hand-edited figures, not a table with a known
/// statutory rounding rule — California's real `$11,079` first rung is not
/// a multiple of any round number. Flooring an arbitrary state figure to an
/// invented increment would silently clip it at `years == 0`, the same
/// failure a $50 federal floor would have caused; scaling without a floor
/// still indexes the schedule (#105's actual bug), just without the
/// step-not-drift realism `index_to` gives the federal table.
fn scaled_state_amount(base: f64, years: f64, inflation: f64) -> f64 {
    base * (1.0 + inflation).powf(years)
}

/// A state bracket schedule scaled the same way as `scaled_state_amount`.
fn scaled_state_brackets(brackets: &[TaxBracket], years: f64, inflation: f64) -> Vec<TaxBracket> {
    brackets
        .iter()
        .map(|bracket| TaxBracket {
            up_to: bracket
                .up_to
                .map(|v| scaled_state_amount(v, years, inflation)),
            rate: bracket.rate,
        })
        .collect()
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
    /// The plan's assumed inflation rate. Indexes the federal brackets, the
    /// federal standard deduction, and the state schedule forward from
    /// simulation start (`period` 0) the same way `ContributionLimits`
    /// indexes statutory contribution caps — otherwise a fixed nominal
    /// table taxes a household's flat *real* income at a rising *nominal*
    /// rate as the projection runs (#105). The federal figures floor to a
    /// round increment as they index (`indexed_federal_amount`), stepping
    /// the way the real statutory table does; the state figures scale by
    /// the same factor with no floor (`scaled_state_amount`), since they
    /// carry no such round increment to step to. The Social Security
    /// provisional-income thresholds are the one federal figure this does
    /// not touch: they are fixed by statute and have not moved since 1993.
    /// State indexing is a default a per-state override could turn off in
    /// the future — some states do not index — but that flag is out of
    /// scope here.
    pub inflation: f64,
}

impl TaxModel for BracketTax {
    fn tax(&self, income: &IncomeBreakdown, period: PeriodIndex) -> TaxResult {
        let status = self.filing_status;
        let years = period as f64;
        let inflation = self.inflation;

        let taxable_ss =
            federally_taxable_social_security(income.ordinary, income.social_security, status);
        let federal_ordinary_income = (income.ordinary + taxable_ss).max(0.0);

        let std_deduction =
            indexed_federal_amount(federal::standard_deduction(status), years, inflation);
        let taxable_ordinary = (federal_ordinary_income - std_deduction).max(0.0);
        let ordinary_brackets =
            indexed_federal_brackets(&federal::ordinary_brackets(status), years, inflation);
        let federal_ordinary_tax = bracket_tax(taxable_ordinary, &ordinary_brackets);

        // Capital gains stack on top of ordinary taxable income: tax the
        // combined total through the LTCG schedule, then back out the
        // portion attributable to ordinary income alone.
        let gains = income.capital_gains.max(0.0);
        let ltcg_brackets =
            indexed_federal_brackets(&federal::ltcg_brackets(status), years, inflation);
        let federal_gains_tax = bracket_tax(taxable_ordinary + gains, &ltcg_brackets)
            - bracket_tax(taxable_ordinary, &ltcg_brackets);

        let state_std_deduction =
            scaled_state_amount(self.state_tax.standard_deduction, years, inflation);
        let state_base = (income.ordinary + income.capital_gains - state_std_deduction).max(0.0);
        let state_brackets = scaled_state_brackets(&self.state_tax.brackets, years, inflation);
        let state_tax = bracket_tax(state_base, &state_brackets);

        TaxResult {
            tax: federal_ordinary_tax + federal_gains_tax + state_tax,
        }
    }
}

/// A household's filing status is a property of the *year*, not of the plan,
/// once the household can lose a member mid-projection (#34): a survivor may
/// file jointly through the year of the death and files Single after it —
/// the same income against roughly half the bracket widths and half the
/// standard deduction. This is the tax cliff a widow or widower actually
/// hits, and a `BracketTax` built once could not express it.
///
/// It stays behind the `TaxModel` trait as a new impl, per the architecture
/// invariants: two stateless `BracketTax`es and the period the household
/// switches between them. Selecting on `period` — rather than widening
/// `IncomeBreakdown` to carry filing status — is what keeps
/// `DrawdownStrategy` out of it: the drawdown grosses withdrawals up through
/// `tax()` and has no business knowing the household's mortality schedule.
/// It is precomputable because mortality here is an assumption, not a draw
/// (see `Plan::first_death`).
pub struct SurvivorTax {
    /// Applies through the period the first death falls in, inclusive.
    pub household: BracketTax,
    /// Applies from `survivor_from` on.
    pub survivor: BracketTax,
    /// First period taxed as `survivor`. `None` when nothing changes —
    /// a one-person plan, or a household already filing Single.
    pub survivor_from: Option<PeriodIndex>,
}

impl TaxModel for SurvivorTax {
    fn tax(&self, income: &IncomeBreakdown, period: PeriodIndex) -> TaxResult {
        match self.survivor_from {
            Some(from) if period >= from => self.survivor.tax(income, period),
            _ => self.household.tax(income, period),
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
            inflation: 0.0,
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
            inflation: 0.0,
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
            inflation: 0.0,
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
            inflation: 0.0,
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

    fn survivor_tax(survivor_from: Option<usize>) -> SurvivorTax {
        SurvivorTax {
            household: BracketTax {
                filing_status: FilingStatus::MarriedFilingJointly,
                state_tax: StateTaxProfile::none(),
                inflation: 0.0,
            },
            survivor: BracketTax {
                filing_status: FilingStatus::Single,
                state_tax: StateTaxProfile::none(),
                inflation: 0.0,
            },
            survivor_from,
        }
    }

    /// The same income, taxed on either side of the transition: identical
    /// dollars, a materially larger bill once the brackets halve.
    #[test]
    fn filing_status_switches_at_the_survivor_period() {
        let tax = survivor_tax(Some(5));
        let income = IncomeBreakdown {
            ordinary: 120_000.0,
            ..Default::default()
        };
        let joint = tax.tax(&income, 4).tax;
        let single = tax.tax(&income, 5).tax;

        let expected_joint = BracketTax {
            filing_status: FilingStatus::MarriedFilingJointly,
            state_tax: StateTaxProfile::none(),
            inflation: 0.0,
        }
        .tax(&income, 4)
        .tax;
        let expected_single = BracketTax {
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            inflation: 0.0,
        }
        .tax(&income, 5)
        .tax;

        assert_close(
            joint,
            expected_joint,
            "pre-transition tax is the joint bill",
        );
        assert_close(
            single,
            expected_single,
            "post-transition tax is the single bill",
        );
        assert!(
            single > joint,
            "the survivor's bill must rise on the same income: {joint} -> {single}"
        );
    }

    /// `None` is the no-transition case — a one-person plan, or a household
    /// already filing Single — and must never reach the survivor brackets.
    #[test]
    fn no_transition_taxes_every_period_as_the_household() {
        let tax = survivor_tax(None);
        let income = IncomeBreakdown {
            ordinary: 120_000.0,
            ..Default::default()
        };
        assert_close(
            tax.tax(&income, 99).tax,
            tax.tax(&income, 0).tax,
            "status never changes",
        );
    }

    /// #105: a household with flat *real* income pays the same *real* tax
    /// whether that income lands in year 0 or year 25, once brackets and
    /// the standard deduction index with inflation. Before the fix, the
    /// same real income drifted into ever-higher nominal brackets against a
    /// standard deduction that never grew — this is the bracket-creep bug
    /// the indexing exists to close. A small tolerance accounts for the $25
    /// rounding `indexed_federal_amount` applies.
    #[test]
    fn flat_real_income_pays_the_same_real_tax_decades_apart() {
        let inflation = 0.03;
        let tax = BracketTax {
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            inflation,
        };
        let real_income = 150_000.0;
        let price_level_at_25 = (1.0 + inflation).powi(25);

        let tax_at_year_0 = tax
            .tax(
                &IncomeBreakdown {
                    ordinary: real_income,
                    ..Default::default()
                },
                0,
            )
            .tax;
        let nominal_tax_at_year_25 = tax
            .tax(
                &IncomeBreakdown {
                    ordinary: real_income * price_level_at_25,
                    ..Default::default()
                },
                25,
            )
            .tax;
        let real_tax_at_year_25 = nominal_tax_at_year_25 / price_level_at_25;

        assert!(
            (real_tax_at_year_25 - tax_at_year_0).abs() < 100.0,
            "real tax should hold roughly flat: year 0 {tax_at_year_0}, year 25 (real) {real_tax_at_year_25}"
        );
    }

    /// The Social Security provisional-income thresholds are fixed by
    /// statute (#105) — unlike the ordinary brackets and standard
    /// deduction, which index every period, the dollar amount of a benefit
    /// that becomes taxable must not move just because the bracket schedule
    /// taxing it has indexed.
    #[test]
    fn ordinary_brackets_and_deduction_index_but_social_security_thresholds_do_not() {
        let status = FilingStatus::Single;
        let inflation = 0.03;
        let years = 30.0;
        let tax = BracketTax {
            filing_status: status,
            state_tax: StateTaxProfile::none(),
            inflation,
        };
        let income = IncomeBreakdown {
            ordinary: 60_000.0,
            social_security: 20_000.0,
            ..Default::default()
        };

        // Computed with the *unindexed* statutory thresholds, matching what
        // `BracketTax::tax` must still use internally.
        let taxable_ss = federally_taxable_social_security(60_000.0, 20_000.0, status);
        let std_deduction =
            indexed_federal_amount(federal::standard_deduction(status), years, inflation);
        let taxable_ordinary = (60_000.0 + taxable_ss - std_deduction).max(0.0);
        let expected = bracket_tax(
            taxable_ordinary,
            &indexed_federal_brackets(&federal::ordinary_brackets(status), years, inflation),
        );

        assert_close(
            tax.tax(&income, 30).tax,
            expected,
            "year-30 tax should use indexed brackets/deduction over the fixed SS-taxable amount",
        );
    }

    /// The state schedule indexes too, by default (#105) — scaled by the
    /// same compounding factor as federal, though without federal's $25
    /// floor, since a state's own figures carry no known round increment.
    #[test]
    fn state_bracket_and_deduction_index_with_inflation() {
        let inflation = 0.03;
        let years = 10.0;
        let state_tax = StateTaxProfile {
            state: crate::model::StateCode::Other,
            brackets: vec![
                TaxBracket {
                    up_to: Some(10_000.0),
                    rate: 0.03,
                },
                TaxBracket {
                    up_to: None,
                    rate: 0.06,
                },
            ],
            standard_deduction: 2_000.0,
        };
        let tax = BracketTax {
            filing_status: FilingStatus::Single,
            state_tax: state_tax.clone(),
            inflation,
        };
        let income = IncomeBreakdown {
            ordinary: 15_750.0, // exactly the *unindexed* federal standard deduction
            ..Default::default()
        };

        let indexed_deduction = scaled_state_amount(state_tax.standard_deduction, years, inflation);
        let indexed_state_brackets = scaled_state_brackets(&state_tax.brackets, years, inflation);
        assert!(
            indexed_deduction > state_tax.standard_deduction,
            "sanity: nonzero inflation over 10 years must raise the deduction"
        );

        let federal_std_deduction = indexed_federal_amount(
            federal::standard_deduction(FilingStatus::Single),
            years,
            inflation,
        );
        assert!(
            federal_std_deduction > 15_750.0,
            "sanity: the indexed federal deduction must have grown past this income, \
             so the federal share of the expected total below is exactly 0"
        );
        let expected_state = bracket_tax(
            (15_750.0 - indexed_deduction).max(0.0),
            &indexed_state_brackets,
        );

        assert_close(
            tax.tax(&income, 10).tax,
            expected_state,
            "state tax should use the indexed state schedule and deduction",
        );
    }
}
