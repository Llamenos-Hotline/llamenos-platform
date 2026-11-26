//! The shape API (spec D1): every HPKE envelope a host seals or opens is named
//! by its **shape**, and the crate supplies the label, the HPKE `info` and the
//! AAD.
//!
//! Before this module, every platform called `hpke_seal(label, aad)` and
//! composed the label and AAD at its own call sites, and each platform rebuilt
//! a `{v: 3, labelId, enc, ct}` envelope around the hex `{enc, ct}` it had
//! stored — so the explicit label check compared the expected label with
//! itself, and the real defence was always HPKE `info`. That is the #2771
//! finding. Now no host can name a label, an AAD, or a `labelId`:
//!
//! ```text
//! seal_to(recipient_pk, shape, aad_fields, plaintext)  -> {enc, ct}
//! open_from(secret,    shape, aad_fields, envelope)    -> plaintext
//! content_seal(shape, plaintext) -> (packed, key)   // the shape's content layer
//! content_open(shape, packed, key) -> plaintext
//! ```
//!
//! `aad_fields` carries the per-record values a shape binds (a device id, a role
//! id, a recovery session). Each shape declares how many it takes; a wrong count,
//! an empty field, or a field containing `:` (the format-1 separator) is refused.
//!
//! The AAD bytes of every shape here are the **format-1** bytes the pilot already
//! stores (`crate::envelope_aad`, and the per-module formats they mirror), so this
//! changes no ciphertext on the wire — only who is allowed to choose it. Format-2
//! (v2 header) shapes are a stage-2 concern (#2961) and are not in this enum yet.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::encryption::{aes256gcm_decrypt, aes256gcm_encrypt, random_bytes_32};
use crate::envelope_aad::{content_aad, key_wrap_aad};
use crate::errors::CryptoError;
use crate::hpke_envelope::{self, HpkeEnvelope};
use crate::labels::*;

/// What an HPKE envelope is. Closed: a host names one of these and nothing else.
///
/// Carried as a UniFFI enum (Swift/Kotlin), a kebab-case string on the Tauri IPC
/// (`"note-key"`), and a byte on the server's C ABI ([`Shape::from_u8`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "mobile", derive(uniffi::Enum))]
#[repr(u8)]
pub enum Shape {
    /// A note's per-note content key.
    NoteKey = 0,
    /// A file's content key.
    FileKey = 1,
    /// A file's metadata key.
    FileMetadataKey = 2,
    /// A contact's profile-tier key.
    ContactProfileKey = 3,
    /// A contact's identifier-tier key.
    ContactIdKey = 4,
    /// A hub key wrapped to a member.
    HubKey = 5,
    /// A firehose buffer window key wrapped to the agent.
    FirehoseWindowKey = 6,
    /// A stored message's content key (no AAD: client- and server-sealed messages
    /// share a conversation with no format marker, see `crate::envelope_aad`).
    MessageKey = 7,
    /// A call record's metadata content key (no AAD, same reason).
    CallMetaKey = 8,
    /// A PUK seed sealed to one device. Field: the device id.
    PukSeed = 9,
    /// A per-user audit key wrapped to an admin. Field: the audited user's pubkey.
    AuditUserKey = 10,
    /// A wake-tier push payload (text).
    PushWake = 11,
    /// A full-tier push payload (text).
    PushFull = 12,
    /// A platform role's name (text). Field: the role id.
    PlatformRoleName = 13,
    /// A platform role's description (text). Field: the role id.
    PlatformRoleDescription = 14,
    /// A recovery share sealed to its holder's device.
    RecoveryGroupShare = 15,
    /// A recovery share contributed back to an admin. Fields: the recovery
    /// session id, then the contributing device's signing pubkey.
    RecoveryShareContribution = 16,
    /// A PUK seed sealed to a recovery group's public key.
    RecoveryPukSeed = 17,
}

/// What the plaintext of a shape is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Payload {
    /// Exactly 32 bytes (a key or seed); `ct` is exactly 48 bytes.
    Key,
    /// Any length.
    Bytes,
}

