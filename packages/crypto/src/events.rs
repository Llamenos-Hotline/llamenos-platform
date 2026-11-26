//! The one relay-events format (spec D9, with #2999).
//!
//! The server seals every relay frame; clients open it. Both run this module —
//! the server through `ffi_server`, clients through UniFFI or the desktop
//! Tauri state — so the key derivation, the AAD and the padding are composed
//! exactly once.
//!
//! ```text
//! epoch   = floor(unix_seconds / 86400)
//! key     = HKDF-SHA256(ikm  = SERVER_SECRET,
//!                       salt = utf8(L_SERVER_EVENT_ENCRYPTION_KEY),
//!                       info = lp(utf8(L_SERVER_EVENT_ENCRYPTION_KEY_INFO)) ‖ lp(utf8(hub_id)) ‖ u64be(epoch),
//!                       32)
//! aad     = lp(utf8(L_HUB_EVENT_EPOCH)) ‖ lp(utf8(hub_id)) ‖ u32be(kind) ‖ u64be(epoch)
//! payload = hex(nonce(12) ‖ AES-256-GCM(key, nonce, pad_to_bucket(utf8(json)), aad))
//! lp(b)   = u16be(len(b)) ‖ b
//! ```
//!
//! **Per hub (#2999).** The key is derived per `(hub, epoch)`, and a client is
//! handed only the keys of hubs it belongs to, so a member of hub A cannot open
//! hub B's frames. The AAD binds the hub and the event kind, so a frame moved
//! into another hub's stream, presented as another kind, or replayed into
//! another epoch fails to open.
//!
//! **No hub-key event format.** Events are sealed only by the server; the older
//! hub-key event format had no producer and its readers were deleted (D9).
//!
//! Clients hold their keys in crate state ([`EventKeyring`]); no host passes an
//! event key into an open call.

use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::encryption::{aes256gcm_decrypt, aes256gcm_encrypt_with_nonce};
use crate::errors::CryptoError;
use crate::hpke_envelope::{decode_hex_exact, decode_hex_min};
use crate::id_profile::check_id;
use crate::labels::{
    LABEL_HUB_EVENT_EPOCH, LABEL_SERVER_EVENT_ENCRYPTION_KEY,
    LABEL_SERVER_EVENT_ENCRYPTION_KEY_INFO,
};

/// One epoch is one UTC day.
pub const EVENT_EPOCH_SECONDS: u64 = 86_400;

/// The epoch a unix timestamp falls in.
pub const fn epoch_of(unix_seconds: u64) -> u64 {
    unix_seconds / EVENT_EPOCH_SECONDS
}

/// nonce(12) + tag(16) + the smallest padding bucket (512).
const MIN_PAYLOAD_BYTES: usize = 12 + 16 + 512;

fn lp(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), CryptoError> {
    let len = u16::try_from(bytes.len())
        .map_err(|_| CryptoError::InvalidInput("length-prefixed field over 65535 bytes".into()))?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

/// Derive the relay-event key of `hub_id` for `epoch` from the server secret.
pub fn derive_server_event_key(
    server_secret: &[u8],
    hub_id: &str,
    epoch: u64,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if server_secret.len() < 32 {
        return Err(CryptoError::InvalidInput(
            "server secret must be at least 32 bytes".into(),
        ));
    }
    check_id("hub_id", hub_id)?;
    let mut info = Vec::new();
    lp(&mut info, LABEL_SERVER_EVENT_ENCRYPTION_KEY_INFO.as_bytes())?;
    lp(&mut info, hub_id.as_bytes())?;
    info.extend_from_slice(&epoch.to_be_bytes());
    let hk = Hkdf::<Sha256>::new(
        Some(LABEL_SERVER_EVENT_ENCRYPTION_KEY.as_bytes()),
        server_secret,
    );
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(&info, key.as_mut())
        .map_err(|_| CryptoError::HkdfExpandError)?;
    Ok(key)
}

/// The AAD of a frame: binds hub, kind and epoch.
pub(crate) fn event_aad(hub_id: &str, kind: u32, epoch: u64) -> Result<Vec<u8>, CryptoError> {
    check_id("hub_id", hub_id)?;
    let mut aad = Vec::new();
    lp(&mut aad, LABEL_HUB_EVENT_EPOCH.as_bytes())?;
    lp(&mut aad, hub_id.as_bytes())?;
    aad.extend_from_slice(&kind.to_be_bytes());
    aad.extend_from_slice(&epoch.to_be_bytes());
    Ok(aad)
}

/// Seal one relay frame (server side). Returns the lowercase-hex payload.
pub fn seal_server_event(
    key: &[u8; 32],
    hub_id: &str,
    kind: u32,
    epoch: u64,
    json: &str,
) -> Result<String, CryptoError> {
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce).expect("getrandom failed");
    seal_server_event_with(key, hub_id, kind, epoch, json, &nonce, |tail| {
        getrandom::getrandom(tail).expect("getrandom failed")
    })
}

