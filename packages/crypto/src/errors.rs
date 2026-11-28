//! Error types for llamenos-core cryptographic operations.

use thiserror::Error;

#[derive(Error, Debug)]
#[cfg_attr(feature = "mobile", derive(uniffi::Error))]
#[cfg_attr(feature = "mobile", uniffi(flat_error))]
pub enum CryptoError {
    #[error("Invalid secret key: must be 32 bytes hex")]
    InvalidSecretKey,

    #[error("Invalid public key: must be a valid 32-byte key, hex-encoded")]
    InvalidPublicKey,

    #[error("Invalid ephemeral public key")]
    InvalidEphemeralKey,

    #[error("ECDH shared secret computation failed")]
    EcdhFailed,

    #[error("Encryption failed: {0}")]
    EncryptionFailed(String),

    #[error("Decryption failed: authentication tag mismatch")]
    DecryptionFailed,

    #[error("Invalid hex encoding: {0}")]
    HexError(#[from] hex::FromHexError),

    #[error("Invalid nonce length: expected 12 bytes")]
    InvalidNonce,

    #[error("Invalid ciphertext: too short")]
    InvalidCiphertext,

    #[error("Key derivation failed: {0}")]
    KeyDerivationFailed(String),

    #[error("Signature verification failed")]
    SignatureVerificationFailed,

    #[error("JSON serialization error: {0}")]
    JsonError(#[from] serde_json::Error),

    #[error("Wrong PIN or corrupted data")]
    WrongPin,

    #[error("Invalid PIN: use 8 or more digits, or a passphrase of 8 or more characters with at least one letter")]
    InvalidPin,

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("invalid format: {0}")]
    InvalidFormat(String),

    #[error("HKDF expand failed")]
    HkdfExpandError,

    #[error("Invalid signature")]
    InvalidSignature,

    #[error("Stale timestamp: message is older than allowed max age")]
    StaleTimestamp,

    #[error("Future timestamp: message timestamp is ahead of current time")]
    FutureTimestamp,

    /// An identifier outside the §2.1 profile (`^[0-9a-z][0-9a-z-]{0,63}$` or lowercase hex).
    #[error("Invalid identifier: {0}")]
    InvalidIdentifier(String),

    /// No relay-event key is held for this hub and epoch.
    #[error("No event key held for this hub and epoch")]
    NoEventKey,

    /// A user sigchain refused by one of its closed rules. `code` is the
    /// rejection code the vectors name (`chain_device_pop`, `chain_key_reused`,
    /// `chain_unauthorised_signer`, …); see [`crate::sigchain`].
    #[error("sigchain rejected ({code}): {detail}")]
    SigchainRejected { code: &'static str, detail: String },

    /// A hub authority chain link or recovery approval refused by one of its
    /// closed rules (wire spec §5, §6.1): `chain_prev_hash`, `chain_fork`,
    /// `chain_unauthorised_signer`, `recovery_threshold`, …; see
    /// [`crate::hub_chain`].
    #[error("hub chain rejected ({code}): {detail}")]
    HubChainRejected { code: &'static str, detail: String },

    /// A device backup that does not carry the device's X-Wing seed — a v5 or
    /// older file, or a payload holding only the signing and X25519 seeds. It
    /// is never half-restored: the X-Wing key the user's chain names for the
    /// device would have no private half, so the restored device would sign in
    /// and decrypt nothing. Recover onto a new device identity instead
    /// (spec 2026-11-25-v2-device-linking-and-recovery L7; #3053).
    #[error("This backup does not contain the device's X-Wing seed, so it cannot restore the device. Recover your account onto a new device instead.")]
    BackupMissingXwingSeed,

    /// The hub has no admin reader to seal to. See [`crate::readers`].
    #[error("No admin reader: the hub has no admin with a registered device and no escrow key, so nobody could read what is about to be written")]
    NoAdminReader,
}

impl CryptoError {
    /// The closed rejection code a cross-platform vector names (spec §6.1).
    /// Tests assert this code, never merely that something failed.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidFormat(_)
            | Self::HexError(_)
            | Self::InvalidCiphertext
            | Self::InvalidNonce
            | Self::InvalidEphemeralKey
            | Self::InvalidPublicKey
            | Self::InvalidSecretKey => "invalid_format",
            Self::DecryptionFailed => "decryption_failed",
            Self::InvalidIdentifier(_) => "invalid_id",
            Self::NoEventKey => "no_event_key",
            Self::SigchainRejected { code, .. } => code,
            Self::HubChainRejected { code, .. } => code,
            Self::BackupMissingXwingSeed => "backup_missing_xwing_seed",
            _ => "invalid_input",
        }
    }
}
