//! Case records and case comments, sealed and opened **per purpose** (#2499).
//!
//! A case record carries two client-sealed ciphertexts — its summary
//! (`encryptedSummary` / `summaryEnvelopes`) and its custom-field values
//! (`encryptedFields` / `fieldEnvelopes`) — and each comment on its timeline
//! carries a third (`encryptedContent` / `contentEnvelopes`). This module is
//! the only place that decides how any of them is sealed:
//!
//! ```text
//! purpose   label                 content AAD (AES-256-GCM)   key-wrap AAD (HPKE)
//! summary   LABEL_CASE_SUMMARY    UTF-8(label)                UTF-8(label ":key-wrap")
//! fields    LABEL_CASE_FIELDS     UTF-8(label)                UTF-8(label ":key-wrap")
//! comment   LABEL_CASE_COMMENT    UTF-8(label)                UTF-8(label ":key-wrap")
//!
//! encryptedContent = hex(iv(12) || AES-256-GCM(content_key, plaintext, content AAD) || tag(16))
//! envelope         = { pubkey, enc, ct }   all hex
//!   pubkey = the reader's X25519 key — the key the wrap is sealed to
//!   enc    = the 32-byte HPKE encapsulated key
//!   ct     = HPKE(info = label, aad = key-wrap AAD).Seal(content_key): 48 bytes
//! ```
//!
//! ## Why the label and AAD are not parameters
//!
//! Before this module the crate exported primitives (`seal(label, aad, …)`) and
//! every platform composed them at its own call sites. Three platforms
//! therefore came to disagree: iOS sealed case records under
//! `LABEL_CASE_SUMMARY` with the canonical AAD, desktop and Android under
//! `LABEL_MESSAGE` with none, and Android sealed comments as notes and opened
//! them as messages — so it could not read its own comments. The first split of
//! this kind (#1393 / #1528) was closed by pinning a fixture (#1927) without
//! removing the ability to choose wrongly; this was the second.
//!
//! So nothing here takes a label or an AAD. A platform says *what* it is
//! sealing — by calling `seal_case_summary` rather than `seal_case_comment` —
//! and the crate supplies the rest. Desktop (Tauri IPC), iOS and Android
//! (UniFFI) and the server (`bun:ffi`) each reach these functions through a
//! binding that forwards bytes and nothing else; none of them can express a
//! different label, an empty AAD, or a different envelope shape.
//!
//! ## Why the canonical AAD, unlike a stored message
//!
//! Stored messages carry no AAD only because a conversation mixes
//! client-sealed and server-sealed messages with no format marker, so a reader
//! could not know which AAD to supply (`crate::envelope_aad`). A case record or
//! comment has exactly one writer kind — a client, through this module — so
//! that constraint is absent and the record gets the stronger binding. The
//! operator ruled the iOS convention canonical on 2026-11-05 (#2499).
//!
//! The server-persisted vectors in `tests/fixtures/case-record-vectors.json`
//! pin the format (PROTOCOL.md §2.18); every platform opens them through its
//! production reader.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::device_keys::{DeviceKeyState, DeviceSecrets};
use crate::encryption::{self, EncryptedMessage, RecipientKeyEnvelope, RecordReader};
use crate::envelope_aad::{content_aad, key_wrap_aad};
use crate::errors::CryptoError;
use crate::labels::{LABEL_CASE_COMMENT, LABEL_CASE_FIELDS, LABEL_CASE_SUMMARY};

/// What a case ciphertext is. The only choice a caller of this module makes —
/// it names the thing being sealed, never how. Every binding carries it as a
/// closed type: a UniFFI enum (Swift/Kotlin), a lowercase string the Tauri IPC
/// deserialises into this enum (`"summary"`/`"fields"`/`"comment"`), and a byte
/// on the server's C ABI.
///
/// `repr(u8)` because the server's C ABI carries it as a byte; the mapping is
/// closed ([`CasePurpose::from_u8`] rejects anything else).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Enum))]
#[repr(u8)]
pub enum CasePurpose {
    /// A case record's summary (title, description, status display).
    Summary = 0,
    /// A case record's custom-field values.
    Fields = 1,
    /// A comment interaction on a case record's timeline.
    Comment = 2,
}

impl CasePurpose {
    /// Every purpose, for exhaustive tests.
    pub const ALL: [CasePurpose; 3] = [Self::Summary, Self::Fields, Self::Comment];

    /// The label this purpose is sealed under. Crate-private: no platform
    /// needs it, and exposing it would invite composing it again by hand.
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Summary => LABEL_CASE_SUMMARY,
            Self::Fields => LABEL_CASE_FIELDS,
            Self::Comment => LABEL_CASE_COMMENT,
        }
    }

    /// Decode the server C ABI's purpose byte.
    pub fn from_u8(value: u8) -> Result<Self, CryptoError> {
        match value {
            0 => Ok(Self::Summary),
            1 => Ok(Self::Fields),
            2 => Ok(Self::Comment),
            other => Err(CryptoError::InvalidInput(format!(
                "unknown case purpose byte: {other}"
            ))),
        }
    }
}

