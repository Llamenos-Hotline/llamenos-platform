//! Ed25519 signature authentication.
//!
//! Auth token format:
//! ```json
//! {
//!   "pubkey": "<ed25519 verifying key hex>",
//!   "timestamp": <unix timestamp ms>,
//!   "token": "<ed25519 signature hex>"
//! }
//! ```
//!
//! Canonical auth message (UTF-8, signed directly — no pre-hashing). Two
//! shapes, each with its own domain-separation label so neither can be
//! reinterpreted as the other:
//! ```text
//! llamenos:device-auth:v1:{pubkey_hex}:{timestamp_ms}:{METHOD}:{path}:{nonce}
//! llamenos:device-auth-no-nonce:v1:{pubkey_hex}:{timestamp_ms}:{METHOD}:{path}
//! ```
//!
//! Ed25519 internally applies SHA-512, providing 256-bit collision resistance.
//! Pre-hashing with SHA-256 would reduce this to 128 bits — unnecessary and weaker.

use ed25519_dalek::{Signer, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::device_keys::DeviceSecrets;
use crate::errors::CryptoError;
use crate::labels::{LABEL_DEVICE_AUTH, LABEL_DEVICE_AUTH_NO_NONCE};

/// A signed Ed25519 authentication token.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct AuthToken {
    pub pubkey: String,
    pub timestamp: u64,
    pub token: String,
    /// Optional random nonce to prevent replay collisions in parallel requests.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
}

/// Build the canonical auth message bytes (UTF-8, no hashing).
///
/// THE single construction path for this message on every platform. Both shapes
/// are produced here and nowhere else:
///
/// | nonce | message |
/// |---|---|
/// | `Some(n)` | `{LABEL_DEVICE_AUTH}:{pubkey_hex}:{timestamp}:{method}:{path}:{n}` |
/// | `None`    | `{LABEL_DEVICE_AUTH_NO_NONCE}:{pubkey_hex}:{timestamp}:{method}:{path}` |
///
/// The nonce-less shape gets its own label rather than simply dropping a field:
/// a URL path may legally contain `:`, so a five-field message with path
/// `/x:abcd` and a six-field message with path `/x` and nonce `abcd` would
/// otherwise be the same bytes under the same label. Distinct labels make the
/// two shapes cryptographically disjoint domains.
///
/// This is the EXACT byte sequence that gets signed/verified. Rust,
/// TypeScript (`packages/shared/auth-message.ts`), Kotlin and Swift (both via
/// the UniFFI export of this function) MUST produce identical bytes; the
/// vectors in `packages/crypto/tests/interop.rs` pin that.
pub fn build_auth_message(
    pubkey_hex: &str,
    timestamp: u64,
    method: &str,
    path: &str,
    nonce: Option<&str>,
) -> Vec<u8> {
    match nonce {
        Some(n) => {
            format!("{LABEL_DEVICE_AUTH}:{pubkey_hex}:{timestamp}:{method}:{path}:{n}").into_bytes()
        }
        None => format!("{LABEL_DEVICE_AUTH_NO_NONCE}:{pubkey_hex}:{timestamp}:{method}:{path}")
            .into_bytes(),
    }
}

/// Canonical nonce format: exactly 32 lowercase hex characters (16 bytes).
///
/// Enforced at verify so an attacker-supplied nonce cannot contain `:` and
/// shift the path/nonce boundary inside the nonce-bearing shape.
pub fn is_canonical_nonce(nonce: &str) -> bool {
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Generate a random 16-byte hex nonce for replay prevention.
///
/// Each auth token gets a unique nonce so that even requests with identical
/// (timestamp, method, path) produce distinct signatures.
fn generate_nonce() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("getrandom failed");
    hex::encode(bytes)
}

/// Sign an auth token over the canonical message.
///
/// Private on purpose: no public constructor takes a nonce, so a caller can
/// neither invent one nor drop one. `Some`/`None` is chosen here by the named
/// public wrapper the caller picked, which is what keeps the nonce-bearing
/// flows nonce-bearing.
fn sign_auth_token(
    signing_key: &ed25519_dalek::SigningKey,
    timestamp: u64,
    method: &str,
    path: &str,
    nonce: Option<String>,
) -> AuthToken {
    let pubkey_hex = hex::encode(signing_key.verifying_key().to_bytes());
    let message = build_auth_message(&pubkey_hex, timestamp, method, path, nonce.as_deref());
    let signature = signing_key.sign(&message);

    AuthToken {
        pubkey: pubkey_hex,
        timestamp,
        token: hex::encode(signature.to_bytes()),
        nonce,
    }
}

