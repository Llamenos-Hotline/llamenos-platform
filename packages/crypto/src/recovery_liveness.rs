//! Recovery share liveness proofs (#2782).
//!
//! A liveness proof lets a recovery-group share holder demonstrate — before a
//! recovery is needed — that they can still produce their Shamir share, without
//! the share (or anything that narrows it) ever reaching the server.
//!
//! ## Construction
//!
//! Each share deterministically derives an Ed25519 keypair:
//!
//! ```text
//! seed = HKDF-SHA256(ikm = x || y, salt = none, info = LABEL_RECOVERY_LIVENESS_PROOF, L = 32)
//! (sk, pk) = Ed25519::from_seed(seed)
//! ```
//!
//! The enrolling client computes `pk` for every share while it still holds the
//! plaintext shares (inside Rust, at split time) and the server stores it beside
//! the holder's share envelope as that holder's *liveness verifying key*. The
//! share commitment (`SHA-256(LABEL_SHAMIR_COMMIT || x || y)`) cannot serve as
//! the verifier: a hash commitment can only be checked by someone holding the
//! preimage, so the server would need the share itself.
//!
//! To prove liveness, the holder asks the server for a fresh single-use 32-byte
//! challenge, opens their share envelope on-device, re-derives `sk` and signs
//!
//! ```text
//! LABEL_RECOVERY_LIVENESS_PROOF || 0x00
//!   || u32be(len(hub_id))        || hub_id
//!   || u32be(len(holder_pubkey)) || holder_pubkey
//!   || challenge (32 bytes)
//! ```
//!
//! The server verifies the signature against the stored liveness key and
//! consumes the challenge.
//!
//! ## Properties
//!
//! - **Possession**: only a party holding `(x, y)` can derive `sk`. A device that
//!   lost its share (or never had it) cannot sign, whatever session it holds. A
//!   share that no longer matches what was enrolled derives a different key, so
//!   the proof also attests that the share is the enrolled one.
//! - **Freshness / replay**: the challenge is server-chosen and single-use, so a
//!   proof cannot be precomputed or replayed.
//! - **Binding**: hub id and holder pubkey are in the signed message, so a proof
//!   minted for one hub or one holder does not verify for another.
//! - **Zero knowledge of the share**: `pk` is a one-way function (HKDF, then
//!   Ed25519 scalar multiplication) of the share, exactly as hiding as the SHA-256
//!   commitment the server already stores. The signature is a standard Ed25519
//!   signature under a key the server already knows the public half of.
//! - **Domain separation**: the HKDF output is used only as an Ed25519 seed, and
//!   the signed message carries the label prefix, so neither collides with any
//!   other use of the share or of a device key.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::errors::CryptoError;
use crate::labels::LABEL_RECOVERY_LIVENESS_PROOF;
use crate::shamir::Share;

/// Length in bytes of a server-issued liveness challenge.
pub const LIVENESS_CHALLENGE_LEN: usize = 32;

/// Derive the share's liveness signing key. Never leaves this module.
fn liveness_signing_key(share: &Share) -> Result<SigningKey, CryptoError> {
    if share.x == 0 {
        return Err(CryptoError::InvalidInput(
            "Shamir share x-coordinate must be non-zero".into(),
        ));
    }
    if share.y.is_empty() {
        return Err(CryptoError::InvalidInput("Shamir share is empty".into()));
    }

    let mut ikm = Zeroizing::new(Vec::with_capacity(1 + share.y.len()));
    ikm.push(share.x);
    ikm.extend_from_slice(&share.y);

    let hk = Hkdf::<Sha256>::new(None, &ikm);
    let mut seed = Zeroizing::new([0u8; 32]);
    hk.expand(LABEL_RECOVERY_LIVENESS_PROOF.as_bytes(), seed.as_mut())
        .map_err(|_| CryptoError::HkdfExpandError)?;
    Ok(SigningKey::from_bytes(&seed))
}

/// The share's liveness verifying key (32-byte Ed25519 public key).
///
/// Computed by the enrolling client for every share and stored by the server as
/// the holder's liveness verifier.
pub fn liveness_public_key(share: &Share) -> Result<[u8; 32], CryptoError> {
    Ok(liveness_signing_key(share)?.verifying_key().to_bytes())
}

/// The exact bytes a liveness proof signs. Shared by every signer and the
/// server's verifier so the layout has exactly one definition.
pub fn build_liveness_message(
    hub_id: &str,
    holder_pubkey: &str,
    challenge: &[u8; LIVENESS_CHALLENGE_LEN],
) -> Vec<u8> {
    let label = LABEL_RECOVERY_LIVENESS_PROOF.as_bytes();
    let mut msg = Vec::with_capacity(
        label.len() + 1 + 8 + hub_id.len() + holder_pubkey.len() + challenge.len(),
    );
    msg.extend_from_slice(label);
    msg.push(0x00);
    msg.extend_from_slice(&(hub_id.len() as u32).to_be_bytes());
    msg.extend_from_slice(hub_id.as_bytes());
    msg.extend_from_slice(&(holder_pubkey.len() as u32).to_be_bytes());
    msg.extend_from_slice(holder_pubkey.as_bytes());
    msg.extend_from_slice(challenge);
    msg
}

