//! Erasure override and device wipe signature operations.
//!
//! ## Erasure Override Co-Approver Signature
//!
//! When a user requests emergency erasure override, a co-approver (a different admin)
//! signs `(targetUserId || timestamp || justification)` with their device Ed25519 key.
//! The label `LABEL_ERASURE_OVERRIDE_SIG` is prepended for domain separation.
//!
//! ## Device Wipe Command Signature
//!
//! The server signs `(targetDevicePubkey || timestamp || reason)` with the server's
//! Ed25519 key using `LABEL_DEVICE_WIPE_SIG` as domain separation. Clients verify
//! this signature before executing a wipe to prevent forged wipe attacks.
//!
//! The fields are `:`-joined, so the encoding is only injective because every
//! field is constrained: the target is exactly 64 lowercase hex chars, the
//! timestamp is decimal, and the reason is one of [`DEVICE_WIPE_REASONS`], none of
//! which contains `:`. Without that, a target of `"<victim>:<ts>"` signed with
//! reason `r` produces the same bytes as a wipe of `<victim>` at `<ts>` with
//! reason `"<ts2>:r"` — so whoever controls the target string (an admin's
//! `wipe-device/:devicePubkey` route parameter) could obtain a server signature
//! that verifies as a wipe of a different device. Both sign and verify enforce
//! the constraints, so neither side can produce or accept an ambiguous message.

use crate::device_keys::{sign_bytes, verify_signature, DeviceSecrets};
use crate::errors::CryptoError;
use crate::labels::{LABEL_DEVICE_WIPE_SIG, LABEL_ERASURE_OVERRIDE_SIG};

/// Build the canonical message for an erasure override co-approver signature.
///
/// Format: `{LABEL_ERASURE_OVERRIDE_SIG}:{target_user_id}:{timestamp_ms}:{justification}`
///
/// All fields are UTF-8 encoded. The label prefix ensures domain separation —
/// this signature cannot be replayed in any other context.
pub fn build_erasure_override_message(
    target_user_id: &str,
    timestamp_ms: u64,
    justification: &str,
) -> Vec<u8> {
    format!("{LABEL_ERASURE_OVERRIDE_SIG}:{target_user_id}:{timestamp_ms}:{justification}")
        .into_bytes()
}

/// Sign an erasure override as a co-approver using Ed25519 device secrets.
///
/// Returns the 64-byte Ed25519 signature as a `Vec<u8>`.
pub fn sign_erasure_override(
    secrets: &DeviceSecrets,
    target_user_id: &str,
    timestamp_ms: u64,
    justification: &str,
) -> Vec<u8> {
    let message = build_erasure_override_message(target_user_id, timestamp_ms, justification);
    sign_bytes(secrets, &message)
}

/// Verify an erasure override co-approver signature.
///
/// - `signature_bytes`: the 64-byte Ed25519 signature
/// - `co_approver_pubkey_hex`: the co-approver's Ed25519 verifying key (hex-encoded)
/// - `target_user_id`: the user being erased
/// - `timestamp_ms`: the timestamp in the signed message
/// - `justification`: the justification text in the signed message
/// - `current_timestamp_ms`: current time for staleness check
/// - `max_age_ms`: maximum allowed age of the signature in milliseconds
///
/// Returns `Ok(())` if valid, `Err(CryptoError::InvalidSignature)` if invalid,
/// `Err(CryptoError::StaleTimestamp)` if the signature is too old.
pub fn verify_erasure_override(
    signature_bytes: &[u8],
    co_approver_pubkey_hex: &str,
    target_user_id: &str,
    timestamp_ms: u64,
    justification: &str,
    current_timestamp_ms: u64,
    max_age_ms: u64,
) -> Result<(), CryptoError> {
    if current_timestamp_ms.saturating_sub(timestamp_ms) > max_age_ms {
        return Err(CryptoError::StaleTimestamp);
    }

    let message = build_erasure_override_message(target_user_id, timestamp_ms, justification);
    let valid = verify_signature(&message, signature_bytes, co_approver_pubkey_hex)?;
    if !valid {
        return Err(CryptoError::InvalidSignature);
    }
    Ok(())
}