/// [`seal_server_event`] with a chosen nonce and padding — seeded vectors only.
pub(crate) fn seal_server_event_with(
    key: &[u8; 32],
    hub_id: &str,
    kind: u32,
    epoch: u64,
    json: &str,
    nonce: &[u8; 12],
    fill: impl FnMut(&mut [u8]),
) -> Result<String, CryptoError> {
    let aad = event_aad(hub_id, kind, epoch)?;
    let padded = Zeroizing::new(crate::padding::pad_to_bucket_with(json.as_bytes(), fill));
    let packed = aes256gcm_encrypt_with_nonce(key, nonce, &padded, &aad)?;
    Ok(hex::encode(packed))
}

/// Open one relay frame with its `(hub, kind, epoch)` key.
pub fn open_server_event(
    key: &[u8; 32],
    hub_id: &str,
    kind: u32,
    epoch: u64,
    payload_hex: &str,
) -> Result<String, CryptoError> {
    let aad = event_aad(hub_id, kind, epoch)?;
    let packed = decode_hex_min("payload", payload_hex, MIN_PAYLOAD_BYTES)?;
    let padded = Zeroizing::new(aes256gcm_decrypt(key, &packed, &aad)?);
    let plaintext = Zeroizing::new(crate::padding::unpad(&padded)?);
    String::from_utf8(plaintext.to_vec()).map_err(|_| CryptoError::DecryptionFailed)
}

/// One relay-event key as the server hands it to a member (`GET /api/auth/me`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct ServerEventKey {
    /// The hub whose frames this key opens.
    pub hub_id: String,
    /// The epoch (UTC day number) it is valid for.
    pub epoch: u64,
    /// The 32-byte key, lowercase hex.
    pub key_hex: String,
}

/// The relay-event keys a client holds, by `(hub, epoch)`. Lives in crate state
/// on every client; no host passes a key into [`EventKeyring::open`].
#[derive(Default)]
pub struct EventKeyring {
    keys: Vec<(String, u64, Zeroizing<[u8; 32]>)>,
}

impl EventKeyring {
    /// Build a keyring from the server's list, refusing a malformed key, an id
    /// outside the profile, or a duplicate `(hub, epoch)`.
    pub fn from_keys(keys: &[ServerEventKey]) -> Result<Self, CryptoError> {
        let mut ring = Self::default();
        for k in keys {
            check_id("hub_id", &k.hub_id)?;
            if ring.find(&k.hub_id, k.epoch).is_some() {
                return Err(CryptoError::InvalidInput(
                    "duplicate event key for one hub and epoch".into(),
                ));
            }
            let bytes = Zeroizing::new(decode_hex_exact("event key", &k.key_hex, 32)?);
            let mut key = Zeroizing::new([0u8; 32]);
            key.copy_from_slice(&bytes);
            ring.keys.push((k.hub_id.clone(), k.epoch, key));
        }
        Ok(ring)
    }

    fn find(&self, hub_id: &str, epoch: u64) -> Option<&[u8; 32]> {
        self.keys
            .iter()
            .find(|(h, e, _)| h == hub_id && *e == epoch)
            .map(|(_, _, k)| &**k)
    }

