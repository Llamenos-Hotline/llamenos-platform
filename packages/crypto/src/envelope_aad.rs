//! The one definition, on the Rust side, of an envelope's additional
//! authenticated data (AAD).
//!
//! `docs/protocol/PROTOCOL.md` §2.4 specifies two distinct AAD values for an
//! envelope-pattern ciphertext:
//!
//! ```text
//! content  (AES-256-GCM) : aad = UTF-8(label)
//! key wrap (HPKE)        : aad = UTF-8(`${label}:key-wrap`)
//! ```
//!
//! with the label additionally bound as the HPKE `info` (the Albrecht defense,
//! enforced at open by [`crate::hpke_envelope`]). The two AADs **must** differ:
//! [`crate::hpke_envelope::hpke_seal`] carries content directly *and*
//! [`crate::hpke_envelope::hpke_seal_key`] wraps a content key, under the
//! *same* label — so the HPKE `info` does not separate those two meanings.
//! Only the AAD does.
//!
//! This module mirrors `packages/shared/envelope-aad.ts`, which is the
//! definition every TypeScript surface imports. Two languages cannot share one
//! source file, so agreement is held by a test instead of by convention:
//! `tests::rust_matches_shared_envelope_aad_ts` parses the TypeScript module's
//! rule and asserts byte equality, and
//! `packages/crypto/tests/envelope_aad_cross_platform.rs` extends that to the
//! generated Kotlin binding. Before this module the rule was spelled out by
//! hand at four sites in this crate alone (`encryption.rs` ×2, `ffi.rs` ×2) and
//! was absent entirely from the mobile FFI, which is why Android and iOS could
//! not read anything the server wrote.
//!
//! Nothing may re-spell `:key-wrap` at a call site. Call these functions.

use crate::errors::CryptoError;

/// The suffix that distinguishes a key-wrap envelope from a content envelope.
pub const KEY_WRAP_AAD_SUFFIX: &str = ":key-wrap";

/// AAD for the AES-256-GCM encryption of an envelope's *content*.
pub fn content_aad(label: &str) -> Vec<u8> {
    label.as_bytes().to_vec()
}

/// AAD for the HPKE seal that *wraps the content key* for one reader.
pub fn key_wrap_aad(label: &str) -> Vec<u8> {
    format!("{label}{KEY_WRAP_AAD_SUFFIX}").into_bytes()
}

/// Reject a label that is not in the generated registry.
///
/// The AAD is only domain-separating if the label is a real domain. A typo'd
/// or hand-written label would still produce a well-formed AAD and still
/// encrypt — and would then be undecryptable by every other implementation,
/// which is the failure mode this whole module exists to close. The hex entry
/// points below are the ones mobile call sites reach, so they check.
fn require_known_label(label: &str) -> Result<(), CryptoError> {
    if crate::labels::label_to_id(label).is_none() {
        return Err(CryptoError::InvalidInput(format!(
            "unknown crypto label: {label}"
        )));
    }
    Ok(())
}

/// [`content_aad`] as hex, for the entry points that take an `aad_hex`
/// (the UniFFI `mobile_*` functions and the Tauri IPC commands).
pub fn content_aad_hex(label: &str) -> Result<String, CryptoError> {
    require_known_label(label)?;
    Ok(hex::encode(content_aad(label)))
}

/// [`key_wrap_aad`] as hex, for the entry points that take an `aad_hex`.
pub fn key_wrap_aad_hex(label: &str) -> Result<String, CryptoError> {
    require_known_label(label)?;
    Ok(hex::encode(key_wrap_aad(label)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::labels::{LABEL_CALL_META, LABEL_MESSAGE};

    #[test]
    fn content_aad_is_the_label_itself() {
        assert_eq!(content_aad(LABEL_MESSAGE), b"llamenos:message".to_vec());
        assert_eq!(
            content_aad_hex(LABEL_MESSAGE).unwrap(),
            hex::encode(content_aad(LABEL_MESSAGE))
        );
    }

    #[test]
    fn key_wrap_aad_appends_the_suffix() {
        assert_eq!(key_wrap_aad(LABEL_MESSAGE), *b"llamenos:message:key-wrap");
        // The hex entry point must agree with the byte-level function; the
        // literal pin for this AAD's spelling is the assertion above.
        assert_eq!(
            key_wrap_aad_hex(LABEL_CALL_META).unwrap(),
            hex::encode(key_wrap_aad(LABEL_CALL_META))
        );
    }

    /// The real hazard is not that the two forms differ for a given label —
    /// they differ by construction. It is that one label's key-wrap AAD could
    /// collide with *another* registered label's content AAD, which would make
    /// a key-wrap envelope and a content envelope byte-ambiguous again. That is
    /// the #1509 shape. The registry must admit no such pair.
    #[test]
    fn no_key_wrap_aad_collides_with_another_labels_content_aad() {
        let labels: Vec<&str> = crate::labels::LABEL_REGISTRY
            .iter()
            .copied()
            .filter(|s| !s.is_empty())
            .collect();
        for &a in &labels {
            let wrap = key_wrap_aad(a);
            for &b in &labels {
                assert_ne!(
                    wrap,
                    content_aad(b),
                    "key-wrap AAD of {a} is byte-identical to the content AAD of {b}"
                );
            }
        }
    }

    #[test]
    fn hex_entry_points_reject_an_unregistered_label() {
        // Derived from a registered label so the raw spelling lives only in
        // labels.rs; the registry must still reject it.
        let unknown = format!("{LABEL_MESSAGE}-not-a-real-label");
        assert_eq!(content_aad_hex(&unknown).is_err(), true);
        assert_eq!(key_wrap_aad_hex(&unknown).is_err(), true);
    }
}