/// Decode a 32-byte hex signing seed into a signing key.
fn signing_key_from_hex(signing_key_hex: &str) -> Result<ed25519_dalek::SigningKey, CryptoError> {
    use zeroize::Zeroizing;

    let sk_bytes = Zeroizing::new(hex::decode(signing_key_hex).map_err(CryptoError::HexError)?);
    if sk_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let sk_arr = Zeroizing::new(
        <[u8; 32]>::try_from(sk_bytes.as_slice()).map_err(|_| CryptoError::InvalidSecretKey)?,
    );
    Ok(ed25519_dalek::SigningKey::from_bytes(&sk_arr))
}

/// Create an Ed25519 auth token using device secrets.
///
/// The message is bound to the specific key, method, and path to prevent
/// cross-endpoint replay and type-confusion attacks, and always carries a
/// freshly generated nonce — there is no way for a caller to omit it.
pub fn create_auth_token(
    secrets: &DeviceSecrets,
    timestamp: u64,
    method: &str,
    path: &str,
) -> Result<AuthToken, CryptoError> {
    Ok(sign_auth_token(
        &secrets.signing_key(),
        timestamp,
        method,
        path,
        Some(generate_nonce()),
    ))
}

/// Create an Ed25519 auth token with NO nonce, for the routes whose wire
/// schema has no `nonce` field.
///
/// Only `POST /api/invites/redeem` is such a route today: its body is
/// `{ code, pubkey, timestamp, token }`, so a nonce would be dropped in
/// transit and the signature could never verify (#1389). The resulting token
/// is signed under `LABEL_DEVICE_AUTH_NO_NONCE`, a separate domain, and is
/// therefore useless against any nonce-bearing endpoint.
///
/// **Do not reach for this to make a signature "simpler".** A nonce-less
/// message is a function only of (pubkey, timestamp, method, path), so it is
/// replayable for as long as the server's timestamp window lasts; the server
/// accepts the nonce-less domain only on routes that explicitly opt in.
pub fn create_auth_token_without_nonce(
    secrets: &DeviceSecrets,
    timestamp: u64,
    method: &str,
    path: &str,
) -> Result<AuthToken, CryptoError> {
    Ok(sign_auth_token(
        &secrets.signing_key(),
        timestamp,
        method,
        path,
        None,
    ))
}

/// Create an Ed25519 auth token from a raw 32-byte signing seed (hex-encoded).
///
/// Used by FFI and stateless callers that don't have a DeviceSecrets struct.
/// Always nonce-bearing.
pub fn create_auth_token_from_signing_key(
    signing_key_hex: &str,
    timestamp: u64,
    method: &str,
    path: &str,
) -> Result<AuthToken, CryptoError> {
    let signing_key = signing_key_from_hex(signing_key_hex)?;
    Ok(sign_auth_token(
        &signing_key,
        timestamp,
        method,
        path,
        Some(generate_nonce()),
    ))
}

/// Nonce-less counterpart of [`create_auth_token_from_signing_key`].
///
/// Same caveats as [`create_auth_token_without_nonce`].
pub fn create_auth_token_from_signing_key_without_nonce(
    signing_key_hex: &str,
    timestamp: u64,
    method: &str,
    path: &str,
) -> Result<AuthToken, CryptoError> {
    let signing_key = signing_key_from_hex(signing_key_hex)?;
    Ok(sign_auth_token(&signing_key, timestamp, method, path, None))
}

/// Verify an Ed25519 auth token with timestamp-based expiry.
///
/// Rejects tokens older than `max_age_ms` or more than 30s in the future.
/// Use `max_age_ms: 300_000` (5 minutes) for standard API authentication.
pub fn verify_auth_token_with_expiry(
    token: &AuthToken,
    method: &str,
    path: &str,
    now_ms: u64,
    max_age_ms: u64,
) -> Result<bool, CryptoError> {
    let age = now_ms.saturating_sub(token.timestamp);
    if age > max_age_ms {
        return Ok(false);
    }
    // Reject tokens from the future (>30s clock skew)
    if token.timestamp > now_ms + 30_000 {
        return Ok(false);
    }
    verify_auth_token(token, method, path)
}