    /// Open a frame of `hub_id`. [`CryptoError::NoEventKey`] when no key is held
    /// for that hub and epoch — a client of another hub, or a stale epoch.
    pub fn open(
        &self,
        hub_id: &str,
        kind: u32,
        epoch: u64,
        payload_hex: &str,
    ) -> Result<String, CryptoError> {
        check_id("hub_id", hub_id)?;
        let key = self.find(hub_id, epoch).ok_or(CryptoError::NoEventKey)?;
        open_server_event(key, hub_id, kind, epoch, payload_hex)
    }

    /// Whether any key is held.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [0x5au8; 32];

    fn key(hub: &str, epoch: u64) -> Zeroizing<[u8; 32]> {
        derive_server_event_key(&SECRET, hub, epoch).unwrap()
    }

    #[test]
    fn roundtrip() {
        let k = key("hub-a", 7);
        let p = seal_server_event(&k, "hub-a", 1000, 7, r#"{"x":1}"#).unwrap();
        assert_eq!(
            open_server_event(&k, "hub-a", 1000, 7, &p).unwrap(),
            r#"{"x":1}"#
        );
        assert_eq!(p.len(), 2 * MIN_PAYLOAD_BYTES);
    }

    #[test]
    fn keys_differ_per_hub_and_epoch() {
        assert_ne!(*key("hub-a", 7), *key("hub-b", 7));
        assert_ne!(*key("hub-a", 7), *key("hub-a", 8));
    }

    #[test]
    fn a_frame_moved_between_hubs_kinds_or_epochs_fails() {
        let k = key("hub-a", 7);
        let p = seal_server_event(&k, "hub-a", 1000, 7, "{}").unwrap();
        for (hub, kind, epoch) in [("hub-b", 1000, 7), ("hub-a", 1001, 7), ("hub-a", 1000, 8)] {
            let r = open_server_event(&k, hub, kind, epoch, &p);
            assert_eq!(r.unwrap_err().code(), "decryption_failed");
        }
        // And the other hub's own key does not open it either.
        let r = open_server_event(&key("hub-b", 7), "hub-a", 1000, 7, &p);
        assert_eq!(r.unwrap_err().code(), "decryption_failed");
    }

    #[test]
    fn keyring_opens_only_its_own_hubs() {
        let ring = EventKeyring::from_keys(&[ServerEventKey {
            hub_id: "hub-a".into(),
            epoch: 7,
            key_hex: hex::encode(*key("hub-a", 7)),
        }])
        .unwrap();
        let pa = seal_server_event(&key("hub-a", 7), "hub-a", 5, 7, "{}").unwrap();
        let pb = seal_server_event(&key("hub-b", 7), "hub-b", 5, 7, "{}").unwrap();
        assert_eq!(ring.open("hub-a", 5, 7, &pa).unwrap(), "{}");
        assert_eq!(
            ring.open("hub-b", 5, 7, &pb).unwrap_err().code(),
            "no_event_key"
        );
        assert_eq!(
            ring.open("hub-a", 5, 8, &pa).unwrap_err().code(),
            "no_event_key"
        );
    }

    #[test]
    fn malformed_inputs_are_refused_with_their_code() {
        let k = key("hub-a", 7);
        let p = seal_server_event(&k, "hub-a", 1, 7, "{}").unwrap();
        assert_eq!(
            open_server_event(&k, "hub-a", 1, 7, &p.to_uppercase())
                .unwrap_err()
                .code(),
            "invalid_format"
        );
        assert_eq!(
            open_server_event(&k, "Hub-A", 1, 7, &p).unwrap_err().code(),
            "invalid_id"
        );
        assert!(EventKeyring::from_keys(&[ServerEventKey {
            hub_id: "hub-a".into(),
            epoch: 7,
            key_hex: "AA".repeat(32),
        }])
        .is_err());
        assert!(derive_server_event_key(&[0u8; 16], "hub-a", 1).is_err());
    }
}
