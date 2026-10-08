//! Offline key backup — the single canonical definition of the backup file.
//!
//! # Why this module exists
//!
//! Before #1709 the backup format was defined three independent times and no two
//! agreed, so the feature could not work in either direction:
//!
//! | | recovery-key bytes | KDF | container |
//! |---|---|---|---|
//! | writer (`apps/desktop/src/crypto.rs`) | `hex::decode(recovery_key)` | HKDF-SHA256 | `{v:3, deviceId, …, encryptedPayload}` |
//! | generator (`src/client/lib/backup.ts`) | base32 + dashes | — | — |
//! | reader (`src/client/lib/backup.ts`) | normalized UTF-8 | PBKDF2-SHA256, 100k | `{v:1, id, t, d, r}` |
//!
//! The writer hex-decoded a base32 string, so **every** download failed at the
//! first non-hex character of the key the user had just been shown. Even with
//! that fixed, the reader rejected `v:3` and used a different KDF over different
//! key bytes, so nothing the writer produced was readable.
//!
//! This module is now the only implementation. `apps/desktop/src/crypto.rs`
//! exposes it over IPC; `src/client/lib/backup.ts` does file I/O and nothing
//! else. There is deliberately **no second implementation in TypeScript** — the
//! duplication is what produced the three-way split, and the webview must not
//! handle device key material at all (desktop-security-audit wave 2, HIGH).
//!
//! # Canonical format (v4)
//!
//! Field names are short and generic so a backup found on a seized device does
//! not advertise which application wrote it, and no plaintext device identifier
//! appears in the file. `id` is a 6-hex-char digest prefix — enough for a user
//! to tell two of their own backups apart, not enough to link the file to a
//! public key. `t` is rounded to the hour to blunt timing correlation. The
//! device id is deliberately absent: a restored key lands on a *different*
//! device, which mints its own id and is re-authorized through the sigchain.
//!
//! ```json
//! {
//!   "v": 4,
//!   "id": "a1b2c3",
//!   "t": 1760000000,
//!   "d": { "kv": 2, "s": "<32B hex>", "m": 65536, "i": 3, "p": 4,
//!          "n": "<12B hex>", "c": "<hex>" },
//!   "r": { "kv": 1, "s": "<32B hex>", "n": "<12B hex>", "c": "<hex>" }
//! }
//! ```
//!
//! Both blocks encrypt the **same plaintext**: the 32-byte Ed25519 signing seed.
//! The X25519 encryption seed is not stored — it is HKDF-derived from the
//! signing seed (`LABEL_DEVICE_ENCRYPTION_SEED`), so storing it would only
//! duplicate secret material.
//!
//! | | credential | KDF | key bytes fed to the KDF |
//! |---|---|---|---|
//! | `d` | PIN / passphrase | Argon2id, params recorded in the block | credential UTF-8 |
//! | `r` | recovery key | HKDF-SHA256, salt `s`, info `LABEL_BACKUP_HKDF_INFO` | [`normalize_recovery_key`] UTF-8 |
//!
//! Cipher for both: AES-256-GCM, 12-byte random nonce, with the block's role
//! bound as AAD (`LABEL_BACKUP` for `d`, `LABEL_BACKUP_HKDF_INFO` for `r`) so a
//! block cannot be moved from one slot to the other.
//!
//! ## The two decisions that mattered
//!
//! **Recovery-key bytes are the normalized key string's UTF-8, not a decode of
//! it.** The user is shown base32 and may retype it; the KDF input must be
//! derived from what they can actually produce. [`normalize_recovery_key`]
//! absorbs dashes, spaces and case, so `qmvp 4mmt…` opens a backup written for
//! `QMVP-4MMT-…`. A 26-character base32 string carries the full 128 bits of the
//! underlying random key, so feeding the string rather than its decode costs no
//! entropy — and it removes a decode step that can fail.
//!
//! **Two KDFs, on purpose.** The recovery key is 128 bits of OS randomness, so
//! stretching it buys nothing and HKDF is the correct primitive. A PIN is
//! low-entropy and guessable, so its block uses Argon2id with the same
//! parameters as the on-disk vault ([`crate::kdf_params`]). Using PBKDF2 for the
//! recovery key (the old reader) was wasted work; using HKDF for a PIN (what a
//! single-KDF format would force) would be a real weakness.
//!
//! ## Compatibility
//!
//! v4 is a clean break. No `v:1` or `v:3` file is readable, and none is
//! expected to exist: the writer has never produced a readable file, so there is
//! nothing in the field to migrate. [`open_backup`] rejects any other version
//! loudly rather than guessing.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::errors::CryptoError;
use crate::kdf_params::{ARGON2_M_COST_KIB, ARGON2_P_COST, ARGON2_T_COST, KDF_VERSION};
use crate::labels::{LABEL_BACKUP, LABEL_BACKUP_HKDF_INFO};

