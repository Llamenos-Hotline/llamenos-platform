//! Integration test: full recovery group crypto flow.
//!
//! This test proves the complete crypto chain:
//! 1. Generate recovery group X25519 keypair
//! 2. Split private key into Shamir shares
//! 3. HPKE-wrap each share with a share holder's pubkey (LABEL_RECOVERY_GROUP_SHARE_WRAP)
//! 4. Verify share commitments
//! 5. Simulate ceremony: HPKE-open a share, re-wrap to new device (LABEL_RECOVERY_SHARE_CONTRIBUTE)
//! 6. New device opens contributed shares
//! 7. Combine shares to reconstruct recovery group private key
//! 8. Use reconstructed key to HPKE-open a PUK seed envelope (LABEL_RECOVERY_PUK_SEED_WRAP)

use llamenos_core::hpke_envelope::{generate_x25519_keypair, hpke_open, hpke_seal};
use llamenos_core::labels::{
    LABEL_RECOVERY_GROUP_SHARE_WRAP, LABEL_RECOVERY_PUK_SEED_WRAP, LABEL_RECOVERY_SHARE_CONTRIBUTE,
};
use llamenos_core::shamir::{
    combine, commit, generate_recovery_group_keypair, split, verify, Share,
};

#[test]
fn full_recovery_ceremony_flow() {
    // --- Setup: participants ---

    // 3 share holders, each with their own device keypair
    let holder_keys: Vec<_> = (0..3).map(|_| generate_x25519_keypair()).collect();
    let holder_pubkeys: Vec<&str> = holder_keys.iter().map(|(_, pk)| pk.as_str()).collect();

    // Recovering user's new device keypair
    let (new_device_sk, new_device_pk) = generate_x25519_keypair();

    // --- Step 1: Generate recovery group keypair ---

    let (recovery_sk, recovery_pk) = generate_recovery_group_keypair();
    assert_eq!(recovery_sk.len(), 64);
    assert_eq!(recovery_pk.len(), 64);

    // --- Step 2: User enrolls their PUK seed ---

    let mut puk_seed = [0u8; 32];
    getrandom::getrandom(&mut puk_seed).unwrap();
    let puk_seed_aad = b"hub-abc:puk-seed";

    let puk_seed_envelope = hpke_seal(
        &puk_seed,
        &recovery_pk,
        LABEL_RECOVERY_PUK_SEED_WRAP,
        puk_seed_aad,
    )
    .unwrap();

    // --- Step 3: Split recovery group private key into shares ---

    let sk_bytes = hex::decode(&*recovery_sk).unwrap();
    let shares = split(&sk_bytes, 3, 2).unwrap();
    assert_eq!(shares.len(), 3);

    // --- Step 4: Compute commitments ---

    let commitments: Vec<[u8; 32]> = shares.iter().map(commit).collect();

    // --- Step 5: HPKE-wrap each share for its holder ---

    let share_envelopes: Vec<_> = shares
        .iter()
        .enumerate()
        .map(|(i, share)| {
            let share_bytes = serialize_share(share);
            let aad = format!("hub-abc:share:{i}");
            hpke_seal(
                &share_bytes,
                holder_pubkeys[i],
                LABEL_RECOVERY_GROUP_SHARE_WRAP,
                aad.as_bytes(),
            )
            .unwrap()
        })
        .collect();

    // Recovery group private key is now zeroized (in production, the caller does this)
    drop(recovery_sk);

    // --- Step 6: Recovery ceremony — 2 share holders contribute ---

    // Session ID for AAD binding
    let session_id = "session-12345";

    let mut contributed_shares: Vec<Share> = Vec::new();

    for i in 0..2 {
        // Holder decrypts their stored share
        let aad = format!("hub-abc:share:{i}");
        let share_bytes = hpke_open(
            &share_envelopes[i],
            &holder_keys[i].0,
            LABEL_RECOVERY_GROUP_SHARE_WRAP,
            aad.as_bytes(),
        )
        .unwrap();

        let share = deserialize_share(&share_bytes);

        // Verify commitment
        assert!(
            verify(&share, &commitments[i]),
            "share {i} commitment failed"
        );

        // HPKE-wrap share to new device's pubkey
        let contribute_aad = format!(
            "{}:{}:{}",
            LABEL_RECOVERY_SHARE_CONTRIBUTE, session_id, holder_pubkeys[i]
        );
        let contribution_envelope = hpke_seal(
            &share_bytes,
            &new_device_pk,
            LABEL_RECOVERY_SHARE_CONTRIBUTE,
            contribute_aad.as_bytes(),
        )
        .unwrap();

        // New device decrypts the contribution
        let decrypted_share_bytes = hpke_open(
            &contribution_envelope,
            &new_device_sk,
            LABEL_RECOVERY_SHARE_CONTRIBUTE,
            contribute_aad.as_bytes(),
        )
        .unwrap();

        let decrypted_share = deserialize_share(&decrypted_share_bytes);

        // New device verifies commitment
        assert!(
            verify(&decrypted_share, &commitments[i]),
            "contributed share {i} commitment failed on new device"
        );

        contributed_shares.push(decrypted_share);
    }

    // --- Step 7: Combine shares to reconstruct recovery group private key ---

    let reconstructed_sk_bytes = combine(&contributed_shares, 2).unwrap();
    let reconstructed_sk_hex = hex::encode(&reconstructed_sk_bytes);

    // --- Step 8: Use reconstructed key to decrypt PUK seed ---

    let recovered_puk_seed = hpke_open(
        &puk_seed_envelope,
        &reconstructed_sk_hex,
        LABEL_RECOVERY_PUK_SEED_WRAP,
        puk_seed_aad,
    )
    .unwrap();

    assert_eq!(
        recovered_puk_seed, puk_seed,
        "recovered PUK seed must match original"
    );
}

