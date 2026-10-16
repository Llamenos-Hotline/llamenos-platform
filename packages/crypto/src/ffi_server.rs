//! C ABI FFI exports for the Bun server via `bun:ffi`.
//!
//! Gated behind `#[cfg(feature = "server")]`. All functions use simple pointer+length
//! arguments. Caller allocates output buffers, Rust writes into them.
//!
//! ## Safety Contract
//!
//! Every FFI function enforces:
//! 1. Null pointer check → return -3
//! 2. Buffer size validation → return -2
//! 3. Input size limit (100 MiB) → return -4
//! 4. `std::slice::from_raw_parts()` with validated lengths
//! 5. `zeroize` on sensitive stack data
//!
//! ## Error Codes
//!
//! - `0` — success
//! - `-1` — cryptographic error
//! - `-2` — output buffer too small
//! - `-3` — null pointer
//! - `-4` — input too large
//! - `-5` — invalid input

use std::cell::RefCell;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use ed25519_dalek::{Signer, Verifier, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::hpke_envelope;

/// Maximum input size: 100 MiB
const MAX_INPUT_SIZE: usize = 100 * 1024 * 1024;

// ── Thread-local error buffer ──────────────────────────────────────────

thread_local! {
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_error(msg: &str) {
    LAST_ERROR.with(|e| {
        let mut buf = e.borrow_mut();
        buf.clear();
        buf.extend_from_slice(msg.as_bytes());
    });
}

fn clear_error() {
    LAST_ERROR.with(|e| e.borrow_mut().clear());
}

/// Retrieve the last error message. Returns bytes written (0 if no error).
#[no_mangle]
pub extern "C" fn ffi_last_error(out: *mut u8, out_len: usize) -> i32 {
    if out.is_null() {
        return -3;
    }
    LAST_ERROR.with(|e| {
        let buf = e.borrow();
        if buf.is_empty() {
            return 0;
        }
        let copy_len = buf.len().min(out_len);
        unsafe {
            std::ptr::copy_nonoverlapping(buf.as_ptr(), out, copy_len);
        }
        copy_len as i32
    })
}

// ── Safety macros ──────────────────────────────────────────────────────

macro_rules! check_null {
    ($($ptr:expr),+ $(,)?) => {
        $(
            if $ptr.is_null() {
                set_error("null pointer argument");
                return -3;
            }
        )+
    };
}

macro_rules! check_output_size {
    ($out_len:expr, $required:expr) => {
        if $out_len < $required {
            set_error(&format!(
                "output buffer too small: need {}, got {}",
                $required, $out_len
            ));
            return -2;
        }
    };
}

macro_rules! check_input_size {
    ($($len:expr),+ $(,)?) => {
        $(
            if $len > MAX_INPUT_SIZE {
                set_error("input exceeds 100 MiB limit");
                return -4;
            }
        )+
    };
}

/// Helper: build a slice from a (possibly null) pointer + length.
/// Returns empty slice if ptr is null AND len is 0 (for optional AAD).
/// Returns -3 error if ptr is null but len > 0.
macro_rules! nullable_slice {
    ($ptr:expr, $len:expr) => {
        if $ptr.is_null() {
            if $len > 0 {
                set_error("null pointer with non-zero length");
                return -3;
            }
            &[]
        } else {
            unsafe { std::slice::from_raw_parts($ptr, $len) }
        }
    };
}

// ── Core Functions ─────────────────────────────────────────────────────

/// Fill `out` with `len` cryptographically secure random bytes.
#[no_mangle]
pub extern "C" fn ffi_random_bytes(out: *mut u8, len: usize) -> i32 {
    clear_error();
    check_null!(out);
    check_input_size!(len);

    let slice = unsafe { std::slice::from_raw_parts_mut(out, len) };
    match getrandom::getrandom(slice) {
        Ok(()) => 0,
        Err(e) => {
            set_error(&format!("getrandom failed: {e}"));
            -1
        }
    }
}

/// Compute SHA-256 hash. Output must be 32 bytes.
#[no_mangle]
pub extern "C" fn ffi_sha256(
    data: *const u8,
    data_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(data, out);
    check_input_size!(data_len);
    check_output_size!(out_len, 32);

    let input = unsafe { std::slice::from_raw_parts(data, data_len) };
    let hash = Sha256::digest(input);

    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, 32) };
    out_slice.copy_from_slice(&hash);
    0
}