/// The reasons a server may sign a device wipe for. Nothing else is signed or accepted.
pub const DEVICE_WIPE_REASONS: [&str; 3] = ["user-erasure", "device-revocation", "admin-erasure"];

/// Reject any field that would make the `:`-joined wipe message ambiguous.
fn validate_device_wipe_fields(
    target_device_pubkey: &str,
    reason: &str,
) -> Result<(), CryptoError> {
    let is_lower_hex_pubkey = target_device_pubkey.len() == 64
        && target_device_pubkey
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !is_lower_hex_pubkey {
        return Err(CryptoError::InvalidInput(
            "device wipe target must be a 64-char lowercase hex Ed25519 pubkey".into(),
        ));
    }
    if !DEVICE_WIPE_REASONS.contains(&reason) {
        return Err(CryptoError::InvalidInput(format!(
            "unknown device wipe reason: {reason}"
        )));
    }
    Ok(())
}

/// Build the canonical message for a device wipe command signature.
///
/// Format: `{LABEL_DEVICE_WIPE_SIG}:{target_device_pubkey}:{timestamp_ms}:{reason}`
///
/// Signed by the server's Ed25519 key. Clients verify before executing wipe.
/// Fails with `CryptoError::InvalidInput` unless the target is a 64-char
/// lowercase hex pubkey and the reason is one of [`DEVICE_WIPE_REASONS`].
pub fn build_device_wipe_message(
    target_device_pubkey: &str,
    timestamp_ms: u64,
    reason: &str,
) -> Result<Vec<u8>, CryptoError> {
    validate_device_wipe_fields(target_device_pubkey, reason)?;
    Ok(
        format!("{LABEL_DEVICE_WIPE_SIG}:{target_device_pubkey}:{timestamp_ms}:{reason}")
            .into_bytes(),
    )
}

/// Sign a device wipe command using the server's Ed25519 key.
///
/// - `server_secrets`: the server's Ed25519 device secrets (signing key)
/// - `target_device_pubkey`: the target device's Ed25519 pubkey (hex)
/// - `timestamp_ms`: current timestamp in milliseconds
/// - `reason`: wipe reason (`"user-erasure"`, `"device-revocation"`, `"admin-erasure"`)
///
/// Returns the 64-byte Ed25519 signature as a `Vec<u8>`, or
/// `CryptoError::InvalidInput` for a malformed target or unknown reason — the
/// server must never sign a message that could parse as a wipe of another device.
pub fn sign_device_wipe(
    server_secrets: &DeviceSecrets,
    target_device_pubkey: &str,
    timestamp_ms: u64,
    reason: &str,
) -> Result<Vec<u8>, CryptoError> {
    let message = build_device_wipe_message(target_device_pubkey, timestamp_ms, reason)?;
    Ok(sign_bytes(server_secrets, &message))
}

