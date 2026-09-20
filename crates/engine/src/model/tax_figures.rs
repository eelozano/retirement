//! The tax figures that change every year — federal brackets, the standard
//! deduction, and contribution limits — gathered into one value.
//!
//! These used to be constants spread across `presets` and `strategies::tax`,
//! so updating them was a code change and nothing said which tax year they
//! were for (the brackets were a year behind the limits). They are data now:
//! the app keeps them in a `tax-figures.yaml` beside the plans folder, which
//! the user edits when the IRS publishes a new year, and hands them to every
//! run. [`TaxFigures::built_in`] is what that file starts as.
//!
//! Deliberately *not* here, because none of it has an annual publication:
//! the Social Security provisional-income thresholds (fixed since 1993), the
//! HSA $1,000 catch-up (fixed since 2009), and the RMD ages and Uniform
//! Lifetime Table (`presets::rmd_age`, `presets::uniform_lifetime_divisor`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{FilingStatus, PlanType, TaxBracket};
use crate::presets::index_to;

/// HSA catch-up for owners 55 and older. Fixed at $1,000 by statute since
/// 2009 and **not** indexed, so it is not one of the editable figures.
pub const HSA_CATCH_UP_55: f64 = 1_000.0;

/// Every figure that changes with the tax year, for one tax year.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct TaxFigures {
    /// Tax year every figure below is published for. Each is indexed
    /// forward (or back) from this year at the plan's inflation rate,
    /// stepping by its statutory rounding increment — so an out-of-date year
    /// still projects sensibly, it just starts from older numbers.
    pub tax_year: i32,
    pub federal: FederalTax,
    pub contribution_limits: ContributionLimits,
}

/// Federal income tax: the standard deduction and both bracket schedules,
/// for each filing status. Published each October or November.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct FederalTax {
    pub standard_deduction: ByFilingStatus<f64>,
    /// The additional standard deduction for each filer who is 65 or older
    /// by the end of the tax year (IRC 63(f)) — per person, so a joint
    /// return with both spouses 65+ takes it twice. The Single figure is
    /// larger than the joint one: $2,050 against $1,650 for 2026.
    ///
    /// Defaulted so a `tax-figures.yaml` written before this figure existed
    /// still loads — the file is never overwritten by an upgrade, and one
    /// that failed to parse would silently fall back to the built-in
    /// figures for everything. The default is the published 2026 amount.
    #[serde(default = "additional_standard_deduction_65")]
    pub additional_standard_deduction_65: ByFilingStatus<f64>,
    pub ordinary_brackets: ByFilingStatus<Vec<TaxBracket>>,
    /// Long-term capital gains and qualified dividends.
    pub capital_gains_brackets: ByFilingStatus<Vec<TaxBracket>>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct ByFilingStatus<T> {
    pub single: T,
    pub married_filing_jointly: T,
}

impl<T> ByFilingStatus<T> {
    pub fn get(&self, status: FilingStatus) -> &T {
        match status {
            FilingStatus::Single => &self.single,
            FilingStatus::MarriedFilingJointly => &self.married_filing_jointly,
        }
    }
}

/// One filing status's slice of [`FederalTax`] — what a single
/// `BracketTax` computes with.
#[derive(Clone, Debug, PartialEq)]
pub struct FederalSchedule {
    pub standard_deduction: f64,
    /// Per filer aged 65 or older; see [`FederalTax::additional_standard_deduction_65`].
    pub additional_standard_deduction_65: f64,
    pub ordinary_brackets: Vec<TaxBracket>,
    pub capital_gains_brackets: Vec<TaxBracket>,
}

impl FederalTax {
    pub fn for_status(&self, status: FilingStatus) -> FederalSchedule {
        FederalSchedule {
            standard_deduction: *self.standard_deduction.get(status),
            additional_standard_deduction_65: *self.additional_standard_deduction_65.get(status),
            ordinary_brackets: self.ordinary_brackets.get(status).clone(),
            capital_gains_brackets: self.capital_gains_brackets.get(status).clone(),
        }
    }
}