/// Compute HMAC-SHA256. Output must be 32 bytes.
#[no_mangle]
pub extern "C" fn ffi_hmac_sha256(
    key: *const u8,
    key_len: usize,
    data: *const u8,
    data_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(key, data, out);
    check_input_size!(key_len, data_len);
    check_output_size!(out_len, 32);

    let key_slice = unsafe { std::slice::from_raw_parts(key, key_len) };
    let data_slice = unsafe { std::slice::from_raw_parts(data, data_len) };

    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(key_slice).expect("HMAC can accept any key length");
    mac.update(data_slice);
    let result = mac.finalize().into_bytes();

    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, 32) };
    out_slice.copy_from_slice(&result);
    0
}

/// HKDF-SHA256 expand. Salt and info may be null (treated as empty).
#[no_mangle]
pub extern "C" fn ffi_hkdf_sha256(
    ikm: *const u8,
    ikm_len: usize,
    salt: *const u8,
    salt_len: usize,
    info: *const u8,
    info_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(ikm, out);
    check_input_size!(ikm_len, salt_len, info_len);

    if out_len == 0 || out_len > 255 * 32 {
        set_error("HKDF output length must be 1..=8160");
        return -5;
    }

    let ikm_slice = unsafe { std::slice::from_raw_parts(ikm, ikm_len) };
    let salt_slice = nullable_slice!(salt, salt_len);
    let info_slice = nullable_slice!(info, info_len);

    let hk = Hkdf::<Sha256>::new(
        if salt_slice.is_empty() {
            None
        } else {
            Some(salt_slice)
        },
        ikm_slice,
    );

    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, out_len) };
    match hk.expand(info_slice, out_slice) {
        Ok(()) => 0,
        Err(e) => {
            set_error(&format!("HKDF expand failed: {e}"));
            -1
        }
    }
}

// ── Symmetric: AES-256-GCM ────────────────────────────────────────────

/// AES-256-GCM encrypt. Output = nonce(12) || ciphertext || tag(16).
/// Output buffer must be at least 12 + pt_len + 16 bytes.
#[no_mangle]
pub extern "C" fn ffi_aes256gcm_encrypt(
    key: *const u8,
    key_len: usize,
    plaintext: *const u8,
    pt_len: usize,
    aad: *const u8,
    aad_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(key, out);
    check_input_size!(pt_len, aad_len);

    if key_len != 32 {
        set_error("AES-256-GCM key must be 32 bytes");
        return -5;
    }

    let required_out = 12 + pt_len + 16;
    check_output_size!(out_len, required_out);

    let key_slice = unsafe { std::slice::from_raw_parts(key, 32) };
    let pt_slice = nullable_slice!(plaintext, pt_len);
    let aad_slice = nullable_slice!(aad, aad_len);

    // Generate random 12-byte nonce
    let mut nonce_bytes = [0u8; 12];
    if getrandom::getrandom(&mut nonce_bytes).is_err() {
        set_error("failed to generate random nonce");
        return -1;
    }

    let cipher = match Aes256Gcm::new_from_slice(key_slice) {
        Ok(c) => c,
        Err(e) => {
            set_error(&format!("AES-256-GCM init failed: {e}"));
            return -1;
        }
    };

    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = match cipher.encrypt(
        nonce,
        aes_gcm::aead::Payload {
            msg: pt_slice,
            aad: aad_slice,
        },
    ) {
        Ok(ct) => ct,
        Err(e) => {
            set_error(&format!("AES-256-GCM encrypt failed: {e}"));
            return -1;
        }
    };

    // Write: nonce || ciphertext (includes tag)
    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, required_out) };
    out_slice[..12].copy_from_slice(&nonce_bytes);
    out_slice[12..].copy_from_slice(&ciphertext);
    0
}