/// Verify an Ed25519 auth token.
///
/// Returns true if the signature is valid for the given method + path.
pub fn verify_auth_token(token: &AuthToken, method: &str, path: &str) -> Result<bool, CryptoError> {
    let pubkey_bytes = hex::decode(&token.pubkey).map_err(CryptoError::HexError)?;
    if pubkey_bytes.len() != 32 {
        return Err(CryptoError::InvalidPublicKey);
    }

    let pubkey_arr: [u8; 32] = pubkey_bytes
        .try_into()
        .map_err(|_| CryptoError::InvalidPublicKey)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pubkey_arr).map_err(|_| CryptoError::InvalidPublicKey)?;

    // A nonce must be canonical hex: a nonce containing ':' could otherwise
    // shift the path/nonce boundary within the nonce-bearing shape.
    if let Some(nonce) = token.nonce.as_deref() {
        if !is_canonical_nonce(nonce) {
            return Ok(false);
        }
    }

    let message = build_auth_message(
        &token.pubkey,
        token.timestamp,
        method,
        path,
        token.nonce.as_deref(),
    );

    let sig_bytes = hex::decode(&token.token).map_err(CryptoError::HexError)?;
    if sig_bytes.len() != 64 {
        return Err(CryptoError::SignatureVerificationFailed);
    }

    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| CryptoError::SignatureVerificationFailed)?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig_arr);

    match verifying_key.verify(&message, &signature) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Verify a raw Ed25519 signature over a message.