/// Statutory contribution limits. Published each October or November (IRS
/// Notice), except the HSA limit, which comes out each spring (Rev. Proc.).
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq)]
#[ts(export)]
pub struct ContributionLimits {
    /// IRC 402(g)(1) elective deferral limit, shared across every
    /// 401(k), 403(b) and Thrift Savings plan a person participates in.
    pub employer_plan: f64,
    /// IRC 414(v) catch-up, added from the year the owner turns 50.
    pub employer_plan_catch_up_50: f64,
    /// SECURE 2.0 higher catch-up, which *replaces* the age-50 figure for
    /// the years the owner turns 60 through 63.
    pub employer_plan_catch_up_60_63: f64,
    /// IRC 219(b)(5)(A) IRA limit, shared across a person's traditional and
    /// Roth IRAs.
    pub ira: f64,
    /// IRC 219(b)(5)(B) IRA catch-up, added from the year the owner turns 50.
    pub ira_catch_up_50: f64,
    /// IRC 415(c)(1)(A) annual additions cap: everything that lands in an
    /// employer plan in a year — the employee's own deferrals *and* the
    /// employer match. Far higher than the deferral limit, which is the
    /// whole point: matched dollars are not held to the employee's cap.
    pub annual_additions: f64,
    /// IRC 457(b) elective deferral limit. The same dollar figure as
    /// `employer_plan` today, but a statutorily separate cap: a person can
    /// defer the full amount into each. Shares `employer_plan`'s catch-up
    /// tiers.
    pub plan_457b: f64,
    /// HSA self-only coverage limit. Family coverage is higher, but this app
    /// has no concept of HSA coverage type, so the more conservative
    /// self-only figure is used for everyone. The 55+ catch-up is
    /// [`HSA_CATCH_UP_55`], fixed by statute.
    pub hsa: f64,
    /// SEP-IRA limit: employer contributions only, capped at the 415(c)
    /// figure. No catch-up.
    pub sep_ira: f64,
    /// SIMPLE IRA elective-deferral limit — its own figure, separate from
    /// both `employer_plan` and `ira`.
    pub simple_ira: f64,
    /// SIMPLE IRA catch-up, added from the year the owner turns 50.
    pub simple_ira_catch_up_50: f64,
    /// SECURE 2.0 higher SIMPLE catch-up, replacing the age-50 figure for
    /// the years the owner turns 60 through 63.
    pub simple_ira_catch_up_60_63: f64,
}

/// Rev. Proc. 2025-32: $1,650 per spouse aged 65 or older on a joint return,
/// $2,050 for an unmarried filer.
fn additional_standard_deduction_65() -> ByFilingStatus<f64> {
    ByFilingStatus {
        single: 2_050.0,
        married_filing_jointly: 1_650.0,
    }
}

fn brackets(raw: &[(Option<f64>, f64)]) -> Vec<TaxBracket> {
    raw.iter()
        .map(|&(up_to, rate)| TaxBracket { up_to, rate })
        .collect()
}