/// Sign a liveness proof for `challenge` with the key derived from `share`.
///
/// `holder_pubkey` is the holder's authenticated identity (the hex Ed25519
/// signing pubkey the server knows them by); `hub_id` is the hub whose recovery
/// group the share belongs to.
pub fn sign_liveness_proof(
    share: &Share,
    hub_id: &str,
    holder_pubkey: &str,
    challenge: &[u8; LIVENESS_CHALLENGE_LEN],
) -> Result<[u8; 64], CryptoError> {
    let key = liveness_signing_key(share)?;
    let msg = build_liveness_message(hub_id, holder_pubkey, challenge);
    Ok(key.sign(&msg).to_bytes())
}

/// Verify a liveness proof against a stored liveness verifying key.
///
/// Uses strict verification (rejects small-order keys and non-canonical
/// signatures). Any malformed input is a failed proof, never an error the caller
/// could mistake for success.
pub fn verify_liveness_proof(
    liveness_pubkey: &[u8; 32],
    hub_id: &str,
    holder_pubkey: &str,
    challenge: &[u8; LIVENESS_CHALLENGE_LEN],
    signature: &[u8; 64],
) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(liveness_pubkey) else {
        return false;
    };
    let sig = Signature::from_bytes(signature);
    let msg = build_liveness_message(hub_id, holder_pubkey, challenge);
    vk.verify_strict(&msg, &sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shamir;

    const HUB: &str = "6f1c2a52-6d3e-4a6f-9f43-0a1b2c3d4e5f";
    const HOLDER: &str = "aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233";

    fn shares() -> Vec<Share> {
        let mut secret = [0u8; 32];
        getrandom::getrandom(&mut secret).unwrap();
        shamir::split(&secret, 3, 2).unwrap()
    }

    fn challenge() -> [u8; 32] {
        let mut c = [0u8; 32];
        getrandom::getrandom(&mut c).unwrap();
        c
    }

    #[test]
    fn proof_from_the_share_verifies() {
        let s = shares();
        let pk = liveness_public_key(&s[0]).unwrap();
        let c = challenge();
        let sig = sign_liveness_proof(&s[0], HUB, HOLDER, &c).unwrap();
        assert!(verify_liveness_proof(&pk, HUB, HOLDER, &c, &sig));
    }

    #[test]
    fn liveness_key_is_deterministic_per_share() {
        let s = shares();
        assert_eq!(
            liveness_public_key(&s[1]).unwrap(),
            liveness_public_key(&s[1].clone()).unwrap()
        );
    }

    #[test]
    fn another_share_cannot_prove_for_this_holder() {
        let s = shares();
        let pk = liveness_public_key(&s[0]).unwrap();
        let c = challenge();
        let sig = sign_liveness_proof(&s[1], HUB, HOLDER, &c).unwrap();
        assert!(!verify_liveness_proof(&pk, HUB, HOLDER, &c, &sig));
    }

    #[test]
    fn a_tampered_share_cannot_prove() {
        let s = shares();
        let pk = liveness_public_key(&s[0]).unwrap();
        let mut bad = s[0].clone();
        bad.y[0] ^= 0x01;
        let c = challenge();
        let sig = sign_liveness_proof(&bad, HUB, HOLDER, &c).unwrap();
        assert!(!verify_liveness_proof(&pk, HUB, HOLDER, &c, &sig));
    }

    #[test]
    fn proof_is_bound_to_the_challenge() {
        let s = shares();
        let pk = liveness_public_key(&s[0]).unwrap();
        let c = challenge();
        let sig = sign_liveness_proof(&s[0], HUB, HOLDER, &c).unwrap();
        assert!(!verify_liveness_proof(&pk, HUB, HOLDER, &challenge(), &sig));
    }

    #[test]
    fn proof_is_bound_to_the_hub_and_holder() {
        let s = shares();
        let pk = liveness_public_key(&s[0]).unwrap();
        let c = challenge();
        let sig = sign_liveness_proof(&s[0], HUB, HOLDER, &c).unwrap();
        assert!(!verify_liveness_proof(&pk, "another-hub", HOLDER, &c, &sig));
        assert!(!verify_liveness_proof(&pk, HUB, "another-holder", &c, &sig));
    }

    #[test]
    fn length_prefixing_prevents_field_boundary_shifts() {
        let c = challenge();
        assert_ne!(
            build_liveness_message("ab", "c", &c),
            build_liveness_message("a", "bc", &c)
        );
    }

    #[test]
    fn message_carries_the_domain_label() {
        let c = challenge();
        let msg = build_liveness_message(HUB, HOLDER, &c);
        assert!(msg.starts_with(LABEL_RECOVERY_LIVENESS_PROOF.as_bytes()));
    }

    #[test]
    fn liveness_key_differs_from_the_commitment() {
        let s = shares();
        assert_ne!(liveness_public_key(&s[0]).unwrap(), shamir::commit(&s[0]));
    }

    #[test]
    fn garbage_signature_and_key_are_rejected() {
        let s = shares();
        let pk = liveness_public_key(&s[0]).unwrap();
        let c = challenge();
        assert!(!verify_liveness_proof(&pk, HUB, HOLDER, &c, &[0u8; 64]));
        let sig = sign_liveness_proof(&s[0], HUB, HOLDER, &c).unwrap();
        assert!(!verify_liveness_proof(&[0u8; 32], HUB, HOLDER, &c, &sig));
    }

    #[test]
    fn empty_or_zero_x_share_is_refused() {
        let empty = Share { x: 1, y: vec![] };
        assert!(liveness_public_key(&empty).is_err());
        let zero_x = Share {
            x: 0,
            y: vec![1, 2, 3],
        };
        assert!(liveness_public_key(&zero_x).is_err());
    }
}
