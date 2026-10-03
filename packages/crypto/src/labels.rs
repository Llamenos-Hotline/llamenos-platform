//! Authoritative domain separation constants for all cryptographic operations.
//!
//! Every HPKE envelope, HKDF context, HMAC key, and Ed25519 signature binding
//! uses a unique context string from this module. This prevents cross-context key
//! reuse attacks where a ciphertext from one domain could be valid in another.
//!
//! RULES:
//! 1. NEVER use raw string literals for crypto contexts — use constants from here
//! 2. New crypto operations MUST add a new constant before implementation
//! 3. All constants are prefixed with "llamenos:" for collision avoidance
//! 4. These MUST match `packages/protocol/crypto-labels.json`
//!
//! ## Label Registry
//!
//! The `LABEL_REGISTRY` array maps numeric IDs (u8) to label strings.
//! This is used in the HPKE envelope `labelId` field for compact wire representation.
//! Indices are stable — never reorder or reuse indices.

// --- HPKE Key Wrapping ---

/// Per-note symmetric key wrapping
pub const LABEL_NOTE_KEY: &str = "llamenos:note-key";

/// Per-file symmetric key wrapping
pub const LABEL_FILE_KEY: &str = "llamenos:file-key";

/// File metadata encryption
pub const LABEL_FILE_METADATA: &str = "llamenos:file-metadata";

/// Hub key distribution wrapping
pub const LABEL_HUB_KEY_WRAP: &str = "llamenos:hub-key-wrap";

// --- Content Encryption ---

/// Server-side transcription encryption
pub const LABEL_TRANSCRIPTION: &str = "llamenos:transcription";

/// E2EE message encryption
pub const LABEL_MESSAGE: &str = "llamenos:message";

/// Encrypted call record metadata
pub const LABEL_CALL_META: &str = "llamenos:call-meta";

/// Encrypted shift schedule details
pub const LABEL_SHIFT_SCHEDULE: &str = "llamenos:shift-schedule";

// --- HKDF Derivation ---

/// HKDF salt for legacy symmetric key derivation
pub const HKDF_SALT: &str = "llamenos:hkdf-salt:v1";

/// HKDF context: legacy V1 note encryption
pub const HKDF_CONTEXT_NOTES: &str = "llamenos:notes";

/// HKDF context: draft encryption
pub const HKDF_CONTEXT_DRAFTS: &str = "llamenos:drafts";

/// HKDF context: export encryption
pub const HKDF_CONTEXT_EXPORT: &str = "llamenos:export";

/// Hub event HKDF derivation from hub key
pub const LABEL_HUB_EVENT: &str = "llamenos:hub-event";

// --- Key Agreement ---

/// Device provisioning shared key derivation
pub const LABEL_DEVICE_PROVISION: &str = "llamenos:device-provision";

/// HKDF salt for provisioning key derivation
pub const LABEL_PROVISIONING_SALT: &str = "llamenos:provisioning:v1";

/// AEAD associated data for the device provisioning key bundle.
///
/// Distinct from `LABEL_DEVICE_PROVISION` (which keys the AEAD) so that a
/// payload from one provisioning bundle format can never authenticate under
/// another: changing the bundle format means minting a new label, and an
/// old-format payload simply fails the GCM tag check.
pub const LABEL_DEVICE_PROVISION_BUNDLE: &str = "llamenos:device-provision-bundle:v1";

// --- SAS Verification ---

/// SAS HKDF salt for provisioning verification
pub const SAS_SALT: &str = "llamenos:sas";

/// SAS HKDF info parameter
pub const SAS_INFO: &str = "llamenos:provisioning-sas";

// --- Auth Token ---

/// Auth token message prefix (Ed25519)
pub const AUTH_PREFIX: &str = "llamenos:auth:";

// --- HMAC Domain Separation ---

/// Phone number hashing prefix
pub const HMAC_PHONE_PREFIX: &str = "llamenos:phone:";

/// IP address hashing prefix
pub const HMAC_IP_PREFIX: &str = "llamenos:ip:";

/// Key identification hashing prefix
pub const HMAC_KEYID_PREFIX: &str = "llamenos:keyid:";

/// Subscriber identifier HMAC key
pub const HMAC_SUBSCRIBER: &str = "llamenos:subscriber";

/// Preference token HMAC key
pub const HMAC_PREFERENCE_TOKEN: &str = "llamenos:preference-token";

// --- Recovery / Backup ---

/// Recovery key PBKDF2 fallback salt (legacy)
pub const RECOVERY_SALT: &str = "llamenos:recovery";

/// Generic backup encryption
pub const LABEL_BACKUP: &str = "llamenos:backup";

// --- Server Identity ---

/// HKDF derivation for server keypair from SERVER_NOSTR_SECRET
pub const LABEL_SERVER_NOSTR_KEY: &str = "llamenos:server-nostr-key";

/// HKDF info parameter for server key (versioned for rotation)
pub const LABEL_SERVER_NOSTR_KEY_INFO: &str = "llamenos:server-nostr-key:v1";

// --- Push Notification Encryption ---

/// Wake-tier push payload — decryptable without PIN (minimal metadata only)
pub const LABEL_PUSH_WAKE: &str = "llamenos:push-wake";

/// Full-tier push payload — decryptable only with user's key
pub const LABEL_PUSH_FULL: &str = "llamenos:push-full";

// --- Contact / CMS Encryption ---

/// HKDF context for encrypting contact identifiers at rest
pub const LABEL_CONTACT_ID: &str = "llamenos:contact-identifier";

