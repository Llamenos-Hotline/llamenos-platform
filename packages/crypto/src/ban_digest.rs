//! The ban digest: the one name a banned phone number has, on every platform (#2759).
//!
//! A ban is matched in real time against an inbound caller's number, so the server must be
//! able to compute a banned number's digest from a caller number it receives. That means the
//! server holds the key. What it must NOT get is the number an admin types when banning, and
//! no client may hold the key either: a phone number space is small and its format is known,
//! so anyone holding the key and the stored column can enumerate every banned number offline.
//!
//! An oblivious PRF (RFC 9497, mode `0x00`, suite `ristretto255-SHA512`) satisfies both:
//!
//! - **Admin banning a number** — the client [`blind`]s the number, the server answers with
//!   [`blind_evaluate`] under the scope's key, and the client [`finalize`]s it into the
//!   digest. The server sees only a uniformly random group element; the client never sees the
//!   key, so it cannot compute any digest without asking the server — one online, permission-
//!   checked request per number.
//! - **Inbound call** — the server already has the caller's number from the provider and
//!   computes the same digest directly with [`evaluate`].
//!
//! The digest is `F(k_scope, HMAC_BAN_PREFIX || E.164)`. Each scope (a hub, or the platform)
//! has its own key, `DeriveKeyPair(BAN_HASH_KEY, LABEL_BAN_KEY_DERIVE ":" scope)`, so one
//! hub's ban digests cannot be compared with another hub's or the platform's.
//!
//! Everything here follows RFC 9497 exactly and is pinned to its Appendix A.1.1 test vectors,
//! so any conforming implementation (the desktop test mock uses `@noble/curves`) interoperates.

use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::Identity;
use sha2::{Digest, Sha512};
use zeroize::Zeroize;

use crate::errors::CryptoError;
use crate::labels::{HMAC_BAN_PREFIX, LABEL_BAN_KEY_DERIVE};

/// RFC 9497 §3.1 `contextString` for mode `0x00` (OPRF) with `ristretto255-SHA512`.
const CONTEXT_STRING: &[u8] = b"OPRFV1-\x00-ristretto255-SHA512";

/// Length in bytes of a serialized element and of a scalar.
pub const ELEMENT_LEN: usize = 32;
/// Length in bytes of a ban digest (the SHA-512 `Finalize` output).
pub const DIGEST_LEN: usize = 64;

/// The client half of one blinded evaluation: what it keeps, and what it sends.
#[derive(Clone)]
pub struct Blinded {
    /// The blind scalar. The client keeps it until [`finalize`]; it is never sent.
    pub blind: [u8; ELEMENT_LEN],
    /// The blinded element sent to the server.
    pub blinded_element: [u8; ELEMENT_LEN],
}

impl Drop for Blinded {
    fn drop(&mut self) {
        self.blind.zeroize();
    }
}

/// The one rule for what counts as a phone number here: `+` then 7–15 digits, nothing else.
///
/// Identical to the server's `e164PhoneSchema` / `isValidE164`, because the provider hands the
/// server exactly this shape at call time; a number typed with spaces or dashes would digest
/// to something no inbound call can ever match, so it is refused rather than normalised.
pub fn is_e164(phone: &str) -> bool {
    let Some(digits) = phone.strip_prefix('+') else {
        return false;
    };
    (7..=15).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
}

/// The OPRF input for a caller identifier: `HMAC_BAN_PREFIX || identifier`.
fn ban_input(identifier: &str) -> Result<Vec<u8>, CryptoError> {
    if identifier.is_empty() {
        return Err(CryptoError::InvalidInput(
            "caller identifier must not be empty".into(),
        ));
    }
    Ok(format!("{HMAC_BAN_PREFIX}{identifier}").into_bytes())
}

/// The OPRF input for a number an admin typed: refused unless it is E.164, never normalised.
fn typed_ban_input(phone: &str) -> Result<Vec<u8>, CryptoError> {
    if !is_e164(phone) {
        return Err(CryptoError::InvalidInput(
            "phone number must be E.164 (+ followed by 7-15 digits)".into(),
        ));
    }
    ban_input(phone)
}

fn key_info(scope: &str) -> Result<Vec<u8>, CryptoError> {
    if scope.is_empty() {
        return Err(CryptoError::InvalidInput(
            "ban scope must not be empty".into(),
        ));
    }
    Ok(format!("{LABEL_BAN_KEY_DERIVE}:{scope}").into_bytes())
}