pub fn verify_ed25519(
    message: &[u8],
    signature_hex: &str,
    pubkey_hex: &str,
) -> Result<bool, CryptoError> {
    let pubkey_bytes = hex::decode(pubkey_hex).map_err(CryptoError::HexError)?;
    if pubkey_bytes.len() != 32 {
        return Err(CryptoError::InvalidPublicKey);
    }

    let pubkey_arr: [u8; 32] = pubkey_bytes
        .try_into()
        .map_err(|_| CryptoError::InvalidPublicKey)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pubkey_arr).map_err(|_| CryptoError::InvalidPublicKey)?;

    let sig_bytes = hex::decode(signature_hex).map_err(CryptoError::HexError)?;
    if sig_bytes.len() != 64 {
        return Err(CryptoError::SignatureVerificationFailed);
    }

    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| CryptoError::SignatureVerificationFailed)?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig_arr);

    match verifying_key.verify(message, &signature) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_keys::generate_device_keys;
    use crate::device_keys::unlock_device_keys;

    fn test_secrets() -> DeviceSecrets {
        let encrypted = generate_device_keys("test-auth-dev", "12345678").unwrap();
        unlock_device_keys(&encrypted, "12345678").unwrap()
    }

    #[test]
    fn roundtrip_auth_token() {
        let secrets = test_secrets();
        let timestamp = 1708900000000u64;
        let method = "POST";
        let path = "/api/auth/login";

        let token = create_auth_token(&secrets, timestamp, method, path).unwrap();
        assert_eq!(
            token.pubkey,
            hex::encode(secrets.signing_pubkey().to_bytes())
        );
        assert_eq!(token.timestamp, timestamp);

        let valid = verify_auth_token(&token, method, path).unwrap();
        assert!(valid);
    }

    #[test]
    fn roundtrip_from_signing_key() {
        let secrets = test_secrets();
        let sk_hex = hex::encode(secrets.signing_seed);

        let token =
            create_auth_token_from_signing_key(&sk_hex, 1708900000000, "GET", "/api/test").unwrap();
        let valid = verify_auth_token(&token, "GET", "/api/test").unwrap();
        assert!(valid);
    }

    #[test]
    fn wrong_path_fails() {
        let secrets = test_secrets();
        let token = create_auth_token(&secrets, 1708900000000, "POST", "/api/auth/login").unwrap();
        let valid = verify_auth_token(&token, "POST", "/api/notes").unwrap();
        assert!(!valid);
    }

    #[test]
    fn wrong_method_fails() {
        let secrets = test_secrets();
        let token = create_auth_token(&secrets, 1708900000000, "POST", "/api/auth/login").unwrap();
        let valid = verify_auth_token(&token, "GET", "/api/auth/login").unwrap();
        assert!(!valid);
    }

    #[test]
    fn verify_with_expiry_rejects_old_token() {
        let secrets = test_secrets();
        let old_timestamp = 1000000u64;
        let now = old_timestamp + 400_000;
        let token = create_auth_token(&secrets, old_timestamp, "GET", "/api/test").unwrap();
        let valid =
            verify_auth_token_with_expiry(&token, "GET", "/api/test", now, 300_000).unwrap();
        assert!(!valid);
    }

    #[test]
    fn verify_with_expiry_rejects_future_token() {
        let secrets = test_secrets();
        let future_timestamp = 2000000u64;
        let now = 1000000u64;
        let token = create_auth_token(&secrets, future_timestamp, "GET", "/api/test").unwrap();
        let valid =
            verify_auth_token_with_expiry(&token, "GET", "/api/test", now, 300_000).unwrap();
        assert!(!valid);
    }

    #[test]
    fn verify_with_expiry_accepts_recent_token() {
        let secrets = test_secrets();
        let now = 1708900000000u64;
        let token = create_auth_token(&secrets, now - 60_000, "GET", "/api/test").unwrap();
        let valid =
            verify_auth_token_with_expiry(&token, "GET", "/api/test", now, 300_000).unwrap();
        assert!(valid);
    }

    #[test]
    fn verify_ed25519_raw() {
        let secrets = test_secrets();
        let message = b"raw message to verify";
        let sig = crate::device_keys::sign_bytes(&secrets, message);
        let pubkey_hex = hex::encode(secrets.signing_pubkey().to_bytes());
        let sig_hex = hex::encode(&sig);

        let valid = verify_ed25519(message, &sig_hex, &pubkey_hex).unwrap();
        assert!(valid);

        let valid = verify_ed25519(b"wrong message", &sig_hex, &pubkey_hex).unwrap();
        assert!(!valid);
    }

    #[test]
    fn malformed_token_rejected() {
        let short_token = AuthToken {
            pubkey: "a".repeat(64),
            timestamp: 1708900000000,
            token: "abcd".to_string(),
            nonce: None,
        };
        let result = verify_auth_token(&short_token, "GET", "/api/notes");
        assert!(result.is_err() || matches!(result, Ok(false)));

        let nonhex_token = AuthToken {
            pubkey: "a".repeat(64),
            timestamp: 1708900000000,
            token: "zzzz".repeat(32),
            nonce: None,
        };
        let result = verify_auth_token(&nonhex_token, "GET", "/api/notes");
        assert!(result.is_err());
    }

    /// Cross-language test vector: deterministic seed produces known auth message.
    /// TypeScript test MUST produce the same message bytes and verify the same signature.
    #[test]
    fn cross_language_test_vector() {
        // Deterministic seed: all zeros
        let seed = [0u8; 32];
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let pubkey_hex = hex::encode(signing_key.verifying_key().to_bytes());

        let timestamp = 1700000000000u64;
        let method = "GET";
        let path = "/api/calls";

        // Build message and verify it matches expected format
        let nonce = "0f0e0d0c0b0a09080706050403020100";
        let message = build_auth_message(&pubkey_hex, timestamp, method, path, Some(nonce));
        let expected =
            format!("{LABEL_DEVICE_AUTH}:{pubkey_hex}:1700000000000:GET:/api/calls:{nonce}");
        assert_eq!(message, expected.as_bytes());

        let nonceless = build_auth_message(&pubkey_hex, timestamp, method, path, None);
        let expected_nonceless =
            format!("{LABEL_DEVICE_AUTH_NO_NONCE}:{pubkey_hex}:1700000000000:GET:/api/calls");
        assert_eq!(nonceless, expected_nonceless.as_bytes());

        // Sign and verify
        let signature = signing_key.sign(&message);
        let token = AuthToken {
            pubkey: pubkey_hex.clone(),
            timestamp,
            token: hex::encode(signature.to_bytes()),
            nonce: Some(nonce.to_string()),
        };
        assert!(verify_auth_token(&token, method, path).unwrap());

        // Print for cross-language verification
        // pubkey: 3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29
        // (this is the well-known ed25519 pubkey for all-zeros seed)
        assert_eq!(
            pubkey_hex,
            "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"
        );
    }

    #[test]
    fn nonceless_token_roundtrips() {
        let secrets = test_secrets();
        let token =
            create_auth_token_without_nonce(&secrets, 1708900000000, "POST", "/api/invites/redeem")
                .unwrap();
        assert!(token.nonce.is_none());
        assert!(verify_auth_token(&token, "POST", "/api/invites/redeem").unwrap());
    }

    #[test]
    fn nonceless_from_signing_key_roundtrips() {
        let secrets = test_secrets();
        let sk_hex = hex::encode(secrets.signing_seed);
        let token = create_auth_token_from_signing_key_without_nonce(
            &sk_hex,
            1708900000000,
            "POST",
            "/api/invites/redeem",
        )
        .unwrap();
        assert!(token.nonce.is_none());
        assert!(verify_auth_token(&token, "POST", "/api/invites/redeem").unwrap());
    }

    /// Dropping the nonce from a nonce-bearing token must NOT downgrade it to a
    /// valid nonce-less token — the two shapes are separate label domains.
    /// This is #1389's failure mode, asserted as a rejection.
    #[test]
    fn stripping_nonce_invalidates_token() {
        let secrets = test_secrets();
        let token = create_auth_token(&secrets, 1708900000000, "POST", "/api/test").unwrap();
        assert!(token.nonce.is_some());

        let stripped = AuthToken {
            nonce: None,
            ..token.clone()
        };
        assert!(!verify_auth_token(&stripped, "POST", "/api/test").unwrap());
    }

    /// The reverse direction: a nonce-less token cannot be dressed up as a
    /// nonce-bearing one by attaching any nonce.
    #[test]
    fn attaching_nonce_invalidates_nonceless_token() {
        let secrets = test_secrets();
        let token =
            create_auth_token_without_nonce(&secrets, 1708900000000, "POST", "/api/test").unwrap();
        let dressed = AuthToken {
            nonce: Some("0".repeat(32)),
            ..token
        };
        assert!(!verify_auth_token(&dressed, "POST", "/api/test").unwrap());
    }

    /// The two shapes cannot collide through a colon in the path. Under a single
    /// shared label these two messages would be identical bytes.
    #[test]
    fn colon_in_path_cannot_collide_shapes() {
        let pubkey = "a".repeat(64);
        let nonce = "b".repeat(32);
        let nonceless = build_auth_message(&pubkey, 1, "POST", &format!("/x:{nonce}"), None);
        let nonced = build_auth_message(&pubkey, 1, "POST", "/x", Some(&nonce));
        assert_ne!(nonceless, nonced);
    }

    #[test]
    fn non_canonical_nonce_rejected() {
        assert!(is_canonical_nonce(&"a".repeat(32)));
        assert!(!is_canonical_nonce(""));
        assert!(!is_canonical_nonce(&"a".repeat(31)));
        assert!(!is_canonical_nonce(&"A".repeat(32)));
        assert!(!is_canonical_nonce("abcd:abcdabcdabcdabcdabcdabcdabcd"));

        // A token whose nonce carries a ':' is rejected before verification, so
        // the path/nonce boundary cannot be shifted by a chosen nonce.
        let secrets = test_secrets();
        let signing_key = secrets.signing_key();
        let pubkey_hex = hex::encode(signing_key.verifying_key().to_bytes());
        let evil_nonce = "b:cdabcdabcdabcdabcdabcdabcdabcd";
        let message =
            build_auth_message(&pubkey_hex, 1708900000000, "POST", "/x", Some(evil_nonce));
        let token = AuthToken {
            pubkey: pubkey_hex,
            timestamp: 1708900000000,
            token: hex::encode(signing_key.sign(&message).to_bytes()),
            nonce: Some(evil_nonce.to_string()),
        };
        assert!(!verify_auth_token(&token, "POST", "/x").unwrap());
    }

    #[test]
    fn generated_nonce_is_canonical() {
        for _ in 0..32 {
            assert!(is_canonical_nonce(&generate_nonce()));
        }
    }
}
