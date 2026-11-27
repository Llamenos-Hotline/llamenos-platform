//! A restored backup decrypts what was sealed before the backup (#2140, #3053).
//!
//! The defects: app-generated device keys carry independent seeds. The v4
//! backup stored only the signing seed, and restore re-derived a *different*
//! X25519 key (#2140). The v5 backup stored the signing and X25519 seeds but no
//! X-Wing seed, so the X-Wing key the user's chain names had no private half
//! after a restore (#3053). Either way the restored user authenticated normally
//! and decrypted nothing.
//!
//! Three legs, all through the real crate:
//!
//! 1. **Live round trip.** `generate_device_keys` → seal a note to the device as
//!    author *and* as admin, and encapsulate to its X-Wing key → `create_backup`
//!    → JSON → `open_backup` with each credential → the restored secrets open
//!    both envelopes and decapsulate the same shared key.
//! 2. **Committed vector.** `tests/fixtures/backup-restore-vectors.json` is a
//!    v6 backup written by this crate, plus a note and an X-Wing encapsulation
//!    sealed to that device before the backup was written. Regenerate only with
//!    a deliberate format bump:
//!    `cargo test --test backup_restore -- --ignored --nocapture print_vector`.
//! 3. **Refusal.** `tests/fixtures/backup-v5-without-xwing-seed.json` is a real
//!    v5 backup. It is refused as `BackupMissingXwingSeed` with either
//!    credential, never half-restored.

use llamenos_core::backup::{
    create_backup, generate_recovery_key, open_backup, BackupCredential, BackupFile,
    BACKUP_FORMAT_VERSION,
};
use llamenos_core::device_keys::{
    generate_device_keys, unlock_device_keys, xwing_decapsulation_key, DeviceSecrets,
};
use llamenos_core::encryption::{decrypt_note, encrypt_note, EncryptedNote};
use llamenos_core::errors::CryptoError;
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

fn kem_pubkey_hex(secrets: &DeviceSecrets) -> String {
    hex::encode(secrets.kem_pubkey())
}

/// Encapsulate to an X-Wing key with `randomness`: the ciphertext, hex, and the
/// shared key, hex.
fn xwing_seal_to(kem_pubkey_hex: &str, randomness: [u8; 64]) -> (String, String) {
    let ek = x_wing::EncapsulationKey::try_from(hex::decode(kem_pubkey_hex).unwrap().as_slice())
        .expect("an X-Wing key");
    let (ct, shared) = ek.encapsulate_deterministic(&randomness.into());
    (hex::encode(ct.as_slice()), hex::encode(shared.as_slice()))
}

/// Decapsulate an X-Wing ciphertext with the device's X-Wing seed.
fn xwing_open(secrets: &DeviceSecrets, ct_hex: &str) -> String {
    use x_wing::Decapsulate;
    let ct = x_wing::Ciphertext::try_from(hex::decode(ct_hex).unwrap().as_slice()).unwrap();
    let shared = xwing_decapsulation_key(&secrets.kem_seed).decapsulate(&ct);
    hex::encode(shared.as_slice())
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
    assert_eq!(kem_pubkey_hex(&original), blob.state.kem_pubkey_hex);
    let (xwing_ct, xwing_shared) = xwing_seal_to(&blob.state.kem_pubkey_hex, rand_bytes());

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
        assert_eq!(
            xwing_open(&restored, &xwing_ct),
            xwing_shared,
            "restored X-Wing seed must open what was sealed to the chain-named key (#3053)"
        );
        open_both(&note, &restored);
    }
}

fn rand_bytes() -> [u8; 64] {
    let mut b = [0u8; 64];
    getrandom::getrandom(&mut b).unwrap();
    b
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    description: String,
    recovery_key: String,
    pin: String,
    signing_pubkey_hex: String,
    encryption_pubkey_hex: String,
    kem_pubkey_hex: String,
    plaintext: String,
    backup: BackupFile,
    note_sealed_before_backup: EncryptedNote,
    /// X-Wing ciphertext encapsulated to `kem_pubkey_hex` before the backup.
    xwing_ciphertext_hex: String,
    /// The shared key it carries.
    xwing_shared_key_hex: String,
}

const FIXTURE: &str = include_str!("fixtures/backup-restore-vectors.json");

#[test]
fn committed_v6_backup_restores_the_keys_that_open_pre_backup_data() {
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
        assert_eq!(kem_pubkey_hex(&restored), vector.kem_pubkey_hex);
        assert_eq!(
            xwing_open(&restored, &vector.xwing_ciphertext_hex),
            vector.xwing_shared_key_hex
        );
        open_both(&vector.note_sealed_before_backup, &restored);
    }
}

const V5_FIXTURE: &str = include_str!("fixtures/backup-v5-without-xwing-seed.json");

#[test]
fn committed_v5_backup_is_refused_by_name() {
    let v: serde_json::Value = serde_json::from_str(V5_FIXTURE).expect("fixture parses");
    let backup: BackupFile = serde_json::from_value(v["backup"].clone()).unwrap();
    assert_eq!(backup.v, 5);
    for credential in [
        BackupCredential::RecoveryKey(v["recoveryKey"].as_str().unwrap()),
        BackupCredential::Pin(v["pin"].as_str().unwrap()),
    ] {
        let err = open_backup(&backup, credential).expect_err("v5 must be refused");
        assert!(
            matches!(err, CryptoError::BackupMissingXwingSeed),
            "got {err}"
        );
        assert!(err.to_string().contains("X-Wing seed"), "{err}");
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
    let (xwing_ciphertext_hex, xwing_shared_key_hex) =
        xwing_seal_to(&blob.state.kem_pubkey_hex, rand_bytes());
    let recovery_key = generate_recovery_key();
    let backup = create_backup(&secrets, BACKUP_PIN, &recovery_key, 1_764_000_000).expect("backup");
    let vector = Vector {
        description: "v6 backup of an app-generated device (independent seeds), a note sealed to \
            that device as author and admin, and an X-Wing encapsulation to its X-Wing key, all \
            made before the backup was written. Restoring with either credential must yield the \
            same X25519 and X-Wing keys, open both envelopes (#2140) and decapsulate the same \
            shared key (#3053). Generated by `print_vector` in tests/backup_restore.rs."
            .into(),
        recovery_key,
        pin: BACKUP_PIN.into(),
        signing_pubkey_hex: signing_pubkey_hex(&secrets),
        encryption_pubkey_hex: pubkey,
        kem_pubkey_hex: blob.state.kem_pubkey_hex.clone(),
        plaintext: NOTE.into(),
        backup,
        note_sealed_before_backup: note,
        xwing_ciphertext_hex,
        xwing_shared_key_hex,
    };
    println!("{}", serde_json::to_string_pretty(&vector).unwrap());
}
