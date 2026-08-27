//! Golden-file test: the seed plan's full projection, snapshotted as JSON.
//! Catches any unintended change to simulation semantics.
//!
//! To bless an intentional change: UPDATE_GOLDEN=1 cargo test -p engine golden

use std::fs;
use std::path::PathBuf;

use engine::presets::seed_plan;
use engine::run_deterministic;

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/seed_projection.json")
}

#[test]
fn seed_projection_matches_golden_file() {
    let projection = run_deterministic(&seed_plan());
    // Compare serialized strings, not parsed values: serde_json's default
    // float parser is not exactly round-tripping (that needs its
    // `float_roundtrip` feature), while serialization is deterministic.
    let actual = serde_json::to_string_pretty(&projection).expect("projection serializes");

    let path = golden_path();
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
            "projection diverged from golden file (first differing line: {:?}); \
             if intentional, re-bless with UPDATE_GOLDEN=1 cargo test -p engine golden",
            mismatch
        );
    }
}