fn i2osp2(n: usize) -> Result<[u8; 2], CryptoError> {
    u16::try_from(n)
        .map(u16::to_be_bytes)
        .map_err(|_| CryptoError::InvalidInput("input longer than 65535 bytes".into()))
}

/// RFC 9380 §5.3.1 `expand_message_xmd` with SHA-512, for a 64-byte output (`ell = 1`).
fn expand_message_xmd_64(msg: &[&[u8]], dst: &[&[u8]]) -> [u8; 64] {
    let dst_len: usize = dst.iter().map(|d| d.len()).sum();
    debug_assert!(dst_len <= 255);
    let dst_len_byte = [dst_len as u8];

    let mut h0 = Sha512::new();
    h0.update([0u8; 128]); // Z_pad: SHA-512's block size
    for m in msg {
        h0.update(m);
    }
    h0.update(64u16.to_be_bytes()); // l_i_b_str
    h0.update([0u8]);
    for d in dst {
        h0.update(d);
    }
    h0.update(dst_len_byte);
    let b0 = h0.finalize();

    let mut h1 = Sha512::new();
    h1.update(b0);
    h1.update([1u8]);
    for d in dst {
        h1.update(d);
    }
    h1.update(dst_len_byte);
    h1.finalize().into()
}

fn hash_to_group(input: &[u8]) -> RistrettoPoint {
    let uniform = expand_message_xmd_64(&[input], &[b"HashToGroup-", CONTEXT_STRING]);
    RistrettoPoint::from_uniform_bytes(&uniform)
}

/// RFC 9497 §3.2.1 `DeriveKeyPair`, secret half only (mode 0x00 never publishes the public key).
fn derive_key(seed: &[u8; 32], info: &[u8]) -> Result<Scalar, CryptoError> {
    let info_len = i2osp2(info.len())?;
    for counter in 0u8..=255 {
        let mut uniform = expand_message_xmd_64(
            &[seed, &info_len, info, &[counter]],
            &[b"DeriveKeyPair", CONTEXT_STRING],
        );
        let sk = Scalar::from_bytes_mod_order_wide(&uniform);
        uniform.zeroize();
        if sk != Scalar::ZERO {
            return Ok(sk);
        }
    }
    Err(CryptoError::KeyDerivationFailed(
        "DeriveKeyPair exhausted its counter".into(),
    ))
}

fn scope_key(ban_hash_key: &[u8; 32], scope: &str) -> Result<Scalar, CryptoError> {
    derive_key(ban_hash_key, &key_info(scope)?)
}

fn decode_element(bytes: &[u8]) -> Result<RistrettoPoint, CryptoError> {
    let compressed = CompressedRistretto::from_slice(bytes)
        .map_err(|_| CryptoError::InvalidInput("group element must be 32 bytes".into()))?;
    let point = compressed
        .decompress()
        .ok_or_else(|| CryptoError::InvalidInput("not a valid ristretto255 element".into()))?;
    if point == RistrettoPoint::identity() {
        return Err(CryptoError::InvalidInput(
            "group element is the identity".into(),
        ));
    }
    Ok(point)
}

fn finalize_hash(
    input: &[u8],
    unblinded: &[u8; ELEMENT_LEN],
) -> Result<[u8; DIGEST_LEN], CryptoError> {
    let mut h = Sha512::new();
    h.update(i2osp2(input.len())?);
    h.update(input);
    h.update(i2osp2(ELEMENT_LEN)?);
    h.update(unblinded);
    h.update(b"Finalize");
    Ok(h.finalize().into())
}

fn blind_with(input: &[u8], blind: Scalar) -> Result<Blinded, CryptoError> {
    let element = hash_to_group(input);
    if element == RistrettoPoint::identity() {
        return Err(CryptoError::InvalidInput(
            "input hashes to the identity".into(),
        ));
    }
    Ok(Blinded {
        blind: blind.to_bytes(),
        blinded_element: (blind * element).compress().to_bytes(),
    })
}

fn finalize_input(
    input: &[u8],
    blind: &[u8; ELEMENT_LEN],
    evaluated_element: &[u8],
) -> Result<[u8; DIGEST_LEN], CryptoError> {
    let blind: Option<Scalar> = Scalar::from_canonical_bytes(*blind).into();
    let blind = blind.filter(|b| *b != Scalar::ZERO).ok_or_else(|| {
        CryptoError::InvalidInput("blind is not a canonical non-zero scalar".into())
    })?;
    let unblinded = (blind.invert() * decode_element(evaluated_element)?)
        .compress()
        .to_bytes();
    finalize_hash(input, &unblinded)
}

