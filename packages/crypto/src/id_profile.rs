//! The identifier profile (spec §2.1): every id that enters an AAD or a key
//! derivation must match `^[0-9a-z][0-9a-z-]{0,63}$`, or be lowercase hex.
//! The crate refuses anything else rather than normalising it, so two
//! implementations can never disagree about which bytes an id stands for.

use crate::errors::CryptoError;

/// The longest lowercase-hex id accepted (a 32-byte pubkey is 64 characters;
/// hex ids beyond the slug profile are pubkeys and hashes).
const MAX_HEX_ID_LEN: usize = 128;

fn is_slug(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_digit() || b[0].is_ascii_lowercase())
        && b.iter()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || *c == b'-')
}

/// Refuse `value` unless it is in the §2.1 profile.
pub fn check_id(field: &str, value: &str) -> Result<(), CryptoError> {
    let hex = !value.is_empty()
        && value.len() <= MAX_HEX_ID_LEN
        && crate::hpke_envelope::is_lower_hex(value);
    if is_slug(value) || hex {
        Ok(())
    } else {
        Err(CryptoError::InvalidIdentifier(format!(
            "{field} is outside the identifier profile"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile() {
        for ok in [
            "0b7c5a1e-2d4f-4c8a-9e1b-3f6d2a7c9e0f",
            "hub-1",
            "a",
            &"a".repeat(64),
            &"ab".repeat(32),
        ] {
            assert!(check_id("hub", ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "-hub",
            "Hub",
            "hub_1",
            "hub 1",
            "hub:1",
            &"a".repeat(65),
            "é",
        ] {
            assert_eq!(
                check_id("hub", bad).unwrap_err().code(),
                "invalid_id",
                "{bad}"
            );
        }
    }
}