impl Shape {
    /// Every shape, for exhaustive tests and vectors.
    pub const ALL: [Shape; 18] = [
        Self::NoteKey,
        Self::FileKey,
        Self::FileMetadataKey,
        Self::ContactProfileKey,
        Self::ContactIdKey,
        Self::HubKey,
        Self::FirehoseWindowKey,
        Self::MessageKey,
        Self::CallMetaKey,
        Self::PukSeed,
        Self::AuditUserKey,
        Self::PushWake,
        Self::PushFull,
        Self::PlatformRoleName,
        Self::PlatformRoleDescription,
        Self::RecoveryGroupShare,
        Self::RecoveryShareContribution,
        Self::RecoveryPukSeed,
    ];

    /// The label this shape seals under (HPKE `info`). Crate-private: no host
    /// needs it, and exposing it would invite composing it again by hand.
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::NoteKey => LABEL_NOTE_KEY,
            Self::FileKey => LABEL_FILE_KEY,
            Self::FileMetadataKey => LABEL_FILE_METADATA,
            Self::ContactProfileKey => LABEL_CONTACT_PROFILE,
            Self::ContactIdKey => LABEL_CONTACT_ID,
            Self::HubKey => LABEL_HUB_KEY_WRAP,
            Self::FirehoseWindowKey => LABEL_FIREHOSE_BUFFER_ENCRYPT,
            Self::MessageKey => LABEL_MESSAGE,
            Self::CallMetaKey => LABEL_CALL_META,
            Self::PukSeed => LABEL_PUK_WRAP_TO_DEVICE,
            Self::AuditUserKey => LABEL_AUDIT_USER_KEY_WRAP,
            Self::PushWake => LABEL_PUSH_WAKE,
            Self::PushFull => LABEL_PUSH_FULL,
            Self::PlatformRoleName => LABEL_PLATFORM_ROLE_NAME_ENCRYPT,
            Self::PlatformRoleDescription => LABEL_PLATFORM_ROLE_DESC_ENCRYPT,
            Self::RecoveryGroupShare => LABEL_RECOVERY_GROUP_SHARE_WRAP,
            Self::RecoveryShareContribution => LABEL_RECOVERY_SHARE_CONTRIBUTE,
            Self::RecoveryPukSeed => LABEL_RECOVERY_PUK_SEED_WRAP,
        }
    }

    /// What the plaintext is.
    pub const fn payload(self) -> Payload {
        match self {
            Self::PushWake
            | Self::PushFull
            | Self::PlatformRoleName
            | Self::PlatformRoleDescription
            | Self::RecoveryGroupShare
            | Self::RecoveryShareContribution => Payload::Bytes,
            _ => Payload::Key,
        }
    }

    /// How many `aad_fields` the shape binds.
    pub const fn arity(self) -> usize {
        match self {
            Self::PukSeed
            | Self::AuditUserKey
            | Self::PlatformRoleName
            | Self::PlatformRoleDescription => 1,
            Self::RecoveryShareContribution => 2,
            _ => 0,
        }
    }

    /// Whether the shape has a content layer (AES-256-GCM under the wrapped key),
    /// and its content AAD if so.
    pub(crate) fn content_aad(self) -> Option<Vec<u8>> {
        match self {
            Self::NoteKey
            | Self::FileKey
            | Self::FileMetadataKey
            | Self::ContactProfileKey
            | Self::ContactIdKey
            | Self::FirehoseWindowKey => Some(content_aad(self.label())),
            Self::MessageKey | Self::CallMetaKey => Some(Vec::new()),
            _ => None,
        }
    }

    /// The HPKE AAD for this shape and its fields — the format-1 bytes.
    pub(crate) fn wrap_aad(self, fields: &[String]) -> Result<Vec<u8>, CryptoError> {
        check_fields(self, fields)?;
        let label = self.label();
        Ok(match self {
            Self::NoteKey
            | Self::FileKey
            | Self::FileMetadataKey
            | Self::ContactProfileKey
            | Self::ContactIdKey
            | Self::HubKey
            | Self::FirehoseWindowKey => key_wrap_aad(label),
            Self::MessageKey
            | Self::CallMetaKey
            | Self::RecoveryGroupShare
            | Self::RecoveryPukSeed => Vec::new(),
            Self::PukSeed | Self::AuditUserKey => format!("{label}:{}", fields[0]).into_bytes(),
            Self::PushWake | Self::PushFull => format!("{label}:push").into_bytes(),
            Self::PlatformRoleName => format!("{}:name", fields[0]).into_bytes(),
            Self::PlatformRoleDescription => format!("{}:description", fields[0]).into_bytes(),
            Self::RecoveryShareContribution => format!("{}:{}", fields[0], fields[1]).into_bytes(),
        })
    }

    /// Decode the server C ABI's shape byte.
    pub fn from_u8(value: u8) -> Result<Self, CryptoError> {
        Self::ALL
            .iter()
            .copied()
            .find(|s| *s as u8 == value)
            .ok_or_else(|| CryptoError::InvalidInput(format!("unknown shape byte: {value}")))
    }
}