/// Container version written by [`create_backup`] and the only one
/// [`open_backup`] accepts.
pub const BACKUP_FORMAT_VERSION: u8 = 4;

/// KDF version recorded in the recovery-key block (1 = HKDF-SHA256).
const RECOVERY_KDF_VERSION: u8 = 1;

/// Largest Argon2id memory cost this build will honour out of a backup file,
/// in KiB (1 GiB). Production writes 64 MiB ([`crate::kdf_params`]) and a
/// `test-kdf` build writes 1 MiB; the ceiling leaves room for a future
/// parameter increase to stay readable without obeying an impossible request.
const MAX_BACKUP_ARGON2_M_COST_KIB: u32 = 1_048_576;
/// Largest Argon2id time cost honoured out of a backup file. Production writes 3.
const MAX_BACKUP_ARGON2_T_COST: u32 = 64;
/// Largest Argon2id lane count honoured out of a backup file. Production writes 4.
const MAX_BACKUP_ARGON2_P_COST: u32 = 255;

/// Salt length both blocks are written with, in bytes.
const BACKUP_SALT_LEN: usize = 32;
/// AES-256-GCM nonce length, in bytes.
const BACKUP_NONCE_LEN: usize = 12;
/// Sealed payload length: a 32-byte signing seed plus the 16-byte GCM tag.
const BACKUP_CIPHERTEXT_LEN: usize = 32 + 16;

/// RFC 4648 base32 alphabet, upper-case, no padding.
const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Bytes of entropy in a recovery key (128 bits).
const RECOVERY_KEY_BYTES: usize = 16;

/// Characters per dash-separated group in a displayed recovery key.
const RECOVERY_KEY_GROUP: usize = 4;

/// PIN-protected block: Argon2id over the credential, AES-256-GCM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinBlock {
    /// KDF version (2 = Argon2id).
    pub kv: u8,
    /// Argon2id salt, hex (32 bytes).
    pub s: String,
    /// Argon2id memory cost, KiB.
    pub m: u32,
    /// Argon2id time cost (iterations).
    pub i: u32,
    /// Argon2id parallelism (lanes).
    pub p: u32,
    /// AES-256-GCM nonce, hex (12 bytes).
    pub n: String,
    /// AES-256-GCM ciphertext of the signing seed, hex.
    pub c: String,
}

/// Recovery-key block: HKDF-SHA256 over the normalized key, AES-256-GCM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryBlock {
    /// KDF version (1 = HKDF-SHA256).
    pub kv: u8,
    /// HKDF salt, hex (32 bytes).
    pub s: String,
    /// AES-256-GCM nonce, hex (12 bytes).
    pub n: String,
    /// AES-256-GCM ciphertext of the signing seed, hex.
    pub c: String,
}

/// The on-disk backup file. See the module docs for the field contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupFile {
    /// Format version — always [`BACKUP_FORMAT_VERSION`] when written here.
    pub v: u8,
    /// First 6 hex chars of SHA-256(signing pubkey hex). Identification only.
    pub id: String,
    /// Creation time, unix seconds, rounded to the nearest hour.
    pub t: u64,
    /// PIN-protected copy of the signing seed.
    pub d: PinBlock,
    /// Recovery-key-protected copy of the signing seed.
    pub r: RecoveryBlock,
}