impl TaxFigures {
    /// The figures this release ships with: tax year 2026. Brackets and the
    /// standard deduction are IRS Rev. Proc. 2025-32 (which carries the One
    /// Big Beautiful Bill Act's higher deduction forward); contribution
    /// limits are IRS Notice 2025-67; the HSA limit is Rev. Proc. 2025-19.
    ///
    /// Only what a missing `tax-figures.yaml` is written with. Once that
    /// file exists the app never replaces it, so a later release changing
    /// these does not change a user's numbers.
    pub fn built_in() -> Self {
        TaxFigures {
            tax_year: 2026,
            federal: FederalTax {
                standard_deduction: ByFilingStatus {
                    single: 16_100.0,
                    married_filing_jointly: 32_200.0,
                },
                additional_standard_deduction_65: additional_standard_deduction_65(),
                ordinary_brackets: ByFilingStatus {
                    single: brackets(&[
                        (Some(12_400.0), 0.10),
                        (Some(50_400.0), 0.12),
                        (Some(105_700.0), 0.22),
                        (Some(201_775.0), 0.24),
                        (Some(256_225.0), 0.32),
                        (Some(640_600.0), 0.35),
                        (None, 0.37),
                    ]),
                    married_filing_jointly: brackets(&[
                        (Some(24_800.0), 0.10),
                        (Some(100_800.0), 0.12),
                        (Some(211_400.0), 0.22),
                        (Some(403_550.0), 0.24),
                        (Some(512_450.0), 0.32),
                        (Some(768_700.0), 0.35),
                        (None, 0.37),
                    ]),
                },
                capital_gains_brackets: ByFilingStatus {
                    single: brackets(&[
                        (Some(49_450.0), 0.0),
                        (Some(545_500.0), 0.15),
                        (None, 0.20),
                    ]),
                    married_filing_jointly: brackets(&[
                        (Some(98_900.0), 0.0),
                        (Some(613_700.0), 0.15),
                        (None, 0.20),
                    ]),
                },
            },
            contribution_limits: ContributionLimits {
                employer_plan: 24_500.0,
                employer_plan_catch_up_50: 8_000.0,
                employer_plan_catch_up_60_63: 11_250.0,
                ira: 7_500.0,
                ira_catch_up_50: 1_100.0,
                annual_additions: 72_000.0,
                plan_457b: 24_500.0,
                hsa: 4_400.0,
                sep_ira: 72_000.0,
                simple_ira: 17_000.0,
                simple_ira_catch_up_50: 4_000.0,
                simple_ira_catch_up_60_63: 5_250.0,
            },
        }
    }

    /// Everything wrong with a hand-edited file, as user-facing sentences.
    /// Empty means usable.
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if !(1900..=2200).contains(&self.tax_year) {
            errors.push(format!(
                "tax_year {} is not a plausible year",
                self.tax_year
            ));
        }

        let amount = |errors: &mut Vec<String>, name: &str, value: f64| {
            if !value.is_finite() || value < 0.0 {
                errors.push(format!("{name} must be zero or more, not {value}"));
            }
        };
        for (label, status) in [
            ("single", FilingStatus::Single),
            ("married_filing_jointly", FilingStatus::MarriedFilingJointly),
        ] {
            amount(
                &mut errors,
                &format!("standard_deduction.{label}"),
                *self.federal.standard_deduction.get(status),
            );
            amount(
                &mut errors,
                &format!("additional_standard_deduction_65.{label}"),
                *self.federal.additional_standard_deduction_65.get(status),
            );
            for (schedule, table) in [
                (
                    "ordinary_brackets",
                    self.federal.ordinary_brackets.get(status),
                ),
                (
                    "capital_gains_brackets",
                    self.federal.capital_gains_brackets.get(status),
                ),
            ] {
                validate_brackets(&mut errors, &format!("{schedule}.{label}"), table);
            }
        }

