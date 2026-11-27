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

// ── HPKE, by shape (D1) ───────────────────────────────────────────────

/// Report a crate error as `"{code}: {message}"`, so a caller (and a negative
/// vector) can assert the closed rejection code (spec §6.1).
/// Returns the matching return code: -5 for input faults, -1 for cryptographic failure.
fn set_crypto_error(e: &crate::errors::CryptoError) -> i32 {
    set_error(&format!("{}: {e}", e.code()));
    match e.code() {
        "decryption_failed" => -1,
        _ => -5,
    }
}

/// Parse the JSON array of AAD fields a shape binds (`[]` for most shapes).
fn parse_fields(fields: &[u8]) -> Result<Vec<String>, crate::errors::CryptoError> {
    if fields.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(fields).map_err(|e| {
        crate::errors::CryptoError::InvalidInput(format!(
            "aad fields must be a JSON string array: {e}"
        ))
    })
}

/// Seal `plaintext` as `shape` (the closed [`crate::shape::Shape`] byte) to a
/// 32-byte X25519 recipient. `fields` is a UTF-8 JSON array of the AAD fields the
/// shape binds, or empty. There is no label and no AAD argument: the crate
/// derives both. Output = enc(32) || ct; `out_len` ≥ 32 + pt_len + 16.
#[no_mangle]
pub extern "C" fn ffi_shape_seal(
    shape: u8,
    recipient_pk: *const u8,
    pk_len: usize,
    fields: *const u8,
    fields_len: usize,
    plaintext: *const u8,
    pt_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(recipient_pk, out);
    check_input_size!(pt_len, fields_len);
    if pk_len != 32 {
        set_error("HPKE recipient public key must be 32 bytes");
        return -5;
    }
    let required_out = 32 + pt_len + 16;
    check_output_size!(out_len, required_out);
    let fields = match parse_fields(nullable_slice!(fields, fields_len)) {
        Ok(f) => f,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    let shape = match crate::shape::Shape::from_u8(shape) {
        Ok(s) => s,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    let pk_hex = hex::encode(unsafe { std::slice::from_raw_parts(recipient_pk, 32) });
    let pt = nullable_slice!(plaintext, pt_len);
    let envelope = match crate::shape::seal_to(&pk_hex, shape, &fields, pt) {
        Ok(env) => env,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    let (Ok(enc), Ok(ct)) = (hex::decode(&envelope.enc), hex::decode(&envelope.ct)) else {
        set_error("internal error: sealed envelope is not hex");
        return -1;
    };
    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, required_out) };
    out_slice[..32].copy_from_slice(&enc);
    out_slice[32..].copy_from_slice(&ct);
    0
}

/// Open `envelope` = enc(32) || ct as `shape` with a 32-byte X25519 secret.
/// Writes the plaintext (env_len − 48 bytes) into `out`.
#[no_mangle]
pub extern "C" fn ffi_shape_open(
    shape: u8,
    secret_key: *const u8,
    sk_len: usize,
    fields: *const u8,
    fields_len: usize,
    envelope: *const u8,
    env_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(secret_key, envelope, out);
    check_input_size!(env_len, fields_len);
    if sk_len != 32 {
        set_error("HPKE secret key must be 32 bytes");
        return -5;
    }
    if env_len < 48 {
        set_error("invalid_format: HPKE envelope too short (need enc + tag)");
        return -5;
    }
    let pt_len = env_len - 48;
    check_output_size!(out_len, pt_len);
    let fields = match parse_fields(nullable_slice!(fields, fields_len)) {
        Ok(f) => f,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    let shape = match crate::shape::Shape::from_u8(shape) {
        Ok(s) => s,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    let mut sk = zeroize::Zeroizing::new([0u8; 32]);
    sk.copy_from_slice(unsafe { std::slice::from_raw_parts(secret_key, 32) });
    let env_slice = unsafe { std::slice::from_raw_parts(envelope, env_len) };
    let env = hpke_envelope::HpkeEnvelope {
        enc: hex::encode(&env_slice[..32]),
        ct: hex::encode(&env_slice[32..]),
    };
    let plaintext = match crate::shape::open_from(&sk, shape, &fields, &env) {
        Ok(pt) => pt,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, plaintext.len()) };
    out_slice.copy_from_slice(&plaintext);
    0
}

/// Seal `plaintext` under a fresh content key with `shape`'s content AAD.
/// Writes the key (32 bytes) to `out_key` and nonce(12) || ct || tag(16) to `out`
/// (`out_len` ≥ pt_len + 28).
#[no_mangle]
pub extern "C" fn ffi_content_seal(
    shape: u8,
    plaintext: *const u8,
    pt_len: usize,
    out_key: *mut u8,
    out_key_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(out_key, out);
    check_input_size!(pt_len);
    check_output_size!(out_key_len, 32);
    check_output_size!(out_len, pt_len + 28);
    let shape = match crate::shape::Shape::from_u8(shape) {
        Ok(s) => s,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    let pt = nullable_slice!(plaintext, pt_len);
    let sealed = match crate::shape::content_seal(shape, pt) {
        Ok(s) => s,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    unsafe {
        std::slice::from_raw_parts_mut(out_key, 32).copy_from_slice(&*sealed.key);
        std::slice::from_raw_parts_mut(out, sealed.packed.len()).copy_from_slice(&sealed.packed);
    }
    0
}

/// Seal `plaintext` with `shape`'s content AAD under an existing 32-byte key
/// (only the firehose window shape; see `shape::content_seal_under`). Writes
/// nonce(12) || ct || tag(16) to `out` (`out_len` ≥ pt_len + 28).
#[no_mangle]
pub extern "C" fn ffi_content_seal_under(
    shape: u8,
    key: *const u8,
    key_len: usize,
    plaintext: *const u8,
    pt_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(key, out);
    check_input_size!(pt_len);
    if key_len != 32 {
        set_error("invalid_format: content key must be 32 bytes");
        return -5;
    }
    check_output_size!(out_len, pt_len + 28);
    let shape = match crate::shape::Shape::from_u8(shape) {
        Ok(s) => s,
        Err(e) => return set_crypto_error(&e),
    };
    let mut k = zeroize::Zeroizing::new([0u8; 32]);
    k.copy_from_slice(unsafe { std::slice::from_raw_parts(key, 32) });
    let pt = nullable_slice!(plaintext, pt_len);
    match crate::shape::content_seal_under(shape, &k, pt) {
        Ok(packed) => {
            unsafe { std::slice::from_raw_parts_mut(out, packed.len()) }.copy_from_slice(&packed);
            0
        }
        Err(e) => set_crypto_error(&e),
    }
}

/// Open nonce(12) || ct || tag(16) of `shape` with its 32-byte key. Writes the
/// plaintext (packed_len − 28 bytes) to `out`.
#[no_mangle]
pub extern "C" fn ffi_content_open(
    shape: u8,
    key: *const u8,
    key_len: usize,
    packed: *const u8,
    packed_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(key, packed, out);
    check_input_size!(packed_len);
    if key_len != 32 || packed_len < 28 {
        set_error("invalid_format: content key must be 32 bytes and ciphertext at least 28");
        return -5;
    }
    check_output_size!(out_len, packed_len - 28);
    let shape = match crate::shape::Shape::from_u8(shape) {
        Ok(s) => s,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    let mut k = zeroize::Zeroizing::new([0u8; 32]);
    k.copy_from_slice(unsafe { std::slice::from_raw_parts(key, 32) });
    let packed_slice = unsafe { std::slice::from_raw_parts(packed, packed_len) };
    let pt = match crate::shape::content_open(shape, packed_slice, &k) {
        Ok(p) => p,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    unsafe { std::slice::from_raw_parts_mut(out, pt.len()) }.copy_from_slice(&pt);
    0
}

// ── Relay events (D9, #2999) ──────────────────────────────────────────

fn utf8_arg<'a>(bytes: &'a [u8], what: &str) -> Result<&'a str, i32> {
    std::str::from_utf8(bytes).map_err(|_| {
        set_error(&format!("invalid_input: {what} must be UTF-8"));
        -5
    })
}

/// Derive the relay-event key of `hub_id` for `epoch` (what `GET /api/auth/me`
/// hands a member of that hub). Writes 32 bytes to `out`.
#[no_mangle]
pub extern "C" fn ffi_server_event_key(
    server_secret: *const u8,
    secret_len: usize,
    hub_id: *const u8,
    hub_len: usize,
    epoch: u64,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(server_secret, hub_id, out);
    check_input_size!(secret_len, hub_len);
    check_output_size!(out_len, 32);
    let secret = unsafe { std::slice::from_raw_parts(server_secret, secret_len) };
    let hub = match utf8_arg(
        unsafe { std::slice::from_raw_parts(hub_id, hub_len) },
        "hub id",
    ) {
        Ok(h) => h,
        Err(code) => return code,
    };
    match crate::events::derive_server_event_key(secret, hub, epoch) {
        Ok(key) => {
            unsafe { std::slice::from_raw_parts_mut(out, 32) }.copy_from_slice(&*key);
            0
        }
        Err(e) => set_crypto_error(&e),
    }
}

/// Seal one relay frame of `hub_id` / `kind` / `epoch`: derives the hub's key
/// for the epoch and seals the UTF-8 JSON. Writes nonce || ct || tag (raw bytes)
/// to `out` and returns the number of bytes written.
#[no_mangle]
pub extern "C" fn ffi_seal_server_event(
    server_secret: *const u8,
    secret_len: usize,
    hub_id: *const u8,
    hub_len: usize,
    kind: u32,
    epoch: u64,
    json: *const u8,
    json_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(server_secret, hub_id, json, out);
    check_input_size!(secret_len, hub_len, json_len);
    let secret = unsafe { std::slice::from_raw_parts(server_secret, secret_len) };
    let hub = match utf8_arg(
        unsafe { std::slice::from_raw_parts(hub_id, hub_len) },
        "hub id",
    ) {
        Ok(h) => h,
        Err(code) => return code,
    };
    let json = match utf8_arg(
        unsafe { std::slice::from_raw_parts(json, json_len) },
        "event JSON",
    ) {
        Ok(j) => j,
        Err(code) => return code,
    };
    let payload = crate::events::derive_server_event_key(secret, hub, epoch)
        .and_then(|key| crate::events::seal_server_event(&key, hub, kind, epoch, json));
    let payload = match payload {
        Ok(p) => p,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    let Ok(bytes) = hex::decode(payload) else {
        set_error("internal error: event payload is not hex");
        return -1;
    };
    check_output_size!(out_len, bytes.len());
    unsafe { std::slice::from_raw_parts_mut(out, bytes.len()) }.copy_from_slice(&bytes);
    bytes.len() as i32
}

/// Open one relay frame with its 32-byte key (the server never needs this; the
/// worker's conformance tests and BDD steps use it to read what the relay sent).
/// Writes the UTF-8 JSON to `out` and returns the number of bytes written.
#[no_mangle]
pub extern "C" fn ffi_open_server_event(
    key: *const u8,
    key_len: usize,
    hub_id: *const u8,
    hub_len: usize,
    kind: u32,
    epoch: u64,
    payload_hex: *const u8,
    payload_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(key, hub_id, payload_hex, out);
    check_input_size!(hub_len, payload_len);
    if key_len != 32 {
        set_error("invalid_format: event key must be 32 bytes");
        return -5;
    }
    let mut k = zeroize::Zeroizing::new([0u8; 32]);
    k.copy_from_slice(unsafe { std::slice::from_raw_parts(key, 32) });
    let hub = match utf8_arg(
        unsafe { std::slice::from_raw_parts(hub_id, hub_len) },
        "hub id",
    ) {
        Ok(h) => h,
        Err(code) => return code,
    };
    let payload = match utf8_arg(
        unsafe { std::slice::from_raw_parts(payload_hex, payload_len) },
        "payload",
    ) {
        Ok(p) => p,
        Err(code) => return code,
    };
    let json = match crate::events::open_server_event(&k, hub, kind, epoch, payload) {
        Ok(j) => j,
        Err(e) => {
            return set_crypto_error(&e);
        }
    };
    check_output_size!(out_len, json.len());
    unsafe { std::slice::from_raw_parts_mut(out, json.len()) }.copy_from_slice(json.as_bytes());
    json.len() as i32
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

// ── Case records + case comments, sealed per purpose (#2499) ─────────

/// Seal a case ciphertext (a record's summary or fields, or a comment) for
/// `readers` — `readers_len / 32` X25519 public keys, concatenated.
///
/// `purpose` is the closed [`crate::case_record::CasePurpose`] byte
/// (0 summary, 1 fields, 2 comment). There is no label and no AAD argument:
/// `crate::case_record` derives both, exactly as it does for every client.
///
/// Writes the sealed ciphertext as UTF-8 JSON
/// `{"encryptedContent":hex,"readerEnvelopes":[{"pubkey","enc","ct"}]}` into
/// `out`. Returns the number of bytes written, or a negative error code.
#[no_mangle]
pub extern "C" fn ffi_case_seal(
    purpose: u8,
    plaintext: *const u8,
    pt_len: usize,
    readers: *const u8,
    readers_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(readers, out);
    check_input_size!(pt_len, readers_len);

    let purpose = match crate::case_record::CasePurpose::from_u8(purpose) {
        Ok(p) => p,
        Err(e) => {
            set_error(&e.to_string());
            return -5;
        }
    };
    if readers_len == 0 || !readers_len.is_multiple_of(32) {
        set_error("readers must be one or more concatenated 32-byte X25519 keys");
        return -5;
    }
    let pt_slice = nullable_slice!(plaintext, pt_len);
    let Ok(pt_str) = std::str::from_utf8(pt_slice) else {
        set_error("case plaintext must be valid UTF-8");
        return -5;
    };
    let reader_slice = unsafe { std::slice::from_raw_parts(readers, readers_len) };
    let reader_pubkeys: Vec<String> = reader_slice
        .as_chunks::<32>()
        .0
        .iter()
        .map(hex::encode)
        .collect();

    let sealed = match crate::case_record::seal(purpose, pt_str, &reader_pubkeys) {
        Ok(s) => s,
        Err(e) => {
            set_error(&format!("case seal failed: {e}"));
            return -1;
        }
    };
    let json = match serde_json::to_vec(&sealed) {
        Ok(j) => j,
        Err(e) => {
            set_error(&format!("internal error serialising case ciphertext: {e}"));
            return -1;
        }
    };
    check_output_size!(out_len, json.len());
    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, json.len()) };
    out_slice.copy_from_slice(&json);
    json.len() as i32
}

/// Open a case ciphertext with a reader's X25519 secret. `sealed_json` is the
/// JSON [`ffi_case_seal`] writes (and the API stores). The envelope addressed
/// to the secret's own public key is the one opened.
///
/// Writes the UTF-8 plaintext into `out`; returns bytes written, or a negative
/// error code. The server holds no reader secret for any case record — this
/// exists so the server-persisted vectors can be verified by the same library
/// the clients run (`gen-case-record-vectors.ts`, the worker's conformance test).
#[no_mangle]
pub extern "C" fn ffi_case_open(
    purpose: u8,
    secret_key: *const u8,
    sk_len: usize,
    sealed_json: *const u8,
    sealed_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(secret_key, sealed_json, out);
    check_input_size!(sealed_len);

    let purpose = match crate::case_record::CasePurpose::from_u8(purpose) {
        Ok(p) => p,
        Err(e) => {
            set_error(&e.to_string());
            return -5;
        }
    };
    if sk_len != 32 {
        set_error("case reader secret key must be 32 bytes");
        return -5;
    }
    let mut sk = [0u8; 32];
    sk.copy_from_slice(unsafe { std::slice::from_raw_parts(secret_key, 32) });
    let sealed_slice = unsafe { std::slice::from_raw_parts(sealed_json, sealed_len) };
    let sealed: crate::case_record::EncryptedCaseCiphertext =
        match serde_json::from_slice(sealed_slice) {
            Ok(s) => s,
            Err(e) => {
                sk.zeroize();
                set_error(&format!("case ciphertext JSON is malformed: {e}"));
                return -5;
            }
        };
    let secret = x25519_dalek::StaticSecret::from(sk);
    sk.zeroize();
    let pubkey_hex = hex::encode(x25519_dalek::PublicKey::from(&secret).as_bytes());
    let secret_hex = zeroize::Zeroizing::new(hex::encode(secret.to_bytes()));

    let plaintext = match crate::case_record::open(
        purpose,
        &sealed.encrypted_content,
        &sealed.reader_envelopes,
        &pubkey_hex,
        &secret_hex,
    ) {
        Ok(p) => zeroize::Zeroizing::new(p),
        Err(_) => {
            set_error("case open failed: decryption error");
            return -1;
        }
    };
    check_output_size!(out_len, plaintext.len());
    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, plaintext.len()) };
    out_slice.copy_from_slice(plaintext.as_bytes());
    plaintext.len() as i32
}

/// Verify a recovery-share liveness proof (#2782).
///
/// `liveness_pubkey` is the holder's stored 32-byte liveness verifying key,
/// `challenge` the 32-byte server-issued challenge, `signature` the 64-byte
/// proof. `hub_id` and `holder_pubkey` are UTF-8 and are bound into the signed
/// message by `recovery_liveness::build_liveness_message` — the one definition
/// of its layout, shared with every signer.
///
/// Returns 0 if the proof verifies, -1 if it does not, and a negative input
/// error otherwise. A malformed key or signature is a failed proof (-1), never
/// an error a caller could read as anything else.
#[no_mangle]
pub extern "C" fn ffi_recovery_liveness_verify(
    liveness_pubkey: *const u8,
    pk_len: usize,
    hub_id: *const u8,
    hub_id_len: usize,
    holder_pubkey: *const u8,
    holder_len: usize,
    challenge: *const u8,
    challenge_len: usize,
    signature: *const u8,
    sig_len: usize,
) -> i32 {
    clear_error();
    check_null!(liveness_pubkey, hub_id, holder_pubkey, challenge, signature);
    check_input_size!(hub_id_len, holder_len);

    if pk_len != 32 {
        set_error("liveness public key must be 32 bytes");
        return -5;
    }
    if challenge_len != crate::recovery_liveness::LIVENESS_CHALLENGE_LEN {
        set_error("liveness challenge must be 32 bytes");
        return -5;
    }
    if sig_len != 64 {
        set_error("liveness proof must be 64 bytes");
        return -5;
    }

    let pk: [u8; 32] = unsafe { std::slice::from_raw_parts(liveness_pubkey, 32) }
        .try_into()
        .unwrap();
    let chal: [u8; 32] = unsafe { std::slice::from_raw_parts(challenge, 32) }
        .try_into()
        .unwrap();
    let sig: [u8; 64] = unsafe { std::slice::from_raw_parts(signature, 64) }
        .try_into()
        .unwrap();
    let hub_slice = unsafe { std::slice::from_raw_parts(hub_id, hub_id_len) };
    let holder_slice = unsafe { std::slice::from_raw_parts(holder_pubkey, holder_len) };
    let (Ok(hub_str), Ok(holder_str)) = (
        std::str::from_utf8(hub_slice),
        std::str::from_utf8(holder_slice),
    ) else {
        set_error("hub id and holder pubkey must be valid UTF-8");
        return -5;
    };

    if crate::recovery_liveness::verify_liveness_proof(&pk, hub_str, holder_str, &chal, &sig) {
        0
    } else {
        set_error("liveness proof did not verify");
        -1
    }
}

// ── User sigchain (`crate::sigchain`) ──────────────────────────────────

/// Verify a whole user sigchain (`crate::sigchain::verify_sigchain`): hash
/// chain, signatures, the device set, `user_init` / `device_add` possession
/// signatures (#2496) and in-chain key reuse. The server runs it over the
/// stored chain plus a candidate link before appending, so the server accepts
/// exactly the chains every client verifier accepts.
///
/// `links` is a UTF-8 JSON array of `SigchainLink` (camelCase). Writes the
/// verified state as JSON to `out` and returns the byte count; on refusal
/// returns -5 with `"{code}: {detail}"` as the last error.
#[no_mangle]
pub extern "C" fn ffi_sigchain_verify(
    links: *const u8,
    links_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(links, out);
    check_input_size!(links_len);
    let slice = unsafe { std::slice::from_raw_parts(links, links_len) };
    let parsed: Vec<crate::sigchain::SigchainLink> = match serde_json::from_slice(slice) {
        Ok(v) => v,
        Err(e) => {
            return set_crypto_error(&crate::errors::CryptoError::InvalidFormat(format!(
                "sigchain links JSON is malformed: {e}"
            )))
        }
    };
    let state = match crate::sigchain::verify_sigchain(&parsed) {
        Ok(s) => s,
        Err(e) => return set_crypto_error(&e),
    };
    let json = match serde_json::to_vec(&state) {
        Ok(j) => j,
        Err(e) => return set_crypto_error(&crate::errors::CryptoError::JsonError(e)),
    };
    check_output_size!(out_len, json.len());
    let out_slice = unsafe { std::slice::from_raw_parts_mut(out, json.len()) };
    out_slice.copy_from_slice(&json);
    json.len() as i32
}

// ── Ban digest (RFC 9497 OPRF, `crate::ban_digest`) ────────────────────

/// Read the 32-byte BAN_HASH_KEY, a UTF-8 scope string, and a UTF-8 phone/element argument.
fn ban_key_and_scope(
    key: *const u8,
    key_len: usize,
    scope: *const u8,
    scope_len: usize,
) -> Result<([u8; 32], String), i32> {
    if key_len != 32 {
        set_error("BAN_HASH_KEY must be 32 bytes");
        return Err(-5);
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(unsafe { std::slice::from_raw_parts(key, 32) });
    let scope_slice = unsafe { std::slice::from_raw_parts(scope, scope_len) };
    match std::str::from_utf8(scope_slice) {
        Ok(s) => Ok((k, s.to_owned())),
        Err(_) => {
            k.zeroize();
            set_error("ban scope must be valid UTF-8");
            Err(-5)
        }
    }
}

/// The ban digest (64 bytes) of a caller identifier the server already holds, under one scope's key.
/// See `crate::ban_digest::evaluate`.
#[no_mangle]
pub extern "C" fn ffi_ban_digest_evaluate(
    key: *const u8,
    key_len: usize,
    scope: *const u8,
    scope_len: usize,
    identifier: *const u8,
    identifier_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(key, scope, identifier, out);
    check_input_size!(scope_len, identifier_len);
    check_output_size!(out_len, crate::ban_digest::DIGEST_LEN);
    let (mut k, scope) = match ban_key_and_scope(key, key_len, scope, scope_len) {
        Ok(v) => v,
        Err(code) => return code,
    };
    let identifier_slice = unsafe { std::slice::from_raw_parts(identifier, identifier_len) };
    let result = match std::str::from_utf8(identifier_slice) {
        Ok(id) => crate::ban_digest::evaluate(&k, &scope, id),
        Err(_) => Err(crate::errors::CryptoError::InvalidInput(
            "caller identifier must be UTF-8".into(),
        )),
    };
    k.zeroize();
    match result {
        Ok(digest) => {
            unsafe { std::slice::from_raw_parts_mut(out, digest.len()) }.copy_from_slice(&digest);
            0
        }
        Err(e) => {
            set_error(&format!("ban digest failed: {e}"));
            -5
        }
    }
}

/// Evaluate a client's 32-byte blinded element under one scope's key (32-byte output).
/// See `crate::ban_digest::blind_evaluate`.
#[no_mangle]
pub extern "C" fn ffi_ban_digest_blind_evaluate(
    key: *const u8,
    key_len: usize,
    scope: *const u8,
    scope_len: usize,
    blinded: *const u8,
    blinded_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    clear_error();
    check_null!(key, scope, blinded, out);
    check_input_size!(scope_len, blinded_len);
    check_output_size!(out_len, crate::ban_digest::ELEMENT_LEN);
    let (mut k, scope) = match ban_key_and_scope(key, key_len, scope, scope_len) {
        Ok(v) => v,
        Err(code) => return code,
    };
    let blinded_slice = unsafe { std::slice::from_raw_parts(blinded, blinded_len) };
    let result = crate::ban_digest::blind_evaluate(&k, &scope, blinded_slice);
    k.zeroize();
    match result {
        Ok(element) => {
            unsafe { std::slice::from_raw_parts_mut(out, element.len()) }.copy_from_slice(&element);
            0
        }
        Err(e) => {
            set_error(&format!("ban digest evaluation failed: {e}"));
            -5
        }
    }
}

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

    fn x25519_pair() -> ([u8; 32], [u8; 32]) {
        use hpke::kem::X25519HkdfSha256;
        use hpke::{Kem as KemTrait, Serializable};
        let mut rng = hpke_envelope::OsRng09;
        let (sk, pk) = X25519HkdfSha256::gen_keypair(&mut rng);
        (sk.to_bytes().into(), pk.to_bytes().into())
    }

    fn shape_seal(shape: u8, pk: &[u8; 32], fields: &[u8], pt: &[u8]) -> (i32, Vec<u8>) {
        let mut env = vec![0u8; 32 + pt.len() + 16];
        let ret = ffi_shape_seal(
            shape,
            pk.as_ptr(),
            32,
            fields.as_ptr(),
            fields.len(),
            pt.as_ptr(),
            pt.len(),
            env.as_mut_ptr(),
            env.len(),
        );
        (ret, env)
    }

    fn shape_open(shape: u8, sk: &[u8; 32], fields: &[u8], env: &[u8]) -> (i32, Vec<u8>) {
        let mut out = vec![0u8; env.len() - 48];
        let ret = ffi_shape_open(
            shape,
            sk.as_ptr(),
            32,
            fields.as_ptr(),
            fields.len(),
            env.as_ptr(),
            env.len(),
            out.as_mut_ptr(),
            out.len(),
        );
        (ret, out)
    }

    fn last_error() -> String {
        let mut buf = [0u8; 512];
        let n = ffi_last_error(buf.as_mut_ptr(), buf.len());
        String::from_utf8_lossy(&buf[..n.max(0) as usize]).into_owned()
    }

    #[test]
    fn test_shape_roundtrip_and_cross_shape_rejection() {
        use crate::shape::Shape;
        let (sk, pk) = x25519_pair();
        let key = [7u8; 32];
        let (ret, env) = shape_seal(Shape::NoteKey as u8, &pk, b"", &key);
        assert_eq!(ret, 0);
        let (ret, out) = shape_open(Shape::NoteKey as u8, &sk, b"", &env);
        assert_eq!(ret, 0);
        assert_eq!(out, key);
        // Another shape (so another label as HPKE info) fails with its code.
        let (ret, _) = shape_open(Shape::FileKey as u8, &sk, b"", &env);
        assert_eq!(ret, -1);
        assert!(last_error().starts_with("decryption_failed"));
        // Wrong key.
        let (wrong_sk, _) = x25519_pair();
        assert_eq!(shape_open(Shape::NoteKey as u8, &wrong_sk, b"", &env).0, -1);
    }

    #[test]
    fn test_shape_binds_its_fields() {
        use crate::shape::Shape;
        let (sk, pk) = x25519_pair();
        let (ret, env) = shape_seal(Shape::AuditUserKey as u8, &pk, br#"["aa"]"#, &[1u8; 32]);
        assert_eq!(ret, 0);
        assert_eq!(
            shape_open(Shape::AuditUserKey as u8, &sk, br#"["aa"]"#, &env).0,
            0
        );
        assert_eq!(
            shape_open(Shape::AuditUserKey as u8, &sk, br#"["bb"]"#, &env).0,
            -1
        );
        // The wrong field count is refused before HPKE runs.
        assert_eq!(
            shape_seal(Shape::AuditUserKey as u8, &pk, b"", &[1u8; 32]).0,
            -5
        );
    }

    #[test]
    fn test_shape_rejects_unknown_shape_byte() {
        let (_, pk) = x25519_pair();
        assert_eq!(shape_seal(200, &pk, b"", &[0u8; 32]).0, -5);
    }

    #[test]
    fn test_content_roundtrip() {
        use crate::shape::Shape;
        let pt = b"note body";
        let mut key = [0u8; 32];
        let mut packed = vec![0u8; pt.len() + 28];
        let ret = ffi_content_seal(
            Shape::NoteKey as u8,
            pt.as_ptr(),
            pt.len(),
            key.as_mut_ptr(),
            32,
            packed.as_mut_ptr(),
            packed.len(),
        );
        assert_eq!(ret, 0);
        let mut out = vec![0u8; pt.len()];
        let open = |shape: u8, out: &mut Vec<u8>| {
            ffi_content_open(
                shape,
                key.as_ptr(),
                32,
                packed.as_ptr(),
                packed.len(),
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert_eq!(open(Shape::NoteKey as u8, &mut out), 0);
        assert_eq!(out, pt);
        assert_eq!(open(Shape::FileKey as u8, &mut out), -1);
    }

    #[test]
    fn test_server_event_seal_and_open() {
        let secret = [0x5au8; 32];
        let hub = b"hub-a";
        let json = br#"{"type":"call:ring"}"#;
        let mut packed = vec![0u8; 1024];
        let n = ffi_seal_server_event(
            secret.as_ptr(),
            32,
            hub.as_ptr(),
            hub.len(),
            1000,
            7,
            json.as_ptr(),
            json.len(),
            packed.as_mut_ptr(),
            packed.len(),
        );
        assert_eq!(n, 12 + 512 + 16);
        let payload = hex::encode(&packed[..n as usize]);
        let mut key = [0u8; 32];
        assert_eq!(
            ffi_server_event_key(
                secret.as_ptr(),
                32,
                hub.as_ptr(),
                hub.len(),
                7,
                key.as_mut_ptr(),
                32
            ),
            0
        );
        let mut out = vec![0u8; 64];
        let open = |hub: &[u8], kind: u32, out: &mut Vec<u8>| {
            ffi_open_server_event(
                key.as_ptr(),
                32,
                hub.as_ptr(),
                hub.len(),
                kind,
                7,
                payload.as_ptr(),
                payload.len(),
                out.as_mut_ptr(),
                out.len(),
            )
        };
        let n = open(hub, 1000, &mut out);
        assert_eq!(&out[..n as usize], json);
        assert_eq!(open(b"hub-b", 1000, &mut out), -1);
        assert!(last_error().starts_with("decryption_failed"));
        assert_eq!(open(hub, 1001, &mut out), -1);
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

    #[test]
    fn test_recovery_liveness_verify() {
        let mut secret = [0u8; 32];
        getrandom::getrandom(&mut secret).unwrap();
        let shares = crate::shamir::split(&secret, 3, 2).unwrap();
        let pk = crate::recovery_liveness::liveness_public_key(&shares[0]).unwrap();
        let chal = [7u8; 32];
        let hub = "hub-1";
        let holder = "holder-1";
        let sig =
            crate::recovery_liveness::sign_liveness_proof(&shares[0], hub, holder, &chal).unwrap();
        let call = |sig: &[u8; 64], hub: &str| {
            ffi_recovery_liveness_verify(
                pk.as_ptr(),
                32,
                hub.as_ptr(),
                hub.len(),
                holder.as_ptr(),
                holder.len(),
                chal.as_ptr(),
                32,
                sig.as_ptr(),
                64,
            )
        };
        assert_eq!(call(&sig, hub), 0);
        assert_eq!(call(&sig, "hub-2"), -1);
        assert_eq!(call(&[0u8; 64], hub), -1);
        let short = [0u8; 16];
        assert_eq!(
            ffi_recovery_liveness_verify(
                pk.as_ptr(),
                32,
                hub.as_ptr(),
                hub.len(),
                holder.as_ptr(),
                holder.len(),
                short.as_ptr(),
                16,
                sig.as_ptr(),
                64,
            ),
            -5
        );
    }
}