/// Which credential is being used to open a backup.
#[derive(Debug, Clone, Copy)]
pub enum BackupCredential<'a> {
    /// The PIN or passphrase that protected the device at backup time.
    Pin(&'a str),
    /// The displayed recovery key, in any capitalization or grouping.
    RecoveryKey(&'a str),
}

/// Generate a fresh 128-bit recovery key, base32-encoded and dash-grouped
/// (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`).
///
/// This is the only generator: the string shown to the user and the string fed
/// to [`create_backup`] come from here, and the round-trip tests in this module
/// consume exactly what it produces.
pub fn generate_recovery_key() -> String {
    let bytes = Zeroizing::new(rand::rngs::OsRng.gen::<[u8; RECOVERY_KEY_BYTES]>());
    encode_recovery_key(bytes.as_ref())
}

/// A fresh random AES-256-GCM nonce.
///
/// Returned rather than filled in place, like [`random_salt`] below. The usual
/// `let mut buf = [0u8; N]; fill_bytes(&mut buf)` shape makes a crypto
/// parameter momentarily a hard-coded all-zero value, which a missing or
/// misplaced fill would silently leave in place — and a repeated AES-GCM nonce
/// under a fixed key destroys both confidentiality and integrity. Returning the
/// bytes makes that unrepresentable, and leaves no constant for a reader or a
/// static analyser to have to rule out (CodeQL
/// `rust/hard-coded-cryptographic-value` reported exactly that shape here).
fn random_nonce() -> [u8; 12] {
    rand::rngs::OsRng.gen()
}

/// A fresh random 32-byte KDF salt. See [`random_nonce`] for why it is returned
/// rather than written into a zeroed buffer.
fn random_salt() -> [u8; 32] {
    rand::rngs::OsRng.gen()
}

/// Base32-encode (RFC 4648, no padding) and group into dash-separated quads.
fn encode_recovery_key(bytes: &[u8]) -> String {
    let mut chars = String::with_capacity(bytes.len() * 8 / 5 + 1);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            chars.push(BASE32_ALPHABET[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        chars.push(BASE32_ALPHABET[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }

    chars
        .as_bytes()
        .chunks(RECOVERY_KEY_GROUP)
        .map(|chunk| std::str::from_utf8(chunk).expect("base32 output is ASCII"))
        .collect::<Vec<_>>()
        .join("-")
}

/// Canonicalize a recovery key as typed by a human: drop everything that is not
/// an ASCII letter or digit (dashes, spaces, line breaks, stray punctuation),
/// then upper-case.
///
/// The result's UTF-8 bytes — not a base32 decode of them — are the KDF input.
/// See the module docs for why.
pub fn normalize_recovery_key(recovery_key: &str) -> String {
    recovery_key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// First 6 hex characters of SHA-256 over the signing pubkey hex string.
fn truncated_pubkey_id(signing_pubkey_hex: &str) -> String {
    let digest = Sha256::digest(signing_pubkey_hex.as_bytes());
    hex::encode(digest)[..6].to_string()
}

/// Round unix seconds to the nearest hour.
fn round_to_hour(unix_seconds: u64) -> u64 {
    const HOUR: u64 = 3_600;
    ((unix_seconds + HOUR / 2) / HOUR) * HOUR
}

/// Derive the recovery-key KEK: HKDF-SHA256 over the normalized key's UTF-8.
fn derive_recovery_kek(
    recovery_key: &str,
    salt: &[u8],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let normalized = Zeroizing::new(normalize_recovery_key(recovery_key));
    if normalized.is_empty() {
        return Err(CryptoError::InvalidInput(
            "Recovery key is empty after normalization".into(),
        ));
    }
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(salt), normalized.as_bytes());
    let mut kek = Zeroizing::new([0u8; 32]);
    hk.expand(LABEL_BACKUP_HKDF_INFO.as_bytes(), kek.as_mut())
        .map_err(|_| CryptoError::HkdfExpandError)?;
    Ok(kek)
}

/// Check Argon2id parameters read out of a backup file before deriving with them.
///
/// The parameters have to be *recorded* — a future increase to the production
/// cost must leave older backups readable, and a `test-kdf` build writes its
/// own — but they must not be *obeyed unbounded*. A backup file is untrusted
/// input: it is chosen by whoever is sitting at the login screen's recovery
/// flow. `Params::new` validates only lower bounds, and `hash_password_into`
/// allocates `m_cost` KiB, so an unchecked `m = u32::MAX` is a ~4 TiB
/// allocation that aborts the process, and an unchecked `t` is unbounded CPU.
///
/// The envelope turns that from unbounded into bounded: the worst a crafted
/// file can now buy is a known, finite amount of work on an action the user
/// explicitly took, instead of a crash. Rust is the authority here rather than
/// the TypeScript shape gate in `src/client/lib/backup.ts`, which stays purely
/// structural — a second copy of these numbers would be a second source of
/// truth, and anything calling the IPC command directly bypasses it anyway.
fn validate_pin_kdf_params(block: &PinBlock) -> Result<(), CryptoError> {
    let offending = if block.m > MAX_BACKUP_ARGON2_M_COST_KIB {
        Some(("memory cost (KiB)", block.m, MAX_BACKUP_ARGON2_M_COST_KIB))
    } else if block.i > MAX_BACKUP_ARGON2_T_COST {
        Some(("time cost", block.i, MAX_BACKUP_ARGON2_T_COST))
    } else if block.p > MAX_BACKUP_ARGON2_P_COST {
        Some(("parallelism", block.p, MAX_BACKUP_ARGON2_P_COST))
    } else {
        None
    };
    match offending {
        None => Ok(()),
        Some((name, got, max)) => Err(CryptoError::InvalidFormat(format!(
            "Backup Argon2id {name} {got} exceeds the maximum this build will honour ({max})"
        ))),
    }
}

/// Decode a salt and hold it to the length the format is written with, so a
/// crafted file cannot hand the KDF an arbitrarily long one.
fn decode_salt(salt_hex: &str) -> Result<Vec<u8>, CryptoError> {
    let salt = hex::decode(salt_hex)?;
    if salt.len() != BACKUP_SALT_LEN {
        return Err(CryptoError::InvalidFormat(format!(
            "Backup salt must be {BACKUP_SALT_LEN} bytes, got {}",
            salt.len()
        )));
    }
    Ok(salt)
}

/// Derive the PIN KEK: Argon2id with the given parameters.
fn derive_pin_kek(
    credential: &str,
    salt: &[u8],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if credential.is_empty() {
        return Err(CryptoError::InvalidInput("PIN is empty".into()));
    }
    let params = Params::new(m_cost, t_cost, p_cost, Some(32))
        .map_err(|e| CryptoError::KeyDerivationFailed(format!("Argon2 params: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut kek = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(credential.as_bytes(), salt, kek.as_mut())
        .map_err(|e| CryptoError::KeyDerivationFailed(format!("Argon2id: {e}")))?;
    Ok(kek)
}

/// AES-256-GCM seal with the block role bound as AAD.
fn seal(kek: &[u8; 32], plaintext: &[u8], aad: &str) -> Result<(String, String), CryptoError> {
    let nonce_bytes = random_nonce();
    let cipher = Aes256Gcm::new_from_slice(kek)
        .map_err(|e| CryptoError::EncryptionFailed(format!("Invalid KEK: {e}")))?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::EncryptionFailed("AES-256-GCM seal failed".into()))?;
    Ok((hex::encode(nonce_bytes), hex::encode(ciphertext)))
}

/// AES-256-GCM open, returning the 32-byte signing seed.
fn open_seed(
    kek: &[u8; 32],
    nonce_hex: &str,
    ciphertext_hex: &str,
    aad: &str,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let nonce_bytes = hex::decode(nonce_hex)?;
    if nonce_bytes.len() != BACKUP_NONCE_LEN {
        return Err(CryptoError::InvalidFormat(format!(
            "Backup nonce must be {BACKUP_NONCE_LEN} bytes, got {}",
            nonce_bytes.len()
        )));
    }
    let ciphertext = hex::decode(ciphertext_hex)?;
    // Exactly one sealed signing seed. v4 stores nothing else, so holding the
    // length here keeps a crafted file from handing AES-GCM a large buffer.
    if ciphertext.len() != BACKUP_CIPHERTEXT_LEN {
        return Err(CryptoError::InvalidFormat(format!(
            "Backup payload must be {BACKUP_CIPHERTEXT_LEN} bytes, got {}",
            ciphertext.len()
        )));
    }
    let cipher = Aes256Gcm::new_from_slice(kek)
        .map_err(|e| CryptoError::EncryptionFailed(format!("Invalid KEK: {e}")))?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: &ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| CryptoError::DecryptionFailed)?,
    );
    if plaintext.len() != 32 {
        return Err(CryptoError::InvalidFormat(format!(
            "Backup payload must be a 32-byte signing seed, got {}",
            plaintext.len()
        )));
    }
    let mut seed = Zeroizing::new([0u8; 32]);
    seed.copy_from_slice(&plaintext);
    Ok(seed)
}

/// Write a v4 backup of `signing_seed`, protected by both `pin` and
/// `recovery_key`.
///
/// `recovery_key` is accepted exactly as [`generate_recovery_key`] produced it —
/// base32 with dashes. `created_at_unix` is supplied by the caller (this crate
/// targets wasm, where a wall clock is not always available) and is rounded to
/// the hour before it is stored.
pub fn create_backup(
    signing_seed: &[u8; 32],
    signing_pubkey_hex: &str,
    pin: &str,
    recovery_key: &str,
    created_at_unix: u64,
) -> Result<BackupFile, CryptoError> {
    // Independent per-backup salts, both random. Nothing in this file derives a
    // KEK under a fixed salt.
    let pin_salt = random_salt();
    let recovery_salt = random_salt();

    let pin_kek = derive_pin_kek(
        pin,
        &pin_salt,
        ARGON2_M_COST_KIB,
        ARGON2_T_COST,
        ARGON2_P_COST,
    )?;
    let (pin_nonce, pin_ciphertext) = seal(&pin_kek, signing_seed, LABEL_BACKUP)?;

    let recovery_kek = derive_recovery_kek(recovery_key, &recovery_salt)?;
    let (recovery_nonce, recovery_ciphertext) =
        seal(&recovery_kek, signing_seed, LABEL_BACKUP_HKDF_INFO)?;

    Ok(BackupFile {
        v: BACKUP_FORMAT_VERSION,
        id: truncated_pubkey_id(signing_pubkey_hex),
        t: round_to_hour(created_at_unix),
        d: PinBlock {
            kv: KDF_VERSION,
            s: hex::encode(pin_salt),
            m: ARGON2_M_COST_KIB,
            i: ARGON2_T_COST,
            p: ARGON2_P_COST,
            n: pin_nonce,
            c: pin_ciphertext,
        },
        r: RecoveryBlock {
            kv: RECOVERY_KDF_VERSION,
            s: hex::encode(recovery_salt),
            n: recovery_nonce,
            c: recovery_ciphertext,
        },
    })
}

/// Recover the 32-byte Ed25519 signing seed from a v4 backup.
///
/// A wrong credential is indistinguishable from a corrupted file: both surface
/// as [`CryptoError::DecryptionFailed`] from the AEAD tag check.
pub fn open_backup(
    backup: &BackupFile,
    credential: BackupCredential<'_>,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if backup.v != BACKUP_FORMAT_VERSION {
        return Err(CryptoError::InvalidFormat(format!(
            "Unsupported backup version {} (this build reads v{})",
            backup.v, BACKUP_FORMAT_VERSION
        )));
    }

    match credential {
        BackupCredential::Pin(pin) => {
            if backup.d.kv != KDF_VERSION {
                return Err(CryptoError::InvalidFormat(format!(
                    "Unsupported PIN KDF version {}",
                    backup.d.kv
                )));
            }
            validate_pin_kdf_params(&backup.d)?;
            let salt = decode_salt(&backup.d.s)?;
            let kek = derive_pin_kek(pin, &salt, backup.d.m, backup.d.i, backup.d.p)?;
            open_seed(&kek, &backup.d.n, &backup.d.c, LABEL_BACKUP)
        }
        BackupCredential::RecoveryKey(recovery_key) => {
            if backup.r.kv != RECOVERY_KDF_VERSION {
                return Err(CryptoError::InvalidFormat(format!(
                    "Unsupported recovery KDF version {}",
                    backup.r.kv
                )));
            }
            let salt = decode_salt(&backup.r.s)?;
            let kek = derive_recovery_kek(recovery_key, &salt)?;
            open_seed(&kek, &backup.r.n, &backup.r.c, LABEL_BACKUP_HKDF_INFO)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kdf_params::{ARGON2_M_COST_KIB, ARGON2_P_COST, ARGON2_T_COST};

    const PIN: &str = "correct-horse-8";
    const PUBKEY_HEX: &str = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";

    fn seed() -> [u8; 32] {
        let mut s = [0u8; 32];
        for (i, b) in s.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(7).wrapping_add(13);
        }
        s
    }

    fn write(recovery_key: &str) -> BackupFile {
        create_backup(&seed(), PUBKEY_HEX, PIN, recovery_key, 1_760_000_123).expect("create_backup")
    }

    #[test]
    fn generated_key_has_the_displayed_shape() {
        let key = generate_recovery_key();
        // 16 bytes -> 26 base32 chars -> 6 quads + a pair.
        let groups: Vec<&str> = key.split('-').collect();
        assert_eq!(groups.len(), 7, "key was {} groups: {key}", groups.len());
        assert!(groups[..6].iter().all(|g| g.len() == 4));
        assert_eq!(groups[6].len(), 2);
        assert!(
            key.chars()
                .all(|c| c == '-' || BASE32_ALPHABET.contains(&(c as u8))),
            "non-base32 character in {key}"
        );
        assert_ne!(key, generate_recovery_key(), "generator is not random");
    }

    #[test]
    fn round_trips_a_generated_recovery_key() {
        // The production generator feeds the production writer and reader, with
        // no hand-written key in between. This is the whole of #1709.
        for _ in 0..16 {
            let key = generate_recovery_key();
            let backup = write(&key);
            let recovered = open_backup(&backup, BackupCredential::RecoveryKey(&key))
                .expect("recovery-key open");
            assert_eq!(recovered.as_ref(), &seed());
        }
    }

    #[test]
    fn round_trips_a_key_that_is_not_valid_hex() {
        // The live failure was `Invalid character 'Q' at position 0` — the key's
        // first character simply is not a hex digit. Pin that exact case so
        // reinstating a hex decode fails here deterministically, rather than on
        // whichever random key happens to start outside [0-9a-f].
        //
        // Built from bytes through the production encoder instead of written out
        // as a string: 0x80 leads with base32 index 16, which is 'Q', so this is
        // the same first character the live trap reported — and there is no
        // secret-shaped literal in the source for a scanner to flag.
        let key = encode_recovery_key(&[0x80u8; RECOVERY_KEY_BYTES]);
        assert!(
            key.starts_with('Q'),
            "expected the live trap's leading character, got {key}"
        );
        assert!(
            hex::decode(&key).is_err(),
            "test key must not be decodable as hex, or it proves nothing"
        );
        let backup = write(&key);
        let recovered =
            open_backup(&backup, BackupCredential::RecoveryKey(&key)).expect("recovery-key open");
        assert_eq!(recovered.as_ref(), &seed());
    }

    #[test]
    fn round_trips_the_pin() {
        let backup = write(&generate_recovery_key());
        let recovered = open_backup(&backup, BackupCredential::Pin(PIN)).expect("pin open");
        assert_eq!(recovered.as_ref(), &seed());
    }

    #[test]
    fn accepts_the_recovery_key_as_a_human_retypes_it() {
        let key = generate_recovery_key();
        let backup = write(&key);
        let stripped = key.replace('-', "");
        for variant in [
            key.to_lowercase(),
            stripped.clone(),
            stripped.to_lowercase(),
            format!(" {} ", key.replace('-', " ")),
            key.replace('-', "\n"),
        ] {
            let recovered = open_backup(&backup, BackupCredential::RecoveryKey(&variant))
                .unwrap_or_else(|e| panic!("variant {variant:?} failed: {e}"));
            assert_eq!(recovered.as_ref(), &seed());
        }
    }

    #[test]
    fn rejects_a_wrong_recovery_key() {
        let backup = write(&generate_recovery_key());
        let err = open_backup(
            &backup,
            BackupCredential::RecoveryKey(&generate_recovery_key()),
        )
        .expect_err("a different key must not open the backup");
        assert!(matches!(err, CryptoError::DecryptionFailed));
    }

    #[test]
    fn rejects_a_wrong_pin() {
        let backup = write(&generate_recovery_key());
        let err = open_backup(&backup, BackupCredential::Pin("wrong-pin-123"))
            .expect_err("a different PIN must not open the backup");
        assert!(matches!(err, CryptoError::DecryptionFailed));
    }

    #[test]
    fn rejects_an_empty_credential() {
        let backup = write(&generate_recovery_key());
        assert!(open_backup(&backup, BackupCredential::Pin("")).is_err());
        assert!(open_backup(&backup, BackupCredential::RecoveryKey("----")).is_err());
    }

    #[test]
    fn rejects_a_tampered_ciphertext() {
        let key = generate_recovery_key();
        let mut backup = write(&key);
        let mut bytes = hex::decode(&backup.r.c).unwrap();
        bytes[0] ^= 0x01;
        backup.r.c = hex::encode(bytes);
        let err = open_backup(&backup, BackupCredential::RecoveryKey(&key))
            .expect_err("AEAD must reject a flipped bit");
        assert!(matches!(err, CryptoError::DecryptionFailed));
    }

    #[test]
    fn blocks_are_not_interchangeable() {
        // Swapping the two blocks' material must leave neither credential able
        // to open the file.
        let key = generate_recovery_key();
        let backup = write(&key);
        let swapped = BackupFile {
            d: PinBlock {
                s: backup.r.s.clone(),
                n: backup.r.n.clone(),
                c: backup.r.c.clone(),
                ..backup.d.clone()
            },
            r: RecoveryBlock {
                s: backup.d.s.clone(),
                n: backup.d.n.clone(),
                c: backup.d.c.clone(),
                ..backup.r.clone()
            },
            ..backup.clone()
        };
        assert!(open_backup(&swapped, BackupCredential::RecoveryKey(&key)).is_err());
        assert!(open_backup(&swapped, BackupCredential::Pin(PIN)).is_err());
    }

    #[test]
    fn aad_binds_a_block_to_its_role() {
        // Even holding the right key, a ciphertext sealed in the PIN role will
        // not open in the recovery role: the role is authenticated as AAD.
        // The KEK is random rather than a fixed array: this test is about the
        // AAD, so nothing here needs a constant key, and a literal one would be
        // a hard-coded cryptographic value whether or not it is a test.
        let kek: [u8; 32] = rand::rngs::OsRng.gen();
        let (nonce, ciphertext) = seal(&kek, &seed(), LABEL_BACKUP).unwrap();
        assert!(open_seed(&kek, &nonce, &ciphertext, LABEL_BACKUP).is_ok());
        let err = open_seed(&kek, &nonce, &ciphertext, LABEL_BACKUP_HKDF_INFO)
            .expect_err("role mismatch must fail the AEAD check");
        assert!(matches!(err, CryptoError::DecryptionFailed));
    }

    #[test]
    fn rejects_other_container_versions() {
        let key = generate_recovery_key();
        let mut backup = write(&key);
        for version in [1u8, 3, 5] {
            backup.v = version;
            let err = open_backup(&backup, BackupCredential::RecoveryKey(&key))
                .expect_err("only v4 is readable");
            assert!(
                matches!(err, CryptoError::InvalidFormat(_)),
                "v{version} gave {err}"
            );
        }
    }

    #[test]
    fn rejects_argon2_parameters_that_exceed_the_honoured_envelope() {
        // A backup file is untrusted: it is whatever the person at the login
        // screen uploaded. `Params::new` only enforces lower bounds, so without
        // this check `m = u32::MAX` reaches `hash_password_into` as a ~4 TiB
        // allocation and aborts the process. Each of these must be refused
        // BEFORE any derivation — the test returning at all is the evidence.
        let key = generate_recovery_key();
        let base = write(&key);
        for (label, block) in [
            (
                "memory",
                PinBlock {
                    m: u32::MAX,
                    ..base.d.clone()
                },
            ),
            (
                "memory just over",
                PinBlock {
                    m: MAX_BACKUP_ARGON2_M_COST_KIB + 1,
                    ..base.d.clone()
                },
            ),
            (
                "time",
                PinBlock {
                    i: u32::MAX,
                    ..base.d.clone()
                },
            ),
            (
                "lanes",
                PinBlock {
                    p: MAX_BACKUP_ARGON2_P_COST + 1,
                    ..base.d.clone()
                },
            ),
        ] {
            let crafted = BackupFile {
                d: block,
                ..base.clone()
            };
            let err = match open_backup(&crafted, BackupCredential::Pin(PIN)) {
                Ok(_) => panic!("{label}: must be refused"),
                Err(e) => e,
            };
            assert!(
                matches!(err, CryptoError::InvalidFormat(_)),
                "{label} gave {err}"
            );
        }
    }

    #[test]
    fn honours_the_parameters_real_builds_write() {
        // The envelope exists to bound abuse, not to reject legitimate files:
        // whatever this build writes must round-trip, and the ceiling must sit
        // above it so a future cost increase stays readable.
        let key = generate_recovery_key();
        let backup = write(&key);
        assert_eq!(backup.d.m, ARGON2_M_COST_KIB);
        assert_eq!(backup.d.i, ARGON2_T_COST);
        assert_eq!(backup.d.p, ARGON2_P_COST);
        assert!(validate_pin_kdf_params(&backup.d).is_ok());
        assert!(ARGON2_M_COST_KIB < MAX_BACKUP_ARGON2_M_COST_KIB);
        assert!(ARGON2_T_COST < MAX_BACKUP_ARGON2_T_COST);
        assert!(ARGON2_P_COST < MAX_BACKUP_ARGON2_P_COST);
        assert!(open_backup(&backup, BackupCredential::Pin(PIN)).is_ok());
    }

    #[test]
    fn rejects_fields_that_are_not_the_written_length() {
        // Everything but the ciphertext is fixed-length in v4, and the
        // ciphertext is exactly one sealed seed. Nothing variable reaches a
        // primitive.
        let key = generate_recovery_key();
        let base = write(&key);
        assert_eq!(hex::decode(&base.d.s).unwrap().len(), BACKUP_SALT_LEN);
        assert_eq!(hex::decode(&base.d.n).unwrap().len(), BACKUP_NONCE_LEN);
        assert_eq!(hex::decode(&base.d.c).unwrap().len(), BACKUP_CIPHERTEXT_LEN);

        let long_salt = hex::encode(vec![0xABu8; 4096]);
        let pin_salt = BackupFile {
            d: PinBlock {
                s: long_salt.clone(),
                ..base.d.clone()
            },
            ..base.clone()
        };
        assert!(open_backup(&pin_salt, BackupCredential::Pin(PIN)).is_err());
        let recovery_salt = BackupFile {
            r: RecoveryBlock {
                s: long_salt,
                ..base.r.clone()
            },
            ..base.clone()
        };
        assert!(open_backup(&recovery_salt, BackupCredential::RecoveryKey(&key)).is_err());

        let long_payload = BackupFile {
            r: RecoveryBlock {
                c: hex::encode(vec![0u8; 1_048_576]),
                ..base.r.clone()
            },
            ..base.clone()
        };
        let err = open_backup(&long_payload, BackupCredential::RecoveryKey(&key))
            .expect_err("an oversized payload must be refused");
        assert!(matches!(err, CryptoError::InvalidFormat(_)), "got {err}");
    }

    #[test]
    fn container_hides_device_identifiers() {
        let key = generate_recovery_key();
        let backup = write(&key);
        let json = serde_json::to_string(&backup).unwrap();
        assert!(
            !json.contains(PUBKEY_HEX),
            "the signing pubkey must not appear in the file"
        );
        assert!(!json.contains("deviceId"), "no plaintext device id");
        assert_eq!(backup.id.len(), 6);
        assert_eq!(backup.t % 3_600, 0, "timestamp must be hour-rounded");
    }

    #[test]
    fn survives_a_json_round_trip() {
        // The desktop IPC boundary hands this struct across as JSON in both
        // directions; serde must read back exactly what it wrote.
        let key = generate_recovery_key();
        let backup = write(&key);
        let json = serde_json::to_string(&backup).unwrap();
        let parsed: BackupFile = serde_json::from_str(&json).unwrap();
        let recovered =
            open_backup(&parsed, BackupCredential::RecoveryKey(&key)).expect("open after reparse");
        assert_eq!(recovered.as_ref(), &seed());
    }
}