// ── Client side ────────────────────────────────────────────────────────

/// Blind a phone number for a ban digest. Send `blinded_element`; keep `blind` for [`finalize`].
pub fn blind(phone: &str) -> Result<Blinded, CryptoError> {
    let input = typed_ban_input(phone)?;
    loop {
        let mut wide = [0u8; 64];
        getrandom::getrandom(&mut wide)
            .map_err(|e| CryptoError::EncryptionFailed(format!("getrandom failed: {e}")))?;
        let r = Scalar::from_bytes_mod_order_wide(&wide);
        wide.zeroize();
        if r != Scalar::ZERO {
            return blind_with(&input, r);
        }
    }
}

/// Turn the server's evaluation of a [`blind`]ed number into its ban digest.
pub fn finalize(
    phone: &str,
    blind: &[u8; ELEMENT_LEN],
    evaluated_element: &[u8],
) -> Result<[u8; DIGEST_LEN], CryptoError> {
    finalize_input(&typed_ban_input(phone)?, blind, evaluated_element)
}

// ── Server side ────────────────────────────────────────────────────────

/// Evaluate a client's blinded element under one scope's key. Learns nothing about the number.
pub fn blind_evaluate(
    ban_hash_key: &[u8; 32],
    scope: &str,
    blinded_element: &[u8],
) -> Result<[u8; ELEMENT_LEN], CryptoError> {
    let element = decode_element(blinded_element)?;
    Ok((scope_key(ban_hash_key, scope)? * element)
        .compress()
        .to_bytes())
}

