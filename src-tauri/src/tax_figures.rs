//! The user's yearly tax figures: `tax-figures.yaml` at the root of the
//! storage folder, beside `plans/` rather than in it — every `.yaml` in
//! `plans/` is read as a household, and this file is not one.
//!
//! One file for every plan, because tax law does not vary by household. The
//! app writes it with the engine's built-in figures the first time it is
//! missing and never overwrites it after that, so a release that ships newer
//! built-ins does not move a user's numbers; deleting the file is how they
//! take the new ones. It is read on every projection — it is a few hundred
//! bytes — so an edit applies at the next recalculation without a restart.
//!
//! A file that cannot be used never stops a projection. The built-in figures
//! stand in and the reason is carried back to the settings window, which is
//! the one place the user is told.

use std::fs;
use std::path::{Path, PathBuf};

use engine::model::TaxFigures;

pub const FILE_NAME: &str = "tax-figures.yaml";

pub fn path(base: &Path) -> PathBuf {
    base.join(FILE_NAME)
}

/// The figures in force, and why they are the built-in ones when the file
/// could not be used.
pub struct Loaded {
    pub figures: TaxFigures,
    pub error: Option<String>,
}

/// Reads `tax-figures.yaml`, writing it from the built-in figures first if
/// it does not exist.
pub fn load(base: &Path) -> Loaded {
    let path = path(base);
    if !path.exists() {
        let figures = TaxFigures::built_in();
        let error = write(&path, &figures).err();
        return Loaded { figures, error };
    }
    match read(&path) {
        Ok(figures) => Loaded {
            figures,
            error: None,
        },
        Err(error) => Loaded {
            figures: TaxFigures::built_in(),
            error: Some(error),
        },
    }
}

fn read(path: &Path) -> Result<TaxFigures, String> {
    let yaml = fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let figures: TaxFigures =
        serde_yaml_ng::from_str(&yaml).map_err(|e| format!("{FILE_NAME}: {e}"))?;
    let problems = figures.validate();
    if problems.is_empty() {
        Ok(figures)
    } else {
        Err(format!("{FILE_NAME}: {}", problems.join("; ")))
    }
}

fn write(path: &Path, figures: &TaxFigures) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    let yaml =
        serde_yaml_ng::to_string(figures).map_err(|e| format!("serializing tax figures: {e}"))?;
    fs::write(path, format!("{}{yaml}", header()))
        .map_err(|e| format!("writing {}: {e}", path.display()))
}

/// What the file says about itself — the only documentation a person
/// editing it by hand is guaranteed to see.
fn header() -> String {
    let year = TaxFigures::built_in().tax_year;
    format!(
        "\
# Tax figures: the numbers that change every tax year.
#
# Every plan is projected with these. Each figure is indexed forward from
# tax_year at the plan's inflation rate, so this only needs updating when
# the IRS publishes a new year. The app reads it on every recalculation.
#
#   tax_year             The year every figure below is for.
#   federal              Standard deduction and income-tax brackets, published
#                        each October or November (an IRS Revenue Procedure on
#                        inflation adjustments). up_to is the top of a bracket
#                        (null means no top, and only the last may be null);
#                        rate is a fraction, so 0.22 is 22%. Capital-gains
#                        brackets are shaped the same way.
#   contribution_limits  401(k)/403(b) (employer_plan), 457(b), IRA, SEP,
#                        SIMPLE and their catch-ups, published each October or
#                        November (an IRS Notice on cost-of-living
#                        adjustments). The HSA limit (self-only coverage) is
#                        published each spring.
#
# Fixed in the app rather than here: the Social Security taxability
# thresholds, the HSA $1,000 age-55 catch-up, and the RMD ages and table.
#
# If this file can't be read, the app uses its built-in {year} figures and
# says why under Settings. Delete the file to go back to the built-in
# figures.

"
    )
}

/// Carries the file along when plan storage moves, the way
/// `migrate::copy_yaml_dir` carries the plans. Never overwrites one already
/// at the destination, which may be the user's own.
pub fn copy(from_base: &Path, to_base: &Path) -> Result<(), String> {
    let from = path(from_base);
    let to = path(to_base);
    if !from.exists() || to.exists() {
        return Ok(());
    }
    fs::create_dir_all(to_base).map_err(|e| format!("creating {}: {e}", to_base.display()))?;
    fs::copy(&from, &to)
        .map(|_| ())
        .map_err(|e| format!("copying {}: {e}", from.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempBase(PathBuf);

    impl TempBase {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "retirement-tax-figures-test-{tag}-{}",
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

    #[test]
    fn a_missing_file_is_written_with_the_built_in_figures() {
        let base = TempBase::new("missing");
        let loaded = load(&base.0);
        assert_eq!(loaded.figures, TaxFigures::built_in());
        assert!(loaded.error.is_none());

        let written = fs::read_to_string(path(&base.0)).unwrap();
        assert!(written.starts_with("# Tax figures"), "header first");
        assert_eq!(read(&path(&base.0)).unwrap(), TaxFigures::built_in());
    }

    #[test]
    fn an_edited_file_is_used_and_never_overwritten() {
        let base = TempBase::new("edited");
        load(&base.0);
        let file = path(&base.0);
        let edited = fs::read_to_string(&file)
            .unwrap()
            .replace("single: 16100.0", "single: 17000.0");
        fs::write(&file, &edited).unwrap();

        let loaded = load(&base.0);
        assert!(loaded.error.is_none(), "{:?}", loaded.error);
        assert_eq!(loaded.figures.federal.standard_deduction.single, 17_000.0);
        assert_eq!(fs::read_to_string(&file).unwrap(), edited);
    }

    #[test]
    fn a_broken_file_falls_back_to_built_in_and_says_why() {
        let base = TempBase::new("broken");
        fs::write(path(&base.0), "tax_year: [not a year").unwrap();
        let loaded = load(&base.0);
        assert_eq!(loaded.figures, TaxFigures::built_in());
        assert!(loaded.error.unwrap().starts_with(FILE_NAME));
    }

    #[test]
    fn an_invalid_file_falls_back_and_names_the_problem() {
        let base = TempBase::new("invalid");
        let mut figures = TaxFigures::built_in();
        figures.contribution_limits.ira = -5.0;
        write(&path(&base.0), &figures).unwrap();

        let loaded = load(&base.0);
        assert_eq!(loaded.figures, TaxFigures::built_in());
        assert!(loaded.error.unwrap().contains("contribution_limits.ira"));
    }

    /// The file sits beside `plans/`, so the household scan never sees it.
    #[test]
    fn the_file_is_never_listed_as_a_plan() {
        let base = TempBase::new("not-a-plan");
        load(&base.0);
        assert!(path(&base.0).exists());
        assert!(crate::storage::list_plans(&base.0).unwrap().is_empty());
    }

    #[test]
    fn copy_carries_the_file_but_never_overwrites() {
        let from = TempBase::new("copy-from");
        let to = TempBase::new("copy-to");
        load(&from.0);
        copy(&from.0, &to.0).unwrap();
        assert_eq!(
            fs::read_to_string(path(&from.0)).unwrap(),
            fs::read_to_string(path(&to.0)).unwrap()
        );

        fs::write(path(&to.0), "theirs").unwrap();
        copy(&from.0, &to.0).unwrap();
        assert_eq!(fs::read_to_string(path(&to.0)).unwrap(), "theirs");
    }
}
