//! Golden-file tests: the seed plan's full projection, snapshotted as JSON.
//! Catches any unintended change to simulation semantics.
//!
//! Two fixtures, because the period grid has two shapes (#106): the seed
//! plan's own January start, where period 0 is a whole calendar year, and
//! the same household started in September, where it is a four-month stub
//! and every later period is a calendar year.
//!
//! To bless an intentional change: UPDATE_GOLDEN=1 cargo test -p engine golden

use std::fs;
use std::path::PathBuf;

use engine::model::YearMonth;
use engine::presets::seed_plan;
use engine::{run_deterministic, Projection};

fn golden_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("tests/golden/{name}.json"))
}

fn assert_matches_golden(name: &str, projection: &Projection) {
    // Compare serialized strings, not parsed values: serde_json's default
    // float parser is not exactly round-tripping (that needs its
    // `float_roundtrip` feature), while serialization is deterministic.
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

    if actual != expected {
        let mismatch = actual
            .lines()
            .zip(expected.lines())
            .enumerate()
            .find(|(_, (a, e))| a != e);
        panic!(
            "{name} diverged from golden file (first differing line: {mismatch:?}); \
             if intentional, re-bless with UPDATE_GOLDEN=1 cargo test -p engine golden"
        );
    }
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
