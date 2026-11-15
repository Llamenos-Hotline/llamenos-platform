//! Shamir Secret Sharing over GF(2^8).
//!
//! Splits a secret into N shares such that any K (threshold) shares can reconstruct
//! the original secret, but fewer than K shares reveal zero information about the secret
//! (information-theoretic security).
//!
//! Uses GF(2^8) arithmetic with the AES irreducible polynomial x^8 + x^4 + x^3 + x + 1
//! (0x11B). Each byte of the secret is processed independently as a separate polynomial.
//!
//! ## Constraints
//!
//! - `threshold` (K) must be in [2, 5]
//! - `total` (N) must be in [3, 5]
//! - `threshold <= total`
//!
//! ## Security
//!
//! - Random coefficients sourced from `getrandom` (OS CSPRNG)
//! - Evaluation points are 1-indexed (never 0 — x=0 is the secret)
//! - Secret bytes are zeroized after splitting
//! - SHA-256 commitments for tamper detection

use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::errors::CryptoError;
use crate::labels::LABEL_SHAMIR_COMMIT;

// =============================================================================
// GF(2^8) Arithmetic
// =============================================================================

/// AES irreducible polynomial: x^8 + x^4 + x^3 + x + 1 = 0x11B
const GF256_MODULUS: u16 = 0x11B;

/// Compile-time GF(2^8) multiplication (Russian peasant, used only for table generation).
const fn gf256_mul_ct(a: u8, b: u8) -> u8 {
    let mut aa = a;
    let mut bb = b;
    let mut result: u8 = 0;
    let mut i = 0;
    while i < 8 {
        if bb & 1 != 0 {
            result ^= aa;
        }
        let carry = aa & 0x80;
        aa <<= 1;
        if carry != 0 {
            aa ^= GF256_MODULUS as u8;
        }
        bb >>= 1;
        i += 1;
    }
    result
}

/// 256x256 constant lookup table for GF(2^8) multiplication.
/// Generated at compile time — eliminates all data-dependent branching at runtime.
static GF256_MUL_TABLE: [[u8; 256]; 256] = {
    let mut table = [[0u8; 256]; 256];
    let mut a = 0usize;
    while a < 256 {
        let mut b = 0usize;
        while b < 256 {
            table[a][b] = gf256_mul_ct(a as u8, b as u8);
            b += 1;
        }
        a += 1;
    }
    table
};

/// Constant-time multiplication in GF(2^8) via lookup table.
#[inline]
fn gf256_mul(a: u8, b: u8) -> u8 {
    GF256_MUL_TABLE[a as usize][b as usize]
}

/// Addition in GF(2^8) — XOR.
#[inline]
fn gf256_add(a: u8, b: u8) -> u8 {
    a ^ b
}

/// Multiplicative inverse in GF(2^8) via extended Euclidean algorithm.
///
/// Returns 0 for input 0 (which has no inverse — caller must prevent this).
fn gf256_inv(a: u8) -> u8 {
    if a == 0 {
        return 0; // 0 has no inverse — should never be called with 0
    }
    // Fermat's little theorem: a^(-1) = a^(254) in GF(2^8) since |GF(2^8)*| = 255
    let mut result = a;
    // Square-and-multiply: compute a^254 = a^(11111110_b)
    // a^2
    result = gf256_mul(result, result);
    // a^3 = a^2 * a
    let a3 = gf256_mul(result, a);
    // a^6 = (a^3)^2
    result = gf256_mul(a3, a3);
    // a^7 = a^6 * a
    let a7 = gf256_mul(result, a);
    // a^14 = (a^7)^2
    result = gf256_mul(a7, a7);
    // a^15 = a^14 * a
    let a15 = gf256_mul(result, a);
    // a^30 = (a^15)^2
    result = gf256_mul(a15, a15);
    // a^31 = a^30 * a
    let a31 = gf256_mul(result, a);
    // a^62 = (a^31)^2
    result = gf256_mul(a31, a31);
    // a^63 = a^62 * a
    let a63 = gf256_mul(result, a);
    // a^126 = (a^63)^2
    result = gf256_mul(a63, a63);
    // a^127 = a^126 * a
    let a127 = gf256_mul(result, a);
    // a^254 = (a^127)^2
    gf256_mul(a127, a127)
}

