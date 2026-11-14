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
}