/// A sealed case ciphertext in wire form: `encryptedContent` plus one envelope
/// per reader. Maps directly onto `encryptedSummary`/`summaryEnvelopes`,
/// `encryptedFields`/`fieldEnvelopes` and `encryptedContent`/`contentEnvelopes`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct EncryptedCaseCiphertext {
    /// hex: iv(12) || ciphertext || tag(16)
    pub encrypted_content: String,
    /// The content key wrapped for each reader, `pubkey` = the reader's X25519 key.
    pub reader_envelopes: Vec<RecipientKeyEnvelope>,
}

impl From<EncryptedMessage> for EncryptedCaseCiphertext {
    fn from(m: EncryptedMessage) -> Self {
        Self {
            encrypted_content: m.encrypted_content,
            reader_envelopes: m.reader_envelopes,
        }
    }
}

/// Normalise a reader list: lowercase hex, 32-byte keys, duplicates dropped
/// (first occurrence wins), and at least one reader.
fn normalise_readers(reader_pubkeys: &[String]) -> Result<Vec<RecordReader>, CryptoError> {
    let mut readers: Vec<RecordReader> = Vec::with_capacity(reader_pubkeys.len());
    for pk in reader_pubkeys {
        let bytes = hex::decode(pk).map_err(CryptoError::HexError)?;
        if bytes.len() != 32 {
            return Err(CryptoError::InvalidInput(format!(
                "case reader pubkey must be a 32-byte X25519 key, got {} bytes",
                bytes.len()
            )));
        }
        let pk = hex::encode(bytes);
        if !readers.iter().any(|r| r.encryption_pubkey == pk) {
            readers.push(RecordReader {
                address: pk.clone(),
                encryption_pubkey: pk,
            });
        }
    }
    if readers.is_empty() {
        return Err(CryptoError::InvalidInput(
            "case ciphertext has no readers — it would be undecryptable by everyone".into(),
        ));
    }
    Ok(readers)
}

/// Seal `plaintext` as `purpose` for `reader_pubkeys` (X25519, hex).
pub fn seal(
    purpose: CasePurpose,
    plaintext: &str,
    reader_pubkeys: &[String],
) -> Result<EncryptedCaseCiphertext, CryptoError> {
    let readers = normalise_readers(reader_pubkeys)?;
    let label = purpose.label();
    encryption::seal_multi_reader(
        plaintext.as_bytes(),
        &readers,
        label,
        &content_aad(label),
        &key_wrap_aad(label),
    )
    .map(Into::into)
}