/// Division in GF(2^8): a / b = a * b^(-1).
#[inline]
fn gf256_div(a: u8, b: u8) -> Result<u8, CryptoError> {
    if b == 0 {
        return Err(CryptoError::InvalidInput(
            "division by zero in GF(2^8)".to_string(),
        ));
    }
    Ok(gf256_mul(a, gf256_inv(b)))
}

// =============================================================================
// Share Type
// =============================================================================

/// A single Shamir share: evaluation point x and the vector of y-values (one per secret byte).
#[derive(Clone, Debug)]
pub struct Share {
    /// Evaluation point (1-indexed, never 0)
    pub x: u8,
    /// y-values, one per byte of the original secret
    pub y: Vec<u8>,
}

impl Drop for Share {
    fn drop(&mut self) {
        self.y.zeroize();
    }
}

/// A Shamir share for UniFFI export (y as hex string).
///
/// This type is used by mobile bindings because `Vec<u8>` fields conflict
/// with `Drop` when combined with `uniffi::Record`.
///
/// `Zeroize` is derived so callers can explicitly zeroize the secret share data.
/// Custom `Drop` is not implemented because it conflicts with `uniffi::Record`.
#[derive(Clone, Debug, Zeroize)]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct ShamirShare {
    pub x: u8,
    pub y_hex: String,
}

impl Share {
    /// Convert to a UniFFI-friendly `ShamirShare`.
    pub fn to_shamir_share(&self) -> ShamirShare {
        ShamirShare {
            x: self.x,
            y_hex: hex::encode(&self.y),
        }
    }
}

impl ShamirShare {
    /// Convert back to the internal `Share` type.
    pub fn to_share(&self) -> Result<Share, CryptoError> {
        let y = hex::decode(&self.y_hex).map_err(CryptoError::HexError)?;
        Ok(Share { x: self.x, y })
    }
}

// =============================================================================
// Public API
// =============================================================================

/// Split a secret into `total` shares with reconstruction `threshold`.
///
/// - `secret`: arbitrary-length byte slice (must not be empty)
/// - `total`: number of shares to generate, N in [3, 5]
/// - `threshold`: minimum shares needed to reconstruct, K in [2, 5], K <= N
///
/// Returns a vector of N shares. The secret is processed byte-by-byte:
/// for each byte, a random polynomial of degree (threshold - 1) is created
/// with the secret byte as the constant term, and evaluated at points 1..=total.
pub fn split(secret: &[u8], total: u8, threshold: u8) -> Result<Vec<Share>, CryptoError> {
    validate_params(total, threshold)?;

    if secret.is_empty() {
        return Err(CryptoError::InvalidInput(
            "secret must not be empty".to_string(),
        ));
    }

    let secret_len = secret.len();

    // Generate random coefficients for each byte's polynomial.
    // For each secret byte, we need (threshold - 1) random coefficients.
    let num_coeffs = (threshold as usize - 1) * secret_len;
    let mut coeffs = vec![0u8; num_coeffs];
    getrandom::getrandom(&mut coeffs)
        .map_err(|e| CryptoError::EncryptionFailed(format!("RNG failed: {e}")))?;

    // Initialize shares
    let mut shares: Vec<Share> = (1..=total)
        .map(|x| Share {
            x,
            y: vec![0u8; secret_len],
        })
        .collect();

    // For each byte of the secret, evaluate the polynomial at each share's x
    for (byte_idx, secret_byte) in secret.iter().enumerate() {
        let coeff_offset = byte_idx * (threshold as usize - 1);

        for share in shares.iter_mut() {
            // Evaluate polynomial: secret[byte_idx] + c1*x + c2*x^2 + ... + c_{k-1}*x^{k-1}
            let mut value = *secret_byte;
            let mut x_power = share.x; // x^1

            for coeff_idx in 0..(threshold as usize - 1) {
                let term = gf256_mul(coeffs[coeff_offset + coeff_idx], x_power);
                value = gf256_add(value, term);
                x_power = gf256_mul(x_power, share.x); // x^(i+1)
            }

            share.y[byte_idx] = value;
        }
    }

    // Zeroize coefficient buffer
    coeffs.zeroize();

    Ok(shares)
}

