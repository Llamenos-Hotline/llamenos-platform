//! Blind index generation for E2EE server-side filtering.
//!
//! Enables server-side filtering of encrypted data using HMAC blind indexes.
//! The server sees only opaque hash tokens, never plaintext values.
//!
//! Three query types:
//! - **Exact match**: HMAC of canonicalized value (for enums, statuses)
//! - **Epoch bucketing**: HMAC at day/week/month granularity (for date ranges)
//! - **Trigram tokenization**: HMAC of each 3-char substring (for name search)

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

use crate::labels::{LABEL_BLIND_INDEX_FIELD, LABEL_BLIND_INDEX_KEY};

type HmacSha256 = Hmac<Sha256>;

/// Derive a field-specific blind index key from the hub key.
/// Each field gets its own key to prevent cross-field correlation.
pub fn derive_blind_index_key(hub_key: &[u8; 32], field_name: &str) -> [u8; 32] {
    let hkdf = Hkdf::<Sha256>::new(Some(LABEL_BLIND_INDEX_KEY.as_bytes()), hub_key);
    let mut okm = [0u8; 32];
    let info = format!("{LABEL_BLIND_INDEX_FIELD}{field_name}");
    hkdf.expand(info.as_bytes(), &mut okm)
        .expect("HKDF expand failed");
    okm
}

