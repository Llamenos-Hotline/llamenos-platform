//! # llamenos-core
//!
//! Shared cryptographic core for the Llamenos project.
//!
//! This crate provides all cryptographic operations used across all platforms:
//! - **Desktop (Tauri v2)**: native Rust dependency
//! - **Mobile (iOS/Android)**: UniFFI-generated Swift/Kotlin bindings
//! - **Server (Bun)**: loaded via bun:ffi as cdylib (feature = "server")
//!
//! ## Crypto Architecture (v3)
//!
//! - **Signing**: Ed25519 (ed25519-dalek)
//! - **Key agreement**: X25519 (x25519-dalek)
//! - **Envelope encryption**: HPKE RFC 9180 (DHKEM(X25519) + HKDF-SHA256 + AES-256-GCM)
//! - **Symmetric**: AES-256-GCM (PIN storage, items_key)
//! - **KDF**: HKDF-SHA256
//! - **Subkey derivation**: HMAC-SHA256
//! - **PIN/passphrase key derivation**: Argon2id (64MB, 3 iterations, 4 parallelism)
//!
//! ## Security Design
//!
//! - All key material uses `Zeroize` on drop — no GC unpredictability
//! - Domain separation via label registry prevents cross-context key reuse
//! - HPKE provides authenticated encryption with label binding
//! - Label enforcement at decrypt (Albrecht defense) rejects mismatched envelopes

#[cfg(feature = "mobile")]
uniffi::setup_scaffolding!();

// === Core modules (Ed25519/X25519 + HPKE) ===
pub mod auth;
pub mod device_keys;
pub mod hpke_envelope;
pub mod labels;
pub mod puk;
pub mod shamir;
pub mod sigchain;

#[cfg(feature = "mls")]
pub mod mls;
pub mod sframe;

// === KDF parameters (shared across device_keys + encryption) ===
pub mod kdf_params;

// === Stable modules (curve-independent) ===
pub mod blind_index;
pub mod errors;
pub mod padding;

// === Encryption module (HPKE + AES-256-GCM) ===
pub mod encryption;

// === The one definition of an envelope AAD (mirrors packages/shared/envelope-aad.ts) ===
pub mod envelope_aad;

// === Audit key management (AES-256-GCM + HPKE wrapping) ===
pub mod audit_key;

// === Offline key backup — the one canonical backup file format (v4) ===
pub mod backup;

// === Erasure override + device wipe signatures ===
pub mod erasure;

// === Device provisioning (X25519 ECDH + HKDF + AES-256-GCM) ===
pub mod provisioning;

// === SAS emoji verification (HKDF-SHA256) ===
pub mod sas;

#[cfg(feature = "mobile")]
mod ffi;
#[cfg(feature = "mobile")]
mod ffi_v3;

#[cfg(feature = "server")]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub mod ffi_server;

// Re-export core types
pub use auth::AuthToken;
pub use device_keys::{DeviceKeyState, EncryptedDeviceKeys};
pub use envelope_aad::{
    content_aad, content_aad_hex, key_wrap_aad, key_wrap_aad_hex, KEY_WRAP_AAD_SUFFIX,
};
pub use errors::CryptoError;
pub use hpke_envelope::HpkeEnvelope;
pub use labels::*;
pub use puk::PukState;
pub use sigchain::{SigchainLink, SigchainVerifiedState};

// Re-export encryption types
pub use encryption::{
    EncryptedKeyData, EncryptedMessage, EncryptedNote, KeyEnvelope, RecipientKeyEnvelope,
};

// Re-export audit key types
pub use audit_key::AuditKeyAdminEnvelope;

// Re-export Shamir types
pub use shamir::Share;

/// Constant-time comparison of two hex-encoded strings.
/// Returns false if either string is not valid hex or lengths differ.
pub fn ct_hex_eq(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    let Ok(a_bytes) = hex::decode(a) else {
        return false;
    };
    let Ok(b_bytes) = hex::decode(b) else {
        return false;
    };
    if a_bytes.len() != b_bytes.len() {
        return false;
    }
    a_bytes.ct_eq(&b_bytes).into()
}