fn check_fields(shape: Shape, fields: &[String]) -> Result<(), CryptoError> {
    if fields.len() != shape.arity() {
        return Err(CryptoError::InvalidInput(format!(
            "{shape:?} binds {} AAD field(s), got {}",
            shape.arity(),
            fields.len()
        )));
    }
    for f in fields {
        if f.is_empty() || f.contains(':') {
            return Err(CryptoError::InvalidInput(format!(
                "{shape:?} AAD field must be non-empty and contain no ':'"
            )));
        }
    }
    Ok(())
}

fn check_plaintext(shape: Shape, plaintext: &[u8]) -> Result<(), CryptoError> {
    if shape.payload() == Payload::Key && plaintext.len() != 32 {
        return Err(CryptoError::InvalidInput(format!(
            "{shape:?} seals a 32-byte key, got {} bytes",
            plaintext.len()
        )));
    }
    Ok(())
}

// ── HPKE layer ───────────────────────────────────────────────────────

/// Seal `plaintext` as `shape` to `recipient_pubkey_hex` (X25519, lowercase hex).
pub fn seal_to(
    recipient_pubkey_hex: &str,
    shape: Shape,
    aad_fields: &[String],
    plaintext: &[u8],
) -> Result<HpkeEnvelope, CryptoError> {
    seal_to_with_rng(
        recipient_pubkey_hex,
        shape,
        aad_fields,
        plaintext,
        &mut hpke_envelope::OsRng09,
    )
}

/// [`seal_to`] with an explicit RNG (vectors only use a seeded one).
pub(crate) fn seal_to_with_rng<R>(
    recipient_pubkey_hex: &str,
    shape: Shape,
    aad_fields: &[String],
    plaintext: &[u8],
    rng: &mut R,
) -> Result<HpkeEnvelope, CryptoError>
where
    R: hpke::rand_core::CryptoRng + hpke::rand_core::RngCore,
{
    check_plaintext(shape, plaintext)?;
    let aad = shape.wrap_aad(aad_fields)?;
    hpke_envelope::hpke_seal_with_rng(plaintext, recipient_pubkey_hex, shape.label(), &aad, rng)
}

/// Open `envelope` as `shape` with the recipient's X25519 secret (raw bytes).
pub fn open_from(
    recipient_secret: &[u8; 32],
    shape: Shape,
    aad_fields: &[String],
    envelope: &HpkeEnvelope,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let aad = shape.wrap_aad(aad_fields)?;
    if shape.payload() == Payload::Key {
        hpke_envelope::decode_hex_exact("ct", &envelope.ct, hpke_envelope::KEY_WRAP_CT_LEN)?;
    }
    let plaintext = Zeroizing::new(hpke_envelope::hpke_open_bytes(
        envelope,
        recipient_secret,
        shape.label(),
        &aad,
    )?);
    if shape.payload() == Payload::Key && plaintext.len() != 32 {
        return Err(CryptoError::DecryptionFailed);
    }
    Ok(plaintext)
}

