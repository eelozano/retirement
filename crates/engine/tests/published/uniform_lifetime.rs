//! The Uniform Lifetime table, every row, against IRS Publication 590-B
//! (2025), Appendix B, Table III. The publication lays it out in two column
//! pairs; this is the same 49 rows in age order.

use engine::presets::uniform_lifetime_divisor;

/// (age, applicable denominator), typed from Table III. Age 120 is the
/// table's "120 and over" row.
const TABLE_III: [(i32, f64); 49] = [
    (72, 27.4),
    (73, 26.5),
    (74, 25.5),
    (75, 24.6),
    (76, 23.7),
    (77, 22.9),
    (78, 22.0),
    (79, 21.1),
    (80, 20.2),
    (81, 19.4),
    (82, 18.5),
    (83, 17.7),
    (84, 16.8),
    (85, 16.0),
    (86, 15.2),
    (87, 14.4),
    (88, 13.7),
    (89, 12.9),
    (90, 12.2),
    (91, 11.5),
    (92, 10.8),
    (93, 10.1),
    (94, 9.5),
    (95, 8.9),
    (96, 8.4),
    (97, 7.8),
    (98, 7.3),
    (99, 6.8),
    (100, 6.4),
    (101, 6.0),
    (102, 5.6),
    (103, 5.2),
    (104, 4.9),
    (105, 4.6),
    (106, 4.3),
    (107, 4.1),
    (108, 3.9),
    (109, 3.7),
    (110, 3.5),
    (111, 3.4),
    (112, 3.3),
    (113, 3.1),
    (114, 3.0),
    (115, 2.9),
    (116, 2.8),
    (117, 2.7),
    (118, 2.5),
    (119, 2.3),
    (120, 2.0),
];

#[test]
fn every_row_matches_publication_590_b_table_iii() {
    for (age, denominator) in TABLE_III {
        assert_eq!(
            uniform_lifetime_divisor(age),
            Some(denominator),
            "age {age}"
        );
    }
}

/// "120 and over": the last row covers every older age.
#[test]
fn ages_past_120_take_the_last_row() {
    assert_eq!(uniform_lifetime_divisor(121), Some(2.0));
}
