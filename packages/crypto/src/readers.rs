//! Who counts as a reader of hub content: the one decision both mobile clients
//! used to make for themselves (#1035).
//!
//! The server answers `GET /api/hubs/:hubId/readers?purpose=admin` with the
//! X25519 device keys of every member holding the admin minimum in that hub,
//! plus the hub's escrow key. What a client must do with that answer is not a
//! UI concern, and two clients each doing it by hand is how they drift (#2552,
//! #1288): a key that is the wrong *kind* of 32 bytes is still 64 hex characters,
//! and DHKEM(X25519) accepts any 32 bytes as a recipient, so a wrong key wraps
//! without error and produces an envelope nobody can open.
//!
//! So the rule lives here, once:
//!
//! * entries are trimmed and lowercased; an entry that is not 64 lowercase hex
//!   characters is **dropped, never repaired**;
//! * duplicates are removed, first occurrence wins, order preserved;
//! * an empty result is an **error**, [`CryptoError::NoAdminReader`], not an empty
//!   list. A note, report or contact sealed to nobody but its author stores and
//!   renders for the author and can never be opened by an admin, and it cannot
//!   be repaired afterwards. The caller refuses the write and keeps the user's
//!   input on screen; it never substitutes another key (the author's own key,
//!   or the instance-wide `adminDecryptionPubkey`, included).
//!
//! The function takes the server's list and nothing else — in particular no
//! "fallback" parameter — so there is no argument through which a client can
//! name a reader of its own choosing.

use crate::errors::CryptoError;

fn is_hex64(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The admin reader set of a hub, from the server's `recipients` list.
///
/// See the module documentation for the rules. Returns
/// [`CryptoError::NoAdminReader`] when nothing usable remains.
pub fn resolve_admin_readers(server_recipients: &[String]) -> Result<Vec<String>, CryptoError> {
    let mut readers: Vec<String> = Vec::new();
    for entry in server_recipients {
        let key = entry.trim().to_ascii_lowercase();
        if is_hex64(&key) && !readers.contains(&key) {
            readers.push(key);
        }
    }
    if readers.is_empty() {
        return Err(CryptoError::NoAdminReader);
    }
    Ok(readers)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11";
    const B: &str = "bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22";

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn every_admin_is_a_reader_in_server_order() {
        assert_eq!(resolve_admin_readers(&v(&[A, B])).unwrap(), v(&[A, B]));
    }

    #[test]
    fn entries_are_normalised_and_deduplicated() {
        let upper = A.to_ascii_uppercase();
        let padded = format!("  {B}\n");
        assert_eq!(
            resolve_admin_readers(&v(&[&upper, A, &padded, B])).unwrap(),
            v(&[A, B])
        );
    }

    #[test]
    fn malformed_entries_are_dropped_not_repaired() {
        let short = &A[..62];
        let long = format!("{A}00");
        let non_hex = format!("zz{}", &A[2..]);
        assert_eq!(
            resolve_admin_readers(&v(&[short, &long, &non_hex, "", B])).unwrap(),
            v(&[B])
        );
    }

    #[test]
    fn an_empty_set_is_refused() {
        assert!(matches!(
            resolve_admin_readers(&[]),
            Err(CryptoError::NoAdminReader)
        ));
    }

    #[test]
    fn a_set_with_nothing_usable_is_refused() {
        assert!(matches!(
            resolve_admin_readers(&v(&["", "not-a-key", &A[..10]])),
            Err(CryptoError::NoAdminReader)
        ));
    }
}