/// [`open_from`] for a key shape, returning the 32-byte key.
pub fn open_key_from(
    recipient_secret: &[u8; 32],
    shape: Shape,
    aad_fields: &[String],
    envelope: &HpkeEnvelope,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if shape.payload() != Payload::Key {
        return Err(CryptoError::InvalidInput(format!(
            "{shape:?} does not carry a key"
        )));
    }
    let pt = open_from(recipient_secret, shape, aad_fields, envelope)?;
    hpke_envelope::to_key(&pt)
}

/// [`open_from`] with the secret as lowercase hex.
pub fn open_from_hex(
    recipient_secret_hex: &str,
    shape: Shape,
    aad_fields: &[String],
    envelope: &HpkeEnvelope,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let secret = crate::encryption::secret_from_hex(recipient_secret_hex)?;
    open_from(&secret, shape, aad_fields, envelope)
}

// ── Content layer ────────────────────────────────────────────────────

/// A content ciphertext and the fresh key that seals it. The key is what the
/// shape's HPKE layer wraps, one envelope per reader.
pub struct SealedContent {
    /// `nonce(12) ‖ AES-256-GCM(key, plaintext, content AAD) ‖ tag(16)`
    pub packed: Vec<u8>,
    /// The fresh 32-byte content key.
    pub key: Zeroizing<[u8; 32]>,
}

fn require_content(shape: Shape) -> Result<Vec<u8>, CryptoError> {
    shape
        .content_aad()
        .ok_or_else(|| CryptoError::InvalidInput(format!("{shape:?} has no content layer")))
}

/// Seal `plaintext` under a fresh key with `shape`'s content AAD.
pub fn content_seal(shape: Shape, plaintext: &[u8]) -> Result<SealedContent, CryptoError> {
    let aad = require_content(shape)?;
    let key = Zeroizing::new(random_bytes_32());
    let packed = aes256gcm_encrypt(&key, plaintext, &aad)?;
    Ok(SealedContent { packed, key })
}

/// Seal `plaintext` with `shape`'s content AAD under an existing key — for the
/// one shape whose key outlives a single item (the firehose buffer window key,
/// which seals every message buffered in its window). Every other shape takes a
/// fresh key per item through [`content_seal`].
pub fn content_seal_under(
    shape: Shape,
    key: &[u8; 32],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if shape != Shape::FirehoseWindowKey {
        return Err(CryptoError::InvalidInput(format!(
            "{shape:?} takes a fresh key per item; use content_seal"
        )));
    }
    let aad = require_content(shape)?;
    aes256gcm_encrypt(key, plaintext, &aad)
}

/// Open a content ciphertext of `shape` with its key.
pub fn content_open(
    shape: Shape,
    packed: &[u8],
    key: &[u8; 32],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let aad = require_content(shape)?;
    Ok(Zeroizing::new(aes256gcm_decrypt(key, packed, &aad)?))
}

