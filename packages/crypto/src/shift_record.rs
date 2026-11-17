//! Free-text shift fields, sealed and opened **per purpose** (#2777, #2778).
//!
//! Two shift rows carry a sentence a person typed:
//!
//! - an availability block's *reason* (`user_availability_blocks.encrypted_reason`)
//!   — why a volunteer cannot take shifts ("medical appointment", "court date");
//! - a shift override's *note* (`shift_overrides.encrypted_note`) — why a shift
//!   is cancelled, or who covers it and why.
//!
//! Both columns were named `encrypted_*` and held the typed text, because the
//! only writer (iOS) had no crate function to seal them with and the server
//! schema accepted any string. This module is that function, and the only place
//! that decides how either field is sealed:
//!
//! ```text
//! purpose               label                       content AAD     key-wrap AAD
//! availability-reason   LABEL_AVAILABILITY_REASON   UTF-8(label)    UTF-8(label ":key-wrap")
//! override-note         LABEL_SHIFT_OVERRIDE_NOTE   UTF-8(label)    UTF-8(label ":key-wrap")
//!
//! encrypted<Field> = hex(iv(12) || AES-256-GCM(content_key, plaintext, content AAD) || tag(16))
//! envelope         = { pubkey, enc, ct }   all hex
//!   pubkey = the reader's X25519 key — the key the wrap is sealed to
//!   enc    = the 32-byte HPKE encapsulated key
//!   ct     = HPKE(info = label, aad = key-wrap AAD).Seal(content_key)
//! ```
//!
//! This is the same construction as [`crate::case_record`], for the same
//! reason: a field with exactly one writer kind (a client) gets the canonical
//! AAD, and no platform is handed a label or an AAD to choose. A reason opens
//! as no note and a note as no reason — that is what stops a server moving one
//! into the other's column.
//!
//! ## Who the readers are
//!
//! The crate does not decide the reader set, but it refuses an empty one and
//! the device-scoped entry points always add the sealing device. The clients
//! seal to the author's device, the hub's `admin` reader set, and the hub
//! reader set of the field's own purpose (`shift-availability` /
//! `shift-overrides`, PROTOCOL §2.4.2); the server refuses a write whose
//! envelopes name no admin (`assertAdminCanRead`).

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::device_keys::{DeviceKeyState, DeviceSecrets};
use crate::encryption::{self, RecipientKeyEnvelope};
use crate::envelope_aad::{content_aad, key_wrap_aad};
use crate::errors::CryptoError;
use crate::labels::{LABEL_AVAILABILITY_REASON, LABEL_SHIFT_OVERRIDE_NOTE};

/// What a shift ciphertext is. The only choice a caller makes — it names the
/// field being sealed, never how. A UniFFI enum on mobile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "mobile", derive(uniffi::Enum))]
pub enum ShiftFieldPurpose {
    /// A volunteer's reason for an availability block.
    AvailabilityReason,
    /// The note on a shift override.
    OverrideNote,
}

impl ShiftFieldPurpose {
    /// Every purpose, for exhaustive tests.
    pub const ALL: [ShiftFieldPurpose; 2] = [Self::AvailabilityReason, Self::OverrideNote];

    /// The label this purpose is sealed under. Crate-private: exposing it would
    /// invite composing the envelope by hand again.
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::AvailabilityReason => LABEL_AVAILABILITY_REASON,
            Self::OverrideNote => LABEL_SHIFT_OVERRIDE_NOTE,
        }
    }
}

/// A sealed shift field in wire form: the ciphertext plus one envelope per
/// reader. Maps onto `encryptedReason`/`reasonEnvelopes` and
/// `encryptedNote`/`noteEnvelopes` unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct EncryptedShiftField {
    /// hex: iv(12) || ciphertext || tag(16)
    pub encrypted_content: String,
    /// The content key wrapped for each reader, `pubkey` = the reader's X25519 key.
    pub reader_envelopes: Vec<RecipientKeyEnvelope>,
}

