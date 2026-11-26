//! HPKE envelope encryption — RFC 9180, and the one envelope wire shape (D1, D2).
//!
//! Wire format (spec `2026-11-24-encryption-v2-wire-format.md` §1.2–§1.3):
//! ```json
//! { "enc": "<lowercase hex — HPKE encapsulated key>", "ct": "<lowercase hex — AEAD ciphertext>" }
//! ```
//!
//! There is no `v` and no `labelId`. The label is a property of the *shape* of
//! what is sealed (`crate::shape::Shape`), and the crate supplies it; no host
//! names a label or an AAD. The label is bound as HPKE `info` on seal and on
//! open, so an envelope opened under the wrong shape fails the AEAD with the
//! same opaque `DecryptionFailed` as a wrong key — there is no separate,
//! earlier label check to bypass or to leak through timing.
//!
//! Every byte string is **lowercase hex, length-checked**. Uppercase, base64url,
//! odd lengths and wrong lengths are `InvalidFormat` at the boundary, never
//! normalised (#1649).
//!
//! HPKE parameters:
//! - Mode: Base (anonymous sender)
//! - KEM: DHKEM(X25519, HKDF-SHA256) — KEM ID 0x0020
//! - KDF: HKDF-SHA256 — KDF ID 0x0001
//! - AEAD: AES-256-GCM — AEAD ID 0x0002
//! - `info`: UTF-8 label string, chosen by the shape
//! - `aad`: built by the shape from its fields

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use hpke::aead::AesGcm256;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, Kem as KemTrait, OpModeR, OpModeS, Serializable};

use crate::errors::CryptoError;
use crate::labels::label_to_id;

// Type aliases for our HPKE suite
type Aead = AesGcm256;
type Kdf = HkdfSha256;
type Kem = X25519HkdfSha256;

/// The KEM id this suite registers in RFC 9180 (DHKEM(X25519, HKDF-SHA256)).
pub const KEM_ID: u16 = 0x0020;
/// Encapsulated key length under X25519.
pub const ENC_LEN: usize = 32;
/// AEAD tag length (AES-256-GCM).
pub const TAG_LEN: usize = 16;
/// `ct` of a 32-byte key wrap: key + tag.
pub const KEY_WRAP_CT_LEN: usize = 32 + TAG_LEN;

/// Bridge getrandom 0.2 to hpke's rand_core 0.9 interface.
/// The hpke crate v0.13 uses rand_core 0.9, while the rest of this crate
/// uses getrandom 0.2. This adapter bridges them without adding rand 0.9.
pub struct OsRng09;

impl hpke::rand_core::RngCore for OsRng09 {
    fn next_u32(&mut self) -> u32 {
        let mut buf = [0u8; 4];
        getrandom::getrandom(&mut buf).expect("getrandom failed");
        u32::from_le_bytes(buf)
    }
    fn next_u64(&mut self) -> u64 {
        let mut buf = [0u8; 8];
        getrandom::getrandom(&mut buf).expect("getrandom failed");
        u64::from_le_bytes(buf)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        getrandom::getrandom(dest).expect("getrandom failed");
    }
}
impl hpke::rand_core::CryptoRng for OsRng09 {}

/// The one HPKE envelope: `{enc, ct}`, both lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct HpkeEnvelope {
    /// Lowercase hex: the HPKE encapsulated key (32 bytes under X25519).
    pub enc: String,
    /// Lowercase hex: the AEAD ciphertext, tag included.
    pub ct: String,
}

// ── Strict lowercase-hex decoding (D2) ───────────────────────────────