/// Reconstruct the secret from a set of shares using Lagrange interpolation.
///
/// Requires at least `threshold` shares. Returns an error if fewer shares are provided.
///
/// Providing more shares than the threshold is allowed and will produce the correct secret
/// as long as the shares are consistent.
pub fn combine(shares: &[Share], threshold: u8) -> Result<Vec<u8>, CryptoError> {
    if shares.is_empty() {
        return Err(CryptoError::InvalidInput("no shares provided".to_string()));
    }

    if (shares.len() as u8) < threshold {
        return Err(CryptoError::InvalidInput(format!(
            "insufficient shares: got {}, need at least {threshold}",
            shares.len()
        )));
    }

    // Verify all shares have the same y length
    let secret_len = shares[0].y.len();
    if shares.iter().any(|s| s.y.len() != secret_len) {
        return Err(CryptoError::InvalidInput(
            "shares have inconsistent lengths".to_string(),
        ));
    }

    // Verify no duplicate x values
    for i in 0..shares.len() {
        for j in (i + 1)..shares.len() {
            if shares[i].x == shares[j].x {
                return Err(CryptoError::InvalidInput(format!(
                    "duplicate share x value: {}",
                    shares[i].x
                )));
            }
        }
    }

    // Verify no x=0 (x=0 would be the secret itself)
    if shares.iter().any(|s| s.x == 0) {
        return Err(CryptoError::InvalidInput(
            "share x value must not be 0".to_string(),
        ));
    }

    let mut secret = vec![0u8; secret_len];

    // Lagrange interpolation at x=0 for each byte position
    for (byte_idx, _) in shares[0].y.iter().enumerate() {
        let mut value = 0u8;

        for (i, share_i) in shares.iter().enumerate() {
            let xi = share_i.x;
            let yi = share_i.y[byte_idx];

            // Compute Lagrange basis polynomial L_i(0)
            // L_i(0) = product_{j != i} (0 - x_j) / (x_i - x_j)
            //        = product_{j != i} x_j / (x_i - x_j)
            // In GF(2^8): subtraction = addition = XOR
            let mut numerator = 1u8;
            let mut denominator = 1u8;

            for (j, share_j) in shares.iter().enumerate() {
                if i == j {
                    continue;
                }
                let xj = share_j.x;
                numerator = gf256_mul(numerator, xj); // product of x_j
                denominator = gf256_mul(denominator, gf256_add(xi, xj)); // product of (x_i XOR x_j)
            }

            let lagrange_coeff = gf256_div(numerator, denominator)?;
            let term = gf256_mul(yi, lagrange_coeff);
            value = gf256_add(value, term);
        }

        secret[byte_idx] = value;
    }

    Ok(secret)
}

/// Compute a SHA-256 commitment for a share.
///
/// The commitment binds (x, y) together so that tampering with either value
/// is detectable before attempting reconstruction.
///
/// Format: SHA-256(domain_prefix || x || y)
pub fn commit(share: &Share) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(LABEL_SHAMIR_COMMIT.as_bytes());
    hasher.update([share.x]);
    hasher.update(&share.y);
    hasher.finalize().into()
}

/// Verify a share against a previously computed commitment.
pub fn verify(share: &Share, commitment: &[u8; 32]) -> bool {
    let computed = commit(share);
    // Constant-time comparison to prevent timing attacks
    constant_time_eq(&computed, commitment)
}

/// Generate an X25519 keypair for a recovery group.
///
/// The private key is intended to be immediately Shamir-split and then zeroized.
/// Returns `(secret_key_hex, public_key_hex)`.
///
/// This is a thin wrapper around `hpke_envelope::generate_x25519_keypair()` that
/// exists for API clarity — recovery group keypairs are X25519 like all other
/// HPKE keypairs in the system.
pub fn generate_recovery_group_keypair() -> (zeroize::Zeroizing<String>, String) {
    crate::hpke_envelope::generate_x25519_keypair()
}

// =============================================================================
// Internal Helpers
// =============================================================================

/// Validate threshold and total parameters.
fn validate_params(total: u8, threshold: u8) -> Result<(), CryptoError> {
    if threshold < 2 {
        return Err(CryptoError::InvalidInput(
            "threshold must be at least 2".to_string(),
        ));
    }
    if threshold > 5 {
        return Err(CryptoError::InvalidInput(
            "threshold must be at most 5".to_string(),
        ));
    }
    if total < 3 {
        return Err(CryptoError::InvalidInput(
            "total shares must be at least 3".to_string(),
        ));
    }
    if total > 5 {
        return Err(CryptoError::InvalidInput(
            "total shares must be at most 5".to_string(),
        ));
    }
    if threshold > total {
        return Err(CryptoError::InvalidInput(format!(
            "threshold ({threshold}) must not exceed total ({total})"
        )));
    }
    Ok(())
}

