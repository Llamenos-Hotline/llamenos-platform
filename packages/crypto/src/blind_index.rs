//! Blind index generation for E2EE server-side filtering.
//!
//! Enables server-side filtering of encrypted data using HMAC blind indexes.
//! The server sees only opaque hash tokens, never plaintext values.
//!
//! Three query types:
//! - **Exact match**: HMAC of canonicalized value (for enums, statuses)
//! - **Epoch bucketing**: HMAC at day/week/month granularity (for date ranges)
//! - **Trigram tokenization**: HMAC of each 3-char substring (for name search)

use chrono::NaiveDate;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

use crate::errors::CryptoError;
use crate::labels::{HMAC_CASE_SEVERITY, HMAC_CASE_STATUS, LABEL_BLIND_INDEX_FIELD, LABEL_BLIND_INDEX_KEY};

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

/// The fields a client may blind-index through the exported surface, each named
/// by its registered domain-separation label.
///
/// This is the one canonical scheme (#2779): the label is the `field_name` fed
/// into [`derive_blind_index_key`], so a field's key is
/// `HKDF(salt = LABEL_BLIND_INDEX_KEY, ikm = hub key, info = LABEL_BLIND_INDEX_FIELD ‖ label)`.
/// The `HMAC_*` labels name the field; they are not a second, parallel HMAC key.
///
/// The set is closed: a client cannot invent a field name, so two platforms
/// cannot drift onto different keys for the same column.
///
/// What a token over these fields hides, and what it does not: the key is the
/// 256-bit hub key, which the server never holds, so the small vocabulary does
/// not let the server enumerate tokens. Equality is the point of a blind
/// index, though, so the server still sees which rows share a status and how
/// often each token occurs.
pub const BLIND_INDEX_FIELDS: &[&str] = &[HMAC_CASE_STATUS, HMAC_CASE_SEVERITY];

/// Blind-index each of `values` for `field_label`, one token per value, in
/// order. `field_label` must be one of [`BLIND_INDEX_FIELDS`]; an empty value
/// (after canonicalisation) is refused rather than given a token of its own.
pub fn field_blind_indexes(
    hub_key: &[u8; 32],
    field_label: &str,
    values: &[String],
) -> Result<Vec<String>, CryptoError> {
    if !BLIND_INDEX_FIELDS.contains(&field_label) {
        return Err(CryptoError::InvalidInput(format!(
            "not a blind-index field: {field_label}"
        )));
    }
    values
        .iter()
        .map(|value| {
            if canonicalize(value).is_empty() {
                return Err(CryptoError::InvalidInput(
                    "cannot blind-index an empty value".into(),
                ));
            }
            Ok(blind_index(hub_key, field_label, value))
        })
        .collect()
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
fn iso_week_string(iso_date: &str) -> String {
    NaiveDate::parse_from_str(iso_date, "%Y-%m-%d")
        .map(|date| {
            use chrono::Datelike;
            let iso = date.iso_week();
            format!("{}-W{:02}", iso.year(), iso.week())
        })
        .unwrap_or_else(|_| "0000-W00".to_string())
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
    fn field_blind_indexes_use_the_label_as_the_field_name() {
        let key = test_key();
        let tokens = field_blind_indexes(
            &key,
            HMAC_CASE_STATUS,
            &["open".to_string(), "closed".to_string()],
        )
        .unwrap();
        assert_eq!(tokens[0], blind_index(&key, HMAC_CASE_STATUS, "open"));
        assert_eq!(tokens[1], blind_index(&key, HMAC_CASE_STATUS, "closed"));
        assert_eq!(tokens[0].len(), 64);
        // A token is never the value it stands for.
        assert_ne!(tokens[0], "open");
    }

    #[test]
    fn field_blind_indexes_separate_status_from_severity() {
        let key = test_key();
        let v = vec!["high".to_string()];
        let status = field_blind_indexes(&key, HMAC_CASE_STATUS, &v).unwrap();
        let severity = field_blind_indexes(&key, HMAC_CASE_SEVERITY, &v).unwrap();
        assert_ne!(status, severity);
    }

    #[test]
    fn field_blind_indexes_refuse_an_unregistered_field() {
        let key = test_key();
        let v = vec!["open".to_string()];
        assert!(field_blind_indexes(&key, "status", &v).is_err());
        assert!(field_blind_indexes(&key, "llamenos:case-category", &v).is_err());
    }

    #[test]
    fn field_blind_indexes_refuse_an_empty_value() {
        let key = test_key();
        assert!(field_blind_indexes(&key, HMAC_CASE_STATUS, &["  ".to_string()]).is_err());
    }

    /// Known answer shared with the desktop IPC mock
    /// (`tests/mocks/crypto-impl.ts`) and the mobile FFI tests, so every
    /// implementation that must agree on a token is checked against one value.
    #[test]
    fn field_blind_index_known_answer() {
        let key = [0x42u8; 32];
        let tokens = field_blind_indexes(
            &key,
            HMAC_CASE_STATUS,
            &["open".to_string()],
        )
        .unwrap();
        let severity = field_blind_indexes(&key, HMAC_CASE_SEVERITY, &["high".to_string()]).unwrap();
        assert_eq!(tokens[0], KAT_STATUS_OPEN);
        assert_eq!(severity[0], KAT_SEVERITY_HIGH);
    }

    const KAT_STATUS_OPEN: &str = "1d4ac0e1a18dd11314d37d71f7286964d04e74c25927b6c5c29a174adc894d74";
    const KAT_SEVERITY_HIGH: &str = "15a7a8fa68968c0c64a0c1562b90cce6e773625ab8fc88ed10ccd4c08b855090";

    #[test]
    fn test_iso_week_string() {
        assert_eq!(iso_week_string("2026-03-14"), "2026-W11");
        assert_eq!(iso_week_string("2026-01-01"), "2026-W01");
    }

    #[test]
    fn test_iso_week_invalid_date() {
        assert_eq!(iso_week_string("invalid"), "0000-W00");
    }
}