/// Compute a blind index token for exact-match queries.
/// Returns hex-encoded HMAC-SHA256 of the canonicalized value.
pub fn blind_index(hub_key: &[u8; 32], field_name: &str, value: &str) -> String {
    let key = derive_blind_index_key(hub_key, field_name);
    let canonical = canonicalize(value);
    let mut mac = HmacSha256::new_from_slice(&key).expect("HMAC key error");
    mac.update(canonical.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Compute date-bucketed blind indexes at day/week/month granularity.
/// Returns a vec of (key_suffix, hash) pairs for server-side date range queries.
///
/// Example: for date "2026-03-14", returns:
/// - ("created_day", hash("2026-03-14"))
/// - ("created_week", hash("2026-W11"))
/// - ("created_month", hash("2026-03"))
pub fn date_blind_indexes(
    hub_key: &[u8; 32],
    field_name: &str,
    iso_date: &str,
) -> Vec<(String, String)> {
    let date_str = if iso_date.len() >= 10 {
        &iso_date[..10]
    } else {
        iso_date
    };
    let month_str = if iso_date.len() >= 7 {
        &iso_date[..7]
    } else {
        iso_date
    };
    let week_str = iso_week_string(date_str);

    vec![
        (
            format!("{field_name}_day"),
            blind_index(hub_key, &format!("{field_name}:day"), date_str),
        ),
        (
            format!("{field_name}_week"),
            blind_index(hub_key, &format!("{field_name}:week"), &week_str),
        ),
        (
            format!("{field_name}_month"),
            blind_index(hub_key, &format!("{field_name}:month"), month_str),
        ),
    ]
}

/// Generate trigram tokens for partial text matching.
/// Returns blind index tokens for each trigram of the canonicalized input.
///
/// Example: "Carlos" → trigrams ["car", "arl", "rlo", "los"] → 4 HMAC tokens
pub fn name_trigram_indexes(hub_key: &[u8; 32], field_name: &str, value: &str) -> Vec<String> {
    let canonical = canonicalize(value);
    let chars: Vec<char> = canonical.chars().collect();

    if chars.len() < 3 {
        // For very short values, index the whole value
        return vec![blind_index(
            hub_key,
            &format!("{field_name}:trigram"),
            &canonical,
        )];
    }

    let mut tokens: Vec<String> = Vec::new();
    for i in 0..=(chars.len().saturating_sub(3)) {
        let trigram: String = chars[i..i + 3].iter().collect();
        tokens.push(blind_index(
            hub_key,
            &format!("{field_name}:trigram"),
            &trigram,
        ));
    }
    tokens.sort();
    tokens.dedup();
    tokens
}

/// Canonicalize a value for consistent blind indexing.
/// Lowercase, NFKD decompose, strip combining diacritical marks, trim whitespace.
pub fn canonicalize(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .nfkd()
        .filter(|c| {
            // Keep everything except combining diacritical marks (Unicode block 0300-036F)
            // This strips accents: é → e, ñ → n, ü → u
            !('\u{0300}'..='\u{036F}').contains(c)
        })
        .collect()
}

/// Convert an ISO date string to ISO week format "YYYY-Www".
///
/// This feeds a blind index, so its output is part of the wire contract: a
/// blind index is a client-computed HMAC the server cannot rebuild, and any
/// input this function buckets differently from before orphans every index
/// already written. The parsing rules below are therefore the exact rules of
/// the `%Y-%m-%d` format this function used when it was built on `chrono`
/// (RUSTSEC-2026-0543, unmaintained), and are pinned by the tests at the
/// bottom of this file:
///
/// * year: 1-4 digits (greedy), or an explicit `+`/`-` sign followed by any
///   number of digits; month and day: 1-2 digits (greedy) — so `2026-3-4`
///   is accepted and `2026-123-4` is not;
/// * the separators are a literal `-`, and nothing may follow the day;
/// * whitespace is skipped before each of the three numbers (not before a
///   `-`, not after the day);
/// * the day must exist in that month of the proleptic Gregorian calendar
///   (year 0 is valid, and is a leap year);
/// * anything else yields the `0000-W00` sentinel.
fn iso_week_string(iso_date: &str) -> String {
    match parse_ymd(iso_date) {
        Some((year, month, day)) => {
            let (iso_year, week) = iso_week(year, month, day);
            format!("{iso_year}-W{week:02}")
        }
        None => "0000-W00".to_string(),
    }
}

/// Consume a run of ASCII digits from the front of `s`, taking at most `max`
/// of them, and require at least one. Returns the value and the remainder.
fn take_number(s: &str, max: usize) -> Option<(i64, &str)> {
    let len = s.bytes().take(max).take_while(u8::is_ascii_digit).count();
    if len == 0 {
        return None;
    }
    let (digits, rest) = s.split_at(len);
    let mut value: i64 = 0;
    for b in digits.bytes() {
        value = value.checked_mul(10)?.checked_add(i64::from(b - b'0'))?;
    }
    Some((value, rest))
}

/// Parse `Y-M-D` (see [`iso_week_string`] for the accepted grammar) into a
/// validated calendar date.
fn parse_ymd(input: &str) -> Option<(i64, u32, u32)> {
    // The calendar range `chrono::NaiveDate` accepted: -262143 ..= 262142.
    const MIN_YEAR: i64 = -262_143;
    const MAX_YEAR: i64 = 262_142;

    // Whitespace (Unicode `White_Space`, not just ASCII) is skipped before each
    // of the three numbers, but never before a `-` separator, between a sign
    // and its digits, or after the day.
    let s = input.trim_start();
    let (year, s) = if let Some(rest) = s.strip_prefix('-') {
        let (v, rest) = take_number(rest, usize::MAX)?;
        (-v, rest)
    } else if let Some(rest) = s.strip_prefix('+') {
        take_number(rest, usize::MAX)?
    } else {
        take_number(s, 4)?
    };
    let (month, s) = take_number(s.strip_prefix('-')?.trim_start(), 2)?;
    let (day, s) = take_number(s.strip_prefix('-')?.trim_start(), 2)?;
    if !s.is_empty() || !(MIN_YEAR..=MAX_YEAR).contains(&year) {
        return None;
    }
    let (month, day) = (u32::try_from(month).ok()?, u32::try_from(day).ok()?);
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    Some((year, month, day))
}

fn is_leap_year(year: i64) -> bool {
    year.rem_euclid(4) == 0 && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0)
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if is_leap_year(year) => 29,
        _ => 28,
    }
}