/// The content AAD of `shape`, for the one host that runs the content layer
/// outside Rust: the desktop webview, which AES-GCM-opens file bytes with
/// WebCrypto under a per-item key. The host never builds this value.
pub fn content_aad_of(shape: Shape) -> Result<Vec<u8>, CryptoError> {
    require_content(shape)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hpke_envelope::generate_x25519_keypair;

    fn kp() -> ([u8; 32], String) {
        let (sk, pk) = generate_x25519_keypair();
        let mut s = [0u8; 32];
        s.copy_from_slice(&hex::decode(sk.as_str()).unwrap());
        (s, pk)
    }

    fn fields(shape: Shape) -> Vec<String> {
        (0..shape.arity()).map(|i| format!("f{i}")).collect()
    }

    #[test]
    fn every_shape_roundtrips_and_no_two_shapes_cross_open() {
        let (sk, pk) = kp();
        for a in Shape::ALL {
            let env = seal_to(&pk, a, &fields(a), &[9u8; 32]).unwrap();
            assert_eq!(&*open_from(&sk, a, &fields(a), &env).unwrap(), &[9u8; 32]);
            for b in Shape::ALL {
                if a == b {
                    continue;
                }
                let r = open_from(&sk, b, &fields(b), &env);
                assert!(r.is_err(), "{a:?} opened as {b:?}");
            }
        }
    }

    #[test]
    fn labels_are_registered_and_distinct() {
        let mut seen = std::collections::HashSet::new();
        for s in Shape::ALL {
            assert!(label_to_id(s.label()).is_some(), "{s:?}");
            assert!(seen.insert(s.label()), "{s:?} shares a label");
            assert_eq!(Shape::from_u8(s as u8).unwrap(), s);
        }
        assert!(Shape::from_u8(Shape::ALL.len() as u8).is_err());
    }

    #[test]
    fn fields_are_checked() {
        let (_sk, pk) = kp();
        assert!(seal_to(&pk, Shape::PukSeed, &[], &[0; 32]).is_err());
        assert!(seal_to(&pk, Shape::PukSeed, &["a:b".into()], &[0; 32]).is_err());
        assert!(seal_to(&pk, Shape::PukSeed, &["".into()], &[0; 32]).is_err());
        assert!(seal_to(&pk, Shape::NoteKey, &["x".into()], &[0; 32]).is_err());
        assert!(seal_to(&pk, Shape::NoteKey, &[], &[0; 31]).is_err());
    }

    #[test]
    fn a_field_is_bound() {
        let (sk, pk) = kp();
        let env = seal_to(&pk, Shape::PukSeed, &["dev-a".into()], &[1; 32]).unwrap();
        assert!(matches!(
            open_from(&sk, Shape::PukSeed, &["dev-b".into()], &env),
            Err(CryptoError::DecryptionFailed)
        ));
    }

    /// The AAD bytes are the format-1 bytes already on the pilot.
    #[test]
    fn aads_are_the_format_1_bytes() {
        // Spelled out, not built from the label: these are the pilot's bytes.
        let aad = b"llamenos:note-key:key-wrap";
        assert_eq!(Shape::NoteKey.wrap_aad(&[]).unwrap(), aad.to_vec());
        assert!(Shape::MessageKey.wrap_aad(&[]).unwrap().is_empty());
        assert_eq!(
            Shape::PlatformRoleName.wrap_aad(&["r1".into()]).unwrap(),
            b"r1:name".to_vec()
        );
        assert_eq!(
            Shape::PukSeed.wrap_aad(&["d1".into()]).unwrap(),
            format!("{LABEL_PUK_WRAP_TO_DEVICE}:d1").into_bytes()
        );
        assert_eq!(
            Shape::NoteKey.content_aad().unwrap(),
            LABEL_NOTE_KEY.as_bytes()
        );
        assert_eq!(Shape::MessageKey.content_aad().unwrap(), Vec::<u8>::new());
        assert!(Shape::HubKey.content_aad().is_none());
    }

    #[test]
    fn content_layer_roundtrips_and_binds_its_shape() {
        let sealed = content_seal(Shape::NoteKey, b"hello").unwrap();
        assert_eq!(
            &*content_open(Shape::NoteKey, &sealed.packed, &sealed.key).unwrap(),
            b"hello"
        );
        assert!(content_open(Shape::FileKey, &sealed.packed, &sealed.key).is_err());
        assert!(content_seal(Shape::HubKey, b"x").is_err());
        let window = [3u8; 32];
        let packed = content_seal_under(Shape::FirehoseWindowKey, &window, b"buffered").unwrap();
        assert_eq!(
            &*content_open(Shape::FirehoseWindowKey, &packed, &window).unwrap(),
            b"buffered"
        );
        assert!(content_seal_under(Shape::NoteKey, &window, b"x").is_err());
    }
}