/// Seal `plaintext` as `purpose` for `reader_pubkeys` (X25519, hex).
pub fn seal(
    purpose: ShiftFieldPurpose,
    plaintext: &str,
    reader_pubkeys: &[String],
) -> Result<EncryptedShiftField, CryptoError> {
    let readers = encryption::normalise_x25519_readers(reader_pubkeys, "shift field")?;
    let label = purpose.label();
    let sealed = encryption::seal_multi_reader(
        plaintext.as_bytes(),
        &readers,
        label,
        &content_aad(label),
        &key_wrap_aad(label),
    )?;
    Ok(EncryptedShiftField {
        encrypted_content: sealed.encrypted_content,
        reader_envelopes: sealed.reader_envelopes,
    })
}

/// Open a shift field with the envelope addressed to `reader_pubkey`
/// (X25519, hex), using that key's secret.
pub fn open(
    purpose: ShiftFieldPurpose,
    encrypted_content: &str,
    envelopes: &[RecipientKeyEnvelope],
    reader_pubkey: &str,
    secret_key_hex: &str,
) -> Result<String, CryptoError> {
    let label = purpose.label();
    let plaintext: Zeroizing<Vec<u8>> = encryption::open_multi_reader(
        encrypted_content,
        envelopes,
        &[reader_pubkey],
        secret_key_hex,
        label,
        &content_aad(label),
        &key_wrap_aad(label),
    )?;
    String::from_utf8(plaintext.to_vec()).map_err(|_| CryptoError::DecryptionFailed)
}

/// Seal as this device: the device's own X25519 key is always a reader, so the
/// author can always read back what they wrote. The device's Ed25519 key, if a
/// caller passes it, is dropped — an HPKE wrap to an Ed25519 key opens for
/// nobody.
pub fn seal_as_device(
    purpose: ShiftFieldPurpose,
    device: &DeviceKeyState,
    plaintext: &str,
    other_readers: &[String],
) -> Result<EncryptedShiftField, CryptoError> {
    let mut readers = Vec::with_capacity(other_readers.len() + 1);
    readers.push(device.encryption_pubkey_hex.clone());
    readers.extend(
        other_readers
            .iter()
            .filter(|pk| !pk.eq_ignore_ascii_case(&device.signing_pubkey_hex))
            .cloned(),
    );
    seal(purpose, plaintext, &readers)
}

