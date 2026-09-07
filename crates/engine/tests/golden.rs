//! Golden-file tests: the seed plan's full projection, snapshotted as JSON.
//! Catches any unintended change to simulation semantics.
//!
//! Two fixtures, because the period grid has two shapes (#106): the seed
//! plan's own January start, where period 0 is a whole calendar year, and
//! the same household started in September, where it is a four-month stub
//! and every later period is a calendar year.
//!
//! To bless an intentional change: UPDATE_GOLDEN=1 cargo test -p engine golden

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use engine::model::YearMonth;
use engine::presets::seed_plan;
use engine::{run_deterministic, Projection};

/// How far a figure may sit from its blessed value and still be the same
/// figure: one part in a billion, relative.
///
/// This comparison used to be on the serialized strings, exactly — which
/// worked for as long as every fixture started in January. A mid-year plan
/// raises `powf` to a *fraction* of a year, for both market growth and
/// stream escalation, and `powf` is not correctly rounded: glibc and
/// Apple's libm disagree in the last bit. The September fixture's 2038
/// salary came out `156711.7002164951` on macOS and `156711.70021649514`
/// in CI, a difference of one part in 10^15 on a dollar figure, and the
/// test failed on a projection that was identical in every way anyone
/// could care about.
///
/// Comparing numbers with a tolerance rather than strings also sidesteps
/// any question about whether the JSON parser round-trips a float exactly,
/// which is what the string comparison was originally there to avoid.
/// Nothing about the simulation's semantics can hide under a billionth: the
/// smallest real change to any of these figures — a month of proration, a
/// bracket, an ordering — moves them by parts in thousands or more.
const TOLERANCE: f64 = 1e-9;

fn golden_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("tests/golden/{name}.json"))
}

fn assert_matches_golden(name: &str, projection: &Projection) {
    let actual = serde_json::to_string_pretty(projection).expect("projection serializes");

    let path = golden_path(name);
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &actual).unwrap();
        return;
    }

    let expected = fs::read_to_string(&path).expect(
        "golden file missing — run UPDATE_GOLDEN=1 cargo test -p engine golden to create it",
    );
    let actual: Value = serde_json::from_str(&actual).expect("projection re-parses");
    let expected: Value = serde_json::from_str(&expected).expect("golden file parses");

    let mut differences = Vec::new();
    compare(&actual, &expected, "", &mut differences);
    if !differences.is_empty() {
        panic!(
            "{name} diverged from golden file:\n  {}\nif intentional, re-bless with \
             UPDATE_GOLDEN=1 cargo test -p engine golden",
            differences.join("\n  ")
        );
    }
}

/// How many differences to name before giving up. One real semantic change
/// moves most of the projection, and a thousand-line panic message says
/// nothing the first few do not.
const MAX_REPORTED: usize = 5;

/// Walks two projections in step, collecting the places they disagree.
/// `path` is the JSON pointer to the value under comparison, so a failure
/// names the snapshot and field rather than a line number.
fn compare(actual: &Value, expected: &Value, path: &str, out: &mut Vec<String>) {
    if out.len() >= MAX_REPORTED {
        return;
    }
    match (actual, expected) {
        (Value::Number(a), Value::Number(e)) => {
            let within = match (a.as_f64(), e.as_f64()) {
                (Some(a), Some(e)) => close_enough(a, e),
                _ => a == e,
            };
            if !within {
                out.push(format!("{path}: {a}, expected {e}"));
            }
        }
        (Value::Array(a), Value::Array(e)) => {
            if a.len() != e.len() {
                out.push(format!("{path}: {} entries, expected {}", a.len(), e.len()));
                return;
            }
            for (i, (a, e)) in a.iter().zip(e).enumerate() {
                compare(a, e, &format!("{path}/{i}"), out);
            }
        }
        (Value::Object(a), Value::Object(e)) => {
            let keys: BTreeSet<&String> = a.keys().chain(e.keys()).collect();
            for key in keys {
                let path = format!("{path}/{key}");
                match (a.get(key), e.get(key)) {
                    (Some(a), Some(e)) => compare(a, e, &path, out),
                    (Some(_), None) => out.push(format!("{path}: present, expected absent")),
                    (None, _) => out.push(format!("{path}: absent, expected present")),
                }
            }
        }
        _ if actual == expected => {}
        _ => out.push(format!("{path}: {actual}, expected {expected}")),
    }
}

/// Relative comparison, with the scale floored at 1 so figures near zero —
/// a period with no withdrawals, a deflator's first 1.0 — are held to an
/// absolute tolerance rather than a vanishing one.
fn close_enough(actual: f64, expected: f64) -> bool {
    if actual == expected {
        return true;
    }
    let scale = actual.abs().max(expected.abs()).max(1.0);
    (actual - expected).abs() <= TOLERANCE * scale
}

#[test]
fn seed_projection_matches_golden_file() {
    assert_matches_golden("seed_projection", &run_deterministic(&seed_plan()));
}

/// The same household, sat down with in September. Period 0 is four months
/// of flows, caps and growth; period 1 starts in January 2027 and is an
/// ordinary calendar year. Pinned separately so a change to the stub grid
/// cannot hide behind the January fixture, which by construction has no
/// stub at all.
#[test]
fn mid_year_seed_projection_matches_golden_file() {
    let mut plan = seed_plan();
    plan.sim_config.start = YearMonth::new(2026, 9);
    assert_matches_golden("seed_projection_mid_year", &run_deterministic(&plan));
}