/// True iff `s` is non-empty-or-empty lowercase hex of even length.
pub fn is_lower_hex(s: &str) -> bool {
    s.len().is_multiple_of(2)
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Decode `value` as exactly `n` bytes of lowercase hex. Anything else —
/// uppercase, base64url, odd or wrong length — is `InvalidFormat`.
pub fn decode_hex_exact(field: &str, value: &str, n: usize) -> Result<Vec<u8>, CryptoError> {
    if value.len() != 2 * n || !is_lower_hex(value) {
        return Err(CryptoError::InvalidFormat(format!(
            "{field} must be {n} bytes of lowercase hex ({} characters)",
            2 * n
        )));
    }
    hex::decode(value).map_err(|e| CryptoError::InvalidFormat(format!("{field}: {e}")))
}

/// Decode `value` as at least `min` bytes of lowercase hex.
pub fn decode_hex_min(field: &str, value: &str, min: usize) -> Result<Vec<u8>, CryptoError> {
    if value.len() < 2 * min || !is_lower_hex(value) {
        return Err(CryptoError::InvalidFormat(format!(
            "{field} must be at least {min} bytes of lowercase hex"
        )));
    }
    hex::decode(value).map_err(|e| CryptoError::InvalidFormat(format!("{field}: {e}")))
}

/// Decode a 32-byte X25519 public key (lowercase hex).
fn decode_recipient_pk(pk_hex: &str) -> Result<<Kem as KemTrait>::PublicKey, CryptoError> {
    let bytes = decode_hex_exact("recipient public key", pk_hex, 32)
        .map_err(|_| CryptoError::InvalidPublicKey)?;
    <Kem as KemTrait>::PublicKey::from_bytes(&bytes).map_err(|_| CryptoError::InvalidPublicKey)
}

// ── Seal / open (crate-internal: hosts reach these only through a Shape) ──

/// Seal `plaintext` to `recipient_pubkey_hex` with HPKE `info = label`.
///
/// Crate-internal: the label and AAD are decided by `crate::shape`, or by a
/// crate module that owns its format (PUK, audit, provisioning, backup).
pub(crate) fn hpke_seal(
    plaintext: &[u8],
    recipient_pubkey_hex: &str,
    label: &str,
    aad: &[u8],
) -> Result<HpkeEnvelope, CryptoError> {
    hpke_seal_with_rng(plaintext, recipient_pubkey_hex, label, aad, &mut OsRng09)
}

/// [`hpke_seal`] with an explicit RNG, so the cross-platform vectors can be
/// generated from a fixed seed (D15). Production callers use [`OsRng09`].
pub(crate) fn hpke_seal_with_rng<R>(
    plaintext: &[u8],
    recipient_pubkey_hex: &str,
    label: &str,
    aad: &[u8],
    rng: &mut R,
) -> Result<HpkeEnvelope, CryptoError>
where
    R: hpke::rand_core::CryptoRng + hpke::rand_core::RngCore,
{
    if label_to_id(label).is_none() {
        return Err(CryptoError::InvalidInput(format!(
            "unknown crypto label: {label}"
        )));
    }
    let recipient_pk = decode_recipient_pk(recipient_pubkey_hex)?;
    let (enc, ciphertext) = hpke::single_shot_seal::<Aead, Kdf, Kem, _>(
        &OpModeS::Base,
        &recipient_pk,
        label.as_bytes(),
        plaintext,
        aad,
        rng,
    )
    .map_err(|e| CryptoError::EncryptionFailed(format!("HPKE seal failed: {e:?}")))?;

    Ok(HpkeEnvelope {
        enc: hex::encode(enc.to_bytes()),
        ct: hex::encode(ciphertext),
    })
}

/// Open an envelope sealed by [`hpke_seal`] under `label`.
///
/// Encoding faults are `InvalidFormat` (they are visible on the wire anyway);
/// every failure past decoding — wrong label, key, AAD or tampered bytes — is
/// the same opaque `DecryptionFailed`.
pub(crate) fn hpke_open(
    envelope: &HpkeEnvelope,
    recipient_secret_hex: &str,
    label: &str,
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let sk_bytes = Zeroizing::new(
        decode_hex_exact("recipient secret key", recipient_secret_hex, 32)
            .map_err(|_| CryptoError::InvalidSecretKey)?,
    );
    hpke_open_bytes(envelope, &sk_bytes, label, aad)
}

/// [`hpke_open`] with the secret as raw bytes.
pub(crate) fn hpke_open_bytes(
    envelope: &HpkeEnvelope,
    recipient_secret: &[u8],
    label: &str,
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let enc_bytes = decode_hex_exact("enc", &envelope.enc, ENC_LEN)?;
    let ciphertext = decode_hex_min("ct", &envelope.ct, TAG_LEN)?;

    let sk = <Kem as KemTrait>::PrivateKey::from_bytes(recipient_secret)
        .map_err(|_| CryptoError::DecryptionFailed)?;
    let encapped_key = <Kem as KemTrait>::EncappedKey::from_bytes(&enc_bytes)
        .map_err(|_| CryptoError::InvalidFormat("enc is not a valid X25519 point".into()))?;

    hpke::single_shot_open::<Aead, Kdf, Kem>(
        &OpModeR::Base,
        &sk,
        &encapped_key,
        label.as_bytes(),
        &ciphertext,
        aad,
    )
    .map_err(|_| CryptoError::DecryptionFailed)
}

/// Seal a 32-byte key. The `ct` is always [`KEY_WRAP_CT_LEN`] bytes.
pub(crate) fn hpke_seal_key(
    key: &[u8; 32],
    recipient_pubkey_hex: &str,
    label: &str,
    aad: &[u8],
) -> Result<HpkeEnvelope, CryptoError> {
    hpke_seal(key, recipient_pubkey_hex, label, aad)
}

/// Open a 32-byte key wrap. A `ct` of any length but [`KEY_WRAP_CT_LEN`] is
/// `InvalidFormat` before HPKE runs.
pub(crate) fn hpke_open_key(
    envelope: &HpkeEnvelope,
    recipient_secret_hex: &str,
    label: &str,
    aad: &[u8],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    decode_hex_exact("ct", &envelope.ct, KEY_WRAP_CT_LEN)?;
    let plaintext = Zeroizing::new(hpke_open(envelope, recipient_secret_hex, label, aad)?);
    to_key(&plaintext)
}

/// A decrypted key-wrap plaintext as a 32-byte key.
pub(crate) fn to_key(plaintext: &[u8]) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if plaintext.len() != 32 {
        return Err(CryptoError::InvalidFormat(format!(
            "expected 32-byte key, got {} bytes",
            plaintext.len()
        )));
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(plaintext);
    Ok(key)
}

/// Generate an X25519 keypair for HPKE operations.
///
/// Returns (secret_key_hex, public_key_hex).
pub fn generate_x25519_keypair() -> (Zeroizing<String>, String) {
    let mut rng = OsRng09;
    let (sk, pk) = Kem::gen_keypair(&mut rng);
    let sk_hex = Zeroizing::new(hex::encode(sk.to_bytes()));
    let pk_hex = hex::encode(pk.to_bytes());
    (sk_hex, pk_hex)
}

/// The X25519 public key of a 32-byte secret, as lowercase hex (vectors).
#[cfg(test)]
pub(crate) fn x25519_public_hex(secret: &[u8; 32]) -> String {
    let sk = x25519_dalek::StaticSecret::from(*secret);
    hex::encode(x25519_dalek::PublicKey::from(&sk).as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::labels::{LABEL_FILE_KEY, LABEL_NOTE_KEY};

    fn gen_keypair() -> (Zeroizing<String>, String) {
        generate_x25519_keypair()
    }

    #[test]
    fn roundtrip_seal_open_is_lowercase_hex() {
        let (sk_hex, pk_hex) = gen_keypair();
        let aad = b"aad";
        let envelope = hpke_seal(b"secret", &pk_hex, LABEL_NOTE_KEY, aad).unwrap();
        assert_eq!(envelope.enc.len(), 2 * ENC_LEN);
        assert!(is_lower_hex(&envelope.enc) && is_lower_hex(&envelope.ct));
        assert_eq!(
            hpke_open(&envelope, &sk_hex, LABEL_NOTE_KEY, aad).unwrap(),
            b"secret"
        );
    }

    #[test]
    fn wrong_label_key_aad_and_tamper_are_all_decryption_failed() {
        let (sk_hex, pk_hex) = gen_keypair();
        let (wrong_sk, _) = gen_keypair();
        let envelope = hpke_seal(b"test", &pk_hex, LABEL_NOTE_KEY, b"aad").unwrap();
        let mut tampered = envelope.clone();
        let mut ct = hex::decode(&tampered.ct).unwrap();
        ct[0] ^= 1;
        tampered.ct = hex::encode(ct);
        for result in [
            hpke_open(&envelope, &sk_hex, LABEL_FILE_KEY, b"aad"),
            hpke_open(&envelope, &wrong_sk, LABEL_NOTE_KEY, b"aad"),
            hpke_open(&envelope, &sk_hex, LABEL_NOTE_KEY, b"other"),
            hpke_open(&tampered, &sk_hex, LABEL_NOTE_KEY, b"aad"),
        ] {
            assert!(
                matches!(result, Err(CryptoError::DecryptionFailed)),
                "{result:?}"
            );
        }
    }

    #[test]
    fn encoding_faults_are_invalid_format_never_normalised() {
        let (sk_hex, pk_hex) = gen_keypair();
        let envelope = hpke_seal_key(&[7u8; 32], &pk_hex, LABEL_NOTE_KEY, b"a").unwrap();
        let b64 = {
            use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
            URL_SAFE_NO_PAD.encode(hex::decode(&envelope.enc).unwrap())
        };
        let cases = [
            HpkeEnvelope {
                enc: envelope.enc.to_uppercase(),
                ct: envelope.ct.clone(),
            },
            HpkeEnvelope {
                enc: envelope.enc.clone(),
                ct: envelope.ct.to_uppercase(),
            },
            HpkeEnvelope {
                enc: b64,
                ct: envelope.ct.clone(),
            },
            HpkeEnvelope {
                enc: envelope.enc.clone(),
                ct: format!("{}00", envelope.ct),
            },
            HpkeEnvelope {
                enc: envelope.enc[..62].into(),
                ct: envelope.ct.clone(),
            },
        ];
        for bad in cases {
            let result = hpke_open_key(&bad, &sk_hex, LABEL_NOTE_KEY, b"a");
            assert!(
                matches!(result, Err(CryptoError::InvalidFormat(_))),
                "{bad:?}: {result:?}"
            );
        }
        assert!(hpke_open_key(&envelope, &sk_hex, LABEL_NOTE_KEY, b"a").is_ok());
    }

    #[test]
    fn key_wrap_ct_is_48_bytes() {
        let (_sk, pk_hex) = gen_keypair();
        let envelope = hpke_seal_key(&[1u8; 32], &pk_hex, LABEL_NOTE_KEY, b"").unwrap();
        assert_eq!(envelope.ct.len(), 2 * KEY_WRAP_CT_LEN);
    }

    #[test]
    fn unknown_label_and_bad_pubkey_rejected() {
        let (_sk_hex, pk_hex) = gen_keypair();
        assert!(matches!(
            hpke_seal(b"t", &pk_hex, "unknown:label", b""),
            Err(CryptoError::InvalidInput(_))
        ));
        assert!(matches!(
            hpke_seal(b"t", &pk_hex.to_uppercase(), LABEL_NOTE_KEY, b""),
            Err(CryptoError::InvalidPublicKey)
        ));
        assert!(hpke_seal(b"t", "deadbeef", LABEL_NOTE_KEY, b"").is_err());
    }
}