        let l = &self.contribution_limits;
        for (name, value) in [
            ("employer_plan", l.employer_plan),
            ("employer_plan_catch_up_50", l.employer_plan_catch_up_50),
            (
                "employer_plan_catch_up_60_63",
                l.employer_plan_catch_up_60_63,
            ),
            ("ira", l.ira),
            ("ira_catch_up_50", l.ira_catch_up_50),
            ("annual_additions", l.annual_additions),
            ("plan_457b", l.plan_457b),
            ("hsa", l.hsa),
            ("sep_ira", l.sep_ira),
            ("simple_ira", l.simple_ira),
            ("simple_ira_catch_up_50", l.simple_ira_catch_up_50),
            ("simple_ira_catch_up_60_63", l.simple_ira_catch_up_60_63),
        ] {
            amount(&mut errors, &format!("contribution_limits.{name}"), value);
        }
        errors
    }

    /// Years from `tax_year` to `year` — the exponent every figure is
    /// indexed by.
    fn years_to(&self, year: i32) -> f64 {
        (year - self.tax_year) as f64
    }

    /// The 415(c) annual-additions cap for calendar year `year`, indexed
    /// from `tax_year`. Catch-up contributions sit on top of 415(c) rather
    /// than inside it, so the eligible catch-up for `age` is added back.
    ///
    /// 415(c) is statutorily **per employer plan**; this model has no
    /// employer grouping, so it is applied per person. That is the stricter
    /// reading, and only differs for someone in two employers' plans at once.
    pub fn annual_additions_limit(&self, age: i32, year: i32, inflation: f64) -> f64 {
        let l = &self.contribution_limits;
        let years = self.years_to(year);
        let catch_up = match age {
            60..=63 => index_to(l.employer_plan_catch_up_60_63, 500.0, years, inflation),
            a if a >= 50 => index_to(l.employer_plan_catch_up_50, 500.0, years, inflation),
            _ => 0.0,
        };
        index_to(l.annual_additions, 1_000.0, years, inflation) + catch_up
    }

    /// The annual limit for `plan_type` in calendar year `year`, for an owner
    /// who reaches `age` during that year, indexed forward from `tax_year`
    /// at `inflation`. Each figure rounds down to its statutory increment —
    /// $500 for the deferral, IRA and employer catch-up limits, $100 for the
    /// IRA catch-up — which is what makes a limit sit still for a few years
    /// and then step, as the real schedule does.
    ///
    /// `None` means "no statutory cap" — a taxable brokerage.
    ///
    /// Catch-up eligibility is by the age *attained during* the calendar
    /// year, which is the statutory rule: someone turning 50 in December is
    /// eligible for that whole year.
    pub fn annual_limit(
        &self,
        plan_type: PlanType,
        age: i32,
        year: i32,
        inflation: f64,
    ) -> Option<f64> {
        let l = &self.contribution_limits;
        let years = self.years_to(year);
        let employer_catch_up = || match age {
            60..=63 => index_to(l.employer_plan_catch_up_60_63, 500.0, years, inflation),
            a if a >= 50 => index_to(l.employer_plan_catch_up_50, 500.0, years, inflation),
            _ => 0.0,
        };
        match plan_type {
            PlanType::None => None,
            PlanType::EmployerPlan => {
                Some(index_to(l.employer_plan, 500.0, years, inflation) + employer_catch_up())
            }
            PlanType::Ira => {
                let catch_up = if age >= 50 {
                    index_to(l.ira_catch_up_50, 100.0, years, inflation)
                } else {
                    0.0
                };
                Some(index_to(l.ira, 500.0, years, inflation) + catch_up)
            }
            // Statutorily separate from `EmployerPlan`, but governed by the
            // same 414(v) catch-up figures.
            PlanType::Plan457b => {
                Some(index_to(l.plan_457b, 500.0, years, inflation) + employer_catch_up())
            }
            PlanType::Hsa => {
                let catch_up = if age >= 55 { HSA_CATCH_UP_55 } else { 0.0 };
                Some(index_to(l.hsa, 50.0, years, inflation) + catch_up)
            }
            // Employer-only contributions: no employee catch-up.
            PlanType::SepIra => Some(index_to(l.sep_ira, 1_000.0, years, inflation)),
            PlanType::SimpleIra => {
                let catch_up = match age {
                    60..=63 => index_to(l.simple_ira_catch_up_60_63, 250.0, years, inflation),
                    a if a >= 50 => index_to(l.simple_ira_catch_up_50, 250.0, years, inflation),
                    _ => 0.0,
                };
                Some(index_to(l.simple_ira, 500.0, years, inflation) + catch_up)
            }
        }
    }
}