/// Days since 0000-03-01 style civil epoch (Howard Hinnant's `days_from_civil`),
/// shifted so that 1970-01-01 is day 0. Valid for the whole proleptic
/// Gregorian calendar.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400); // [0, 399]
    let mp = i64::from((month + 9) % 12); // March = 0
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// ISO-8601 weekday, Monday = 1 … Sunday = 7.
fn iso_weekday(year: i64, month: u32, day: u32) -> i64 {
    // 1970-01-01 was a Thursday (4).
    (days_from_civil(year, month, day) + 3).rem_euclid(7) + 1
}

/// Number of ISO weeks (52 or 53) in `year`: 53 when 1 January is a Thursday,
/// or a Wednesday in a leap year.
fn iso_weeks_in_year(year: i64) -> i64 {
    let jan1 = iso_weekday(year, 1, 1);
    if jan1 == 4 || (jan1 == 3 && is_leap_year(year)) {
        53
    } else {
        52
    }
}

/// ISO-8601 week-based year and week number of a valid calendar date.
fn iso_week(year: i64, month: u32, day: u32) -> (i64, i64) {
    let ordinal = days_from_civil(year, month, day) - days_from_civil(year, 1, 1) + 1;
    let week = (ordinal - iso_weekday(year, month, day) + 10) / 7;
    if week < 1 {
        (year - 1, iso_weeks_in_year(year - 1))
    } else if week > iso_weeks_in_year(year) {
        (year + 1, 1)
    } else {
        (year, week)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; 32] {
        [42u8; 32]
    }

    #[test]
    fn test_blind_index_deterministic() {
        let key = test_key();
        let a = blind_index(&key, "status", "open");
        let b = blind_index(&key, "status", "open");
        assert_eq!(a, b);
    }

    #[test]
    fn test_blind_index_different_values() {
        let key = test_key();
        let a = blind_index(&key, "status", "open");
        let b = blind_index(&key, "status", "closed");
        assert_ne!(a, b);
    }

    #[test]
    fn test_blind_index_different_fields() {
        let key = test_key();
        let a = blind_index(&key, "status", "open");
        let b = blind_index(&key, "severity", "open");
        assert_ne!(a, b); // Same value, different field → different hash
    }

    #[test]
    fn test_blind_index_different_hub_keys() {
        let key_a = [1u8; 32];
        let key_b = [2u8; 32];
        let a = blind_index(&key_a, "status", "open");
        let b = blind_index(&key_b, "status", "open");
        assert_ne!(a, b); // Different hub keys → different hashes
    }

    #[test]
    fn test_canonicalization_case_insensitive() {
        let key = test_key();
        let a = blind_index(&key, "name", "Carlos");
        let b = blind_index(&key, "name", "carlos");
        assert_eq!(a, b);
    }

    #[test]
    fn test_canonicalization_whitespace() {
        let key = test_key();
        let a = blind_index(&key, "name", "Carlos");
        let b = blind_index(&key, "name", "  Carlos  ");
        assert_eq!(a, b);
    }

    #[test]
    fn test_date_blind_indexes_count() {
        let key = test_key();
        let indexes = date_blind_indexes(&key, "created", "2026-03-14");
        assert_eq!(indexes.len(), 3);
        assert!(indexes.iter().any(|(k, _)| k == "created_day"));
        assert!(indexes.iter().any(|(k, _)| k == "created_week"));
        assert!(indexes.iter().any(|(k, _)| k == "created_month"));
    }

    #[test]
    fn test_date_blind_indexes_deterministic() {
        let key = test_key();
        let a = date_blind_indexes(&key, "created", "2026-03-14");
        let b = date_blind_indexes(&key, "created", "2026-03-14");
        assert_eq!(a, b);
    }

    #[test]
    fn test_date_same_month_different_day() {
        let key = test_key();
        let a = date_blind_indexes(&key, "created", "2026-03-14");
        let b = date_blind_indexes(&key, "created", "2026-03-15");
        // Day hashes differ
        let a_day = a.iter().find(|(k, _)| k == "created_day").unwrap();
        let b_day = b.iter().find(|(k, _)| k == "created_day").unwrap();
        assert_ne!(a_day.1, b_day.1);
        // Month hashes are the same
        let a_month = a.iter().find(|(k, _)| k == "created_month").unwrap();
        let b_month = b.iter().find(|(k, _)| k == "created_month").unwrap();
        assert_eq!(a_month.1, b_month.1);
    }

    #[test]
    fn test_trigram_indexes() {
        let key = test_key();
        let tokens = name_trigram_indexes(&key, "name", "Carlos");
        // "carlos" → trigrams: "car", "arl", "rlo", "los" = 4 tokens
        assert_eq!(tokens.len(), 4);
    }

    #[test]
    fn test_trigram_short_value() {
        let key = test_key();
        let tokens = name_trigram_indexes(&key, "name", "ab");
        assert_eq!(tokens.len(), 1); // Too short for trigrams, index whole value
    }

    #[test]
    fn test_trigram_dedup() {
        let key = test_key();
        // "aaa" has only one unique trigram "aaa"
        let tokens = name_trigram_indexes(&key, "name", "aaa");
        assert_eq!(tokens.len(), 1);
    }

    #[test]
    fn test_iso_week_string() {
        assert_eq!(iso_week_string("2026-03-14"), "2026-W11");
        assert_eq!(iso_week_string("2026-01-01"), "2026-W01");
    }

    #[test]
    fn test_iso_week_invalid_date() {
        assert_eq!(iso_week_string("invalid"), "0000-W00");
    }

    // ── Wire-compatibility pins ─────────────────────────────────────────────
    //
    // Every expectation below was produced by the `chrono`-based implementation
    // this module used before RUSTSEC-2026-0543 forced it out (and the
    // replacement was differential-tested against chrono over every day of
    // 1600-2600, every 4-digit year x month x day shape, and 3M random
    // strings). A blind index is a client-computed HMAC the server cannot
    // rebuild: if any of these changes, every index already written for that
    // input stops matching and searches silently return nothing.

    #[test]
    fn iso_week_year_boundaries_belong_to_the_neighbouring_year() {
        for (date, week) in [
            // 53-week years: early January still belongs to last year's W53.
            ("2020-12-31", "2020-W53"),
            ("2021-01-01", "2020-W53"),
            ("2021-01-03", "2020-W53"),
            ("2021-01-04", "2021-W01"),
            ("2015-12-31", "2015-W53"),
            ("2016-01-03", "2015-W53"),
            ("2016-01-04", "2016-W01"),
            ("2004-12-31", "2004-W53"),
            ("2005-01-01", "2004-W53"),
            ("2026-12-31", "2026-W53"),
            ("2027-01-01", "2026-W53"),
            ("2027-01-03", "2026-W53"),
            // Late December can already be next year's W01.
            ("2024-12-29", "2024-W52"),
            ("2024-12-30", "2025-W01"),
            ("2008-12-29", "2009-W01"),
            ("2026-01-01", "2026-W01"),
        ] {
            assert_eq!(iso_week_string(date), week, "{date}");
        }
    }

    #[test]
    fn iso_week_leap_day_rules() {
        assert_eq!(iso_week_string("2024-02-29"), "2024-W09");
        assert_eq!(iso_week_string("2000-02-29"), "2000-W09"); // divisible by 400
        assert_eq!(iso_week_string("1900-02-29"), "0000-W00"); // divisible by 100 only
        assert_eq!(iso_week_string("2100-02-29"), "0000-W00");
        assert_eq!(iso_week_string("2023-02-29"), "0000-W00");
        // Proleptic Gregorian: year 0 exists and is a leap year; its ISO week
        // year is printed unpadded.
        assert_eq!(iso_week_string("0000-02-29"), "0-W09");
        assert_eq!(iso_week_string("0000-01-01"), "-1-W52");
        assert_eq!(iso_week_string("0001-01-01"), "1-W01");
        assert_eq!(iso_week_string("9999-12-31"), "9999-W52");
    }

    #[test]
    fn iso_week_rejects_dates_that_do_not_exist() {
        for date in [
            "2026-13-01",
            "2026-00-10",
            "2026-04-31",
            "2026-03-00",
            "2026-03-32",
        ] {
            assert_eq!(iso_week_string(date), "0000-W00", "{date}");
        }
    }

    #[test]
    fn iso_week_accepts_short_fields_and_leading_whitespace_like_chrono_did() {
        // Month/day may be 1-2 digits, the year 1-4 (so `026` is year 26).
        for date in ["2026-3-4", "2026-03-4", "2026-3-04"] {
            assert_eq!(iso_week_string(date), "2026-W10", "{date}");
        }
        assert_eq!(iso_week_string("026-03-14"), "26-W11");
        // Whitespace is skipped before each number, nowhere else.
        for date in [
            " 2026-03-14",
            "2026- 3-14",
            "2026-03- 14",
            "\u{a0}2026-03-14",
        ] {
            assert_eq!(iso_week_string(date), "2026-W11", "{date:?}");
        }
        for date in ["2026-03-14 ", "2026 -03-14", "2026-03 -14", "+ 2026-03-14"] {
            assert_eq!(iso_week_string(date), "0000-W00", "{date:?}");
        }
    }

    #[test]
    fn iso_week_signed_years_and_trailing_input() {
        assert_eq!(iso_week_string("+2026-03-14"), "2026-W11");
        assert_eq!(iso_week_string("+10000-01-01"), "9999-W52");
        assert_eq!(iso_week_string("-0001-12-31"), "-1-W52");
        assert_eq!(iso_week_string("-1-01-01"), "-2-W53");
        // Unsigned years stop at four digits, so a fifth is trailing input.
        assert_eq!(iso_week_string("12345-01-01"), "0000-W00");
        for date in ["2026-03-14T", "2026/03/14", "20260314", "", "invalid"] {
            assert_eq!(iso_week_string(date), "0000-W00", "{date:?}");
        }
        // The supported calendar range is chrono's NaiveDate range.
        assert_eq!(iso_week_string("+262142-12-31"), "262143-W01");
        assert_eq!(iso_week_string("+262143-01-01"), "0000-W00");
        assert_eq!(iso_week_string("-262143-01-01"), "-262143-W01");
        assert_eq!(iso_week_string("-262144-01-01"), "0000-W00");
    }

    #[test]
    fn date_blind_indexes_golden_vectors() {
        // Frozen outputs: the full HMAC chain (key derivation, canonicalisation,
        // bucket strings) for a fixed hub key. These cannot change without
        // orphaning every stored date index.
        let key = test_key();
        let day = date_blind_indexes(&key, "created_at", "2026-03-14");
        assert_eq!(
            day,
            vec![
                (
                    "created_at_day".to_string(),
                    "8cb29e43b6cbe47fa66f4e3d90a07c2e4d7b03999e13b80dd06e644ab790e1f9".to_string()
                ),
                (
                    "created_at_week".to_string(),
                    "0637d827a34b6bfbd8946f9a9db94719ecd6448e5a2ccd624016d1a257189f79".to_string()
                ),
                (
                    "created_at_month".to_string(),
                    "9764194bc1490eb1364bad724f2a1d08d84eaf0a023e82533771929feb5c578d".to_string()
                ),
            ]
        );
        // A full timestamp buckets exactly like its date part.
        assert_eq!(
            date_blind_indexes(&key, "created_at", "2026-03-14T08:30:00.000Z"),
            day
        );
        // An unparseable date still produces tokens, with the `0000-W00` week.
        let junk = date_blind_indexes(&key, "created_at", "not-a-date");
        assert_eq!(
            junk[1].1,
            "1a23b2e932ac1b7fa36f87622f4f7c3f4f9e24cd70355e6d7ff257a848c94121"
        );
    }
}