/// Open a case ciphertext with the envelope addressed to `reader_pubkey`
/// (X25519, hex), using that key's secret.
pub fn open(
    purpose: CasePurpose,
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

/// Seal as this device: the device's own X25519 key is always a reader, so a
/// device can never write a case ciphertext it cannot read back.
///
/// `other_readers` are X25519 keys. The device's Ed25519 account key, if a
/// caller passes it, is dropped: it names this device, which is already a
/// reader, and sealing an HPKE wrap to an Ed25519 key yields an envelope that
/// nobody can open.
pub fn seal_as_device(
    purpose: CasePurpose,
    device: &DeviceKeyState,
    plaintext: &str,
    other_readers: &[String],
) -> Result<EncryptedCaseCiphertext, CryptoError> {
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
    purpose: CasePurpose,
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
    use crate::encryption::{open_record_for_reader, seal_record_for_readers};
    use crate::labels::LABEL_MESSAGE;
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
        let (a_sk, a_pk) = keypair(0x11);
        let (b_sk, b_pk) = keypair(0x22);
        for purpose in CasePurpose::ALL {
            let sealed = seal(purpose, "{\"title\":\"t\"}", &[a_pk.clone(), b_pk.clone()]).unwrap();
            assert_eq!(sealed.reader_envelopes.len(), 2);
            for (sk, pk) in [(&a_sk, &a_pk), (&b_sk, &b_pk)] {
                let opened = open(
                    purpose,
                    &sealed.encrypted_content,
                    &sealed.reader_envelopes,
                    pk,
                    sk,
                )
                .unwrap();
                assert_eq!(opened, "{\"title\":\"t\"}");
            }
        }
    }

    /// Domain separation: a ciphertext sealed for one purpose opens as no other.
    /// This is what stops a server moving a comment into a summary column.
    #[test]
    fn a_ciphertext_does_not_open_as_another_purpose() {
        let (sk, pk) = keypair(0x33);
        for sealed_as in CasePurpose::ALL {
            let sealed = seal(sealed_as, "x", std::slice::from_ref(&pk)).unwrap();
            for opened_as in CasePurpose::ALL {
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

    /// The #2499 defect shape, both directions: the stored-message format
    /// (`LABEL_MESSAGE`, no AAD) that desktop and Android wrote does not open as
    /// a case ciphertext, and a case ciphertext does not open as a message.
    #[test]
    fn the_stored_message_format_is_not_a_case_format() {
        let (sk, pk) = keypair(0x44);
        let reader = RecordReader {
            address: pk.clone(),
            encryption_pubkey: pk.clone(),
        };
        let as_message =
            seal_record_for_readers(b"x", std::slice::from_ref(&reader), LABEL_MESSAGE).unwrap();
        for purpose in CasePurpose::ALL {
            assert!(open(
                purpose,
                &as_message.encrypted_content,
                &as_message.reader_envelopes,
                &pk,
                &sk,
            )
            .is_err());
            let as_case = seal(purpose, "x", std::slice::from_ref(&pk)).unwrap();
            assert!(open_record_for_reader(
                &as_case.encrypted_content,
                &as_case.reader_envelopes,
                &[&pk],
                &sk,
                LABEL_MESSAGE,
            )
            .is_err());
        }
    }

    /// Each layer carries the canonical AAD — an empty AAD on either layer is
    /// refused (open the wrap with the right AAD and the content with none, and
    /// vice versa).
    #[test]
    fn both_layers_bind_the_canonical_aad() {
        use crate::envelope_aad::{content_aad, key_wrap_aad};
        let (sk, pk) = keypair(0x55);
        let sealed = seal(CasePurpose::Summary, "x", std::slice::from_ref(&pk)).unwrap();
        let label = CasePurpose::Summary.label();
        let wrap_only = encryption::open_multi_reader(
            &sealed.encrypted_content,
            &sealed.reader_envelopes,
            &[&pk],
            &sk,
            label,
            &[],
            &key_wrap_aad(label),
        );
        assert!(wrap_only.is_err(), "content layer opened without its AAD");
        let content_only = encryption::open_multi_reader(
            &sealed.encrypted_content,
            &sealed.reader_envelopes,
            &[&pk],
            &sk,
            label,
            &content_aad(label),
            &[],
        );
        assert!(content_only.is_err(), "key wrap opened without its AAD");
    }

    #[test]
    fn readers_are_deduplicated_and_must_be_present() {
        let (_, pk) = keypair(0x66);
        let upper = pk.to_uppercase();
        let sealed = seal(CasePurpose::Comment, "x", &[pk.clone(), upper]).unwrap();
        assert_eq!(sealed.reader_envelopes.len(), 1);
        assert_eq!(sealed.reader_envelopes[0].pubkey, pk);
        assert!(seal(CasePurpose::Comment, "x", &[]).is_err());
        assert!(seal(CasePurpose::Comment, "x", &["abcd".into()]).is_err());
    }

    #[test]
    fn the_device_is_always_a_reader_and_its_account_key_is_not_sealed_to() {
        let secrets = DeviceSecrets {
            signing_seed: [7u8; 32],
            encryption_seed: [8u8; 32],
        };
        let device = DeviceKeyState {
            device_id: "d".into(),
            signing_pubkey_hex: hex::encode(secrets.signing_pubkey().to_bytes()),
            encryption_pubkey_hex: hex::encode(secrets.encryption_pubkey().to_bytes()),
        };
        let (other_sk, other_pk) = keypair(0x77);
        let sealed = seal_as_device(
            CasePurpose::Summary,
            &device,
            "mine",
            &[device.signing_pubkey_hex.clone(), other_pk.clone()],
        )
        .unwrap();
        let addresses: Vec<&str> = sealed
            .reader_envelopes
            .iter()
            .map(|e| e.pubkey.as_str())
            .collect();
        assert_eq!(
            addresses,
            vec![device.encryption_pubkey_hex.as_str(), other_pk.as_str()]
        );
        assert_eq!(
            open_as_device(
                CasePurpose::Summary,
                &secrets,
                &device,
                &sealed.encrypted_content,
                &sealed.reader_envelopes,
            )
            .unwrap(),
            "mine"
        );
        assert_eq!(
            open(
                CasePurpose::Summary,
                &sealed.encrypted_content,
                &sealed.reader_envelopes,
                &other_pk,
                &other_sk,
            )
            .unwrap(),
            "mine"
        );
    }

    #[test]
    fn the_purpose_byte_mapping_is_closed() {
        for purpose in CasePurpose::ALL {
            assert_eq!(CasePurpose::from_u8(purpose as u8).unwrap(), purpose);
        }
        assert!(CasePurpose::from_u8(3).is_err());
    }
}