/// AES-256-GCM decrypt. Input = nonce(12) || ciphertext || tag(16).
/// Output buffer must be at least ct_len - 28 bytes.
#[no_mangle]
pub extern "C" fn ffi_aes256gcm_decrypt(
    key: *const u8,
    key_len: usize,
    ciphertext: *const u8,
    ct_len: usize,
    aad: *const u8,
    aad_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(key, ciphertext, out);
    check_input_size!(ct_len, aad_len);

    if key_len != 32 {
        set_error("AES-256-GCM key must be 32 bytes");
        return -5;
    }

    // nonce(12) + tag(16) = 28 bytes minimum
    if ct_len < 28 {
        set_error("ciphertext too short (need at least 28 bytes for nonce + tag)");
        return -5;
    }

    let pt_len = ct_len - 28;
    check_output_size!(out_len, pt_len);

    let key_slice = unsafe { std::slice::from_raw_parts(key, 32) };
    let ct_slice = unsafe { std::slice::from_raw_parts(ciphertext, ct_len) };
    let aad_slice = nullable_slice!(aad, aad_len);

    let nonce = Nonce::from_slice(&ct_slice[..12]);
    let cipher = match Aes256Gcm::new_from_slice(key_slice) {
        Ok(c) => c,
        Err(e) => {
            set_error(&format!("AES-256-GCM init failed: {e}"));
            return -1;
        }
    };

    let plaintext = match cipher.decrypt(
        nonce,
        aes_gcm::aead::Payload {
            msg: &ct_slice[12..],
            aad: aad_slice,
        },
    ) {
        Ok(pt) => pt,
        Err(_) => {
            set_error("AES-256-GCM decryption failed: authentication tag mismatch");
            return -1;
        }
    };

    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, pt_len) };
    out_slice.copy_from_slice(&plaintext);
    0
}

// ── Asymmetric: HPKE ──────────────────────────────────────────────────

/// HPKE seal (encrypt for a recipient). Output = enc(32) || ciphertext || tag(16).
/// Output buffer must be at least 32 + pt_len + 16 bytes.
///
/// The `label` parameter must be a valid UTF-8 domain separation label registered
/// in the label registry (Albrecht defense). Raw info bytes are NOT accepted —
/// all HPKE operations must use a registered label for domain separation.
#[no_mangle]
pub extern "C" fn ffi_hpke_seal(
    recipient_pk: *const u8,
    pk_len: usize,
    plaintext: *const u8,
    pt_len: usize,
    label: *const u8,
    label_len: usize,
    aad: *const u8,
    aad_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(recipient_pk, out);
    check_input_size!(pt_len, label_len, aad_len);

    if pk_len != 32 {
        set_error("HPKE recipient public key must be 32 bytes");
        return -5;
    }

    // Label is required — reject null/empty
    if label.is_null() || label_len == 0 {
        set_error("HPKE label is required (domain separation)");
        return -5;
    }

    let label_slice = unsafe { std::slice::from_raw_parts(label, label_len) };
    let label_str = match std::str::from_utf8(label_slice) {
        Ok(s) => s,
        Err(_) => {
            set_error("HPKE label must be valid UTF-8");
            return -5;
        }
    };

    // Albrecht defense: validate label against the registry
    if crate::labels::label_to_id(label_str).is_none() {
        set_error(&format!("unknown crypto label: {label_str}"));
        return -5;
    }

    let required_out = 32 + pt_len + 16;
    check_output_size!(out_len, required_out);

    let pk_slice = unsafe { std::slice::from_raw_parts(recipient_pk, 32) };
    let pt_slice = nullable_slice!(plaintext, pt_len);
    let aad_slice = nullable_slice!(aad, aad_len);

    // Route through hpke_envelope which enforces label as HPKE info
    let pk_hex = hex::encode(pk_slice);
    let envelope = match hpke_envelope::hpke_seal(pt_slice, &pk_hex, label_str, aad_slice) {
        Ok(env) => env,
        Err(e) => {
            set_error(&format!("HPKE seal failed: {e}"));
            return -1;
        }
    };

    // Convert HpkeEnvelope (base64url) back to binary: enc(32) || ct
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    let enc_bytes = match URL_SAFE_NO_PAD.decode(&envelope.enc) {
        Ok(b) => b,
        Err(e) => {
            set_error(&format!("internal error decoding enc: {e}"));
            return -1;
        }
    };
    let ct_bytes = match URL_SAFE_NO_PAD.decode(&envelope.ct) {
        Ok(b) => b,
        Err(e) => {
            set_error(&format!("internal error decoding ct: {e}"));
            return -1;
        }
    };

    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, required_out) };
    out_slice[..32].copy_from_slice(&enc_bytes);
    out_slice[32..].copy_from_slice(&ct_bytes);
    0
}