/// Open as this device, with the envelope addressed to its X25519 key.
pub fn open_as_device(
    purpose: ShiftFieldPurpose,
    secrets: &DeviceSecrets,
    device: &DeviceKeyState,
    encrypted_content: &str,
    envelopes: &[RecipientKeyEnvelope],
) -> Result<String, CryptoError> {
    let secret_hex = Zeroizing::new(hex::encode(secrets.encryption_seed));
    open(
        purpose,
        encrypted_content,
        envelopes,
        &device.encryption_pubkey_hex,
        &secret_hex,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::case_record::{self, CasePurpose};
    use x25519_dalek::{PublicKey, StaticSecret};

    fn keypair(byte: u8) -> (String, String) {
        let secret = StaticSecret::from([byte; 32]);
        let public = PublicKey::from(&secret);
        (
            hex::encode(secret.to_bytes()),
            hex::encode(public.as_bytes()),
        )
    }

    #[test]
    fn every_purpose_round_trips_for_every_reader() {
        let (author_sk, author_pk) = keypair(0x51);
        let (admin_sk, admin_pk) = keypair(0x52);
        for purpose in ShiftFieldPurpose::ALL {
            let sealed = seal(
                purpose,
                "medical appointment",
                &[author_pk.clone(), admin_pk.clone()],
            )
            .unwrap();
            assert_eq!(sealed.reader_envelopes.len(), 2);
            for (sk, pk) in [(&author_sk, &author_pk), (&admin_sk, &admin_pk)] {
                let opened = open(
                    purpose,
                    &sealed.encrypted_content,
                    &sealed.reader_envelopes,
                    pk,
                    sk,
                )
                .unwrap();
                assert_eq!(opened, "medical appointment");
            }
        }
    }

    /// The defect this module closes: the stored value is not the typed text.
    #[test]
    fn the_ciphertext_does_not_contain_the_plaintext() {
        let (_, pk) = keypair(0x53);
        let typed = "court date";
        for purpose in ShiftFieldPurpose::ALL {
            let sealed = seal(purpose, typed, std::slice::from_ref(&pk)).unwrap();
            assert!(!sealed.encrypted_content.contains(typed));
            assert!(!sealed.encrypted_content.contains(&hex::encode(typed)));
        }
    }

    /// A reason opens as no note, and a note as no reason.
    #[test]
    fn a_ciphertext_does_not_open_as_another_purpose() {
        let (sk, pk) = keypair(0x54);
        for sealed_as in ShiftFieldPurpose::ALL {
            let sealed = seal(sealed_as, "x", std::slice::from_ref(&pk)).unwrap();
            for opened_as in ShiftFieldPurpose::ALL {
                let result = open(
                    opened_as,
                    &sealed.encrypted_content,
                    &sealed.reader_envelopes,
                    &pk,
                    &sk,
                );
                assert_eq!(
                    result.is_ok(),
                    sealed_as == opened_as,
                    "sealed as {sealed_as:?}, opened as {opened_as:?}"
                );
            }
        }
    }

    /// Nor can a case ciphertext be moved into a shift column, or back.
    #[test]
    fn shift_fields_and_case_ciphertexts_are_separate_domains() {
        let (sk, pk) = keypair(0x55);
        for purpose in ShiftFieldPurpose::ALL {
            let shift = seal(purpose, "x", std::slice::from_ref(&pk)).unwrap();
            for case_purpose in CasePurpose::ALL {
                assert!(case_record::open(
                    case_purpose,
                    &shift.encrypted_content,
                    &shift.reader_envelopes,
                    &pk,
                    &sk
                )
                .is_err());
                let case = case_record::seal(case_purpose, "x", std::slice::from_ref(&pk)).unwrap();
                assert!(open(
                    purpose,
                    &case.encrypted_content,
                    &case.reader_envelopes,
                    &pk,
                    &sk
                )
                .is_err());
            }
        }
    }

    #[test]
    fn a_non_reader_cannot_open() {
        let (_, reader_pk) = keypair(0x56);
        let (outsider_sk, outsider_pk) = keypair(0x57);
        let sealed = seal(
            ShiftFieldPurpose::OverrideNote,
            "x",
            std::slice::from_ref(&reader_pk),
        )
        .unwrap();
        assert!(open(
            ShiftFieldPurpose::OverrideNote,
            &sealed.encrypted_content,
            &sealed.reader_envelopes,
            &outsider_pk,
            &outsider_sk
        )
        .is_err());
    }

    #[test]
    fn an_empty_reader_set_is_refused() {
        for purpose in ShiftFieldPurpose::ALL {
            assert!(seal(purpose, "x", &[]).is_err());
        }
    }

    #[test]
    fn readers_are_deduplicated_and_must_be_x25519_sized() {
        let (_, pk) = keypair(0x58);
        let sealed = seal(
            ShiftFieldPurpose::AvailabilityReason,
            "x",
            &[pk.clone(), pk.to_uppercase()],
        )
        .unwrap();
        assert_eq!(sealed.reader_envelopes.len(), 1);
        assert!(seal(
            ShiftFieldPurpose::AvailabilityReason,
            "x",
            &["ab".repeat(16)]
        )
        .is_err());
    }

    #[test]
    fn the_device_is_always_a_reader_and_its_ed25519_key_is_dropped() {
        let (device_sk, device_pk) = keypair(0x59);
        let (_, admin_pk) = keypair(0x5a);
        let device = DeviceKeyState {
            device_id: "d".into(),
            signing_pubkey_hex: "ed".repeat(32),
            encryption_pubkey_hex: device_pk.clone(),
        };
        let sealed = seal_as_device(
            ShiftFieldPurpose::AvailabilityReason,
            &device,
            "childcare",
            &[admin_pk.clone(), "ed".repeat(32)],
        )
        .unwrap();
        let addressed: Vec<&str> = sealed
            .reader_envelopes
            .iter()
            .map(|e| e.pubkey.as_str())
            .collect();
        assert_eq!(addressed, vec![device_pk.as_str(), admin_pk.as_str()]);
        assert_eq!(
            open(
                ShiftFieldPurpose::AvailabilityReason,
                &sealed.encrypted_content,
                &sealed.reader_envelopes,
                &device_pk,
                &device_sk
            )
            .unwrap(),
            "childcare"
        );
    }
}
