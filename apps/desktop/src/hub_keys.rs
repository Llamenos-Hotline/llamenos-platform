//! Per-hub key store behind the desktop hub-key IPC commands.
//!
//! A user can be a member of several hubs, each with its own random 32-byte
//! key. Every key held here is BOUND to the hub it belongs to, and every
//! operation that uses one names it explicitly with a [`HubKeyRef`]. There is
//! no "current hub key" for an operation to pick up implicitly.
//!
//! That is the whole point. With one ambient slot, loading hub B's key (the UI
//! does this on every hub switch) silently changed the key that an in-flight
//! distribute or rotation of hub A was sealing into A's envelopes. The server
//! cannot catch that: its generation guard validates which generation a write
//! names, not which key the envelopes wrap. Here a reference to hub A's key
//! either resolves to hub A's key or is refused, whatever else is loaded.
//!
//! Two kinds of key are held, and they never alias:
//! - **committed**: the key the server holds for a hub, at a generation. At
//!   most one per hub; a newer generation is never replaced by an older one.
//! - **pending**: a freshly generated key (provisioning or rotation) the
//!   server has not accepted yet. Addressed by a random id and bound to its
//!   hub, so it can seal envelopes and re-encrypt records for that hub without
//!   ever touching the committed key other code encrypts with. It becomes
//!   committed only once the server accepts it.

use std::collections::HashMap;

use serde::Deserialize;
use zeroize::Zeroizing;

pub type HubKey = Zeroizing<[u8; 32]>;

/// Names the hub key an operation must use. Deserialized from the webview as
/// `{ state: "committed", hubId, generation }` or
/// `{ state: "pending", hubId, pendingId }`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum HubKeyRef {
    /// The key the server accepted for `hub_id`, at exactly `generation`.
    #[serde(rename_all = "camelCase")]
    Committed { hub_id: String, generation: u64 },
    /// A key generated for `hub_id` that the server has not accepted yet.
    #[serde(rename_all = "camelCase")]
    Pending { hub_id: String, pending_id: String },
}

struct CommittedKey {
    generation: u64,
    key: HubKey,
}

struct PendingKey {
    hub_id: String,
    key: HubKey,
}

#[derive(Default)]
pub struct HubKeyStore {
    committed: HashMap<String, CommittedKey>,
    pending: HashMap<String, PendingKey>,
}

