//! Identity initialisation vectors (docs/protocol/PROTOCOL.md §2.11,
//! "Identity initialisation"; issue #1050).
//!
//! A user created from nothing has exactly this sigchain:
//!
//!   seq 1  genesis    payload `user_init`  (self-signed by the first device;
//!                     names its X25519 and X-Wing keys, with a possession
//!                     signature over the X-Wing key — #2496, linking spec §5)
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
use llamenos_core::sigchain::{
    create_sigchain_link, sign_device_pop, verify_sigchain, DEVICE_KEM_FORMAT,
};
use sha2::{Digest, Sha256};

const DEVICE_SIGNING_SEED: [u8; 32] = [0x11; 32];
const DEVICE_ENCRYPTION_SEED: [u8; 32] = [0x22; 32];
const DEVICE_KEM_SEED: [u8; 32] = [0x44; 32];
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
const DEVICE_KEM_PUBKEY_SHA256: &str =
    "0d952cc4e7f6d0c663756af1e9bd03f3df4112f62909eb8e8ea575703a130809";
const GENESIS_POP: &str = "646c84c3c43ffb8d14614e72b17e3eb2ddd736ce0c10c065f5c3c1dad7fed617e735b05aa3defc088e7409790ad0443697871fcd185dd74611777eeb46a3b704";
const GENESIS_ENTRY_HASH: &str = "7dfa75be549821b49ad6ee398762b708ab107a73c4d316cb4d424db2e018ee22";
const GENESIS_SIGNATURE: &str =
    "52754e1361a6003f963c2ac48ab9646c3285ebc52836b785c589326a65bbe01271616406b60c35a5674f91a3e6914b988e1cb9e5f6f386145c09842ada80060f";
const PUK_EPOCH_ENTRY_HASH: &str =
    "cc2a325f75a1d8bd8fb51817e1d1fc3a90f78c40fc6de71498977e251169ea93";
const PUK_EPOCH_SIGNATURE: &str =
    "ff725cfdaa519bd2a17468ad1d49b74b823d554d28fe354651231bad6276478a1fee2be8752dbe22e66ebafc791a6ea8aea17574546f16c06130bad739b1d804";

#[test]
fn identity_init_chain_vectors() {
    let secrets = DeviceSecrets {
        signing_seed: DEVICE_SIGNING_SEED,
        encryption_seed: DEVICE_ENCRYPTION_SEED,
        kem_seed: DEVICE_KEM_SEED,
    };
    let device_pubkey = hex::encode(secrets.signing_pubkey().to_bytes());
    let device_enc_pubkey = hex::encode(secrets.encryption_pubkey().to_bytes());
    let device_xwing_pubkey = hex::encode(secrets.kem_pubkey());
    let pop = sign_device_pop(
        &secrets,
        &device_pubkey,
        &device_xwing_pubkey,
        DEVICE_KEM_FORMAT,
    )
    .unwrap();

    // Insertion order deliberately differs from sorted order: the entry hash
    // must not depend on how a client happens to serialise the payload.
    let genesis_payload = format!(
        r#"{{"type":"user_init","deviceId":"{DEVICE_ID}","devicePubkey":"{device_pubkey}","deviceEncryptionPubkey":"{device_enc_pubkey}","encryptionPubkey":"{device_xwing_pubkey}","format":{DEVICE_KEM_FORMAT},"pop":"{pop}"}}"#
    );
    // The crate's own builder produces the same payload (sorted keys).
    let built: serde_json::Value = serde_json::from_str(
        &llamenos_core::sigchain::user_init_payload(&secrets, DEVICE_ID).unwrap(),
    )
    .unwrap();
    let written: serde_json::Value = serde_json::from_str(&genesis_payload).unwrap();
    assert_eq!(built, written);
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
    let kem_digest = hex::encode(Sha256::digest(hex::decode(&device_xwing_pubkey).unwrap()));
    eprintln!("device X-Wing pubkey sha256: {kem_digest}");
    eprintln!("genesis pop:              {pop}");
    eprintln!("puk sign pubkey:          {}", puk.sign_pubkey_hex);
    eprintln!("puk dh pubkey:            {}", puk.dh_pubkey_hex);
    eprintln!("genesis entry hash:       {}", genesis.entry_hash);
    eprintln!("genesis signature:        {}", genesis.signature);
    eprintln!("puk_epoch entry hash:     {}", epoch.entry_hash);
    eprintln!("puk_epoch signature:      {}", epoch.signature);

    assert_eq!(device_pubkey, DEVICE_SIGNING_PUBKEY);
    assert_eq!(device_enc_pubkey, DEVICE_ENCRYPTION_PUBKEY);
    assert_eq!(kem_digest, DEVICE_KEM_PUBKEY_SHA256);
    assert_eq!(pop, GENESIS_POP);
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
    assert_eq!(verified.user_pubkey, DEVICE_SIGNING_PUBKEY);
    // The genesis names the device's X-Wing key (#2496).
    assert_eq!(verified.active_device_keys.len(), 1);
    assert_eq!(
        verified.active_device_keys[0].encryption_pubkey,
        device_xwing_pubkey
    );
    let mut named = vec![
        DEVICE_SIGNING_PUBKEY.to_string(),
        device_xwing_pubkey.clone(),
        hex::encode(
            x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from([0x22u8; 32]))
                .to_bytes(),
        ),
    ];
    named.sort();
    assert_eq!(verified.named_keys, named);

    // A server that reorders or drops the genesis link must not verify.
    assert!(verify_sigchain(std::slice::from_ref(&epoch)).is_err());
    assert!(verify_sigchain(&[epoch, genesis]).is_err());
}