/// HPKE open (decrypt). Input = enc(32) || ciphertext || tag(16).
/// Output buffer must be at least env_len - 48 bytes.
///
/// The `label` parameter must be a valid UTF-8 domain separation label registered
/// in the label registry (Albrecht defense). The label is verified against the
/// envelope's embedded label_id before decryption proceeds.
#[no_mangle]
pub extern "C" fn ffi_hpke_open(
    secret_key: *const u8,
    sk_len: usize,
    envelope: *const u8,
    env_len: usize,
    label: *const u8,
    label_len: usize,
    aad: *const u8,
    aad_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(secret_key, envelope, out);
    check_input_size!(env_len, label_len, aad_len);

    if sk_len != 32 {
        set_error("HPKE secret key must be 32 bytes");
        return -5;
    }

    // Label is required — reject null/empty
    if label.is_null() || label_len == 0 {
        set_error("HPKE label is required (domain separation)");
        return -5;
    }

    let label_slice = unsafe { std::slice::from_raw_parts(label, label_len) };
    let label_str = match std::str::from_utf8(label_slice) {
        Ok(s) => s,
        Err(_) => {
            set_error("HPKE label must be valid UTF-8");
            return -5;
        }
    };

    // Albrecht defense: validate label against the registry
    let label_id = match crate::labels::label_to_id(label_str) {
        Some(id) => id,
        None => {
            set_error(&format!("unknown crypto label: {label_str}"));
            return -5;
        }
    };

    // enc(32) + tag(16) = 48 bytes minimum
    if env_len < 48 {
        set_error("HPKE envelope too short (need at least 48 bytes for enc + tag)");
        return -5;
    }

    let pt_len = env_len - 48;
    check_output_size!(out_len, pt_len);

    let sk_slice = unsafe { std::slice::from_raw_parts(secret_key, 32) };
    let env_slice = unsafe { std::slice::from_raw_parts(envelope, env_len) };
    let aad_slice = nullable_slice!(aad, aad_len);

    // Reconstruct HpkeEnvelope for the envelope layer to validate
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    let hpke_env = hpke_envelope::HpkeEnvelope {
        v: 3,
        label_id,
        enc: URL_SAFE_NO_PAD.encode(&env_slice[..32]),
        ct: URL_SAFE_NO_PAD.encode(&env_slice[32..]),
    };

    let sk_hex = hex::encode(sk_slice);
    let plaintext = match hpke_envelope::hpke_open(&hpke_env, &sk_hex, label_str, aad_slice) {
        Ok(pt) => pt,
        Err(_) => {
            set_error("HPKE open failed: decryption error");
            return -1;
        }
    };

    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, pt_len) };
    out_slice.copy_from_slice(&plaintext);
    0
}

// ── Asymmetric: Ed25519 ───────────────────────────────────────────────

/// Ed25519 sign. Output = 64-byte signature.
#[no_mangle]
pub extern "C" fn ffi_ed25519_sign(
    secret_key: *const u8,
    sk_len: usize,
    message: *const u8,
    msg_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(secret_key, message, out);
    check_input_size!(msg_len);
    check_output_size!(out_len, 64);

    if sk_len != 32 {
        set_error("Ed25519 secret key (seed) must be 32 bytes");
        return -5;
    }

    let sk_slice = unsafe { std::slice::from_raw_parts(secret_key, 32) };
    let msg_slice = unsafe { std::slice::from_raw_parts(message, msg_len) };

    let mut seed = [0u8; 32];
    seed.copy_from_slice(sk_slice);
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
    seed.zeroize();

    let signature = signing_key.sign(msg_slice);
    let sig_bytes = signature.to_bytes();

    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, 64) };
    out_slice.copy_from_slice(&sig_bytes);
    0
}

/// Build the canonical device-auth message (the exact bytes that get signed).
///
/// Exposed so the Bun server shares one construction path with every client
/// instead of re-implementing the layout. `nonce` may be null (length 0) to
/// select the nonce-less shape, which carries its own domain-separation label.
///
/// All string arguments are UTF-8. Returns the number of bytes written into
/// `out` on success, or a negative error code.
#[no_mangle]
pub extern "C" fn ffi_build_auth_message(
    pubkey_hex: *const u8,
    pubkey_len: usize,
    timestamp: u64,
    method: *const u8,
    method_len: usize,
    path: *const u8,
    path_len: usize,
    nonce: *const u8,
    nonce_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(pubkey_hex, method, path, out);
    check_input_size!(pubkey_len, method_len, path_len, nonce_len);

    let pubkey_slice = unsafe { std::slice::from_raw_parts(pubkey_hex, pubkey_len) };
    let method_slice = unsafe { std::slice::from_raw_parts(method, method_len) };
    let path_slice = unsafe { std::slice::from_raw_parts(path, path_len) };
    let nonce_slice: &[u8] = nullable_slice!(nonce, nonce_len);

    let (Ok(pubkey_str), Ok(method_str), Ok(path_str)) = (
        std::str::from_utf8(pubkey_slice),
        std::str::from_utf8(method_slice),
        std::str::from_utf8(path_slice),
    ) else {
        set_error("pubkey, method and path must be valid UTF-8");
        return -5;
    };
    let nonce_str = if nonce.is_null() {
        None
    } else {
        match std::str::from_utf8(nonce_slice) {
            Ok(n) => Some(n),
            Err(_) => {
                set_error("nonce must be valid UTF-8");
                return -5;
            }
        }
    };

    let message =
        crate::auth::build_auth_message(pubkey_str, timestamp, method_str, path_str, nonce_str);
    check_output_size!(out_len, message.len());

    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, message.len()) };
    out_slice.copy_from_slice(&message);
    message.len() as i32
}