/// Verify a device wipe command signature from the server.
///
/// - `signature_bytes`: the 64-byte Ed25519 signature
/// - `server_pubkey_hex`: the server's Ed25519 verifying key (hex-encoded)
/// - `target_device_pubkey`: the target device's pubkey (hex)
/// - `timestamp_ms`: timestamp from the wipe command
/// - `reason`: reason from the wipe command
/// - `current_timestamp_ms`: current time for freshness check
/// - `max_age_ms`: maximum allowed age of the wipe command in milliseconds
///
/// Returns `Ok(())` if valid, `Err(CryptoError::InvalidSignature)` if invalid,
/// `Err(CryptoError::StaleTimestamp)` if the command is too old,
/// `Err(CryptoError::FutureTimestamp)` if the command timestamp is in the future,
/// `Err(CryptoError::InvalidInput)` if the target or reason is malformed.
/// Every error means: do not wipe.
pub fn verify_device_wipe(
    signature_bytes: &[u8],
    server_pubkey_hex: &str,
    target_device_pubkey: &str,
    timestamp_ms: u64,
    reason: &str,
    current_timestamp_ms: u64,
    max_age_ms: u64,
) -> Result<(), CryptoError> {
    // Reject future timestamps (with small clock-skew tolerance of 30 seconds)
    const CLOCK_SKEW_TOLERANCE_MS: u64 = 30_000;
    if timestamp_ms > current_timestamp_ms.saturating_add(CLOCK_SKEW_TOLERANCE_MS) {
        return Err(CryptoError::FutureTimestamp);
    }

    // Reject stale timestamps
    if current_timestamp_ms.saturating_sub(timestamp_ms) > max_age_ms {
        return Err(CryptoError::StaleTimestamp);
    }

    let message = build_device_wipe_message(target_device_pubkey, timestamp_ms, reason)?;
    let valid = verify_signature(&message, signature_bytes, server_pubkey_hex)?;
    if !valid {
        return Err(CryptoError::InvalidSignature);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_keys::{generate_device_keys, unlock_device_keys};

    fn test_secrets(device_id: &str) -> (DeviceSecrets, String) {
        let encrypted = generate_device_keys(device_id, "12345678").unwrap();
        let pubkey = encrypted.state.signing_pubkey_hex.clone();
        let secrets = unlock_device_keys(&encrypted, "12345678").unwrap();
        (secrets, pubkey)
    }

    const FRESH_TS: u64 = 1708900000000;
    const MAX_AGE: u64 = 300_000; // 5 minutes

    // --- Erasure Override Tests ---

    #[test]
    fn erasure_override_sign_verify_roundtrip() {
        let (secrets, pubkey) = test_secrets("co-approver-1");
        let target = "user-to-erase-abc";
        let justification = "User requested emergency erasure due to safety concern";

        let sig = sign_erasure_override(&secrets, target, FRESH_TS, justification);
        assert_eq!(sig.len(), 64);

        verify_erasure_override(
            &sig,
            &pubkey,
            target,
            FRESH_TS,
            justification,
            FRESH_TS,
            MAX_AGE,
        )
        .unwrap();
    }

    #[test]
    fn erasure_override_wrong_target_fails() {
        let (secrets, pubkey) = test_secrets("co-approver-2");
        let justification = "Safety concern";

        let sig = sign_erasure_override(&secrets, "user-A", FRESH_TS, justification);

        let result = verify_erasure_override(
            &sig,
            &pubkey,
            "user-B",
            FRESH_TS,
            justification,
            FRESH_TS,
            MAX_AGE,
        );
        assert!(
            matches!(result, Err(CryptoError::InvalidSignature)),
            "different target must fail verification"
        );
    }

    #[test]
    fn erasure_override_wrong_timestamp_fails() {
        let (secrets, pubkey) = test_secrets("co-approver-3");
        let target = "user-X";
        let justification = "Reason";

        let sig = sign_erasure_override(&secrets, target, 1000, justification);

        let result =
            verify_erasure_override(&sig, &pubkey, target, 2000, justification, 2000, MAX_AGE);
        assert!(
            matches!(result, Err(CryptoError::InvalidSignature)),
            "different timestamp must fail verification"
        );
    }

    #[test]
    fn erasure_override_wrong_justification_fails() {
        let (secrets, pubkey) = test_secrets("co-approver-4");
        let target = "user-Y";

        let sig = sign_erasure_override(&secrets, target, FRESH_TS, "original reason");

        let result = verify_erasure_override(
            &sig,
            &pubkey,
            target,
            FRESH_TS,
            "tampered reason",
            FRESH_TS,
            MAX_AGE,
        );
        assert!(
            matches!(result, Err(CryptoError::InvalidSignature)),
            "different justification must fail verification"
        );
    }

    #[test]
    fn erasure_override_wrong_pubkey_fails() {
        let (secrets, _pubkey) = test_secrets("co-approver-5");
        let (_, other_pubkey) = test_secrets("other-admin");
        let target = "user-Z";
        let justification = "Reason";

        let sig = sign_erasure_override(&secrets, target, FRESH_TS, justification);

        let result = verify_erasure_override(
            &sig,
            &other_pubkey,
            target,
            FRESH_TS,
            justification,
            FRESH_TS,
            MAX_AGE,
        );
        assert!(
            matches!(result, Err(CryptoError::InvalidSignature)),
            "wrong co-approver pubkey must fail verification"
        );
    }

    #[test]
    fn erasure_override_tampered_signature_fails() {
        let (secrets, pubkey) = test_secrets("co-approver-6");
        let target = "user-W";
        let justification = "Reason";

        let mut sig = sign_erasure_override(&secrets, target, FRESH_TS, justification);
        sig[0] ^= 0x01; // flip one bit

        let result = verify_erasure_override(
            &sig,
            &pubkey,
            target,
            FRESH_TS,
            justification,
            FRESH_TS,
            MAX_AGE,
        );
        assert!(
            matches!(result, Err(CryptoError::InvalidSignature)),
            "tampered signature must fail verification"
        );
    }

    #[test]
    fn erasure_override_message_format() {
        let msg = build_erasure_override_message("user-123", 1708900000000, "safety concern");
        let expected = format!(
            "{}:user-123:1708900000000:safety concern",
            LABEL_ERASURE_OVERRIDE_SIG
        );
        assert_eq!(msg, expected.as_bytes());
    }

    #[test]
    fn erasure_override_stale_timestamp_rejected() {
        let (secrets, pubkey) = test_secrets("co-approver-stale");
        let target = "user-stale";
        let justification = "Reason";
        let old_ts = 1000;
        let now = old_ts + MAX_AGE + 1; // just past max age

        let sig = sign_erasure_override(&secrets, target, old_ts, justification);

        let result =
            verify_erasure_override(&sig, &pubkey, target, old_ts, justification, now, MAX_AGE);
        assert!(
            matches!(result, Err(CryptoError::StaleTimestamp)),
            "stale timestamp must be rejected"
        );
    }

    #[test]
    fn erasure_override_at_max_age_boundary_accepted() {
        let (secrets, pubkey) = test_secrets("co-approver-boundary");
        let target = "user-boundary";
        let justification = "Reason";
        let old_ts = 1000;
        let now = old_ts + MAX_AGE; // exactly at max age

        let sig = sign_erasure_override(&secrets, target, old_ts, justification);

        verify_erasure_override(&sig, &pubkey, target, old_ts, justification, now, MAX_AGE)
            .unwrap();
    }

    // --- Device Wipe Tests ---

    #[test]
    fn device_wipe_sign_verify_roundtrip() {
        let (server_secrets, server_pubkey) = test_secrets("server-key");
        let target_device = "aa".repeat(32); // 64 hex chars
        let reason = "user-erasure";

        let sig = sign_device_wipe(&server_secrets, &target_device, FRESH_TS, reason).unwrap();
        assert_eq!(sig.len(), 64);

        verify_device_wipe(
            &sig,
            &server_pubkey,
            &target_device,
            FRESH_TS,
            reason,
            FRESH_TS,
            MAX_AGE,
        )
        .unwrap();
    }

    #[test]
    fn device_wipe_wrong_target_fails() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-2");
        let reason = "admin-erasure";

        let sig = sign_device_wipe(&server_secrets, &"aa".repeat(32), FRESH_TS, reason).unwrap();

        let result = verify_device_wipe(
            &sig,
            &server_pubkey,
            &"bb".repeat(32),
            FRESH_TS,
            reason,
            FRESH_TS,
            MAX_AGE,
        );
        assert!(matches!(result, Err(CryptoError::InvalidSignature)));
    }

    #[test]
    fn device_wipe_wrong_reason_fails() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-3");
        let target = "cc".repeat(32);

        let sig = sign_device_wipe(&server_secrets, &target, FRESH_TS, "user-erasure").unwrap();

        let result = verify_device_wipe(
            &sig,
            &server_pubkey,
            &target,
            FRESH_TS,
            "device-revocation",
            FRESH_TS,
            MAX_AGE,
        );
        assert!(matches!(result, Err(CryptoError::InvalidSignature)));
    }

    #[test]
    fn device_wipe_wrong_timestamp_fails() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-4");
        let target = "dd".repeat(32);
        let reason = "user-erasure";

        let sig = sign_device_wipe(&server_secrets, &target, 1000, reason).unwrap();

        // Signed with timestamp 1000, but verify claims timestamp 2000 — signature mismatch
        let result = verify_device_wipe(&sig, &server_pubkey, &target, 2000, reason, 2000, MAX_AGE);
        assert!(matches!(result, Err(CryptoError::InvalidSignature)));
    }

    #[test]
    fn device_wipe_wrong_server_key_fails() {
        let (server_secrets, _server_pubkey) = test_secrets("server-key-5");
        let (_, other_pubkey) = test_secrets("impersonator");
        let target = "ee".repeat(32);
        let reason = "admin-erasure";

        let sig = sign_device_wipe(&server_secrets, &target, FRESH_TS, reason).unwrap();

        let result = verify_device_wipe(
            &sig,
            &other_pubkey,
            &target,
            FRESH_TS,
            reason,
            FRESH_TS,
            MAX_AGE,
        );
        assert!(
            matches!(result, Err(CryptoError::InvalidSignature)),
            "wrong server key must fail — prevents forged wipe attacks"
        );
    }

    #[test]
    fn device_wipe_message_format() {
        let target = "de".repeat(32);
        let msg = build_device_wipe_message(&target, 1708900000000, "device-revocation").unwrap();
        let expected = format!("{LABEL_DEVICE_WIPE_SIG}:{target}:1708900000000:device-revocation");
        assert_eq!(msg, expected.as_bytes());
    }

    #[test]
    fn device_wipe_all_three_reasons() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-6");
        let target = "ff".repeat(32);

        for reason in &["user-erasure", "device-revocation", "admin-erasure"] {
            let sig = sign_device_wipe(&server_secrets, &target, FRESH_TS, reason).unwrap();
            verify_device_wipe(
                &sig,
                &server_pubkey,
                &target,
                FRESH_TS,
                reason,
                FRESH_TS,
                MAX_AGE,
            )
            .unwrap_or_else(|_| panic!("reason '{reason}' should verify"));
        }
    }

    #[test]
    fn device_wipe_tampered_signature_fails() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-7");
        let target = "ab".repeat(32);
        let reason = "user-erasure";

        let mut sig = sign_device_wipe(&server_secrets, &target, FRESH_TS, reason).unwrap();
        sig[31] ^= 0xFF;

        let result = verify_device_wipe(
            &sig,
            &server_pubkey,
            &target,
            FRESH_TS,
            reason,
            FRESH_TS,
            MAX_AGE,
        );
        assert!(matches!(result, Err(CryptoError::InvalidSignature)));
    }

    #[test]
    fn device_wipe_stale_timestamp_rejected() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-stale");
        let target = "ab".repeat(32);
        let reason = "user-erasure";
        let old_ts = 1000;
        let now = old_ts + MAX_AGE + 1; // just past max age

        let sig = sign_device_wipe(&server_secrets, &target, old_ts, reason).unwrap();

        let result =
            verify_device_wipe(&sig, &server_pubkey, &target, old_ts, reason, now, MAX_AGE);
        assert!(
            matches!(result, Err(CryptoError::StaleTimestamp)),
            "stale wipe command must be rejected to prevent replay attacks"
        );
    }

    #[test]
    fn device_wipe_at_max_age_boundary_accepted() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-boundary");
        let target = "ab".repeat(32);
        let reason = "user-erasure";
        let old_ts = 1000;
        let now = old_ts + MAX_AGE; // exactly at max age

        let sig = sign_device_wipe(&server_secrets, &target, old_ts, reason).unwrap();

        verify_device_wipe(&sig, &server_pubkey, &target, old_ts, reason, now, MAX_AGE).unwrap();
    }

    #[test]
    fn device_wipe_future_timestamp_rejected() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-future");
        let target = "ab".repeat(32);
        let reason = "device-revocation";
        let now = 1_708_900_000_000;
        // 60 seconds in the future — well beyond 30s clock-skew tolerance
        let future_ts = now + 60_000;

        let sig = sign_device_wipe(&server_secrets, &target, future_ts, reason).unwrap();

        let result = verify_device_wipe(
            &sig,
            &server_pubkey,
            &target,
            future_ts,
            reason,
            now,
            MAX_AGE,
        );
        assert!(
            matches!(result, Err(CryptoError::FutureTimestamp)),
            "wipe command with future timestamp must be rejected"
        );
    }

    #[test]
    fn device_wipe_within_clock_skew_tolerance_accepted() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-skew");
        let target = "ab".repeat(32);
        let reason = "admin-erasure";
        let now = 1_708_900_000_000;
        // 20 seconds in the future — within 30s clock-skew tolerance
        let slightly_future_ts = now + 20_000;

        let sig = sign_device_wipe(&server_secrets, &target, slightly_future_ts, reason).unwrap();

        verify_device_wipe(
            &sig,
            &server_pubkey,
            &target,
            slightly_future_ts,
            reason,
            now,
            MAX_AGE,
        )
        .unwrap();
    }

    /// The ambiguity the field constraints close: a target smuggling a `:ts`
    /// suffix would, unconstrained, sign the exact bytes of a wipe of `victim`.
    #[test]
    fn device_wipe_colon_smuggled_target_is_neither_signed_nor_verified() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-smuggle");
        let victim = "ab".repeat(32);
        let smuggled_target = format!("{victim}:{FRESH_TS}");

        assert!(matches!(
            sign_device_wipe(&server_secrets, &smuggled_target, 1, "admin-erasure"),
            Err(CryptoError::InvalidInput(_))
        ));

        // Even given the bytes a lax signer would have produced, verification
        // refuses the colon-bearing reason it would need to accept.
        let lax_message =
            format!("{LABEL_DEVICE_WIPE_SIG}:{smuggled_target}:1:admin-erasure").into_bytes();
        let sig = crate::device_keys::sign_bytes(&server_secrets, &lax_message);
        let result = verify_device_wipe(
            &sig,
            &server_pubkey,
            &victim,
            FRESH_TS,
            "1:admin-erasure",
            FRESH_TS,
            MAX_AGE,
        );
        assert!(
            matches!(result, Err(CryptoError::InvalidInput(_))),
            "a smuggled reason must be refused before any signature check"
        );
    }

    #[test]
    fn device_wipe_rejects_malformed_targets() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-target");
        let good = "ab".repeat(32);
        let sig = sign_device_wipe(&server_secrets, &good, FRESH_TS, "admin-erasure").unwrap();

        for bad in [
            String::new(),
            "ab".repeat(31),
            "ab".repeat(33),
            "AB".repeat(32),
            format!("{}zz", "ab".repeat(31)),
            format!("{}:a", "ab".repeat(31)),
        ] {
            assert!(
                matches!(
                    sign_device_wipe(&server_secrets, &bad, FRESH_TS, "admin-erasure"),
                    Err(CryptoError::InvalidInput(_))
                ),
                "sign must refuse target {bad:?}"
            );
            assert!(
                matches!(
                    verify_device_wipe(
                        &sig,
                        &server_pubkey,
                        &bad,
                        FRESH_TS,
                        "admin-erasure",
                        FRESH_TS,
                        MAX_AGE
                    ),
                    Err(CryptoError::InvalidInput(_))
                ),
                "verify must refuse target {bad:?}"
            );
        }
    }

    #[test]
    fn device_wipe_rejects_unknown_reasons() {
        let (server_secrets, server_pubkey) = test_secrets("server-key-reason");
        let target = "ab".repeat(32);
        let sig = sign_device_wipe(&server_secrets, &target, FRESH_TS, "admin-erasure").unwrap();

        for bad in [
            "",
            "Admin-Erasure",
            "admin-erasure ",
            "something-new",
            "a:b",
        ] {
            assert!(
                matches!(
                    sign_device_wipe(&server_secrets, &target, FRESH_TS, bad),
                    Err(CryptoError::InvalidInput(_))
                ),
                "sign must refuse reason {bad:?}"
            );
            assert!(
                matches!(
                    verify_device_wipe(
                        &sig,
                        &server_pubkey,
                        &target,
                        FRESH_TS,
                        bad,
                        FRESH_TS,
                        MAX_AGE
                    ),
                    Err(CryptoError::InvalidInput(_))
                ),
                "verify must refuse reason {bad:?}"
            );
        }
    }
}
