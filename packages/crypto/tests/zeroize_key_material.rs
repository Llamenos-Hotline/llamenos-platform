//! Key-material hygiene (#1107): the secrets this crate derives and holds must
//! be wiped when they go out of scope, on *every* exit path.
//!
//! Zeroization cannot be observed from safe code after the fact (the memory is
//! freed), so these tests pin it at the type level: a function that hands back
//! raw `[u8; 32]` is `Copy` and silently leaves a duplicate behind on every
//! early `?` return, whereas `Zeroizing<_>` / `ZeroizeOnDrop` cannot. A revert
//! to a bare array fails to compile here rather than passing quietly.

use llamenos_core::encryption::derive_kek_from_pin;
use zeroize::{Zeroize, ZeroizeOnDrop};

fn assert_zeroize_on_drop<T: ZeroizeOnDrop>(_: &T) {}
fn assert_zeroize_on_drop_ty<T: ZeroizeOnDrop>() {}

/// The PIN-derived KEK decrypts the device key blob. A wrong PIN exits the
/// decrypt path early, so the KEK must be wiped by its type, not by a trailing call.
#[test]
fn pin_kek_is_wiped_by_its_type() {
    let kek = derive_kek_from_pin("12345678", &[7u8; 32]);
    assert_zeroize_on_drop(&kek);
}

/// `aes-gcm`'s own `zeroize` feature only wipes the GHASH subkey. The expanded
/// AES key schedule — a full copy of the key — is wiped by `aes`'s feature,
/// which the crate enables directly. If the feature is dropped from Cargo.toml
/// this stops compiling: every AEAD call would again leave its key behind.
#[test]
fn aes_key_schedule_is_wiped_on_drop() {
    assert_zeroize_on_drop_ty::<aes::Aes256>();
    assert_zeroize_on_drop_ty::<aes::Aes128>();
}

/// A `Zeroizing` secret actually zeroes its bytes when explicitly wiped — the
/// behaviour every wrapper above relies on.
#[test]
fn zeroizing_wipes_bytes() {
    let mut kek = derive_kek_from_pin("12345678", &[7u8; 32]);
    assert_ne!(
        *kek, [0u8; 32],
        "KEK must start non-zero for the test to mean anything"
    );
    kek.zeroize();
    assert_eq!(*kek, [0u8; 32]);
}
