//! A restored backup decrypts what was sealed before the backup (#2140).
//!
//! The defect: app-generated device keys carry two independent seeds, the v4
//! backup stored only the signing seed, and restore re-derived a *different*
//! X25519 key. The restored user authenticated normally and decrypted nothing.
//!
//! Two legs, both through the real crate (the desktop Tauri mock reproduced the
//! defect, so no E2E could see it):
//!
//! 1. **Live round trip.** `generate_device_keys` → seal a note to the device as
//!    author *and* as admin → `create_backup` → JSON → `open_backup` with each
//!    credential → the restored secrets open both envelopes.
//! 2. **Committed vector.** `tests/fixtures/backup-restore-vectors.json` is a
//!    v5 backup written by this crate, plus a note sealed to that device before
//!    the backup was written. A change that leaves a pilot-era backup unable to
//!    restore the key that opens pilot-era data fails here, not in the field.
//!    Regenerate only with a deliberate format bump:
//!    `cargo test --test backup_restore -- --ignored --nocapture print_vector`.

use llamenos_core::backup::{
    create_backup, generate_recovery_key, open_backup, BackupCredential, BackupFile,
    BACKUP_FORMAT_VERSION,
};
use llamenos_core::device_keys::{generate_device_keys, unlock_device_keys, DeviceSecrets};
use llamenos_core::encryption::{decrypt_note, encrypt_note, EncryptedNote};
use llamenos_core::hpke_envelope::HpkeEnvelope as KeyEnvelope;
use serde::{Deserialize, Serialize};

const DEVICE_PIN: &str = "24681357";
const BACKUP_PIN: &str = "correct-horse-8";
const NOTE: &str = r#"{"text":"sealed before the backup"}"#;

fn secret_hex(secrets: &DeviceSecrets) -> String {
    hex::encode(secrets.encryption_seed)
}

fn encryption_pubkey_hex(secrets: &DeviceSecrets) -> String {
    hex::encode(secrets.encryption_pubkey().to_bytes())
}

fn signing_pubkey_hex(secrets: &DeviceSecrets) -> String {
    hex::encode(secrets.signing_pubkey().to_bytes())
}

/// Open the author envelope and the first admin envelope with `secrets`.
fn open_both(note: &EncryptedNote, secrets: &DeviceSecrets) {
    let sk = secret_hex(secrets);
    let as_author = decrypt_note(&note.encrypted_content, &note.author_envelope, &sk)
        .expect("restored device opens its author envelope");
    assert_eq!(as_author, NOTE);
    let admin = &note.admin_envelopes[0];
    let admin_envelope = KeyEnvelope {
        enc: admin.enc.clone(),
        ct: admin.ct.clone(),
    };
    let as_admin = decrypt_note(&note.encrypted_content, &admin_envelope, &sk)
        .expect("restored device opens its admin envelope");
    assert_eq!(as_admin, NOTE);
}

#[test]
fn restored_backup_opens_a_note_sealed_before_the_backup() {
    let blob = generate_device_keys("device-before", DEVICE_PIN).expect("generate");
    let original = unlock_device_keys(&blob, DEVICE_PIN).expect("unlock");
    // The precondition that made #2140 possible: the two seeds are independent.
    assert_ne!(original.signing_seed, original.encryption_seed);

    let pubkey = encryption_pubkey_hex(&original);
    assert_eq!(pubkey, blob.state.encryption_pubkey_hex);
    let note = encrypt_note(NOTE, &pubkey, std::slice::from_ref(&pubkey)).expect("seal note");

    let recovery_key = generate_recovery_key();
    let backup =
        create_backup(&original, BACKUP_PIN, &recovery_key, 1_760_000_000).expect("create backup");
    let json = serde_json::to_string(&backup).expect("serialize");
    drop(original);

    let parsed: BackupFile = serde_json::from_str(&json).expect("parse");
    for credential in [
        BackupCredential::RecoveryKey(&recovery_key),
        BackupCredential::Pin(BACKUP_PIN),
    ] {
        let restored = open_backup(&parsed, credential).expect("open backup");
        assert_eq!(
            signing_pubkey_hex(&restored),
            blob.state.signing_pubkey_hex,
            "restored identity"
        );
        assert_eq!(
            encryption_pubkey_hex(&restored),
            blob.state.encryption_pubkey_hex,
            "restored X25519 key must be the one the data was sealed to (#2140)"
        );
        open_both(&note, &restored);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    description: String,
    recovery_key: String,
    pin: String,
    signing_pubkey_hex: String,
    encryption_pubkey_hex: String,
    plaintext: String,
    backup: BackupFile,
    note_sealed_before_backup: EncryptedNote,
}

const FIXTURE: &str = include_str!("fixtures/backup-restore-vectors.json");

#[test]
fn committed_v5_backup_restores_the_key_that_opens_pre_backup_data() {
    let vector: Vector = serde_json::from_str(FIXTURE).expect("fixture parses");
    assert_eq!(vector.backup.v, BACKUP_FORMAT_VERSION);
    assert_eq!(vector.plaintext, NOTE);
    for credential in [
        BackupCredential::RecoveryKey(&vector.recovery_key),
        BackupCredential::Pin(&vector.pin),
    ] {
        let restored = open_backup(&vector.backup, credential).expect("open committed backup");
        assert_eq!(signing_pubkey_hex(&restored), vector.signing_pubkey_hex);
        assert_eq!(
            encryption_pubkey_hex(&restored),
            vector.encryption_pubkey_hex
        );
        open_both(&vector.note_sealed_before_backup, &restored);
    }
}

/// Writes the committed vector. Ignored: it is random, so running it in CI would
/// prove nothing and the output must be reviewed before it replaces the fixture.
#[test]
#[ignore]
fn print_vector() {
    let blob = generate_device_keys("vector-device", DEVICE_PIN).expect("generate");
    let secrets = unlock_device_keys(&blob, DEVICE_PIN).expect("unlock");
    let pubkey = encryption_pubkey_hex(&secrets);
    let note = encrypt_note(NOTE, &pubkey, std::slice::from_ref(&pubkey)).expect("seal note");
    let recovery_key = generate_recovery_key();
    let backup = create_backup(&secrets, BACKUP_PIN, &recovery_key, 1_764_000_000).expect("backup");
    let vector = Vector {
        description: "v5 backup of an app-generated device (independent seeds), and a note \
            sealed to that device as author and admin before the backup was written. \
            Restoring with either credential must yield the same X25519 key and open both \
            envelopes (#2140). Generated by `print_vector` in tests/backup_restore.rs."
            .into(),
        recovery_key,
        pin: BACKUP_PIN.into(),
        signing_pubkey_hex: signing_pubkey_hex(&secrets),
        encryption_pubkey_hex: pubkey,
        plaintext: NOTE.into(),
        backup,
        note_sealed_before_backup: note,
    };
    println!("{}", serde_json::to_string_pretty(&vector).unwrap());
}