/// Contact profile encryption
pub const LABEL_CONTACT_PROFILE: &str = "llamenos:contact-profile";

/// Case summary encryption
pub const LABEL_CASE_SUMMARY: &str = "llamenos:case-summary";

/// Case fields encryption
pub const LABEL_CASE_FIELDS: &str = "llamenos:case-fields";

/// Event details encryption
pub const LABEL_EVENT_DETAILS: &str = "llamenos:event-details";

/// Blind index key derivation (HKDF salt)
pub const LABEL_BLIND_INDEX_KEY: &str = "llamenos:blind-index-key";

/// Blind index field-level HKDF info prefix
pub const LABEL_BLIND_INDEX_FIELD: &str = "llamenos:blind-idx:";

/// Cross-hub share encryption
pub const LABEL_CROSS_HUB_SHARE: &str = "llamenos:cross-hub-share";

// --- HMAC: CMS Blind Index ---

pub const HMAC_CONTACT_NAME: &str = "llamenos:contact-name";
pub const HMAC_CONTACT_TAG: &str = "llamenos:contact-tag";
pub const HMAC_CASE_STATUS: &str = "llamenos:case-status";
pub const HMAC_CASE_SEVERITY: &str = "llamenos:case-severity";
pub const HMAC_CASE_CATEGORY: &str = "llamenos:case-category";
pub const HMAC_EVENT_TYPE: &str = "llamenos:event-type";

// --- NEW: PUK (Per-User Key) ---

/// PUK signing subkey derivation
pub const LABEL_PUK_SIGN: &str = "llamenos:puk:sign:v1";

/// PUK DH (encryption) subkey derivation
pub const LABEL_PUK_DH: &str = "llamenos:puk:dh:v1";

/// PUK secretbox (CLKR chain) subkey derivation
pub const LABEL_PUK_SECRETBOX: &str = "llamenos:puk:secretbox:v1";

/// PUK seed wrapped to a device's X25519 key
pub const LABEL_PUK_WRAP_TO_DEVICE: &str = "llamenos:puk:wrap:device:v1";

/// PUK previous generation wrap (CLKR chain link)
pub const LABEL_PUK_PREVIOUS_GEN: &str = "llamenos:puk:prev-gen:v1";

// --- NEW: Device Auth (Ed25519) ---

/// Ed25519 device authentication token label
pub const LABEL_DEVICE_AUTH: &str = "llamenos:device-auth:v1";

// --- NEW: Items Key / Note Epoch ---

/// Items key export from MLS epoch secret
pub const LABEL_ITEMS_KEY_EXPORT: &str = "llamenos:items-key-export:v1";

/// Note epoch key derivation
pub const LABEL_NOTE_EPOCH_KEY: &str = "llamenos:note-epoch-key:v1";

// --- NEW: Hub PTK ---

/// Hub PTK derivation from MLS export secret
pub const LABEL_HUB_PTK: &str = "llamenos:hub-ptk:v1";

/// Hub PTK previous generation wrap
pub const LABEL_HUB_PTK_PREV_GEN: &str = "llamenos:hub-ptk:prev-gen:v1";

// --- NEW: SFrame ---

/// SFrame call secret derivation from MLS exporter
pub const LABEL_SFRAME_CALL_SECRET: &str = "llamenos:sframe-call-secret:v1";

/// SFrame per-participant base key
pub const LABEL_SFRAME_BASE_KEY: &str = "llamenos:sframe-base-key:v1";

// --- NEW: MLS ---

/// MLS key package provisioning
pub const LABEL_MLS_PROVISION: &str = "llamenos:mls-provision:v1";

// --- Nostr ---

/// Nostr event tag type used to identify Llamenos hub events
pub const NOSTR_EVENT_TAG: &str = "llamenos:event";

/// Prefix for per-room Nostr event tags used in device provisioning flows
pub const LABEL_PROVISION_PREFIX: &str = "llamenos:provision-";

/// PBKDF2 salt for Tauri Stronghold key derivation (desktop only)
pub const LABEL_STRONGHOLD: &str = "llamenos:stronghold:v1";

/// Storage credential wrapping (encrypted key material at rest)
pub const LABEL_STORAGE_CREDENTIAL_WRAP: &str = "llamenos:storage-credential-wrap";

// --- Server Nostr Signing ---

/// HKDF derivation for server Nostr signing key
pub const LABEL_SERVER_NOSTR_SIGNING_KEY: &str = "llamenos:server-nostr-signing:v1";

/// HKDF info for server Nostr signing key
pub const LABEL_SERVER_NOSTR_SIGNING_KEY_INFO: &str = "llamenos:server-nostr-signing-info:v1";

// --- Server Event Encryption ---

/// HKDF derivation for server event encryption key
pub const LABEL_SERVER_EVENT_ENCRYPTION_KEY: &str = "llamenos:server-event-encryption:v1";

/// HKDF info for server event encryption key
pub const LABEL_SERVER_EVENT_ENCRYPTION_KEY_INFO: &str = "llamenos:server-event-encryption-info:v1";

// --- Hub Event Epoch ---

/// Hub event epoch key derivation
pub const LABEL_HUB_EVENT_EPOCH: &str = "llamenos:hub-event-epoch:v1";

// --- Server Signing ---

/// Server signing key derivation
pub const LABEL_SERVER_SIGNING_KEY: &str = "llamenos:server-signing-key:v1";

/// Server signing key HKDF info
pub const LABEL_SERVER_SIGNING_INFO: &str = "llamenos:server-signing-key-info:v1";

// --- WebSocket Auth ---