/// A schedule is usable when it is non-empty, every ceiling but the last is
/// set and rises, the last is open-ended (`up_to: null`), and every rate is
/// between 0 and 1.
fn validate_brackets(errors: &mut Vec<String>, name: &str, table: &[TaxBracket]) {
    let Some((last, rest)) = table.split_last() else {
        errors.push(format!("{name} has no brackets"));
        return;
    };
    if last.up_to.is_some() {
        errors.push(format!(
            "{name}: the last bracket must have `up_to: null` (no ceiling)"
        ));
    }
    let mut previous = 0.0;
    for (i, bracket) in rest.iter().enumerate() {
        match bracket.up_to {
            None => errors.push(format!(
                "{name}: only the last bracket may have `up_to: null` (bracket {})",
                i + 1
            )),
            Some(up_to) if !up_to.is_finite() || up_to <= previous => errors.push(format!(
                "{name}: bracket {} ceiling {up_to} must be above {previous}",
                i + 1
            )),
            Some(up_to) => previous = up_to,
        }
    }
    for (i, bracket) in table.iter().enumerate() {
        if !(0.0..=1.0).contains(&bracket.rate) {
            errors.push(format!(
                "{name}: bracket {} rate {} must be between 0 and 1 (0.22 means 22%)",
                i + 1,
                bracket.rate
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_figures_are_valid() {
        assert_eq!(TaxFigures::built_in().validate(), Vec::<String>::new());
    }

    /// Every federal figure has to divide evenly by the $25 the tables index
    /// in steps of, or `years == 0` would already be off the real table —
    /// see `FEDERAL_ROUNDING` in `strategies::tax`.
    #[test]
    fn built_in_federal_figures_are_multiples_of_25() {
        let federal = TaxFigures::built_in().federal;
        for status in [FilingStatus::Single, FilingStatus::MarriedFilingJointly] {
            let schedule = federal.for_status(status);
            let ceilings = schedule
                .ordinary_brackets
                .iter()
                .chain(&schedule.capital_gains_brackets)
                .filter_map(|b| b.up_to);
            let deductions = [
                schedule.standard_deduction,
                schedule.additional_standard_deduction_65,
            ];
            for value in ceilings.chain(deductions) {
                assert_eq!(value % 25.0, 0.0, "{value} is not a multiple of $25");
            }
        }
    }

    #[test]
    fn validation_names_each_problem() {
        let mut figures = TaxFigures::built_in();
        figures.tax_year = 26;
        figures.contribution_limits.ira = -1.0;
        figures.federal.ordinary_brackets.single[1].up_to = Some(1_000.0);
        figures
            .federal
            .capital_gains_brackets
            .married_filing_jointly[2]
            .up_to = Some(1e9);
        figures.federal.ordinary_brackets.married_filing_jointly[0].rate = 22.0;

        let errors = figures.validate().join("\n");
        for expected in [
            "tax_year 26",
            "contribution_limits.ira",
            "ordinary_brackets.single: bracket 2 ceiling 1000",
            "capital_gains_brackets.married_filing_jointly: the last bracket",
            "ordinary_brackets.married_filing_jointly: bracket 1 rate 22",
        ] {
            assert!(
                errors.contains(expected),
                "missing {expected:?} in:\n{errors}"
            );
        }
    }

    /// The limits index from `tax_year`, so moving it moves every year's
    /// figure — the same limit in 2030 is higher off a 2026 basis than off a
    /// 2030 one.
    #[test]
    fn limits_index_from_the_tax_year() {
        let figures = TaxFigures::built_in();
        let at_basis = figures.annual_limit(PlanType::Ira, 40, 2026, 0.03);
        assert_eq!(at_basis, Some(7_500.0));

        let later = TaxFigures {
            tax_year: 2030,
            ..figures.clone()
        };
        assert_eq!(
            later.annual_limit(PlanType::Ira, 40, 2030, 0.03),
            Some(7_500.0)
        );
        assert!(figures.annual_limit(PlanType::Ira, 40, 2030, 0.03).unwrap() > 7_500.0);
    }
}