/// Constant-time byte array comparison (prevents timing side-channels on commitments).
fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for i in 0..32 {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: generate a random secret of the given length.
    fn random_secret(len: usize) -> Vec<u8> {
        let mut buf = vec![0u8; len];
        getrandom::getrandom(&mut buf).unwrap();
        buf
    }

    // =========================================================================
    // GF(2^8) arithmetic tests
    // =========================================================================

    #[test]
    fn gf256_mul_identity() {
        for a in 0..=255u8 {
            assert_eq!(gf256_mul(a, 1), a, "a * 1 should equal a");
            assert_eq!(gf256_mul(1, a), a, "1 * a should equal a");
        }
    }

    #[test]
    fn gf256_mul_zero() {
        for a in 0..=255u8 {
            assert_eq!(gf256_mul(a, 0), 0, "a * 0 should equal 0");
            assert_eq!(gf256_mul(0, a), 0, "0 * a should equal 0");
        }
    }

    #[test]
    fn gf256_mul_commutative() {
        // Spot check commutativity
        for a in [1u8, 2, 3, 17, 42, 100, 200, 255] {
            for b in [1u8, 2, 3, 17, 42, 100, 200, 255] {
                assert_eq!(
                    gf256_mul(a, b),
                    gf256_mul(b, a),
                    "multiplication should be commutative for ({a}, {b})"
                );
            }
        }
    }

    #[test]
    fn gf256_inverse_roundtrip() {
        // Every nonzero element has an inverse: a * a^(-1) = 1
        for a in 1..=255u8 {
            let inv = gf256_inv(a);
            assert_ne!(inv, 0, "inverse of nonzero element should be nonzero");
            assert_eq!(gf256_mul(a, inv), 1, "a * a^(-1) should equal 1 for a={a}");
        }
    }

    #[test]
    fn gf256_known_values() {
        // AES S-box uses the same field. Verify a known multiplication:
        // 0x53 * 0xCA = 0x01 (these are inverses in AES's GF(2^8))
        assert_eq!(gf256_mul(0x53, 0xCA), 0x01);
    }

    // =========================================================================
    // Split/combine round-trip tests for all valid (K, N) combinations
    // =========================================================================

    #[test]
    fn roundtrip_2_of_3() {
        let secret = random_secret(32);
        let shares = split(&secret, 3, 2).unwrap();
        assert_eq!(shares.len(), 3);

        // Any 2 shares should reconstruct correctly
        for combo in &[[0, 1], [0, 2], [1, 2]] {
            let subset: Vec<Share> = combo.iter().map(|&i| shares[i].clone()).collect();
            let recovered = combine(&subset, 2).unwrap();
            assert_eq!(recovered, secret, "failed with shares {combo:?}");
        }

        // All 3 shares should also work
        let recovered = combine(&shares, 2).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn roundtrip_2_of_4() {
        let secret = random_secret(32);
        let shares = split(&secret, 4, 2).unwrap();
        assert_eq!(shares.len(), 4);

        let subset = vec![shares[1].clone(), shares[3].clone()];
        let recovered = combine(&subset, 2).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn roundtrip_2_of_5() {
        let secret = random_secret(32);
        let shares = split(&secret, 5, 2).unwrap();
        assert_eq!(shares.len(), 5);

        let subset = vec![shares[0].clone(), shares[4].clone()];
        let recovered = combine(&subset, 2).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn roundtrip_3_of_3() {
        let secret = random_secret(32);
        let shares = split(&secret, 3, 3).unwrap();
        let recovered = combine(&shares, 3).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn roundtrip_3_of_4() {
        let secret = random_secret(32);
        let shares = split(&secret, 4, 3).unwrap();

        // Any 3 of 4 should work
        for skip in 0..4 {
            let subset: Vec<Share> = shares
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != skip)
                .map(|(_, s)| s.clone())
                .collect();
            let recovered = combine(&subset, 3).unwrap();
            assert_eq!(recovered, secret, "failed when skipping share {skip}");
        }
    }

    #[test]
    fn roundtrip_3_of_5() {
        let secret = random_secret(32);
        let shares = split(&secret, 5, 3).unwrap();

        let subset = vec![shares[0].clone(), shares[2].clone(), shares[4].clone()];
        let recovered = combine(&subset, 3).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn roundtrip_4_of_4() {
        let secret = random_secret(32);
        let shares = split(&secret, 4, 4).unwrap();
        let recovered = combine(&shares, 4).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn roundtrip_4_of_5() {
        let secret = random_secret(32);
        let shares = split(&secret, 5, 4).unwrap();

        let subset: Vec<Share> = shares[0..4].to_vec();
        let recovered = combine(&subset, 4).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn roundtrip_5_of_5() {
        let secret = random_secret(32);
        let shares = split(&secret, 5, 5).unwrap();
        let recovered = combine(&shares, 5).unwrap();
        assert_eq!(recovered, secret);
    }

    // =========================================================================
    // Below-threshold is now rejected
    // =========================================================================

    #[test]
    fn below_threshold_rejected() {
        let secret = random_secret(32);
        let shares = split(&secret, 5, 3).unwrap();

        // 2 shares (below threshold of 3) should be rejected
        let subset = vec![shares[0].clone(), shares[1].clone()];
        let result = combine(&subset, 3);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("insufficient shares"));
    }

    #[test]
    fn single_share_below_threshold_rejected() {
        let secret = random_secret(32);
        let shares = split(&secret, 3, 2).unwrap();

        let subset = vec![shares[0].clone()];
        let result = combine(&subset, 2);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("insufficient shares"));
    }

    // =========================================================================
    // Commitment round-trip
    // =========================================================================

    #[test]
    fn commitment_roundtrip() {
        let secret = random_secret(32);
        let shares = split(&secret, 3, 2).unwrap();

        for share in &shares {
            let commitment = commit(share);
            assert!(verify(share, &commitment), "commitment should verify");
        }
    }

    /// Pinned cross-platform vector: `SHA-256("llamenos:shamir-commit:v1" || x || y)`
    /// computed outside Rust. The desktop crate's `ipc_surface_tests` pins the
    /// SAME literal against its own `shamir_commit` command, so a commitment
    /// format change on either side fails a test on both.
    #[test]
    fn commitment_matches_the_pinned_cross_platform_vector() {
        let share = Share {
            x: 7,
            y: hex::decode("0102030405060708090a0b0c0d0e0f10").unwrap(),
        };
        assert_eq!(
            hex::encode(commit(&share)),
            "5a46e2f7c18caaa8227164f370875bcea284606ed6abe0dc1d1fb8cc0dff2db5"
        );
    }

    #[test]
    fn commitment_includes_domain_prefix() {
        let share = Share { x: 1, y: vec![42] };
        let commitment = commit(&share);

        // Raw SHA-256(1 || 42) without prefix should differ
        let mut raw_hasher = Sha256::new();
        raw_hasher.update([1u8]);
        raw_hasher.update([42u8]);
        let raw_hash: [u8; 32] = raw_hasher.finalize().into();

        assert_ne!(
            commitment, raw_hash,
            "commitment must include domain prefix"
        );
    }

    #[test]
    fn commitments_are_unique_per_share() {
        let secret = random_secret(32);
        let shares = split(&secret, 5, 3).unwrap();

        let commitments: Vec<[u8; 32]> = shares.iter().map(commit).collect();
        for i in 0..commitments.len() {
            for j in (i + 1)..commitments.len() {
                assert_ne!(
                    commitments[i], commitments[j],
                    "different shares should have different commitments"
                );
            }
        }
    }

    // =========================================================================
    // Tampered share fails commitment
    // =========================================================================

    #[test]
    fn tampered_y_fails_commitment() {
        let secret = random_secret(32);
        let shares = split(&secret, 3, 2).unwrap();
        let commitment = commit(&shares[0]);

        // Tamper with y
        let mut tampered = shares[0].clone();
        tampered.y[0] ^= 0x01;
        assert!(
            !verify(&tampered, &commitment),
            "tampered y should fail verification"
        );
    }

    #[test]
    fn tampered_x_fails_commitment() {
        let secret = random_secret(32);
        let shares = split(&secret, 3, 2).unwrap();
        let commitment = commit(&shares[0]);

        // Tamper with x
        let mut tampered = shares[0].clone();
        tampered.x = if tampered.x == 1 { 2 } else { 1 };
        assert!(
            !verify(&tampered, &commitment),
            "tampered x should fail verification"
        );
    }

    // =========================================================================
    // Invalid parameters rejected
    // =========================================================================

    #[test]
    fn threshold_below_2_rejected() {
        let secret = random_secret(32);
        let result = split(&secret, 3, 1);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("threshold must be at least 2"));
    }

    #[test]
    fn threshold_above_5_rejected() {
        let secret = random_secret(32);
        let result = split(&secret, 5, 6);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("threshold must be at most 5"));
    }

    #[test]
    fn total_below_3_rejected() {
        let secret = random_secret(32);
        let result = split(&secret, 2, 2);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("total shares must be at least 3"));
    }

    #[test]
    fn total_above_5_rejected() {
        let secret = random_secret(32);
        let result = split(&secret, 6, 3);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("total shares must be at most 5"));
    }

    #[test]
    fn threshold_exceeds_total_rejected() {
        let secret = random_secret(32);
        let result = split(&secret, 3, 4);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("must not exceed total"));
    }

    #[test]
    fn empty_secret_rejected() {
        let result = split(&[], 3, 2);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("secret must not be empty"));
    }

    #[test]
    fn empty_shares_rejected() {
        let result = combine(&[], 2);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("no shares provided"));
    }

    #[test]
    fn duplicate_x_rejected() {
        let share = Share { x: 1, y: vec![42] };
        let result = combine(&[share.clone(), share], 2);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("duplicate share x value"));
    }

    // =========================================================================
    // Variable secret sizes
    // =========================================================================

    #[test]
    fn single_byte_secret() {
        let secret = vec![0xAB];
        let shares = split(&secret, 3, 2).unwrap();
        let subset = vec![shares[0].clone(), shares[2].clone()];
        let recovered = combine(&subset, 2).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn large_secret() {
        let secret = random_secret(1024);
        let shares = split(&secret, 3, 2).unwrap();
        let subset = vec![shares[0].clone(), shares[1].clone()];
        let recovered = combine(&subset, 2).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn all_zeros_secret() {
        let secret = vec![0u8; 32];
        let shares = split(&secret, 3, 2).unwrap();
        let subset = vec![shares[0].clone(), shares[1].clone()];
        let recovered = combine(&subset, 2).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn all_ones_secret() {
        let secret = vec![0xFFu8; 32];
        let shares = split(&secret, 3, 2).unwrap();
        let subset = vec![shares[1].clone(), shares[2].clone()];
        let recovered = combine(&subset, 2).unwrap();
        assert_eq!(recovered, secret);
    }

    // =========================================================================
    // Determinism: same secret split twice produces different shares
    // =========================================================================

    #[test]
    fn different_splits_produce_different_shares() {
        let secret = random_secret(32);
        let shares1 = split(&secret, 3, 2).unwrap();
        let shares2 = split(&secret, 3, 2).unwrap();

        // With overwhelming probability, the shares will differ due to random coefficients
        let any_differ = shares1
            .iter()
            .zip(shares2.iter())
            .any(|(s1, s2)| s1.y != s2.y);
        assert!(
            any_differ,
            "two splits of the same secret should produce different shares"
        );
    }

    // =========================================================================
    // Recovery group keypair generation
    // =========================================================================

    #[test]
    fn shamir_share_zeroize() {
        let mut share = ShamirShare {
            x: 1,
            y_hex: "deadbeef".to_string(),
        };
        share.zeroize();
        assert!(share.y_hex.is_empty());
        assert_eq!(share.x, 0);
    }

    #[test]
    fn recovery_group_keypair_roundtrip_with_hpke() {
        use crate::hpke_envelope::{hpke_open, hpke_seal};
        use crate::labels::LABEL_RECOVERY_PUK_SEED_WRAP;

        let (sk_hex, pk_hex) = generate_recovery_group_keypair();

        // Verify key lengths
        assert_eq!(sk_hex.len(), 64, "secret key should be 32 bytes hex");
        assert_eq!(pk_hex.len(), 64, "public key should be 32 bytes hex");

        // Round-trip: seal a PUK seed under the recovery group pubkey, open with privkey
        let puk_seed = random_secret(32);
        let aad = b"test-hub-id:puk-seed";
        let envelope = hpke_seal(&puk_seed, &pk_hex, LABEL_RECOVERY_PUK_SEED_WRAP, aad).unwrap();
        let decrypted = hpke_open(&envelope, &sk_hex, LABEL_RECOVERY_PUK_SEED_WRAP, aad).unwrap();
        assert_eq!(decrypted, puk_seed);
    }

    #[test]
    fn recovery_group_keypair_unique() {
        let (sk1, pk1) = generate_recovery_group_keypair();
        let (sk2, pk2) = generate_recovery_group_keypair();
        assert_ne!(*sk1, *sk2);
        assert_ne!(pk1, pk2);
    }
}