/// The ban digest of a caller identifier the server already holds (an inbound caller, a
/// call's sealed number), under one scope's key. Equal to what [`blind`] → [`blind_evaluate`]
/// → [`finalize`] produces for the same number and scope.
///
/// Unlike the client half this does not insist on E.164: a provider can present a caller as
/// something else (a withheld or SIP identity), and the call path must still be able to check
/// and ban it exactly as it could before. Only an empty identifier is refused.
pub fn evaluate(
    ban_hash_key: &[u8; 32],
    scope: &str,
    identifier: &str,
) -> Result<[u8; DIGEST_LEN], CryptoError> {
    let input = ban_input(identifier)?;
    let element = hash_to_group(&input);
    if element == RistrettoPoint::identity() {
        return Err(CryptoError::InvalidInput(
            "input hashes to the identity".into(),
        ));
    }
    let issued = (scope_key(ban_hash_key, scope)? * element)
        .compress()
        .to_bytes();
    finalize_hash(&input, &issued)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        hex::decode(s).unwrap()
    }

    /// RFC 9497 Appendix A.1.1 — OPRF(ristretto255, SHA-512), mode 0x00.
    const SEED: &str = "a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3";
    const KEY_INFO: &str = "74657374206b6579";
    const SK: &str = "5ebcea5ee37023ccb9fc2d2019f9d7737be85591ae8652ffa9ef0f4d37063b0e";
    const BLIND: &str = "64d37aed22a27f5191de1c1d69fadb899d8862b58eb4220029e036ec4c1f6706";
    struct Vector {
        input: &'static str,
        blinded: &'static str,
        evaluated: &'static str,
        output: &'static str,
    }
    const VECTORS: [Vector; 2] = [
        Vector {
            input: "00",
            blinded: "609a0ae68c15a3cf6903766461307e5c8bb2f95e7e6550e1ffa2dc99e412803c",
            evaluated: "7ec6578ae5120958eb2db1745758ff379e77cb64fe77b0b2d8cc917ea0869c7e",
            output: "527759c3d9366f277d8c6020418d96bb393ba2afb20ff90df23fb7708264e2f3ab9135e3bd69955851de4b1f9fe8a0973396719b7912ba9ee8aa7d0b5e24bcf6",
        },
        Vector {
            input: "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
            blinded: "da27ef466870f5f15296299850aa088629945a17d1f5b7f5ff043f76b3c06418",
            evaluated: "b4cbf5a4f1eeda5a63ce7b77c7d23f461db3fcab0dd28e4e17cecb5c90d02c25",
            output: "f4a74c9c592497375e796aa837e907b1a045d34306a749db9f34221f7e750cb4f2a6413a6bf6fa5e19ba6348eb673934a722a7ede2e7621306d18951e7cf2c73",
        },
    ];

    fn seed() -> [u8; 32] {
        h(SEED).try_into().unwrap()
    }

    #[test]
    fn derive_key_pair_matches_rfc9497() {
        let sk = derive_key(&seed(), &h(KEY_INFO)).unwrap();
        assert_eq!(hex::encode(sk.to_bytes()), SK);
    }

    #[test]
    fn blind_evaluate_finalize_match_rfc9497() {
        let sk = derive_key(&seed(), &h(KEY_INFO)).unwrap();
        let blind: [u8; 32] = h(BLIND).try_into().unwrap();
        let r: Scalar = Option::from(Scalar::from_canonical_bytes(blind)).unwrap();
        for v in VECTORS {
            let input = h(v.input);
            let b = blind_with(&input, r).unwrap();
            assert_eq!(hex::encode(b.blinded_element), v.blinded);
            let evaluated = (sk * decode_element(&b.blinded_element).unwrap())
                .compress()
                .to_bytes();
            assert_eq!(hex::encode(evaluated), v.evaluated);
            let out = finalize_input(&input, &b.blind, &evaluated).unwrap();
            assert_eq!(hex::encode(out), v.output);
            // Evaluate (the non-interactive path) is the same function.
            let issued = (sk * hash_to_group(&input)).compress().to_bytes();
            assert_eq!(
                hex::encode(finalize_hash(&input, &issued).unwrap()),
                v.output
            );
        }
    }

    #[test]
    fn oblivious_round_trip_equals_direct_evaluation() {
        let key = [7u8; 32];
        let phone = "+12125551234";
        let b = blind(phone).unwrap();
        let evaluated = blind_evaluate(&key, "platform", &b.blinded_element).unwrap();
        let oblivious = finalize(phone, &b.blind, &evaluated).unwrap();
        assert_eq!(oblivious, evaluate(&key, "platform", phone).unwrap());
    }

    #[test]
    fn a_fresh_blind_hides_the_number_each_time() {
        let a = blind("+12125551234").unwrap();
        let b = blind("+12125551234").unwrap();
        assert_ne!(a.blinded_element, b.blinded_element);
    }

    #[test]
    fn scopes_have_unrelated_digests() {
        let key = [7u8; 32];
        let phone = "+12125551234";
        let platform = evaluate(&key, "platform", phone).unwrap();
        let hub = evaluate(&key, "hub-1", phone).unwrap();
        let other = evaluate(&key, "hub-2", phone).unwrap();
        assert_ne!(platform, hub);
        assert_ne!(hub, other);
    }

    #[test]
    fn the_key_matters() {
        let phone = "+12125551234";
        assert_ne!(
            evaluate(&[7u8; 32], "platform", phone).unwrap(),
            evaluate(&[8u8; 32], "platform", phone).unwrap()
        );
    }

    #[test]
    fn non_e164_input_is_refused_not_normalised() {
        for bad in [
            "12125551234",
            "+1 212 555 1234",
            "+1-212-555-1234",
            "+123456",
            "+1234567890123456",
            "",
            "+",
        ] {
            assert!(blind(bad).is_err(), "{bad:?} must be refused");
        }
        let b = blind("+12125551234").unwrap();
        assert!(finalize("+1 212 555 1234", &b.blind, &b.blinded_element).is_err());
        assert!(blind("+1234567").is_ok());
        assert!(blind("+123456789012345").is_ok());
    }

    #[test]
    fn the_server_digests_any_caller_identifier_but_an_empty_one() {
        let key = [7u8; 32];
        assert!(evaluate(&key, "platform", "anonymous").is_ok());
        assert!(evaluate(&key, "platform", "").is_err());
    }

    #[test]
    fn invalid_elements_are_refused() {
        let key = [7u8; 32];
        assert!(
            blind_evaluate(&key, "platform", &[0u8; 32]).is_err(),
            "identity"
        );
        assert!(
            blind_evaluate(&key, "platform", &[0xffu8; 32]).is_err(),
            "not an encoding"
        );
        assert!(
            blind_evaluate(&key, "platform", &[1u8; 31]).is_err(),
            "short"
        );
        let b = blind("+12125551234").unwrap();
        assert!(finalize("+12125551234", &b.blind, &[0u8; 32]).is_err());
        assert!(
            finalize("+12125551234", &[0u8; 32], &b.blinded_element).is_err(),
            "zero blind"
        );
        assert!(
            blind_evaluate(&key, "", &b.blinded_element).is_err(),
            "empty scope"
        );
    }
}
