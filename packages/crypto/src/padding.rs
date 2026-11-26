//! Payload padding for traffic analysis resistance.
//!
//! All hub event payloads are padded to a power-of-2 bucket before encryption
//! so that ciphertext length does not reveal content type or message size.
//!
//! ## Format
//! ```text
//! [4-byte LE actual-length][plaintext][random padding bytes]
//! ```
//!
//! ## Buckets
//! 512, 1024, 2048, 4096, 8192, … (powers of 2, minimum 512 B)
//!
//! The padding bytes are cryptographically random (getrandom).  The decrypt
//! side reads the 4-byte length prefix and discards the trailing padding.

use crate::errors::CryptoError;

const MIN_BUCKET: usize = 512;

/// Pad `plaintext` to the next power-of-2 bucket (minimum 512 B).
///
/// Output format: `[4-byte LE length][plaintext][random padding]`
pub fn pad_to_bucket(plaintext: &[u8]) -> Vec<u8> {
    pad_to_bucket_with(plaintext, |tail| {
        getrandom::getrandom(tail).expect("getrandom failed")
    })
}

/// [`pad_to_bucket`] with the padding filled by `fill`, so the cross-platform
/// vectors can be generated from a fixed seed. Production uses [`pad_to_bucket`].
pub(crate) fn pad_to_bucket_with(plaintext: &[u8], mut fill: impl FnMut(&mut [u8])) -> Vec<u8> {
    let total_needed = 4 + plaintext.len();
    let mut bucket = MIN_BUCKET;
    while bucket < total_needed {
        bucket *= 2;
    }

    let mut out = vec![0u8; bucket];

    // Write 4-byte little-endian length prefix
    let len_bytes = (plaintext.len() as u32).to_le_bytes();
    out[..4].copy_from_slice(&len_bytes);

    // Write plaintext
    out[4..4 + plaintext.len()].copy_from_slice(plaintext);

    // Fill padding region with random bytes
    let padding_start = 4 + plaintext.len();
    if padding_start < bucket {
        fill(&mut out[padding_start..]);
    }

    out
}

/// Strip padding added by [`pad_to_bucket`].
///
/// Reads the 4-byte LE length prefix and returns a copy of the plaintext
/// bytes, ignoring trailing padding.
///
/// # Errors
/// Returns [`CryptoError::InvalidCiphertext`] if the buffer is too short or
/// the embedded length exceeds the buffer.
pub fn unpad(padded: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if padded.len() < 4 {
        return Err(CryptoError::InvalidCiphertext);
    }

    let actual_len = u32::from_le_bytes(padded[..4].try_into().unwrap()) as usize;

    if actual_len + 4 > padded.len() {
        return Err(CryptoError::InvalidCiphertext);
    }

    Ok(padded[4..4 + actual_len].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- pad_to_bucket: bucket selection ---

    #[test]
    fn empty_input_pads_to_512() {
        let out = pad_to_bucket(&[]);
        assert_eq!(out.len(), 512);
    }

    #[test]
    fn one_byte_pads_to_512() {
        let out = pad_to_bucket(&[0x42]);
        assert_eq!(out.len(), 512);
    }

    #[test]
    fn exactly_fits_512_bucket() {
        // 4 + 508 = 512 — fits exactly, no promotion needed
        let plaintext = vec![0u8; 508];
        let out = pad_to_bucket(&plaintext);
        assert_eq!(out.len(), 512);
    }

    #[test]
    fn one_byte_over_512_bucket_promotes_to_1024() {
        // 4 + 509 = 513 > 512
        let plaintext = vec![0u8; 509];
        let out = pad_to_bucket(&plaintext);
        assert_eq!(out.len(), 1024);
    }

    #[test]
    fn exactly_fits_1024_bucket() {
        // 4 + 1020 = 1024
        let plaintext = vec![0u8; 1020];
        let out = pad_to_bucket(&plaintext);
        assert_eq!(out.len(), 1024);
    }

    #[test]
    fn promotes_to_2048_bucket() {
        // 4 + 1021 = 1025
        let plaintext = vec![0u8; 1021];
        let out = pad_to_bucket(&plaintext);
        assert_eq!(out.len(), 2048);
    }

    #[test]
    fn exactly_fits_4096_bucket() {
        // 4 + 4092 = 4096
        let plaintext = vec![0u8; 4092];
        let out = pad_to_bucket(&plaintext);
        assert_eq!(out.len(), 4096);
    }

    #[test]
    fn promotes_to_8192_bucket() {
        // 4 + 4093 = 4097
        let plaintext = vec![0u8; 4093];
        let out = pad_to_bucket(&plaintext);
        assert_eq!(out.len(), 8192);
    }

    // --- pad_to_bucket: format ---

    #[test]
    fn length_prefix_is_4_byte_le() {
        let plaintext = b"hello";
        let out = pad_to_bucket(plaintext);
        let actual_len = u32::from_le_bytes(out[..4].try_into().unwrap()) as usize;
        assert_eq!(actual_len, plaintext.len());
    }

    #[test]
    fn plaintext_bytes_at_offset_4() {
        let plaintext = b"abc";
        let out = pad_to_bucket(plaintext);
        assert_eq!(&out[4..7], plaintext);
    }

    #[test]
    fn padding_bytes_are_not_all_zero() {
        // 4 + 1 = 5 bytes used, 507 bytes of padding — statistically impossible for all to be zero
        let plaintext = b"x";
        let out = pad_to_bucket(plaintext);
        let padding = &out[5..];
        assert!(!padding.iter().all(|&b| b == 0));
    }

    #[test]
    fn two_calls_produce_different_padding() {
        let plaintext = b"same input";
        let out1 = pad_to_bucket(plaintext);
        let out2 = pad_to_bucket(plaintext);
        // Length prefix and plaintext bytes are identical; the padding region differs
        assert_ne!(out1[4 + plaintext.len()..], out2[4 + plaintext.len()..]);
    }

    // --- unpad ---

    #[test]
    fn roundtrip_empty() {
        let original: &[u8] = &[];
        let padded = pad_to_bucket(original);
        let recovered = unpad(&padded).unwrap();
        assert_eq!(recovered, original);
    }

    #[test]
    fn roundtrip_small() {
        let original = b"hello, world";
        let padded = pad_to_bucket(original);
        let recovered = unpad(&padded).unwrap();
        assert_eq!(recovered, original);
    }

    #[test]
    fn roundtrip_exact_bucket_boundary() {
        // 4 + 508 = 512
        let original = vec![0xABu8; 508];
        let padded = pad_to_bucket(&original);
        assert_eq!(padded.len(), 512);
        let recovered = unpad(&padded).unwrap();
        assert_eq!(recovered, original);
    }

    #[test]
    fn roundtrip_large_payload() {
        let original = vec![0x7Fu8; 5000];
        let padded = pad_to_bucket(&original);
        assert_eq!(padded.len(), 8192);
        let recovered = unpad(&padded).unwrap();
        assert_eq!(recovered, original);
    }

    #[test]
    fn unpad_too_short_errors() {
        let result = unpad(&[0x01, 0x02, 0x03]); // < 4 bytes
        assert!(matches!(result, Err(CryptoError::InvalidCiphertext)));
    }

    #[test]
    fn unpad_length_exceeds_buffer_errors() {
        let mut bad = vec![0u8; 8];
        // Claim 9999 bytes of plaintext but buffer is only 8 bytes
        let len_bytes = 9999u32.to_le_bytes();
        bad[..4].copy_from_slice(&len_bytes);
        let result = unpad(&bad);
        assert!(matches!(result, Err(CryptoError::InvalidCiphertext)));
    }
}