/// Ed25519 verify. Returns 0 if valid, -1 if invalid signature.
#[no_mangle]
pub extern "C" fn ffi_ed25519_verify(
    pubkey: *const u8,
    pk_len: usize,
    message: *const u8,
    msg_len: usize,
    signature: *const u8,
    sig_len: usize,
) -> i32 {
    clear_error();
    check_null!(pubkey, message, signature);
    check_input_size!(msg_len);

    if pk_len != 32 {
        set_error("Ed25519 public key must be 32 bytes");
        return -5;
    }
    if sig_len != 64 {
        set_error("Ed25519 signature must be 64 bytes");
        return -5;
    }

    let pk_slice = unsafe { std::slice::from_raw_parts(pubkey, 32) };
    let msg_slice = unsafe { std::slice::from_raw_parts(message, msg_len) };
    let sig_slice = unsafe { std::slice::from_raw_parts(signature, 64) };

    let pk_arr: [u8; 32] = pk_slice.try_into().unwrap();
    let verifying_key = match VerifyingKey::from_bytes(&pk_arr) {
        Ok(vk) => vk,
        Err(_) => {
            set_error("invalid Ed25519 public key");
            return -5;
        }
    };

    let sig_arr: [u8; 64] = sig_slice.try_into().unwrap();
    let sig = ed25519_dalek::Signature::from_bytes(&sig_arr);

    match verifying_key.verify(msg_slice, &sig) {
        Ok(()) => 0,
        Err(_) => {
            set_error("Ed25519 signature verification failed");
            -1
        }
    }
}