/// WebSocket authentication challenge label
pub const LABEL_WS_CHALLENGE: &str = "llamenos:ws-auth:v1";

// --- EP08: Account Lifecycle ---

/// Audit user key wrapping — per-user symmetric key HPKE-wrapped to admin pubkeys
pub const LABEL_AUDIT_USER_KEY_WRAP: &str = "llamenos:audit-user-key-wrap:v1";

/// Erasure override co-approver signature — Ed25519 sig over (targetUserId || timestamp || justification)
pub const LABEL_ERASURE_OVERRIDE_SIG: &str = "llamenos:erasure-override-sig:v1";

/// Audit entry details content encryption (AES-256-GCM AAD prefix)
pub const LABEL_AUDIT_DETAILS: &str = "llamenos:audit-details:v1";

/// Device wipe command signature — Ed25519 sig over (targetDevicePubkey || timestamp || reason)
pub const LABEL_DEVICE_WIPE_SIG: &str = "llamenos:device-wipe-sig:v1";

// --- Recovery Group ---

/// HPKE wrapping each share holder's Shamir share at rest
pub const LABEL_RECOVERY_GROUP_SHARE_WRAP: &str = "llamenos:recovery-group:share-wrap:v1";

/// HPKE wrapping user's PUK seed under recovery group pubkey
pub const LABEL_RECOVERY_PUK_SEED_WRAP: &str = "llamenos:recovery-group:puk-seed-wrap:v1";

/// HPKE wrapping share contribution to user's new device during ceremony
pub const LABEL_RECOVERY_SHARE_CONTRIBUTE: &str = "llamenos:recovery-group:share-contribute:v1";

/// Domain separation for share liveness proofs
pub const LABEL_RECOVERY_LIVENESS_PROOF: &str = "llamenos:recovery-group:liveness-proof:v1";

// --- Role Encryption ---

/// Platform role name encryption (per-admin HPKE envelope)
pub const LABEL_PLATFORM_ROLE_NAME_ENCRYPT: &str = "llamenos:platform-role-name-encrypt:v1";

/// Platform role description encryption (per-admin HPKE envelope)
pub const LABEL_PLATFORM_ROLE_DESC_ENCRYPT: &str = "llamenos:platform-role-desc-encrypt:v1";

/// Hub role encryption (hub key symmetric encryption)
pub const LABEL_HUB_ROLE_ENCRYPT: &str = "llamenos:hub-role-encrypt:v1";

// --- Shift/Availability Encryption (EP07) ---

/// Availability reason encryption
pub const LABEL_AVAILABILITY_REASON: &str = "llamenos:availability-reason";

/// Ring group name encryption
pub const LABEL_RING_GROUP_NAME: &str = "llamenos:ring-group-name";

/// Shift name encryption
pub const LABEL_SHIFT_NAME: &str = "llamenos:shift-name";

/// Shift override note encryption
pub const LABEL_SHIFT_OVERRIDE_NOTE: &str = "llamenos:shift-override-note";

// --- Team/Tag Encryption (EP03) ---

/// Team field encryption (hub key symmetric encryption)
pub const LABEL_TEAM_ENCRYPT: &str = "llamenos:team-field:v1";

/// Tag field encryption (hub key symmetric encryption)
pub const LABEL_TAG_ENCRYPT: &str = "llamenos:tag-field:v1";

// --- Entity Type (EP06) ---

/// Entity type definition encryption
pub const LABEL_ENTITY_TYPE_DEFINITION: &str = "llamenos:entity-type-def:v1";

// --- SFrame Nonce (Epic B) ---

/// SFrame nonce derivation (replaces raw `b"sframe nonce"`)
pub const LABEL_SFRAME_NONCE: &str = "llamenos:sframe-nonce:v1";

// --- Shamir Commitment (Epic B) ---

/// Shamir share commitment domain prefix
pub const LABEL_SHAMIR_COMMIT: &str = "llamenos:shamir-commit:v1";

// --- Desktop Key Management (Security Audit) ---

/// HKDF info for backup key derivation from recovery key (versioned)
pub const LABEL_BACKUP_HKDF_INFO: &str = "llamenos:backup:v1";

/// HKDF info for deriving X25519 encryption seed from Ed25519 signing seed
pub const LABEL_DEVICE_ENCRYPTION_SEED: &str = "llamenos:device-encryption-seed:v1";

/// Account lockdown intent binding (prevents replay of lockdown commands)
pub const LABEL_LOCKDOWN_INTENT: &str = "llamenos:lockdown-intent:v1";

// --- Firehose Agent (EP-Firehose) ---

/// Firehose agent payload seal (HPKE envelope)
pub const LABEL_FIREHOSE_AGENT_SEAL: &str = "llamenos:firehose:agent-seal";

/// Firehose buffer content encryption
pub const LABEL_FIREHOSE_BUFFER_ENCRYPT: &str = "llamenos:firehose:buffer-encrypt";

/// Firehose report wrapping (admin HPKE envelope)
pub const LABEL_FIREHOSE_REPORT_WRAP: &str = "llamenos:firehose:report-wrap";

// --- IVR media URLs (#1325, #1347) ---

/// HMAC over the path of an IVR audio URL the worker hands a telephony
/// provider (an operator-uploaded prompt or generated speech), so the public
/// media routes serve only URLs the worker minted.
pub const HMAC_IVR_MEDIA_URL: &str = "llamenos:ivr-media-url:v1";

// --- SAS Derivation (EP02) ---

/// Domain separation for SAS emoji derivation (device verification ceremony)
pub const LABEL_SAS_DERIVE: &str = "llamenos:sas-derive:v1";

