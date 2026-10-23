//! Identity initialisation vectors (docs/protocol/PROTOCOL.md §2.11,
//! "Identity initialisation"; issue #1050).
//!
//! A user created from nothing has exactly this sigchain:
//!
//!   seq 1  genesis    payload `user_init`  (self-signed by the first device)
//!   seq 2  puk_epoch  payload `puk_epoch`  (binds PUK generation 1's public keys)
//!
//! This test builds that chain from fixed device and PUK seeds, checks that
//! `verify_sigchain` accepts it and authorises the device, and pins every
//! derived value. Ed25519 is deterministic, so any other implementation that
//! claims to mirror this crate — the Playwright Tauri IPC mock
//! (`tests/mocks/sigchain-mock.ts`, asserted in
//! `apps/worker/__tests__/unit/sigchain-mock-parity.test.ts`) and the server's
//! `computeEntryHash` — must reproduce these exact bytes.
//!
//! Run with: cargo test --test identity_init

use llamenos_core::device_keys::DeviceSecrets;
use llamenos_core::puk::derive_puk_subkeys;
use llamenos_core::sigchain::{create_sigchain_link, verify_sigchain};

const DEVICE_SIGNING_SEED: [u8; 32] = [0x11; 32];
const DEVICE_ENCRYPTION_SEED: [u8; 32] = [0x22; 32];
const PUK_SEED: [u8; 32] = [0x33; 32];
const DEVICE_ID: &str = "device-genesis-001";

const GENESIS_TIMESTAMP: &str = "2026-09-26T00:00:00.000Z";
const PUK_EPOCH_TIMESTAMP: &str = "2026-09-26T00:00:01.000Z";

// Pinned outputs.
const DEVICE_SIGNING_PUBKEY: &str =
    "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";
const DEVICE_ENCRYPTION_PUBKEY: &str =
    "0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20";
const PUK_SIGN_PUBKEY: &str = "a4ed4a7ec643c741dbba79154761afa9eefd736e41de49cbe7eca73f45c10372";
const PUK_DH_PUBKEY: &str = "9022243e22195ddbe4e0953be4bb6e7dab8f9b39b45a910e8b038e177add7949";
const GENESIS_ENTRY_HASH: &str = "1e8fd94271f2843d67dffb611360e52900886edfaadb1aa4fa425d3dd3a49b72";
const GENESIS_SIGNATURE: &str =
    "5e7564725530af584275e656c3449615b09c4ad6c882815e193cacff32e939881ed79c331018340f7f2ebcfad3b9d9a0b40f150f92a98ea5f15c3db5dbd4e90d";
const PUK_EPOCH_ENTRY_HASH: &str =
    "3d3335d5be5d50e7544ae84758dc99457447cd0e59cfcb640f1abcecbfc83272";
const PUK_EPOCH_SIGNATURE: &str =
    "0b00c9314d162e5ab14be0dea45178580e0af158d27ca1e54756c28547af4b5c489f8383c0fc166dda06478a09a7d0ef2c703644a9cba48f1e9fd86cb4d78f08";

#[test]
fn identity_init_chain_vectors() {
    let secrets = DeviceSecrets {
        signing_seed: DEVICE_SIGNING_SEED,
        encryption_seed: DEVICE_ENCRYPTION_SEED,
    };
    let device_pubkey = hex::encode(secrets.signing_pubkey().to_bytes());
    let device_enc_pubkey = hex::encode(secrets.encryption_pubkey().to_bytes());

    // Insertion order deliberately differs from sorted order: the entry hash
    // must not depend on how a client happens to serialise the payload.
    let genesis_payload = format!(
        r#"{{"type":"user_init","deviceId":"{DEVICE_ID}","devicePubkey":"{device_pubkey}","deviceEncryptionPubkey":"{device_enc_pubkey}"}}"#
    );
    let genesis = create_sigchain_link(
        &secrets,
        "link-genesis",
        DEVICE_ID,
        1,
        None,
        GENESIS_TIMESTAMP,
        &genesis_payload,
    )
    .unwrap();

    let puk = derive_puk_subkeys(&PUK_SEED, 1);
    let epoch_payload = format!(
        r#"{{"type":"puk_epoch","generation":1,"signPubkey":"{}","dhPubkey":"{}"}}"#,
        puk.sign_pubkey_hex, puk.dh_pubkey_hex
    );
    let epoch = create_sigchain_link(
        &secrets,
        "link-puk-epoch",
        DEVICE_ID,
        2,
        Some(genesis.entry_hash.clone()),
        PUK_EPOCH_TIMESTAMP,
        &epoch_payload,
    )
    .unwrap();

    eprintln!("=== IDENTITY INIT VECTORS ===");
    eprintln!("device signing pubkey:    {device_pubkey}");
    eprintln!("device encryption pubkey: {device_enc_pubkey}");
    eprintln!("puk sign pubkey:          {}", puk.sign_pubkey_hex);
    eprintln!("puk dh pubkey:            {}", puk.dh_pubkey_hex);
    eprintln!("genesis entry hash:       {}", genesis.entry_hash);
    eprintln!("genesis signature:        {}", genesis.signature);
    eprintln!("puk_epoch entry hash:     {}", epoch.entry_hash);
    eprintln!("puk_epoch signature:      {}", epoch.signature);

    assert_eq!(device_pubkey, DEVICE_SIGNING_PUBKEY);
    assert_eq!(device_enc_pubkey, DEVICE_ENCRYPTION_PUBKEY);
    assert_eq!(puk.generation, 1);
    assert_eq!(puk.sign_pubkey_hex, PUK_SIGN_PUBKEY);
    assert_eq!(puk.dh_pubkey_hex, PUK_DH_PUBKEY);
    assert_eq!(genesis.signer_pubkey, DEVICE_SIGNING_PUBKEY);
    assert_eq!(genesis.signer_device_id, DEVICE_ID);
    assert_eq!(genesis.entry_hash, GENESIS_ENTRY_HASH);
    assert_eq!(genesis.signature, GENESIS_SIGNATURE);
    assert_eq!(epoch.entry_hash, PUK_EPOCH_ENTRY_HASH);
    assert_eq!(epoch.signature, PUK_EPOCH_SIGNATURE);

    let verified = verify_sigchain(&[genesis.clone(), epoch.clone()]).unwrap();
    assert_eq!(verified.verified_count, 2);
    assert_eq!(verified.head_seq, 2);
    assert_eq!(verified.head_hash, PUK_EPOCH_ENTRY_HASH);
    assert_eq!(
        verified.active_device_pubkeys,
        vec![DEVICE_SIGNING_PUBKEY.to_string()]
    );

    // A server that reorders or drops the genesis link must not verify.
    assert!(verify_sigchain(&[epoch.clone()]).is_err());
    assert!(verify_sigchain(&[epoch, genesis]).is_err());
}