impl HubKeyStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hold `key` as `hub_id`'s committed key at `generation`. A newer
    /// generation already held is kept (a slow response must not roll a hub
    /// back to a retired key). Returns the generation now held for the hub.
    pub fn install(&mut self, hub_id: &str, generation: u64, key: HubKey) -> u64 {
        match self.committed.get(hub_id) {
            Some(held) if held.generation > generation => held.generation,
            _ => {
                self.committed
                    .insert(hub_id.to_owned(), CommittedKey { generation, key });
                generation
            }
        }
    }

    /// Drop `hub_id`'s committed key (the server holds no envelope for us).
    pub fn forget(&mut self, hub_id: &str) {
        self.committed.remove(hub_id);
    }

    /// Hold a new random key for `hub_id` as pending. Returns its id.
    pub fn generate_pending(&mut self, hub_id: &str) -> String {
        let mut key: HubKey = Zeroizing::new([0u8; 32]);
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, key.as_mut());
        let mut id = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut id);
        let pending_id = hex::encode(id);
        self.pending.insert(
            pending_id.clone(),
            PendingKey {
                hub_id: hub_id.to_owned(),
                key,
            },
        );
        pending_id
    }

    /// The server accepted pending key `pending_id` for `hub_id` as
    /// `generation`: hold it as the hub's committed key. Returns the
    /// generation now held for the hub.
    pub fn commit_pending(
        &mut self,
        hub_id: &str,
        pending_id: &str,
        generation: u64,
    ) -> Result<u64, String> {
        match self.pending.get(pending_id) {
            None => return Err(format!("No pending hub key {pending_id}")),
            Some(p) if p.hub_id != hub_id => {
                return Err(format!(
                    "Pending hub key {pending_id} belongs to hub {}, not {hub_id}",
                    p.hub_id
                ))
            }
            Some(_) => {}
        }
        let pending = self
            .pending
            .remove(pending_id)
            .ok_or_else(|| format!("No pending hub key {pending_id}"))?;
        Ok(self.install(hub_id, generation, pending.key))
    }

    /// Drop a pending key the server did not accept. Unknown ids are ignored.
    pub fn discard_pending(&mut self, pending_id: &str) {
        self.pending.remove(pending_id);
    }

    /// The key `key_ref` names — refused unless exactly that key is held.
    pub fn resolve(&self, key_ref: &HubKeyRef) -> Result<&HubKey, String> {
        match key_ref {
            HubKeyRef::Committed { hub_id, generation } => match self.committed.get(hub_id) {
                Some(held) if held.generation == *generation => Ok(&held.key),
                Some(held) => Err(format!(
                    "Hub key generation {generation} of hub {hub_id} is not loaded (held: {})",
                    held.generation
                )),
                None => Err(format!("Hub key for hub {hub_id} is not loaded")),
            },
            HubKeyRef::Pending { hub_id, pending_id } => match self.pending.get(pending_id) {
                Some(p) if &p.hub_id == hub_id => Ok(&p.key),
                Some(p) => Err(format!(
                    "Pending hub key {pending_id} belongs to hub {}, not {hub_id}",
                    p.hub_id
                )),
                None => Err(format!("No pending hub key {pending_id}")),
            },
        }
    }

    /// `hub_id`'s committed key, whatever its generation (decryption only).
    pub fn committed(&self, hub_id: &str) -> Result<&HubKey, String> {
        self.committed
            .get(hub_id)
            .map(|held| &held.key)
            .ok_or_else(|| format!("Hub key for hub {hub_id} is not loaded"))
    }

    /// Drop every key (device lock). `Zeroizing` wipes each on drop.
    pub fn clear(&mut self) {
        self.committed.clear();
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> HubKey {
        Zeroizing::new([byte; 32])
    }

    fn committed(hub: &str, generation: u64) -> HubKeyRef {
        HubKeyRef::Committed {
            hub_id: hub.into(),
            generation,
        }
    }

    #[test]
    fn a_reference_resolves_to_its_own_hubs_key_whatever_else_is_loaded() {
        let mut store = HubKeyStore::new();
        store.install("hub-a", 1, key(0xa));
        // The UI switches to hub B mid-operation.
        store.install("hub-b", 1, key(0xb));
        assert_eq!(**store.resolve(&committed("hub-a", 1)).unwrap(), [0xa; 32]);
        assert_eq!(**store.resolve(&committed("hub-b", 1)).unwrap(), [0xb; 32]);
    }

    #[test]
    fn a_reference_to_a_key_not_held_is_refused() {
        let mut store = HubKeyStore::new();
        store.install("hub-b", 1, key(0xb));
        assert!(store.resolve(&committed("hub-a", 1)).is_err());
        store.install("hub-a", 2, key(0xa));
        assert!(store.resolve(&committed("hub-a", 1)).is_err(), "generation must match");
        store.forget("hub-a");
        assert!(store.resolve(&committed("hub-a", 2)).is_err());
    }

    #[test]
    fn an_older_generation_never_replaces_a_newer_one() {
        let mut store = HubKeyStore::new();
        assert_eq!(store.install("hub-a", 2, key(2)), 2);
        assert_eq!(store.install("hub-a", 1, key(1)), 2);
        assert_eq!(**store.committed("hub-a").unwrap(), [2; 32]);
        assert_eq!(store.install("hub-a", 3, key(3)), 3);
        assert_eq!(**store.committed("hub-a").unwrap(), [3; 32]);
    }

    #[test]
    fn a_pending_key_is_bound_to_its_hub_and_leaves_the_committed_key_alone() {
        let mut store = HubKeyStore::new();
        store.install("hub-a", 1, key(0xa));
        let pending_id = store.generate_pending("hub-a");
        let pending = HubKeyRef::Pending {
            hub_id: "hub-a".into(),
            pending_id: pending_id.clone(),
        };
        let fresh = **store.resolve(&pending).unwrap();
        assert_ne!(fresh, [0xa; 32]);
        assert_eq!(**store.committed("hub-a").unwrap(), [0xa; 32]);

        let wrong_hub = HubKeyRef::Pending {
            hub_id: "hub-b".into(),
            pending_id: pending_id.clone(),
        };
        assert!(store.resolve(&wrong_hub).is_err());
        assert!(store.commit_pending("hub-b", &pending_id, 2).is_err());

        assert_eq!(store.commit_pending("hub-a", &pending_id, 2).unwrap(), 2);
        assert_eq!(**store.resolve(&committed("hub-a", 2)).unwrap(), fresh);
        assert!(store.resolve(&pending).is_err(), "a committed pending key is consumed");
    }

    #[test]
    fn a_discarded_pending_key_is_gone_and_clear_drops_everything() {
        let mut store = HubKeyStore::new();
        store.install("hub-a", 1, key(0xa));
        let pending_id = store.generate_pending("hub-a");
        store.discard_pending(&pending_id);
        assert!(store.commit_pending("hub-a", &pending_id, 2).is_err());
        store.generate_pending("hub-a");
        store.clear();
        assert!(store.committed("hub-a").is_err());
        assert!(store.pending.is_empty());
    }

    #[test]
    fn key_refs_deserialize_from_the_webview_shape() {
        let c: HubKeyRef =
            serde_json::from_str(r#"{"state":"committed","hubId":"h","generation":3}"#).unwrap();
        assert_eq!(c, committed("h", 3));
        let p: HubKeyRef =
            serde_json::from_str(r#"{"state":"pending","hubId":"h","pendingId":"ab"}"#).unwrap();
        assert_eq!(
            p,
            HubKeyRef::Pending {
                hub_id: "h".into(),
                pending_id: "ab".into()
            }
        );
    }
}