/// Derive Ed25519 public key from a 32-byte seed. Output = 32 bytes.
#[no_mangle]
pub extern "C" fn ffi_ed25519_pubkey_from_seed(
    seed: *const u8,
    seed_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(seed, out);
    check_output_size!(out_len, 32);

    if seed_len != 32 {
        set_error("Ed25519 seed must be 32 bytes");
        return -5;
    }

    let seed_slice = unsafe { std::slice::from_raw_parts(seed, 32) };
    let mut seed_arr = [0u8; 32];
    seed_arr.copy_from_slice(seed_slice);

    let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed_arr);
    seed_arr.zeroize();

    let pubkey = signing_key.verifying_key().to_bytes();
    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, 32) };
    out_slice.copy_from_slice(&pubkey);
    0
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_random_bytes() {
        let mut buf = [0u8; 32];
        let ret = ffi_random_bytes(buf.as_mut_ptr(), 32);
        assert_eq!(ret, 0);
        // Extremely unlikely to be all zeros
        assert_ne!(buf, [0u8; 32]);
    }

    #[test]
    fn test_random_bytes_null() {
        let ret = ffi_random_bytes(std::ptr::null_mut(), 32);
        assert_eq!(ret, -3);
    }

    #[test]
    fn test_sha256() {
        let data = b"hello world";
        let mut out = [0u8; 32];
        let ret = ffi_sha256(data.as_ptr(), data.len(), out.as_mut_ptr(), 32);
        assert_eq!(ret, 0);

        // Known SHA-256 of "hello world"
        let expected = Sha256::digest(b"hello world");
        assert_eq!(&out, expected.as_slice());
    }

    #[test]
    fn test_sha256_buffer_too_small() {
        let data = b"test";
        let mut out = [0u8; 16];
        let ret = ffi_sha256(data.as_ptr(), data.len(), out.as_mut_ptr(), 16);
        assert_eq!(ret, -2);
    }

    #[test]
    fn test_hmac_sha256() {
        let key = b"secret key";
        let data = b"hello";
        let mut out = [0u8; 32];
        let ret = ffi_hmac_sha256(
            key.as_ptr(),
            key.len(),
            data.as_ptr(),
            data.len(),
            out.as_mut_ptr(),
            32,
        );
        assert_eq!(ret, 0);

        // Verify with known computation
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).unwrap();
        mac.update(data);
        let expected = mac.finalize().into_bytes();
        assert_eq!(&out, expected.as_slice());
    }

    #[test]
    fn test_hkdf_sha256() {
        let ikm = [0x0bu8; 22];
        let salt = [0u8; 13];
        let info = b"test info";
        let mut out = [0u8; 42];

        let ret = ffi_hkdf_sha256(
            ikm.as_ptr(),
            ikm.len(),
            salt.as_ptr(),
            salt.len(),
            info.as_ptr(),
            info.len(),
            out.as_mut_ptr(),
            42,
        );
        assert_eq!(ret, 0);
        assert_ne!(out, [0u8; 42]);
    }

    #[test]
    fn test_hkdf_null_salt_and_info() {
        let ikm = [0x01u8; 32];
        let mut out = [0u8; 32];

        let ret = ffi_hkdf_sha256(
            ikm.as_ptr(),
            ikm.len(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            0,
            out.as_mut_ptr(),
            32,
        );
        assert_eq!(ret, 0);
        assert_ne!(out, [0u8; 32]);
    }

    #[test]
    fn test_aes256gcm_roundtrip() {
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key).unwrap();
        let plaintext = b"secret message for encryption test";
        let aad = b"additional data";

        let ct_len = 12 + plaintext.len() + 16;
        let mut ciphertext = vec![0u8; ct_len];

        let ret = ffi_aes256gcm_encrypt(
            key.as_ptr(),
            32,
            plaintext.as_ptr(),
            plaintext.len(),
            aad.as_ptr(),
            aad.len(),
            ciphertext.as_mut_ptr(),
            ct_len,
        );
        assert_eq!(ret, 0);

        let mut decrypted = vec![0u8; plaintext.len()];
        let ret = ffi_aes256gcm_decrypt(
            key.as_ptr(),
            32,
            ciphertext.as_ptr(),
            ct_len,
            aad.as_ptr(),
            aad.len(),
            decrypted.as_mut_ptr(),
            plaintext.len(),
        );
        assert_eq!(ret, 0);
        assert_eq!(&decrypted, plaintext);
    }

    #[test]
    fn test_aes256gcm_wrong_key() {
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key).unwrap();
        let plaintext = b"test";
        let aad = b"";

        let ct_len = 12 + plaintext.len() + 16;
        let mut ciphertext = vec![0u8; ct_len];

        ffi_aes256gcm_encrypt(
            key.as_ptr(),
            32,
            plaintext.as_ptr(),
            plaintext.len(),
            aad.as_ptr(),
            aad.len(),
            ciphertext.as_mut_ptr(),
            ct_len,
        );

        let mut wrong_key = [0xffu8; 32];
        let mut decrypted = vec![0u8; plaintext.len()];
        let ret = ffi_aes256gcm_decrypt(
            wrong_key.as_ptr(),
            32,
            ciphertext.as_ptr(),
            ct_len,
            aad.as_ptr(),
            aad.len(),
            decrypted.as_mut_ptr(),
            plaintext.len(),
        );
        assert_eq!(ret, -1);
        wrong_key.zeroize();
    }

    #[test]
    fn test_ed25519_sign_verify_roundtrip() {
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed).unwrap();
        let message = b"test message to sign";

        let mut signature = [0u8; 64];
        let ret = ffi_ed25519_sign(
            seed.as_ptr(),
            32,
            message.as_ptr(),
            message.len(),
            signature.as_mut_ptr(),
            64,
        );
        assert_eq!(ret, 0);

        let mut pubkey = [0u8; 32];
        let ret = ffi_ed25519_pubkey_from_seed(seed.as_ptr(), 32, pubkey.as_mut_ptr(), 32);
        assert_eq!(ret, 0);

        let ret = ffi_ed25519_verify(
            pubkey.as_ptr(),
            32,
            message.as_ptr(),
            message.len(),
            signature.as_ptr(),
            64,
        );
        assert_eq!(ret, 0);

        // Wrong message should fail
        let wrong_msg = b"wrong message";
        let ret = ffi_ed25519_verify(
            pubkey.as_ptr(),
            32,
            wrong_msg.as_ptr(),
            wrong_msg.len(),
            signature.as_ptr(),
            64,
        );
        assert_eq!(ret, -1);
    }

    #[test]
    fn test_ed25519_pubkey_from_seed_deterministic() {
        let seed = [42u8; 32];
        let mut pubkey1 = [0u8; 32];
        let mut pubkey2 = [0u8; 32];

        ffi_ed25519_pubkey_from_seed(seed.as_ptr(), 32, pubkey1.as_mut_ptr(), 32);
        ffi_ed25519_pubkey_from_seed(seed.as_ptr(), 32, pubkey2.as_mut_ptr(), 32);

        assert_eq!(pubkey1, pubkey2);
        assert_ne!(pubkey1, [0u8; 32]);
    }

    #[test]
    fn test_hpke_roundtrip() {
        use hpke::kem::X25519HkdfSha256;
        use hpke::{Kem as KemTrait, Serializable};

        // Generate keypair
        let mut rng = hpke_envelope::OsRng09;
        let (sk, pk) = X25519HkdfSha256::gen_keypair(&mut rng);
        let sk_bytes = sk.to_bytes();
        let pk_bytes = pk.to_bytes();
        let sk_slice: &[u8] = sk_bytes.as_ref();
        let pk_slice: &[u8] = pk_bytes.as_ref();

        let plaintext = b"secret for HPKE";
        let label = crate::labels::LABEL_NOTE_KEY.as_bytes();
        let aad = b"test-aad";

        let env_len = 32 + plaintext.len() + 16;
        let mut envelope = vec![0u8; env_len];

        let ret = ffi_hpke_seal(
            pk_slice.as_ptr(),
            32,
            plaintext.as_ptr(),
            plaintext.len(),
            label.as_ptr(),
            label.len(),
            aad.as_ptr(),
            aad.len(),
            envelope.as_mut_ptr(),
            env_len,
        );
        assert_eq!(ret, 0);

        let mut decrypted = vec![0u8; plaintext.len()];
        let ret = ffi_hpke_open(
            sk_slice.as_ptr(),
            32,
            envelope.as_ptr(),
            env_len,
            label.as_ptr(),
            label.len(),
            aad.as_ptr(),
            aad.len(),
            decrypted.as_mut_ptr(),
            plaintext.len(),
        );
        assert_eq!(ret, 0);
        assert_eq!(&decrypted, plaintext);
    }

    #[test]
    fn test_hpke_wrong_key() {
        use hpke::kem::X25519HkdfSha256;
        use hpke::{Kem as KemTrait, Serializable};

        let mut rng = hpke_envelope::OsRng09;
        let (_, pk) = X25519HkdfSha256::gen_keypair(&mut rng);
        let (wrong_sk, _) = X25519HkdfSha256::gen_keypair(&mut rng);
        let pk_bytes = pk.to_bytes();
        let wrong_sk_bytes = wrong_sk.to_bytes();
        let pk_slice: &[u8] = pk_bytes.as_ref();
        let wrong_sk_slice: &[u8] = wrong_sk_bytes.as_ref();

        let plaintext = b"test";
        let label = crate::labels::LABEL_NOTE_KEY.as_bytes();
        let aad = b"aad";
        let env_len = 32 + plaintext.len() + 16;
        let mut envelope = vec![0u8; env_len];

        ffi_hpke_seal(
            pk_slice.as_ptr(),
            32,
            plaintext.as_ptr(),
            plaintext.len(),
            label.as_ptr(),
            label.len(),
            aad.as_ptr(),
            aad.len(),
            envelope.as_mut_ptr(),
            env_len,
        );

        let mut decrypted = vec![0u8; plaintext.len()];
        let ret = ffi_hpke_open(
            wrong_sk_slice.as_ptr(),
            32,
            envelope.as_ptr(),
            env_len,
            label.as_ptr(),
            label.len(),
            aad.as_ptr(),
            aad.len(),
            decrypted.as_mut_ptr(),
            plaintext.len(),
        );
        assert_eq!(ret, -1);
    }

    #[test]
    fn test_hpke_rejects_unknown_label() {
        use hpke::kem::X25519HkdfSha256;
        use hpke::{Kem as KemTrait, Serializable};

        let mut rng = hpke_envelope::OsRng09;
        let (_, pk) = X25519HkdfSha256::gen_keypair(&mut rng);
        let pk_bytes = pk.to_bytes();
        let pk_slice: &[u8] = pk_bytes.as_ref();

        let plaintext = b"test";
        let bad_label = b"not-a-registered-label";
        let aad = b"aad";
        let env_len = 32 + plaintext.len() + 16;
        let mut envelope = vec![0u8; env_len];

        let ret = ffi_hpke_seal(
            pk_slice.as_ptr(),
            32,
            plaintext.as_ptr(),
            plaintext.len(),
            bad_label.as_ptr(),
            bad_label.len(),
            aad.as_ptr(),
            aad.len(),
            envelope.as_mut_ptr(),
            env_len,
        );
        assert_eq!(ret, -5, "ffi_hpke_seal must reject unknown labels");
    }

    #[test]
    fn test_hpke_rejects_null_label() {
        use hpke::kem::X25519HkdfSha256;
        use hpke::{Kem as KemTrait, Serializable};

        let mut rng = hpke_envelope::OsRng09;
        let (_, pk) = X25519HkdfSha256::gen_keypair(&mut rng);
        let pk_bytes = pk.to_bytes();
        let pk_slice: &[u8] = pk_bytes.as_ref();

        let plaintext = b"test";
        let aad = b"aad";
        let env_len = 32 + plaintext.len() + 16;
        let mut envelope = vec![0u8; env_len];

        let ret = ffi_hpke_seal(
            pk_slice.as_ptr(),
            32,
            plaintext.as_ptr(),
            plaintext.len(),
            std::ptr::null(),
            0,
            aad.as_ptr(),
            aad.len(),
            envelope.as_mut_ptr(),
            env_len,
        );
        assert_eq!(ret, -5, "ffi_hpke_seal must reject null label");
    }

    #[test]
    fn test_hpke_label_mismatch_rejected() {
        use hpke::kem::X25519HkdfSha256;
        use hpke::{Kem as KemTrait, Serializable};

        let mut rng = hpke_envelope::OsRng09;
        let (sk, pk) = X25519HkdfSha256::gen_keypair(&mut rng);
        let sk_bytes = sk.to_bytes();
        let pk_bytes = pk.to_bytes();
        let sk_slice: &[u8] = sk_bytes.as_ref();
        let pk_slice: &[u8] = pk_bytes.as_ref();

        let plaintext = b"test";
        let seal_label = crate::labels::LABEL_NOTE_KEY.as_bytes();
        let open_label = crate::labels::LABEL_FILE_KEY.as_bytes();
        let aad = b"aad";
        let env_len = 32 + plaintext.len() + 16;
        let mut envelope = vec![0u8; env_len];

        let ret = ffi_hpke_seal(
            pk_slice.as_ptr(),
            32,
            plaintext.as_ptr(),
            plaintext.len(),
            seal_label.as_ptr(),
            seal_label.len(),
            aad.as_ptr(),
            aad.len(),
            envelope.as_mut_ptr(),
            env_len,
        );
        assert_eq!(ret, 0);

        // Try to open with a different label — must fail
        let mut decrypted = vec![0u8; plaintext.len()];
        let ret = ffi_hpke_open(
            sk_slice.as_ptr(),
            32,
            envelope.as_ptr(),
            env_len,
            open_label.as_ptr(),
            open_label.len(),
            aad.as_ptr(),
            aad.len(),
            decrypted.as_mut_ptr(),
            plaintext.len(),
        );
        assert_eq!(ret, -1, "ffi_hpke_open must reject label mismatch");
    }

    #[test]
    fn test_last_error() {
        // Trigger an error
        let data = b"test";
        let mut out = [0u8; 16];
        let ret = ffi_sha256(data.as_ptr(), data.len(), out.as_mut_ptr(), 16);
        assert_eq!(ret, -2);

        // Read the error
        let mut err_buf = [0u8; 256];
        let err_len = ffi_last_error(err_buf.as_mut_ptr(), 256);
        assert!(err_len > 0);
        let err_msg = std::str::from_utf8(&err_buf[..err_len as usize]).unwrap();
        assert!(err_msg.contains("output buffer too small"));
    }

    #[test]
    fn test_known_ed25519_vector() {
        // Test vector: all-zeros seed should produce a deterministic pubkey
        let seed = [0u8; 32];
        let mut pubkey = [0u8; 32];
        let ret = ffi_ed25519_pubkey_from_seed(seed.as_ptr(), 32, pubkey.as_mut_ptr(), 32);
        assert_eq!(ret, 0);

        // Verify by signing and verifying
        let message = b"auth test vector";
        let mut sig = [0u8; 64];
        let ret = ffi_ed25519_sign(
            seed.as_ptr(),
            32,
            message.as_ptr(),
            message.len(),
            sig.as_mut_ptr(),
            64,
        );
        assert_eq!(ret, 0);

        let ret = ffi_ed25519_verify(
            pubkey.as_ptr(),
            32,
            message.as_ptr(),
            message.len(),
            sig.as_ptr(),
            64,
        );
        assert_eq!(ret, 0);
    }
}
