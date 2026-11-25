//! Crypto format of a sealed row (#2964).
//!
//! Every table that stores ciphertext carries a `crypto_format` column. Today
//! there is one format, [`CRYPTO_FORMAT_V1`]: the envelope and AAD layout the
//! pilot writes. M2 changes that layout (content AAD bound to the record's hub,
//! type and document; group recipients — #2961, #2974), and its re-encryption
//! jobs select rows by this value instead of trial-decrypting them.
//!
//! The rule for every reader on every platform: **refuse a format you do not
//! know, and never guess.** A row stamped with a format this build cannot read
//! is an error to surface, not something to try each known layout against.
//! [`check_crypto_format`] is that rule, defined once here so iOS, Android and
//! desktop apply the same one.
//!
//! The values are pinned to `packages/protocol/crypto-formats.json`, which the
//! worker's database CHECK constraints are generated from, by
//! `crypto_formats_match_protocol_json` below. This module does NOT define v2:
//! the #2974 spec does, and appends it here.

use crate::errors::CryptoError;

/// Format 1: the pilot layout — content AAD is the label alone
/// ([`crate::envelope_aad`]), recipients are individual device keys.
pub const CRYPTO_FORMAT_V1: u32 = 1;

/// The format every writer in this build produces.
pub const CRYPTO_FORMAT_CURRENT: u32 = CRYPTO_FORMAT_V1;

/// Every format a reader in this build accepts.
pub const CRYPTO_FORMATS_KNOWN: &[u32] = &[CRYPTO_FORMAT_V1];

/// Accept a row's `crypto_format` only if this build can read it.
///
/// Call before opening any sealed row. An unknown value is
/// [`CryptoError::InvalidFormat`]; there is no fallback to a known layout.
#[cfg_attr(feature = "mobile", uniffi::export)]
pub fn check_crypto_format(format: u32) -> Result<(), CryptoError> {
    if CRYPTO_FORMATS_KNOWN.contains(&format) {
        Ok(())
    } else {
        Err(CryptoError::InvalidFormat(format!(
            "Unknown crypto format {format}: this build reads {CRYPTO_FORMATS_KNOWN:?} and does not guess"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_every_known_format() {
        for &format in CRYPTO_FORMATS_KNOWN {
            assert!(check_crypto_format(format).is_ok(), "format {format}");
        }
        assert!(CRYPTO_FORMATS_KNOWN.contains(&CRYPTO_FORMAT_CURRENT));
    }

    #[test]
    fn refuses_unknown_formats() {
        // 0 is what a missing value defaults to in most decoders; 2 is the next
        // format, which this build must not read before it is defined; 257
        // would alias 1 under a u8 truncation.
        for format in [0, 2, 257, u32::MAX] {
            let err = check_crypto_format(format).expect_err("unknown format must be refused");
            assert!(
                matches!(err, CryptoError::InvalidFormat(_)),
                "{format}: {err}"
            );
        }
    }

    /// CI GUARD: the crate and the worker's CHECK constraints agree on which
    /// formats exist. Both read `packages/protocol/crypto-formats.json`.
    #[test]
    fn crypto_formats_match_protocol_json() {
        let json: serde_json::Value =
            serde_json::from_str(include_str!("../../protocol/crypto-formats.json"))
                .expect("crypto-formats.json parses");
        let current = json["current"].as_u64().expect("current is an integer");
        let known: Vec<u64> = json["known"]
            .as_array()
            .expect("known is an array")
            .iter()
            .map(|v| v.as_u64().expect("known holds integers"))
            .collect();
        assert_eq!(current, u64::from(CRYPTO_FORMAT_CURRENT));
        assert_eq!(
            known,
            CRYPTO_FORMATS_KNOWN
                .iter()
                .map(|&f| u64::from(f))
                .collect::<Vec<_>>()
        );
    }
}
