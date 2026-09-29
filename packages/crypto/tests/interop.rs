//! Cross-platform interoperability tests.
//!
//! These tests generate test vectors using deterministic inputs and verify
//! that the wire format matches what the JavaScript (@noble/*) and mobile
//! (UniFFI) implementations produce. The test vectors are written to
//! `tests/fixtures/test-vectors.json` so other platforms can consume them.
//!
//! Run with: cargo test --test interop

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek;
use llamenos_core::auth::{create_auth_token_from_signing_key, verify_auth_token, AuthToken};
use llamenos_core::encryption::{
    decrypt_call_record, decrypt_draft, decrypt_message, decrypt_note, decrypt_with_pin,
    encrypt_draft, encrypt_export, encrypt_message, encrypt_note, encrypt_with_pin,
    hpke_unwrap_key, hpke_wrap_key, EncryptedKeyData, EncryptedMessage, EncryptedNote, KeyEnvelope,
    RecipientKeyEnvelope,
};
use llamenos_core::labels::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

/// Well-known test keypair (NEVER use in production).
/// These 32-byte hex secrets serve as both X25519 private keys (for HPKE) and
/// Ed25519 seeds (for auth tokens).
const TEST_SECRET_KEY: &str = "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f";

/// Second test keypair for multi-recipient tests.
const TEST_ADMIN_SECRET_KEY: &str =
    "0101010101010101010101010101010101010101010101010101010101010101";

/// Third test keypair for adversarial / "wrong key" tests.
const TEST_WRONG_SECRET_KEY: &str =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

/// Test PIN for key encryption vectors.
const TEST_PIN: &str = "12345678";

/// Derive X25519 public key hex from a 32-byte secret key hex.
fn x25519_pubkey(secret_hex: &str) -> String {
    let sk_bytes: [u8; 32] = hex::decode(secret_hex).unwrap().try_into().unwrap();
    let secret = X25519StaticSecret::from(sk_bytes);
    let pubkey = X25519PublicKey::from(&secret);
    hex::encode(pubkey.as_bytes())
}

// ─── Top-Level Struct ────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestVectors {
    /// Metadata
    version: String,
    generated_by: String,

    /// Key material (deterministic from known secrets)
    keys: KeyVectors,

    /// HPKE wrap/unwrap vectors
    hpke: HpkeVectors,

    /// Note encryption vectors (V2 forward secrecy)
    note_encryption: NoteEncryptionVectors,

    /// Auth token vectors
    auth: AuthVectors,

    /// PIN encryption vectors
    pin_encryption: PinEncryptionVectors,

    /// Draft encryption vectors
    draft_encryption: DraftEncryptionVectors,

    /// Label constants (for cross-platform consistency)
    labels: LabelVectors,

    // ─── New in v2 ───
    /// Message encryption vectors (Epic 74 — E2EE messaging)
    message_encryption: MessageEncryptionVectors,

    /// Hub key wrapping vectors (hub key HPKE distribution)
    hub_key: HubKeyVectors,

    /// Export encryption vectors (HKDF + base64)
    export_encryption: ExportEncryptionVectors,

    /// Call record metadata vectors (admin-only HPKE)
    call_record: CallRecordVectors,

    /// Domain separation proof vectors
    domain_separation: DomainSeparationVectors,

    /// Adversarial test vectors (wrong keys, tampered data)
    adversarial: AdversarialVectors,
}