#[test]
fn wrong_label_on_share_wrap_rejected() {
    let (holder_sk, holder_pk) = generate_x25519_keypair();
    let secret = vec![42u8; 32];
    let shares = split(&secret, 3, 2).unwrap();

    let share_bytes = serialize_share(&shares[0]);
    let envelope = hpke_seal(
        &share_bytes,
        &holder_pk,
        LABEL_RECOVERY_GROUP_SHARE_WRAP,
        b"aad",
    )
    .unwrap();

    // Try to open with wrong label (Albrecht defense)
    let result = hpke_open(
        &envelope,
        &holder_sk,
        LABEL_RECOVERY_PUK_SEED_WRAP, // wrong label
        b"aad",
    );
    assert!(result.is_err(), "wrong label should be rejected");
}

#[test]
fn aad_binding_prevents_cross_session_replay() {
    let (new_device_sk, new_device_pk) = generate_x25519_keypair();
    let (_holder_sk, holder_pk) = generate_x25519_keypair();

    let secret = vec![42u8; 32];
    let shares = split(&secret, 3, 2).unwrap();
    let share_bytes = serialize_share(&shares[0]);

    // Contribution for session A
    let aad_a = format!("{LABEL_RECOVERY_SHARE_CONTRIBUTE}:session-A:{holder_pk}");
    let envelope = hpke_seal(
        &share_bytes,
        &new_device_pk,
        LABEL_RECOVERY_SHARE_CONTRIBUTE,
        aad_a.as_bytes(),
    )
    .unwrap();

    // Try to open with session B AAD — should fail
    let aad_b = format!("{LABEL_RECOVERY_SHARE_CONTRIBUTE}:session-B:{holder_pk}");
    let result = hpke_open(
        &envelope,
        &new_device_sk,
        LABEL_RECOVERY_SHARE_CONTRIBUTE,
        aad_b.as_bytes(),
    );
    assert!(
        result.is_err(),
        "AAD binding should prevent cross-session replay"
    );

    // Correct AAD works
    let result = hpke_open(
        &envelope,
        &new_device_sk,
        LABEL_RECOVERY_SHARE_CONTRIBUTE,
        aad_a.as_bytes(),
    );
    assert!(result.is_ok(), "correct AAD should succeed");
}

// =============================================================================
// Share serialization helpers (for transport via HPKE)
// =============================================================================

/// Serialize a Share to bytes: [x, y...]
fn serialize_share(share: &Share) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(1 + share.y.len());
    bytes.push(share.x);
    bytes.extend_from_slice(&share.y);
    bytes
}

/// Deserialize a Share from bytes: [x, y...]
fn deserialize_share(bytes: &[u8]) -> Share {
    assert!(!bytes.is_empty(), "share bytes must not be empty");
    Share {
        x: bytes[0],
        y: bytes[1..].to_vec(),
    }
}