// =============================================================================
// LABEL REGISTRY — maps numeric IDs (u8) to label strings.
//
// The index IS the labelId in the HPKE envelope wire format.
// Indices are stable and MUST NEVER be reordered or reused.
//
// Indices 0-35: existing labels (from crypto-labels.json ordering)
// Indices 36-46: new v3 labels (PUK, device auth, items key, SFrame, MLS)
// Index 53: TOMBSTONE (was LABEL_ECIES_V2_SALT — ECIES removed, index reserved)
// Indices 57-68: labels synced from crypto-labels.json
// Indices 69-72: EP08 Account Lifecycle
// Indices 73-76: Recovery Group (EP09-P1)
// Indices 77-79: Role Encryption (EP01)
// Index 80: EP02 Device Identity
// Indices 92-94: Firehose Agent (EP-Firehose)
// Index 96: IVR media URL signing
// =============================================================================

pub const LABEL_REGISTRY: &[&str] = &[
    // 0-3: Key wrapping
    LABEL_NOTE_KEY,      // 0
    LABEL_FILE_KEY,      // 1
    LABEL_FILE_METADATA, // 2
    LABEL_HUB_KEY_WRAP,  // 3
    // 4-7: Content encryption
    LABEL_TRANSCRIPTION,  // 4
    LABEL_MESSAGE,        // 5
    LABEL_CALL_META,      // 6
    LABEL_SHIFT_SCHEDULE, // 7
    // 8-12: HKDF contexts
    HKDF_SALT,           // 8
    HKDF_CONTEXT_NOTES,  // 9
    HKDF_CONTEXT_DRAFTS, // 10
    HKDF_CONTEXT_EXPORT, // 11
    LABEL_HUB_EVENT,     // 12
    // 13: Key agreement
    LABEL_DEVICE_PROVISION, // 13
    // 14-15: SAS
    SAS_SALT, // 14
    SAS_INFO, // 15
    // 16: Auth
    AUTH_PREFIX, // 16
    // 17-21: HMAC prefixes
    HMAC_PHONE_PREFIX,     // 17
    HMAC_IP_PREFIX,        // 18
    HMAC_KEYID_PREFIX,     // 19
    HMAC_SUBSCRIBER,       // 20
    HMAC_PREFERENCE_TOKEN, // 21
    // 22-23: Recovery/backup
    RECOVERY_SALT, // 22
    LABEL_BACKUP,  // 23
    // 24-25: Server identity
    LABEL_SERVER_NOSTR_KEY,      // 24
    LABEL_SERVER_NOSTR_KEY_INFO, // 25
    // 26-27: Push
    LABEL_PUSH_WAKE, // 26
    LABEL_PUSH_FULL, // 27
    // 28-34: CMS
    LABEL_CONTACT_ID,      // 28
    LABEL_CONTACT_PROFILE, // 29
    LABEL_CASE_SUMMARY,    // 30
    LABEL_CASE_FIELDS,     // 31
    LABEL_EVENT_DETAILS,   // 32
    LABEL_BLIND_INDEX_KEY, // 33
    LABEL_CROSS_HUB_SHARE, // 34
    // 35-40: CMS HMAC
    HMAC_CONTACT_NAME,  // 35
    HMAC_CONTACT_TAG,   // 36
    HMAC_CASE_STATUS,   // 37
    HMAC_CASE_SEVERITY, // 38
    HMAC_CASE_CATEGORY, // 39
    HMAC_EVENT_TYPE,    // 40
    // 41-45: PUK
    LABEL_PUK_SIGN,           // 41
    LABEL_PUK_DH,             // 42
    LABEL_PUK_SECRETBOX,      // 43
    LABEL_PUK_WRAP_TO_DEVICE, // 44
    LABEL_PUK_PREVIOUS_GEN,   // 45
    // 46: Device auth
    LABEL_DEVICE_AUTH, // 46
    // 47-48: Items key / note epoch
    LABEL_ITEMS_KEY_EXPORT, // 47
    LABEL_NOTE_EPOCH_KEY,   // 48
    // 49: Hub PTK
    LABEL_HUB_PTK_PREV_GEN, // 49
    // 50-51: SFrame
    LABEL_SFRAME_CALL_SECRET, // 50
    LABEL_SFRAME_BASE_KEY,    // 51
    // 52: MLS
    LABEL_MLS_PROVISION, // 52
    // 53-56: Salt/derivation labels
    "",                      // 53 — TOMBSTONE (was LABEL_ECIES_V2_SALT, ECIES removed)
    LABEL_PROVISIONING_SALT, // 54
    LABEL_BLIND_INDEX_FIELD, // 55
    LABEL_HUB_PTK,           // 56
    // 57-68: New labels (synced from crypto-labels.json)
    NOSTR_EVENT_TAG,                        // 57
    LABEL_PROVISION_PREFIX,                 // 58
    LABEL_STRONGHOLD,                       // 59
    LABEL_STORAGE_CREDENTIAL_WRAP,          // 60
    LABEL_SERVER_NOSTR_SIGNING_KEY,         // 61
    LABEL_SERVER_NOSTR_SIGNING_KEY_INFO,    // 62
    LABEL_SERVER_EVENT_ENCRYPTION_KEY,      // 63
    LABEL_SERVER_EVENT_ENCRYPTION_KEY_INFO, // 64
    LABEL_HUB_EVENT_EPOCH,                  // 65
    LABEL_SERVER_SIGNING_KEY,               // 66
    LABEL_SERVER_SIGNING_INFO,              // 67
    LABEL_WS_CHALLENGE,                     // 68
    // 69-72: EP08 Account Lifecycle
    LABEL_AUDIT_USER_KEY_WRAP,  // 69
    LABEL_ERASURE_OVERRIDE_SIG, // 70
    LABEL_AUDIT_DETAILS,        // 71
    LABEL_DEVICE_WIPE_SIG,      // 72
    // 73-76: Recovery Group (EP09-P1)
    LABEL_RECOVERY_GROUP_SHARE_WRAP, // 73
    LABEL_RECOVERY_PUK_SEED_WRAP,    // 74
    LABEL_RECOVERY_SHARE_CONTRIBUTE, // 75
    LABEL_RECOVERY_LIVENESS_PROOF,   // 76
    // 77-79: Role Encryption (EP01)
    LABEL_PLATFORM_ROLE_NAME_ENCRYPT, // 77
    LABEL_PLATFORM_ROLE_DESC_ENCRYPT, // 78
    LABEL_HUB_ROLE_ENCRYPT,           // 79
    // 80: EP02 Device Identity
    LABEL_SAS_DERIVE, // 80
    // 81-84: Shift/Availability (EP07)
    LABEL_AVAILABILITY_REASON, // 81
    LABEL_RING_GROUP_NAME,     // 82
    LABEL_SHIFT_NAME,          // 83
    LABEL_SHIFT_OVERRIDE_NOTE, // 84
    // 85-86: Teams/Tags (EP03)
    LABEL_TEAM_ENCRYPT, // 85
    LABEL_TAG_ENCRYPT,  // 86
    // 87: Entity Type (EP06)
    LABEL_ENTITY_TYPE_DEFINITION, // 87
    // 88-89: Epic B Crypto Fixes
    LABEL_SFRAME_NONCE,  // 88
    LABEL_SHAMIR_COMMIT, // 89
    // 90-91: Desktop Key Management (Security Audit)
    LABEL_BACKUP_HKDF_INFO,       // 90
    LABEL_DEVICE_ENCRYPTION_SEED, // 91
    // 92: Account Lockdown
    LABEL_LOCKDOWN_INTENT, // 92
    // 93-95: Firehose Agent (EP-Firehose)
    LABEL_FIREHOSE_AGENT_SEAL,     // 93
    LABEL_FIREHOSE_BUFFER_ENCRYPT, // 94
    LABEL_FIREHOSE_REPORT_WRAP,    // 95
    // 96: IVR media URL signing (#1325, #1347)
    HMAC_IVR_MEDIA_URL, // 96
    // 97: Device provisioning key bundle
    LABEL_DEVICE_PROVISION_BUNDLE, // 97
];