// ─── Existing Structs ────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyVectors {
    secret_key_hex: String,
    /// X25519 public key for HPKE encryption
    x25519_pubkey_hex: String,
    admin_secret_key_hex: String,
    admin_x25519_pubkey_hex: String,
    wrong_secret_key_hex: String,
    wrong_x25519_pubkey_hex: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HpkeVectors {
    envelope: KeyEnvelope,
    original_key_hex: String,
    label: String,
    recipient_pubkey_hex: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteEncryptionVectors {
    plaintext_json: String,
    author_pubkey: String,
    admin_pubkeys: Vec<String>,
    encrypted: EncryptedNote,
    author_can_decrypt: bool,
    admin_can_decrypt: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthVectors {
    secret_key_hex: String,
    timestamp: u64,
    method: String,
    path: String,
    token: AuthToken,
    valid: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinEncryptionVectors {
    pin: String,
    nsec: String,
    pubkey_hex: String,
    encrypted: EncryptedKeyData,
    decryptable: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftEncryptionVectors {
    plaintext: String,
    secret_key_hex: String,
    encrypted_hex: String,
    decryptable: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LabelVectors {
    label_note_key: String,
    label_file_key: String,
    label_file_metadata: String,
    label_hub_key_wrap: String,
    label_transcription: String,
    label_message: String,
    label_call_meta: String,
    label_shift_schedule: String,
    hkdf_salt: String,
    hkdf_context_notes: String,
    hkdf_context_drafts: String,
    hkdf_context_export: String,
    label_hub_event: String,
    label_device_provision: String,
    sas_salt: String,
    sas_info: String,
    auth_prefix: String,
    hmac_phone_prefix: String,
    hmac_ip_prefix: String,
    hmac_keyid_prefix: String,
    hmac_subscriber: String,
    hmac_preference_token: String,
    recovery_salt: String,
    label_backup: String,
    label_server_nostr_key: String,
    label_server_nostr_key_info: String,
    label_push_wake: String,
    label_push_full: String,
    label_audit_user_key_wrap: String,
    label_erasure_override_sig: String,
    label_audit_details: String,
    label_device_wipe_sig: String,
}

// ─── New v2 Structs ──────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageEncryptionVectors {
    plaintext: String,
    reader_pubkeys: Vec<String>,
    encrypted: EncryptedMessage,
    volunteer_can_decrypt: bool,
    admin_can_decrypt: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubKeyVectors {
    hub_key_hex: String,
    member_pubkeys: Vec<String>,
    wrapped_envelopes: Vec<KeyEnvelope>,
    label: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportEncryptionVectors {
    plaintext_json: String,
    secret_key_hex: String,
    encrypted_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallRecordVectors {
    plaintext_json: String,
    admin_pubkeys: Vec<String>,
    encrypted_content: String,
    admin_envelopes: Vec<RecipientKeyEnvelope>,
    admin_can_decrypt: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DomainSeparationVectors {
    original_key_hex: String,
    recipient_pubkey_hex: String,
    wrapped_with_note_label: KeyEnvelope,
    wrapped_with_message_label: KeyEnvelope,
    wrapped_with_hub_label: KeyEnvelope,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdversarialVectors {
    hpke: AdversarialHpke,
    note: AdversarialNote,
    auth: AdversarialAuth,
    message: AdversarialMessage,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdversarialHpke {
    /// Valid envelope that can be unwrapped with admin key
    valid_envelope: KeyEnvelope,
    valid_label: String,
    /// ct with a flipped bit
    tampered_ct: String,
    /// ct truncated by 1 byte
    truncated_ct: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdversarialNote {
    /// Valid encrypted note
    valid_encrypted: EncryptedNote,
    /// encryptedContent with a flipped bit
    tampered_content: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdversarialAuth {
    /// Valid auth token
    valid_token: AuthToken,
    valid_method: String,
    valid_path: String,
    /// A timestamp 6 minutes in the past (expired)
    expired_timestamp: u64,
    /// Wrong method to test method binding
    wrong_method: String,
    /// Wrong path to test path binding
    wrong_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdversarialMessage {
    /// Valid encrypted message for volunteer + admin
    valid_encrypted: EncryptedMessage,
}

// ─── Main Vector Generation ──────────────────────────────────

#[test]
fn generate_and_verify_test_vectors() {
    // --- Key derivation ---
    // X25519 pubkeys for HPKE encryption operations
    let author_x25519 = x25519_pubkey(TEST_SECRET_KEY);
    let admin_x25519 = x25519_pubkey(TEST_ADMIN_SECRET_KEY);
    let wrong_x25519 = x25519_pubkey(TEST_WRONG_SECRET_KEY);

    // --- HPKE wrap/unwrap roundtrip ---
    let original_key = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    let key_bytes: [u8; 32] = hex::decode(original_key).unwrap().try_into().unwrap();
    let envelope = hpke_wrap_key(&key_bytes, &admin_x25519, LABEL_NOTE_KEY).unwrap();

    // Verify unwrap works
    let unwrapped = hpke_unwrap_key(&envelope, TEST_ADMIN_SECRET_KEY, LABEL_NOTE_KEY).unwrap();
    assert_eq!(hex::encode(&unwrapped), original_key);

    // --- Note encryption roundtrip ---
    let note_payload = r#"{"text":"Test note for interop","fields":{"severity":"high"}}"#;
    let encrypted_note =
        encrypt_note(note_payload, &author_x25519, &[admin_x25519.clone()]).unwrap();

    // Author can decrypt
    let author_decrypted = decrypt_note(
        &encrypted_note.encrypted_content,
        &encrypted_note.author_envelope,
        TEST_SECRET_KEY,
    )
    .unwrap();
    assert_eq!(author_decrypted, note_payload);

    // Admin can decrypt
    let admin_env = encrypted_note
        .admin_envelopes
        .iter()
        .find(|e| e.pubkey == admin_x25519)
        .unwrap();
    let admin_decrypted = decrypt_note(
        &encrypted_note.encrypted_content,
        &KeyEnvelope {
            enc: admin_env.enc.clone(),
            ct: admin_env.ct.clone(),
        },
        TEST_ADMIN_SECRET_KEY,
    )
    .unwrap();
    assert_eq!(admin_decrypted, note_payload);

    // --- Auth token roundtrip ---
    let timestamp = 1708900000000u64;
    let method = "POST";
    let path = "/api/notes";
    let auth_token =
        create_auth_token_from_signing_key(TEST_SECRET_KEY, timestamp, method, path).unwrap();
    let valid = verify_auth_token(&auth_token, method, path).unwrap();
    assert!(valid);

    // --- PIN encryption roundtrip ---
    let test_nsec = "nsec1test1234567890abcdef1234567890abcdef1234567890";
    let test_pubkey = &author_x25519;
    let pin_encrypted = encrypt_with_pin(test_nsec, TEST_PIN, test_pubkey).unwrap();
    let pin_decrypted = decrypt_with_pin(&pin_encrypted, TEST_PIN).unwrap();
    assert_eq!(pin_decrypted, test_nsec);

    // --- Draft encryption roundtrip ---
    let draft_text = "Draft note content for interop test";
    let draft_encrypted = encrypt_draft(draft_text, TEST_SECRET_KEY).unwrap();
    let draft_decrypted = decrypt_draft(&draft_encrypted, TEST_SECRET_KEY).unwrap();
    assert_eq!(draft_decrypted, draft_text);

    // ─── NEW v2: Message encryption roundtrip ────────────────
    let msg_plaintext = "Hello from volunteer — E2EE message interop test";
    let msg_readers = vec![author_x25519.clone(), admin_x25519.clone()];
    let encrypted_msg = encrypt_message(msg_plaintext, &msg_readers).unwrap();

    // Volunteer can decrypt
    let vol_decrypted = decrypt_message(
        &encrypted_msg.encrypted_content,
        &encrypted_msg.reader_envelopes,
        TEST_SECRET_KEY,
        &author_x25519,
    )
    .unwrap();
    assert_eq!(vol_decrypted, msg_plaintext);

    // Admin can decrypt
    let admin_msg_decrypted = decrypt_message(
        &encrypted_msg.encrypted_content,
        &encrypted_msg.reader_envelopes,
        TEST_ADMIN_SECRET_KEY,
        &admin_x25519,
    )
    .unwrap();
    assert_eq!(admin_msg_decrypted, msg_plaintext);

    // ─── NEW v2: Hub key wrapping ────────────────────────────
    let hub_key_hex = "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe";
    let hub_key_bytes: [u8; 32] = hex::decode(hub_key_hex).unwrap().try_into().unwrap();
    let hub_member_pubkeys = vec![author_x25519.clone(), admin_x25519.clone()];

    let hub_envelope_vol =
        hpke_wrap_key(&hub_key_bytes, &author_x25519, LABEL_HUB_KEY_WRAP).unwrap();
    let hub_envelope_admin =
        hpke_wrap_key(&hub_key_bytes, &admin_x25519, LABEL_HUB_KEY_WRAP).unwrap();

    // Both can unwrap
    let vol_hub = hpke_unwrap_key(&hub_envelope_vol, TEST_SECRET_KEY, LABEL_HUB_KEY_WRAP).unwrap();
    assert_eq!(hex::encode(&vol_hub), hub_key_hex);
    let admin_hub = hpke_unwrap_key(
        &hub_envelope_admin,
        TEST_ADMIN_SECRET_KEY,
        LABEL_HUB_KEY_WRAP,
    )
    .unwrap();
    assert_eq!(hex::encode(&admin_hub), hub_key_hex);

    // ─── Export encryption ───────────────────────────
    let export_json =
        r#"{"notes":[{"id":"abc","text":"test"}],"exportedAt":"2024-01-01T00:00:00Z"}"#;
    let export_encrypted = encrypt_export(export_json, TEST_SECRET_KEY).unwrap();
    // Verify it's valid base64
    let export_decoded = STANDARD.decode(&export_encrypted).unwrap();
    assert!(
        export_decoded.len() >= 24,
        "export must have nonce + ciphertext"
    );

    // ─── NEW v2: Call record metadata (reuse message pattern with LABEL_CALL_META) ─
    // Call records are encrypted using the same pattern as messages but with LABEL_CALL_META.
    // Since there's no encrypt_call_record in Rust (server encrypts in JS), we manually
    // construct one using the low-level HPKE + AES-256-GCM primitives.
    let call_record_json =
        r#"{"answeredBy":"vol-pubkey-here","callerNumber":"+15551234567","duration":120}"#;

    // Encrypt call record for admin only (volunteer can NOT decrypt call records)
    let call_record_msg = encrypt_call_record_for_test(call_record_json, &[admin_x25519.clone()]);

    // Admin can decrypt
    let call_decrypted = decrypt_call_record(
        &call_record_msg.encrypted_content,
        &call_record_msg.reader_envelopes,
        TEST_ADMIN_SECRET_KEY,
        &admin_x25519,
    )
    .unwrap();
    assert_eq!(call_decrypted, call_record_json);

    // ─── NEW v2: Domain separation proof ─────────────────────
    let ds_key_hex = "1111111111111111111111111111111111111111111111111111111111111111";
    let ds_key_bytes: [u8; 32] = hex::decode(ds_key_hex).unwrap().try_into().unwrap();

    let ds_note = hpke_wrap_key(&ds_key_bytes, &admin_x25519, LABEL_NOTE_KEY).unwrap();
    let ds_msg = hpke_wrap_key(&ds_key_bytes, &admin_x25519, LABEL_MESSAGE).unwrap();
    let ds_hub = hpke_wrap_key(&ds_key_bytes, &admin_x25519, LABEL_HUB_KEY_WRAP).unwrap();

    // Same-label unwrap must succeed
    assert!(hpke_unwrap_key(&ds_note, TEST_ADMIN_SECRET_KEY, LABEL_NOTE_KEY).is_ok());
    assert!(hpke_unwrap_key(&ds_msg, TEST_ADMIN_SECRET_KEY, LABEL_MESSAGE).is_ok());
    assert!(hpke_unwrap_key(&ds_hub, TEST_ADMIN_SECRET_KEY, LABEL_HUB_KEY_WRAP).is_ok());

    // Cross-label unwrap must fail
    assert!(hpke_unwrap_key(&ds_note, TEST_ADMIN_SECRET_KEY, LABEL_MESSAGE).is_err());
    assert!(hpke_unwrap_key(&ds_msg, TEST_ADMIN_SECRET_KEY, LABEL_NOTE_KEY).is_err());
    assert!(hpke_unwrap_key(&ds_hub, TEST_ADMIN_SECRET_KEY, LABEL_NOTE_KEY).is_err());

    // ─── Adversarial vectors ─────────────────────────────────

    // HPKE adversarial: tampered and truncated ciphertext
    let adv_envelope = hpke_wrap_key(&key_bytes, &admin_x25519, LABEL_NOTE_KEY).unwrap();
    let tampered_ct = tamper_hex(&adv_envelope.ct);
    let truncated_ct = truncate_hex(&adv_envelope.ct);

    // Verify tampered fails
    let tampered_env = KeyEnvelope {
        enc: adv_envelope.enc.clone(),
        ct: tampered_ct.clone(),
    };
    assert!(hpke_unwrap_key(&tampered_env, TEST_ADMIN_SECRET_KEY, LABEL_NOTE_KEY).is_err());

    // Verify truncated fails
    let truncated_env = KeyEnvelope {
        enc: adv_envelope.enc.clone(),
        ct: truncated_ct.clone(),
    };
    assert!(hpke_unwrap_key(&truncated_env, TEST_ADMIN_SECRET_KEY, LABEL_NOTE_KEY).is_err());

    // Note adversarial: tampered content
    let adv_note = encrypt_note(note_payload, &author_x25519, &[admin_x25519.clone()]).unwrap();
    let tampered_note_content = tamper_hex(&adv_note.encrypted_content);
    assert!(decrypt_note(
        &tampered_note_content,
        &adv_note.author_envelope,
        TEST_SECRET_KEY,
    )
    .is_err());

    // Auth adversarial: different method/path
    let adv_auth_token =
        create_auth_token_from_signing_key(TEST_SECRET_KEY, 1708900000000, "GET", "/api/notes")
            .unwrap();
    assert!(!verify_auth_token(&adv_auth_token, "POST", "/api/notes").unwrap());
    assert!(!verify_auth_token(&adv_auth_token, "GET", "/api/calls").unwrap());

    // Message adversarial: wrong reader
    let adv_msg = encrypt_message("adversarial message", &msg_readers).unwrap();
    assert!(decrypt_message(
        &adv_msg.encrypted_content,
        &adv_msg.reader_envelopes,
        TEST_WRONG_SECRET_KEY,
        &wrong_x25519,
    )
    .is_err());

    // ─── Build test vectors JSON ─────────────────────────────
    let vectors = TestVectors {
        version: "3".to_string(),
        generated_by: "llamenos-core interop test v3 (HPKE + AES-256-GCM)".to_string(),
        keys: KeyVectors {
            secret_key_hex: TEST_SECRET_KEY.to_string(),
            x25519_pubkey_hex: author_x25519.clone(),
            admin_secret_key_hex: TEST_ADMIN_SECRET_KEY.to_string(),
            admin_x25519_pubkey_hex: admin_x25519.clone(),
            wrong_secret_key_hex: TEST_WRONG_SECRET_KEY.to_string(),
            wrong_x25519_pubkey_hex: wrong_x25519.clone(),
        },
        hpke: HpkeVectors {
            envelope: envelope.clone(),
            original_key_hex: original_key.to_string(),
            label: LABEL_NOTE_KEY.to_string(),
            recipient_pubkey_hex: admin_x25519.clone(),
        },
        note_encryption: NoteEncryptionVectors {
            plaintext_json: note_payload.to_string(),
            author_pubkey: author_x25519.clone(),
            admin_pubkeys: vec![admin_x25519.clone()],
            encrypted: encrypted_note.clone(),
            author_can_decrypt: true,
            admin_can_decrypt: true,
        },
        auth: AuthVectors {
            secret_key_hex: TEST_SECRET_KEY.to_string(),
            timestamp,
            method: method.to_string(),
            path: path.to_string(),
            token: auth_token,
            valid: true,
        },
        pin_encryption: PinEncryptionVectors {
            pin: TEST_PIN.to_string(),
            nsec: test_nsec.to_string(),
            pubkey_hex: test_pubkey.clone(),
            encrypted: pin_encrypted,
            decryptable: true,
        },
        draft_encryption: DraftEncryptionVectors {
            plaintext: draft_text.to_string(),
            secret_key_hex: TEST_SECRET_KEY.to_string(),
            encrypted_hex: draft_encrypted,
            decryptable: true,
        },
        labels: LabelVectors {
            label_note_key: LABEL_NOTE_KEY.to_string(),
            label_file_key: LABEL_FILE_KEY.to_string(),
            label_file_metadata: LABEL_FILE_METADATA.to_string(),
            label_hub_key_wrap: LABEL_HUB_KEY_WRAP.to_string(),
            label_transcription: LABEL_TRANSCRIPTION.to_string(),
            label_message: LABEL_MESSAGE.to_string(),
            label_call_meta: LABEL_CALL_META.to_string(),
            label_shift_schedule: LABEL_SHIFT_SCHEDULE.to_string(),
            hkdf_salt: HKDF_SALT.to_string(),
            hkdf_context_notes: HKDF_CONTEXT_NOTES.to_string(),
            hkdf_context_drafts: HKDF_CONTEXT_DRAFTS.to_string(),
            hkdf_context_export: HKDF_CONTEXT_EXPORT.to_string(),
            label_hub_event: LABEL_HUB_EVENT.to_string(),
            label_device_provision: LABEL_DEVICE_PROVISION.to_string(),
            sas_salt: SAS_SALT.to_string(),
            sas_info: SAS_INFO.to_string(),
            auth_prefix: AUTH_PREFIX.to_string(),
            hmac_phone_prefix: HMAC_PHONE_PREFIX.to_string(),
            hmac_ip_prefix: HMAC_IP_PREFIX.to_string(),
            hmac_keyid_prefix: HMAC_KEYID_PREFIX.to_string(),
            hmac_subscriber: HMAC_SUBSCRIBER.to_string(),
            hmac_preference_token: HMAC_PREFERENCE_TOKEN.to_string(),
            recovery_salt: RECOVERY_SALT.to_string(),
            label_backup: LABEL_BACKUP.to_string(),
            label_server_nostr_key: LABEL_SERVER_NOSTR_KEY.to_string(),
            label_server_nostr_key_info: LABEL_SERVER_NOSTR_KEY_INFO.to_string(),
            label_push_wake: LABEL_PUSH_WAKE.to_string(),
            label_push_full: LABEL_PUSH_FULL.to_string(),
            label_audit_user_key_wrap: LABEL_AUDIT_USER_KEY_WRAP.to_string(),
            label_erasure_override_sig: LABEL_ERASURE_OVERRIDE_SIG.to_string(),
            label_audit_details: LABEL_AUDIT_DETAILS.to_string(),
            label_device_wipe_sig: LABEL_DEVICE_WIPE_SIG.to_string(),
        },
        message_encryption: MessageEncryptionVectors {
            plaintext: msg_plaintext.to_string(),
            reader_pubkeys: msg_readers.clone(),
            encrypted: encrypted_msg,
            volunteer_can_decrypt: true,
            admin_can_decrypt: true,
        },
        hub_key: HubKeyVectors {
            hub_key_hex: hub_key_hex.to_string(),
            member_pubkeys: hub_member_pubkeys,
            wrapped_envelopes: vec![hub_envelope_vol, hub_envelope_admin],
            label: LABEL_HUB_KEY_WRAP.to_string(),
        },
        export_encryption: ExportEncryptionVectors {
            plaintext_json: export_json.to_string(),
            secret_key_hex: TEST_SECRET_KEY.to_string(),
            encrypted_base64: export_encrypted,
        },
        call_record: CallRecordVectors {
            plaintext_json: call_record_json.to_string(),
            admin_pubkeys: vec![admin_x25519.clone()],
            encrypted_content: call_record_msg.encrypted_content,
            admin_envelopes: call_record_msg.reader_envelopes,
            admin_can_decrypt: true,
        },
        domain_separation: DomainSeparationVectors {
            original_key_hex: ds_key_hex.to_string(),
            recipient_pubkey_hex: admin_x25519.clone(),
            wrapped_with_note_label: ds_note,
            wrapped_with_message_label: ds_msg,
            wrapped_with_hub_label: ds_hub,
        },
        adversarial: AdversarialVectors {
            hpke: AdversarialHpke {
                valid_envelope: adv_envelope,
                valid_label: LABEL_NOTE_KEY.to_string(),
                tampered_ct,
                truncated_ct,
            },
            note: AdversarialNote {
                valid_encrypted: adv_note,
                tampered_content: tampered_note_content,
            },
            auth: AdversarialAuth {
                valid_token: adv_auth_token,
                valid_method: "GET".to_string(),
                valid_path: "/api/notes".to_string(),
                expired_timestamp: 1708900000000 - 360_000, // 6 minutes ago
                wrong_method: "POST".to_string(),
                wrong_path: "/api/calls".to_string(),
            },
            message: AdversarialMessage {
                valid_encrypted: adv_msg,
            },
        },
    };

    // Write test vectors to fixture file
    let json = serde_json::to_string_pretty(&vectors).unwrap();
    let fixture_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/test-vectors.json"
    );
    fs::write(fixture_path, &json).unwrap();

    println!("Test vectors v2 written to {fixture_path}");
}

// ─── Helper: Encrypt call record for test (mirrors JS server-side encrypt) ───

/// Manually encrypt call record metadata using HPKE + AES-256-GCM.
/// This mirrors what the server (Worker) does in JS.
fn encrypt_call_record_for_test(plaintext: &str, admin_pubkeys: &[String]) -> EncryptedMessage {
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };
    use zeroize::Zeroize;

    // Generate random per-record key
    let mut record_key = [0u8; 32];
    getrandom::getrandom(&mut record_key).expect("getrandom failed");

    // Generate random nonce (12 bytes for AES-256-GCM)
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).expect("getrandom failed");

    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(&record_key).unwrap();
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: LABEL_CALL_META.as_bytes(),
            },
        )
        .unwrap();

    let mut packed = Vec::with_capacity(12 + ciphertext.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&ciphertext);

    // Wrap the record key for each admin using LABEL_CALL_META via HPKE
    let reader_envelopes: Vec<RecipientKeyEnvelope> = admin_pubkeys
        .iter()
        .map(|pk| {
            let env = hpke_wrap_key(&record_key, pk, LABEL_CALL_META).unwrap();
            RecipientKeyEnvelope {
                pubkey: pk.clone(),
                enc: env.enc,
                ct: env.ct,
            }
        })
        .collect();

    record_key.zeroize();

    EncryptedMessage {
        encrypted_content: hex::encode(&packed),
        reader_envelopes,
    }
}

// ─── Helper: Tamper with hex string (flip a bit in the ciphertext area) ──────

fn tamper_hex(hex_str: &str) -> String {
    let mut bytes = hex::decode(hex_str).unwrap();
    // Flip a bit in the last byte (ciphertext/tag area, not nonce)
    if let Some(last) = bytes.last_mut() {
        *last ^= 0x01;
    }
    hex::encode(&bytes)
}

fn truncate_hex(hex_str: &str) -> String {
    // Remove last 2 hex chars (1 byte)
    hex_str[..hex_str.len() - 2].to_string()
}

// ─── Existing Tests ──────────────────────────────────────────

#[test]
fn hpke_cross_label_rejection() {
    let admin_x25519 = x25519_pubkey(TEST_ADMIN_SECRET_KEY);
    let key_bytes: [u8; 32] =
        hex::decode("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .unwrap()
            .try_into()
            .unwrap();

    let envelope = hpke_wrap_key(&key_bytes, &admin_x25519, LABEL_NOTE_KEY).unwrap();

    // Unwrapping with wrong label should fail
    let result = hpke_unwrap_key(&envelope, TEST_ADMIN_SECRET_KEY, LABEL_MESSAGE);
    assert!(result.is_err(), "Cross-label unwrap must fail");

    // Unwrapping with correct label should succeed
    let result = hpke_unwrap_key(&envelope, TEST_ADMIN_SECRET_KEY, LABEL_NOTE_KEY);
    assert!(result.is_ok(), "Same-label unwrap must succeed");
}

#[test]
fn auth_token_deterministic_verification() {
    let token =
        create_auth_token_from_signing_key(TEST_SECRET_KEY, 1708900000000, "GET", "/api/notes")
            .unwrap();

    // The auth token now uses Ed25519 — pubkey is the Ed25519 verifying key, NOT secp256k1 x-only.
    // Derive Ed25519 pubkey from the same seed for comparison.
    let sk_bytes = hex::decode(TEST_SECRET_KEY).unwrap();
    let sk_arr: [u8; 32] = sk_bytes.try_into().unwrap();
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&sk_arr);
    let expected_pubkey = hex::encode(signing_key.verifying_key().to_bytes());
    assert_eq!(token.pubkey, expected_pubkey);

    assert!(verify_auth_token(&token, "GET", "/api/notes").unwrap());
    assert!(!verify_auth_token(&token, "POST", "/api/notes").unwrap());
    assert!(!verify_auth_token(&token, "GET", "/api/calls").unwrap());
}

#[test]
fn pin_encryption_format_consistency() {
    let test_nsec = "nsec1testformatconsistency1234567890abcdef12345";
    let test_pubkey = &x25519_pubkey(TEST_SECRET_KEY);
    let encrypted = encrypt_with_pin(test_nsec, "56789012", test_pubkey).unwrap();

    assert!(!encrypted.salt.is_empty(), "salt must be present");
    assert!(!encrypted.nonce.is_empty(), "nonce must be present");
    assert!(
        !encrypted.ciphertext.is_empty(),
        "ciphertext must be present"
    );
    assert!(!encrypted.pubkey.is_empty(), "pubkey hash must be present");

    assert_eq!(
        encrypted.salt.len(),
        64,
        "salt must be 64 hex chars (32 bytes)"
    );
    assert_eq!(
        encrypted.nonce.len(),
        24,
        "nonce must be 24 hex chars (12 bytes)"
    );

    let decrypted = decrypt_with_pin(&encrypted, "56789012").unwrap();
    assert_eq!(decrypted, test_nsec);

    let result = decrypt_with_pin(&encrypted, "99999999");
    assert!(result.is_err(), "Wrong credential must fail");
}

// `label_count_matches_expected` was removed here (#1222). It built a
// `LabelVectors` struct from 32 hand-listed constants, serialised it, and
// asserted the resulting map had 32 entries — i.e. it compared the struct's
// own field count, a compile-time constant, against a literal. Adding a label
// to crypto-labels.json could never fail it, and by the time it was removed
// the source of truth held 95 labels while this test still said 32. Its
// comment ("update interop test if new labels were added") described an
// intention that nothing enforced.
//
// The property it claimed to check is enforced for real, derived from the
// source of truth rather than hardcoded, by these tests in
// packages/crypto/src/labels.rs:
//   - `label_registry_matches_json` — every label in crypto-labels.json exists
//     in LABEL_REGISTRY with the same value, and vice versa.
//   - `label_count_matches_json`    — the registry count equals the JSON count.

// ─── NEW v2 Tests ────────────────────────────────────────────

#[test]
fn message_encryption_roundtrip() {
    let author_x25519 = x25519_pubkey(TEST_SECRET_KEY);
    let admin_x25519 = x25519_pubkey(TEST_ADMIN_SECRET_KEY);

    let plaintext = "Multi-reader encrypted message test";
    let readers = vec![author_x25519.clone(), admin_x25519.clone()];
    let encrypted = encrypt_message(plaintext, &readers).unwrap();

    // Both readers can decrypt
    let vol = decrypt_message(
        &encrypted.encrypted_content,
        &encrypted.reader_envelopes,
        TEST_SECRET_KEY,
        &author_x25519,
    )
    .unwrap();
    assert_eq!(vol, plaintext);

    let admin = decrypt_message(
        &encrypted.encrypted_content,
        &encrypted.reader_envelopes,
        TEST_ADMIN_SECRET_KEY,
        &admin_x25519,
    )
    .unwrap();
    assert_eq!(admin, plaintext);

    // Wrong key fails
    let wrong_x25519 = x25519_pubkey(TEST_WRONG_SECRET_KEY);
    let result = decrypt_message(
        &encrypted.encrypted_content,
        &encrypted.reader_envelopes,
        TEST_WRONG_SECRET_KEY,
        &wrong_x25519,
    );
    assert!(result.is_err(), "Wrong reader key must fail");
}

#[test]
fn hub_key_multi_recipient_wrap() {
    let vol_x25519 = x25519_pubkey(TEST_SECRET_KEY);
    let admin_x25519 = x25519_pubkey(TEST_ADMIN_SECRET_KEY);

    let hub_key = [0xCA; 32]; // deterministic for test
    let vol_env = hpke_wrap_key(&hub_key, &vol_x25519, LABEL_HUB_KEY_WRAP).unwrap();
    let admin_env = hpke_wrap_key(&hub_key, &admin_x25519, LABEL_HUB_KEY_WRAP).unwrap();

    // Both unwrap to same hub key
    let vol_unwrapped = hpke_unwrap_key(&vol_env, TEST_SECRET_KEY, LABEL_HUB_KEY_WRAP).unwrap();
    let admin_unwrapped =
        hpke_unwrap_key(&admin_env, TEST_ADMIN_SECRET_KEY, LABEL_HUB_KEY_WRAP).unwrap();

    assert_eq!(*vol_unwrapped, hub_key);
    assert_eq!(*admin_unwrapped, hub_key);

    // Wrong label fails
    assert!(hpke_unwrap_key(&vol_env, TEST_SECRET_KEY, LABEL_NOTE_KEY).is_err());
}

#[test]
fn export_encryption_roundtrip() {
    let json = r#"{"notes":[],"exportedAt":"2024-06-15"}"#;
    let encrypted = encrypt_export(json, TEST_SECRET_KEY).unwrap();

    // Verify base64 encoding
    let decoded = STANDARD.decode(&encrypted).unwrap();
    assert!(decoded.len() >= 12 + 16, "must have nonce + tag minimum");

    // Since decrypt_export doesn't exist in Rust, verify structure manually:
    // First 12 bytes are nonce, rest is ciphertext + tag
    let _nonce = &decoded[..12];
    let _ciphertext = &decoded[12..];
}

#[test]
fn call_record_admin_only_decryption() {
    let admin_x25519 = x25519_pubkey(TEST_ADMIN_SECRET_KEY);
    let vol_x25519 = x25519_pubkey(TEST_SECRET_KEY);

    let plaintext = r#"{"answeredBy":"vol123","callerNumber":"+1555000"}"#;
    let encrypted = encrypt_call_record_for_test(plaintext, &[admin_x25519.clone()]);

    // Admin can decrypt
    let decrypted = decrypt_call_record(
        &encrypted.encrypted_content,
        &encrypted.reader_envelopes,
        TEST_ADMIN_SECRET_KEY,
        &admin_x25519,
    )
    .unwrap();
    assert_eq!(decrypted, plaintext);

    // Volunteer cannot (not in envelopes)
    let result = decrypt_call_record(
        &encrypted.encrypted_content,
        &encrypted.reader_envelopes,
        TEST_SECRET_KEY,
        &vol_x25519,
    );
    assert!(result.is_err(), "Volunteer must not decrypt call records");
}

#[test]
fn domain_separation_all_labels() {
    let admin_x25519 = x25519_pubkey(TEST_ADMIN_SECRET_KEY);
    let key = [0x42; 32];

    // Wrap same key with different labels
    let labels = [
        LABEL_NOTE_KEY,
        LABEL_MESSAGE,
        LABEL_HUB_KEY_WRAP,
        LABEL_CALL_META,
    ];
    let envelopes: Vec<_> = labels
        .iter()
        .map(|l| hpke_wrap_key(&key, &admin_x25519, l).unwrap())
        .collect();

    // Each envelope only unwraps with its own label
    for (i, env) in envelopes.iter().enumerate() {
        for (j, label) in labels.iter().enumerate() {
            let result = hpke_unwrap_key(env, TEST_ADMIN_SECRET_KEY, label);
            if i == j {
                assert!(result.is_ok(), "Same label must succeed: {label}");
                assert_eq!(*result.unwrap(), key);
            } else {
                assert!(
                    result.is_err(),
                    "Cross-label {}/{} must fail",
                    labels[i],
                    label
                );
            }
        }
    }
}