/// Look up a label string by its numeric ID.
///
/// Returns `None` for out-of-range IDs and for tombstoned indices (empty strings).
pub fn id_to_label(id: u8) -> Option<&'static str> {
    LABEL_REGISTRY
        .get(id as usize)
        .copied()
        .filter(|s| !s.is_empty())
}

use std::collections::HashMap;
use std::sync::LazyLock;

static LABEL_MAP: LazyLock<HashMap<&'static str, u8>> = LazyLock::new(|| {
    let mut map = HashMap::with_capacity(LABEL_REGISTRY.len());
    for (i, &label) in LABEL_REGISTRY.iter().enumerate() {
        if !label.is_empty() {
            map.insert(label, i as u8);
        }
    }
    map
});

/// Look up the numeric ID for a label string.
///
/// Empty strings (tombstoned indices) are never matched.
pub fn label_to_id(label: &str) -> Option<u8> {
    if label.is_empty() {
        return None;
    }
    LABEL_MAP.get(label).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ensure all label constants match the TypeScript originals exactly.
    #[test]
    fn labels_match_expected_values() {
        assert_eq!(LABEL_NOTE_KEY, "llamenos:note-key");
        assert_eq!(LABEL_FILE_KEY, "llamenos:file-key");
        assert_eq!(LABEL_FILE_METADATA, "llamenos:file-metadata");
        assert_eq!(LABEL_HUB_KEY_WRAP, "llamenos:hub-key-wrap");
        assert_eq!(LABEL_TRANSCRIPTION, "llamenos:transcription");
        assert_eq!(LABEL_MESSAGE, "llamenos:message");
        assert_eq!(LABEL_CALL_META, "llamenos:call-meta");
        assert_eq!(LABEL_SHIFT_SCHEDULE, "llamenos:shift-schedule");
        assert_eq!(HKDF_SALT, "llamenos:hkdf-salt:v1");
        assert_eq!(HKDF_CONTEXT_NOTES, "llamenos:notes");
        assert_eq!(HKDF_CONTEXT_DRAFTS, "llamenos:drafts");
        assert_eq!(HKDF_CONTEXT_EXPORT, "llamenos:export");
        assert_eq!(LABEL_HUB_EVENT, "llamenos:hub-event");
        assert_eq!(LABEL_DEVICE_PROVISION, "llamenos:device-provision");
        assert_eq!(SAS_SALT, "llamenos:sas");
        assert_eq!(SAS_INFO, "llamenos:provisioning-sas");
        assert_eq!(AUTH_PREFIX, "llamenos:auth:");
        assert_eq!(HMAC_PHONE_PREFIX, "llamenos:phone:");
        assert_eq!(HMAC_IP_PREFIX, "llamenos:ip:");
        assert_eq!(HMAC_KEYID_PREFIX, "llamenos:keyid:");
        assert_eq!(HMAC_SUBSCRIBER, "llamenos:subscriber");
        assert_eq!(HMAC_PREFERENCE_TOKEN, "llamenos:preference-token");
        assert_eq!(RECOVERY_SALT, "llamenos:recovery");
        assert_eq!(LABEL_BACKUP, "llamenos:backup");
        assert_eq!(LABEL_SERVER_NOSTR_KEY, "llamenos:server-nostr-key");
        assert_eq!(LABEL_SERVER_NOSTR_KEY_INFO, "llamenos:server-nostr-key:v1");
        assert_eq!(LABEL_PUSH_WAKE, "llamenos:push-wake");
        assert_eq!(LABEL_PUSH_FULL, "llamenos:push-full");
        assert_eq!(LABEL_CONTACT_ID, "llamenos:contact-identifier");
    }

    /// Verify new v3 labels are present.
    #[test]
    fn new_v3_labels() {
        assert_eq!(LABEL_PUK_SIGN, "llamenos:puk:sign:v1");
        assert_eq!(LABEL_PUK_DH, "llamenos:puk:dh:v1");
        assert_eq!(LABEL_PUK_SECRETBOX, "llamenos:puk:secretbox:v1");
        assert_eq!(LABEL_PUK_WRAP_TO_DEVICE, "llamenos:puk:wrap:device:v1");
        assert_eq!(LABEL_PUK_PREVIOUS_GEN, "llamenos:puk:prev-gen:v1");
        assert_eq!(LABEL_DEVICE_AUTH, "llamenos:device-auth:v1");
        assert_eq!(LABEL_ITEMS_KEY_EXPORT, "llamenos:items-key-export:v1");
        assert_eq!(LABEL_NOTE_EPOCH_KEY, "llamenos:note-epoch-key:v1");
        assert_eq!(LABEL_HUB_PTK_PREV_GEN, "llamenos:hub-ptk:prev-gen:v1");
        assert_eq!(LABEL_SFRAME_CALL_SECRET, "llamenos:sframe-call-secret:v1");
        assert_eq!(LABEL_SFRAME_BASE_KEY, "llamenos:sframe-base-key:v1");
        assert_eq!(LABEL_MLS_PROVISION, "llamenos:mls-provision:v1");
        assert_eq!(LABEL_PROVISIONING_SALT, "llamenos:provisioning:v1");
        assert_eq!(LABEL_BLIND_INDEX_FIELD, "llamenos:blind-idx:");
        assert_eq!(LABEL_HUB_PTK, "llamenos:hub-ptk:v1");
        assert_eq!(
            LABEL_STORAGE_CREDENTIAL_WRAP,
            "llamenos:storage-credential-wrap"
        );
        assert_eq!(
            LABEL_SERVER_NOSTR_SIGNING_KEY,
            "llamenos:server-nostr-signing:v1"
        );
        assert_eq!(
            LABEL_SERVER_NOSTR_SIGNING_KEY_INFO,
            "llamenos:server-nostr-signing-info:v1"
        );
        assert_eq!(
            LABEL_SERVER_EVENT_ENCRYPTION_KEY,
            "llamenos:server-event-encryption:v1"
        );
        assert_eq!(
            LABEL_SERVER_EVENT_ENCRYPTION_KEY_INFO,
            "llamenos:server-event-encryption-info:v1"
        );
        assert_eq!(LABEL_HUB_EVENT_EPOCH, "llamenos:hub-event-epoch:v1");
        assert_eq!(LABEL_SERVER_SIGNING_KEY, "llamenos:server-signing-key:v1");
        assert_eq!(
            LABEL_SERVER_SIGNING_INFO,
            "llamenos:server-signing-key-info:v1"
        );
        assert_eq!(LABEL_WS_CHALLENGE, "llamenos:ws-auth:v1");
        assert_eq!(LABEL_AUDIT_USER_KEY_WRAP, "llamenos:audit-user-key-wrap:v1");
        assert_eq!(
            LABEL_ERASURE_OVERRIDE_SIG,
            "llamenos:erasure-override-sig:v1"
        );
        assert_eq!(LABEL_AUDIT_DETAILS, "llamenos:audit-details:v1");
        assert_eq!(LABEL_DEVICE_WIPE_SIG, "llamenos:device-wipe-sig:v1");
        assert_eq!(
            LABEL_RECOVERY_GROUP_SHARE_WRAP,
            "llamenos:recovery-group:share-wrap:v1"
        );
        assert_eq!(
            LABEL_RECOVERY_PUK_SEED_WRAP,
            "llamenos:recovery-group:puk-seed-wrap:v1"
        );
        assert_eq!(
            LABEL_RECOVERY_SHARE_CONTRIBUTE,
            "llamenos:recovery-group:share-contribute:v1"
        );
        assert_eq!(
            LABEL_RECOVERY_LIVENESS_PROOF,
            "llamenos:recovery-group:liveness-proof:v1"
        );
        assert_eq!(
            LABEL_PLATFORM_ROLE_NAME_ENCRYPT,
            "llamenos:platform-role-name-encrypt:v1"
        );
        assert_eq!(
            LABEL_PLATFORM_ROLE_DESC_ENCRYPT,
            "llamenos:platform-role-desc-encrypt:v1"
        );
        assert_eq!(LABEL_HUB_ROLE_ENCRYPT, "llamenos:hub-role-encrypt:v1");
        assert_eq!(LABEL_SAS_DERIVE, "llamenos:sas-derive:v1");
        assert_eq!(LABEL_AVAILABILITY_REASON, "llamenos:availability-reason");
        assert_eq!(LABEL_RING_GROUP_NAME, "llamenos:ring-group-name");
        assert_eq!(LABEL_SHIFT_NAME, "llamenos:shift-name");
        assert_eq!(LABEL_SHIFT_OVERRIDE_NOTE, "llamenos:shift-override-note");
        assert_eq!(LABEL_TEAM_ENCRYPT, "llamenos:team-field:v1");
        assert_eq!(LABEL_TAG_ENCRYPT, "llamenos:tag-field:v1");
        assert_eq!(LABEL_ENTITY_TYPE_DEFINITION, "llamenos:entity-type-def:v1");
        assert_eq!(LABEL_SFRAME_NONCE, "llamenos:sframe-nonce:v1");
        assert_eq!(LABEL_SHAMIR_COMMIT, "llamenos:shamir-commit:v1");
        assert_eq!(LABEL_BACKUP_HKDF_INFO, "llamenos:backup:v1");
        assert_eq!(
            LABEL_DEVICE_ENCRYPTION_SEED,
            "llamenos:device-encryption-seed:v1"
        );
        assert_eq!(LABEL_LOCKDOWN_INTENT, "llamenos:lockdown-intent:v1");
        assert_eq!(LABEL_FIREHOSE_AGENT_SEAL, "llamenos:firehose:agent-seal");
        assert_eq!(
            LABEL_FIREHOSE_BUFFER_ENCRYPT,
            "llamenos:firehose:buffer-encrypt"
        );
        assert_eq!(LABEL_FIREHOSE_REPORT_WRAP, "llamenos:firehose:report-wrap");
        assert_eq!(HMAC_IVR_MEDIA_URL, "llamenos:ivr-media-url:v1");
        assert_eq!(
            LABEL_DEVICE_PROVISION_BUNDLE,
            "llamenos:device-provision-bundle:v1"
        );
    }

    /// Verify registry index stability.
    #[test]
    fn registry_indices_stable() {
        assert_eq!(id_to_label(0), Some(LABEL_NOTE_KEY));
        assert_eq!(id_to_label(5), Some(LABEL_MESSAGE));
        assert_eq!(id_to_label(16), Some(AUTH_PREFIX));
        assert_eq!(id_to_label(26), Some(LABEL_PUSH_WAKE));
        assert_eq!(id_to_label(41), Some(LABEL_PUK_SIGN));
        assert_eq!(id_to_label(46), Some(LABEL_DEVICE_AUTH));
        assert_eq!(id_to_label(52), Some(LABEL_MLS_PROVISION));
        assert_eq!(id_to_label(53), None); // tombstone (was LABEL_ECIES_V2_SALT)
        assert_eq!(id_to_label(54), Some(LABEL_PROVISIONING_SALT));
        assert_eq!(id_to_label(55), Some(LABEL_BLIND_INDEX_FIELD));
        assert_eq!(id_to_label(56), Some(LABEL_HUB_PTK));
        assert_eq!(id_to_label(57), Some(NOSTR_EVENT_TAG));
        assert_eq!(id_to_label(58), Some(LABEL_PROVISION_PREFIX));
        assert_eq!(id_to_label(59), Some(LABEL_STRONGHOLD));
        assert_eq!(id_to_label(60), Some(LABEL_STORAGE_CREDENTIAL_WRAP));
        assert_eq!(id_to_label(61), Some(LABEL_SERVER_NOSTR_SIGNING_KEY));
        assert_eq!(id_to_label(62), Some(LABEL_SERVER_NOSTR_SIGNING_KEY_INFO));
        assert_eq!(id_to_label(63), Some(LABEL_SERVER_EVENT_ENCRYPTION_KEY));
        assert_eq!(
            id_to_label(64),
            Some(LABEL_SERVER_EVENT_ENCRYPTION_KEY_INFO)
        );
        assert_eq!(id_to_label(65), Some(LABEL_HUB_EVENT_EPOCH));
        assert_eq!(id_to_label(66), Some(LABEL_SERVER_SIGNING_KEY));
        assert_eq!(id_to_label(67), Some(LABEL_SERVER_SIGNING_INFO));
        assert_eq!(id_to_label(68), Some(LABEL_WS_CHALLENGE));
        assert_eq!(id_to_label(69), Some(LABEL_AUDIT_USER_KEY_WRAP));
        assert_eq!(id_to_label(70), Some(LABEL_ERASURE_OVERRIDE_SIG));
        assert_eq!(id_to_label(71), Some(LABEL_AUDIT_DETAILS));
        assert_eq!(id_to_label(72), Some(LABEL_DEVICE_WIPE_SIG));
        assert_eq!(id_to_label(73), Some(LABEL_RECOVERY_GROUP_SHARE_WRAP));
        assert_eq!(id_to_label(74), Some(LABEL_RECOVERY_PUK_SEED_WRAP));
        assert_eq!(id_to_label(75), Some(LABEL_RECOVERY_SHARE_CONTRIBUTE));
        assert_eq!(id_to_label(76), Some(LABEL_RECOVERY_LIVENESS_PROOF));
        assert_eq!(id_to_label(77), Some(LABEL_PLATFORM_ROLE_NAME_ENCRYPT));
        assert_eq!(id_to_label(78), Some(LABEL_PLATFORM_ROLE_DESC_ENCRYPT));
        assert_eq!(id_to_label(79), Some(LABEL_HUB_ROLE_ENCRYPT));
        assert_eq!(id_to_label(80), Some(LABEL_SAS_DERIVE));
        assert_eq!(id_to_label(81), Some(LABEL_AVAILABILITY_REASON));
        assert_eq!(id_to_label(82), Some(LABEL_RING_GROUP_NAME));
        assert_eq!(id_to_label(83), Some(LABEL_SHIFT_NAME));
        assert_eq!(id_to_label(84), Some(LABEL_SHIFT_OVERRIDE_NOTE));
        assert_eq!(id_to_label(85), Some(LABEL_TEAM_ENCRYPT));
        assert_eq!(id_to_label(86), Some(LABEL_TAG_ENCRYPT));
        assert_eq!(id_to_label(87), Some(LABEL_ENTITY_TYPE_DEFINITION));
        assert_eq!(id_to_label(88), Some(LABEL_SFRAME_NONCE));
        assert_eq!(id_to_label(89), Some(LABEL_SHAMIR_COMMIT));
        assert_eq!(id_to_label(90), Some(LABEL_BACKUP_HKDF_INFO));
        assert_eq!(id_to_label(91), Some(LABEL_DEVICE_ENCRYPTION_SEED));
        assert_eq!(id_to_label(92), Some(LABEL_LOCKDOWN_INTENT));
        assert_eq!(id_to_label(93), Some(LABEL_FIREHOSE_AGENT_SEAL));
        assert_eq!(id_to_label(94), Some(LABEL_FIREHOSE_BUFFER_ENCRYPT));
        assert_eq!(id_to_label(95), Some(LABEL_FIREHOSE_REPORT_WRAP));
        assert_eq!(id_to_label(96), Some(HMAC_IVR_MEDIA_URL));
        assert_eq!(id_to_label(97), Some(LABEL_DEVICE_PROVISION_BUNDLE));
    }

    /// Verify bidirectional lookup (skipping tombstoned indices).
    #[test]
    fn label_id_roundtrip() {
        for (i, &label) in LABEL_REGISTRY.iter().enumerate() {
            if label.is_empty() {
                // Tombstoned index — id_to_label returns None, label_to_id("") returns None
                assert_eq!(
                    id_to_label(i as u8),
                    None,
                    "tombstone at index {i} should return None"
                );
                continue;
            }
            assert_eq!(
                label_to_id(label),
                Some(i as u8),
                "label_to_id failed for {label}"
            );
            assert_eq!(
                id_to_label(i as u8),
                Some(label),
                "id_to_label failed for index {i}"
            );
        }
    }

    /// Verify unknown IDs return None.
    #[test]
    fn unknown_id_returns_none() {
        assert_eq!(id_to_label(255), None);
        assert_eq!(label_to_id("nonexistent:label"), None);
    }

    #[test]
    fn label_lookup_is_hashmap_backed() {
        // Round-trip all labels
        for (i, &label) in LABEL_REGISTRY.iter().enumerate() {
            if !label.is_empty() {
                assert_eq!(label_to_id(label), Some(i as u8));
                assert_eq!(id_to_label(i as u8), Some(label));
            }
        }
        // Unknown labels
        assert_eq!(label_to_id("llamenos:nonexistent:v1"), None);
        assert_eq!(label_to_id(""), None);
    }

    /// Verify no duplicate labels in registry (tombstones excluded).
    #[test]
    fn no_duplicate_labels() {
        let mut seen = std::collections::HashSet::new();
        for &label in LABEL_REGISTRY {
            if label.is_empty() {
                continue; // skip tombstoned slots
            }
            assert!(seen.insert(label), "duplicate label in registry: {label}");
        }
    }

    /// CI GUARD: Every label in crypto-labels.json must exist in LABEL_REGISTRY and vice versa.
    /// This prevents the drift that has been found 4 times — if you add a label to one place,
    /// this test forces you to add it to the other.
    #[test]
    fn label_registry_matches_json() {
        let json_str = include_str!("../../../packages/protocol/crypto-labels.json");
        let json: serde_json::Value =
            serde_json::from_str(json_str).expect("crypto-labels.json is valid JSON");
        let labels_obj = json["labels"]
            .as_object()
            .expect("crypto-labels.json has 'labels' object");

        // Every label in JSON must exist in LABEL_REGISTRY with the correct value
        for (key, value) in labels_obj {
            let expected_value = value
                .as_str()
                .unwrap_or_else(|| panic!("label {key} value is not a string"));
            let found = LABEL_REGISTRY.iter().any(|&l| l == expected_value);
            assert!(
                found,
                "Label {key} = \"{expected_value}\" exists in crypto-labels.json but NOT in LABEL_REGISTRY"
            );
        }

        // Every non-tombstone label in LABEL_REGISTRY must exist in JSON
        for (idx, &label) in LABEL_REGISTRY.iter().enumerate() {
            if label.is_empty() {
                continue;
            } // tombstone
            let found = labels_obj.values().any(|v| v.as_str() == Some(label));
            assert!(
                found,
                "Label at index {idx} = \"{label}\" exists in LABEL_REGISTRY but NOT in crypto-labels.json"
            );
        }
    }

    /// CI GUARD: Label count in LABEL_REGISTRY (excluding tombstones) must match JSON count.
    #[test]
    fn label_count_matches_json() {
        let json_str = include_str!("../../../packages/protocol/crypto-labels.json");
        let json: serde_json::Value =
            serde_json::from_str(json_str).expect("crypto-labels.json is valid JSON");
        let json_count = json["labels"]
            .as_object()
            .expect("crypto-labels.json has 'labels' object")
            .len();
        let registry_count = LABEL_REGISTRY.iter().filter(|l| !l.is_empty()).count();
        assert_eq!(
            registry_count, json_count,
            "LABEL_REGISTRY has {registry_count} labels but crypto-labels.json has {json_count}"
        );
    }
}
