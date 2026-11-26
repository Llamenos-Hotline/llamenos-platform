//! Cross-platform v2 vectors (spec D15): generated here, from a seeded ChaCha20
//! RNG, and never edited by hand.
//!
//! `cargo test` regenerates both fixtures in memory and fails if the committed
//! files differ, so a change to any byte on the wire shows up as a fixture diff
//! in the PR that made it. To write them after an intended wire change:
//!
//! ```sh
//! LLAMENOS_WRITE_VECTORS=1 cargo test --lib vectors
//! ```
//!
//! Every platform opens them through its **production** reader — the crate here,
//! the server through `bun:ffi`, desktop through the Tauri state, iOS and Android
//! through UniFFI — and asserts each negative vector's closed rejection code
//! (`CryptoError::code`), never merely that something failed.
//!
//! Compiled only under `cfg(test)`: the seeded RNG cannot reach a release build.

use rand_chacha::rand_core::{RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use serde_json::{json, Value};

use crate::events::{self, EventKeyring, ServerEventKey};
use crate::hpke_envelope::{self, HpkeEnvelope};
use crate::shape::{self, Payload, Shape};

const HPKE_WRAP_PATH: &str = "tests/fixtures/v2/hpke-wrap.json";
const FIXTURE_DEVICES_PATH: &str = "tests/fixtures/v2/fixture-reader-devices.json";
const SERVER_EVENT_PATH: &str = "tests/fixtures/v2/server-event.json";

fn rng(label: &str) -> ChaCha20Rng {
    let mut seed = [0u8; 32];
    let digest = <sha2::Sha256 as sha2::Digest>::digest(label.as_bytes());
    seed.copy_from_slice(&digest);
    ChaCha20Rng::from_seed(seed)
}

fn bytes32(rng: &mut ChaCha20Rng) -> [u8; 32] {
    let mut b = [0u8; 32];
    rng.fill_bytes(&mut b);
    b
}

fn shape_name(s: Shape) -> String {
    serde_json::to_value(s)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

fn b64(hex_str: &str) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    URL_SAFE_NO_PAD.encode(hex::decode(hex_str).unwrap())
}

fn fields_for(s: Shape) -> Vec<String> {
    match s.arity() {
        0 => vec![],
        1 => vec!["0b7c5a1e-2d4f-4c8a-9e1b-3f6d2a7c9e0f".into()],
        _ => vec![
            "session-7".into(),
            "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988".into(),
        ],
    }
}

/// `hpke-wrap.json`: one envelope per shape, and the negative cases.
pub(crate) fn generate_hpke_wrap() -> Value {
    let mut r = rng("llamenos v2 vectors: hpke-wrap");
    let secret = bytes32(&mut r);
    let pubkey = hpke_envelope::x25519_public_hex(&secret);

    let mut positives = Vec::new();
    for s in Shape::ALL {
        let fields = fields_for(s);
        let plaintext: Vec<u8> = match s.payload() {
            Payload::Key => bytes32(&mut r).to_vec(),
            Payload::Bytes => format!("{{\"shape\":\"{}\"}}", shape_name(s)).into_bytes(),
        };
        let env = shape::seal_to_with_rng(&pubkey, s, &fields, &plaintext, &mut r).unwrap();
        positives.push(json!({
            "shape": shape_name(s),
            "aadFields": fields,
            "aadHex": hex::encode(s.wrap_aad(&fields).unwrap()),
            "plaintextHex": hex::encode(&plaintext),
            "envelope": { "enc": env.enc, "ct": env.ct },
        }));
    }

    // Negatives, built from the note-key envelope.
    let note = &positives[0];
    let enc = note["envelope"]["enc"].as_str().unwrap().to_string();
    let ct = note["envelope"]["ct"].as_str().unwrap().to_string();
    let neg =
        |name: &str, shape: Shape, fields: Vec<String>, enc: String, ct: String, code: &str| {
            json!({
                "name": name,
                "shape": shape_name(shape),
                "aadFields": fields,
                "envelope": { "enc": enc, "ct": ct },
                "expect": code,
            })
        };
    let mut other_suite_enc = enc.clone();
    other_suite_enc.push_str(&"00".repeat(1120 - 32));
    let audit = &positives[Shape::AuditUserKey as usize];
    let negatives = vec![
        neg(
            "wrong-shape-is-wrong-label",
            Shape::FileKey,
            vec![],
            enc.clone(),
            ct.clone(),
            "decryption_failed",
        ),
        neg(
            "base64url-enc",
            Shape::NoteKey,
            vec![],
            b64(&enc),
            ct.clone(),
            "invalid_format",
        ),
        neg(
            "base64url-ct",
            Shape::NoteKey,
            vec![],
            enc.clone(),
            b64(&ct),
            "invalid_format",
        ),
        neg(
            "uppercase-enc",
            Shape::NoteKey,
            vec![],
            enc.to_uppercase(),
            ct.clone(),
            "invalid_format",
        ),
        neg(
            "uppercase-ct",
            Shape::NoteKey,
            vec![],
            enc.clone(),
            ct.to_uppercase(),
            "invalid_format",
        ),
        neg(
            "key-wrap-ct-not-96-chars",
            Shape::NoteKey,
            vec![],
            enc.clone(),
            format!("{ct}00"),
            "invalid_format",
        ),
        neg(
            "enc-of-another-suite-length",
            Shape::NoteKey,
            vec![],
            other_suite_enc,
            ct.clone(),
            "invalid_format",
        ),
        neg(
            "odd-length-hex",
            Shape::NoteKey,
            vec![],
            enc[..63].to_string(),
            ct.clone(),
            "invalid_format",
        ),
        neg(
            "aad-field-swapped",
            Shape::AuditUserKey,
            vec!["0b7c5a1e-2d4f-4c8a-9e1b-3f6d2a7c9e00".into()],
            audit["envelope"]["enc"].as_str().unwrap().into(),
            audit["envelope"]["ct"].as_str().unwrap().into(),
            "decryption_failed",
        ),
        neg(
            "aad-field-missing",
            Shape::AuditUserKey,
            vec![],
            audit["envelope"]["enc"].as_str().unwrap().into(),
            audit["envelope"]["ct"].as_str().unwrap().into(),
            "invalid_input",
        ),
    ];

    let mut out = json!({
        "description": "v2 HPKE envelopes (spec D1, D2): one {enc, ct} per shape, lowercase hex. \
                        The label is the shape's, as HPKE info; the AAD is the shape's format-1 bytes. \
                        Every platform opens `positives` with recipientSecretHex through its production \
                        shape reader and asserts each negative's `expect` code.",
        "generator": "packages/crypto/src/vectors.rs (seeded ChaCha20; LLAMENOS_WRITE_VECTORS=1 cargo test --lib vectors)",
        "suite": { "kemId": hpke_envelope::KEM_ID, "kdfId": 1, "aeadId": 2 },
        "recipientSecretHex": hex::encode(secret),
        "recipientPubkeyHex": pubkey,
        "positives": positives,
        "negatives": negatives,
    });
    // The recipient as a PIN-encrypted device-key blob, for clients that can load
    // a device only through `mobile_unlock` (iOS has no raw-secret import, by
    // design). Production Argon2id parameters; omitted under `test-kdf`, whose
    // parameters no shipped XCFramework uses.
    if !cfg!(feature = "test-kdf") {
        let secrets = crate::device_keys::DeviceSecrets {
            signing_seed: bytes32(&mut r),
            encryption_seed: secret,
            kem_seed: None,
        };
        let state = crate::device_keys::DeviceKeyState {
            device_id: "v2-vectors".into(),
            signing_pubkey_hex: hex::encode(secrets.signing_pubkey().to_bytes()),
            encryption_pubkey_hex: pubkey.clone(),
            kem_pubkey_hex: None,
        };
        let mut nonce = [0u8; 12];
        r.fill_bytes(&mut nonce);
        let blob = crate::device_keys::encrypt_device_secrets_with(
            &secrets,
            DEVICE_BLOB_PIN,
            &state,
            &bytes32(&mut r),
            &nonce,
        )
        .unwrap();
        out["recipientDeviceKeys"] = json!({
            "pin": DEVICE_BLOB_PIN,
            "blob": serde_json::to_value(&blob).unwrap(),
        });
    }
    out
}

/// The PIN of the vector recipient's device-key blob (test-only, guards nothing).
const DEVICE_BLOB_PIN: &str = "24681357";

/// `server-event.json`: frames of two hubs over two epochs, the keys a member of
/// hub A (only) holds, and the negative cases (#2999).
pub(crate) fn generate_server_event() -> Value {
    let mut r = rng("llamenos v2 vectors: server-event");
    let server_secret = bytes32(&mut r);
    let (hub_a, hub_b) = (
        "0b7c5a1e-2d4f-4c8a-9e1b-3f6d2a7c9e0f",
        "5d1f8e2a-7c3b-4a9e-8f1d-2b6c9a3e7f10",
    );
    let (e1, e2) = (20_416u64, 20_417u64);
    let key = |hub: &str, epoch: u64| {
        events::derive_server_event_key(&server_secret, hub, epoch).unwrap()
    };

    let mut frames = Vec::new();
    let big = format!(
        "{{\"type\":\"conversation:new\",\"pad\":\"{}\"}}",
        "x".repeat(600)
    );
    for (name, hub, kind, epoch, plaintext) in [
        (
            "hub-a-call-ring",
            hub_a,
            1000u32,
            e2,
            r#"{"type":"call:ring","callId":"c-1"}"#.to_string(),
        ),
        (
            "hub-a-previous-epoch",
            hub_a,
            1001,
            e1,
            r#"{"type":"call:update","status":"ended"}"#.to_string(),
        ),
        ("hub-a-padded-to-next-bucket", hub_a, 1010, e2, big),
        (
            "hub-b-call-ring",
            hub_b,
            1000,
            e2,
            r#"{"type":"call:ring","callId":"c-2"}"#.to_string(),
        ),
    ] {
        let mut nonce = [0u8; 12];
        r.fill_bytes(&mut nonce);
        let payload = events::seal_server_event_with(
            &key(hub, epoch),
            hub,
            kind,
            epoch,
            &plaintext,
            &nonce,
            |t| r.fill_bytes(t),
        )
        .unwrap();
        frames.push(json!({
            "name": name, "hubId": hub, "kind": kind, "epoch": epoch,
            "plaintext": plaintext, "payload": payload,
        }));
    }

    // A member of hub A only: keys for A at both epochs.
    let held: Vec<Value> = [(hub_a, e2), (hub_a, e1)]
        .iter()
        .map(|(h, e)| json!({ "hubId": h, "epoch": e, "keyHex": hex::encode(*key(h, *e)) }))
        .collect();

    let a = &frames[0];
    let a_payload = a["payload"].as_str().unwrap().to_string();
    let b_payload = frames[3]["payload"].as_str().unwrap().to_string();
    let neg = |name: &str, hub: &str, kind: u32, epoch: u64, payload: String, code: &str| json!({ "name": name, "hubId": hub, "kind": kind, "epoch": epoch, "payload": payload, "expect": code });
    let negatives = vec![
        neg(
            "another-hubs-frame-no-key",
            hub_b,
            1000,
            e2,
            b_payload.clone(),
            "no_event_key",
        ),
        neg(
            "another-hubs-frame-relabelled-as-own-hub",
            hub_a,
            1000,
            e2,
            b_payload,
            "decryption_failed",
        ),
        neg(
            "frame-presented-as-another-kind",
            hub_a,
            1001,
            e2,
            a_payload.clone(),
            "decryption_failed",
        ),
        neg(
            "frame-replayed-into-another-epoch",
            hub_a,
            1000,
            e1,
            a_payload.clone(),
            "decryption_failed",
        ),
        neg(
            "uppercase-payload",
            hub_a,
            1000,
            e2,
            a_payload.to_uppercase(),
            "invalid_format",
        ),
        neg(
            "truncated-payload",
            hub_a,
            1000,
            e2,
            a_payload[..100].to_string(),
            "invalid_format",
        ),
        neg(
            "hub-id-outside-profile",
            "Hub_A",
            1000,
            e2,
            a_payload,
            "invalid_id",
        ),
    ];

    json!({
        "description": "Relay events (spec D9 + #2999): key = HKDF(SERVER_SECRET, salt = L_SERVER_EVENT_ENCRYPTION_KEY, \
                        info = lp(L_SERVER_EVENT_ENCRYPTION_KEY_INFO) || lp(hub) || u64be(epoch)); \
                        aad = lp(L_HUB_EVENT_EPOCH) || lp(hub) || u32be(kind) || u64be(epoch); \
                        payload = hex(nonce || AES-256-GCM(pad_to_bucket(json))). A client loads `heldKeys` \
                        (a member of hub A only), opens every `frames` entry of hub A, and asserts each \
                        negative's `expect` code. The server derives `heldKeys` from serverSecretHex.",
        "generator": "packages/crypto/src/vectors.rs (seeded ChaCha20; LLAMENOS_WRITE_VECTORS=1 cargo test --lib vectors)",
        "serverSecretHex": hex::encode(server_secret),
        "heldKeys": held,
        "frames": frames,
        "negatives": negatives,
    })
}

/// `fixture-reader-devices.json`: every reader of the format-1 fixtures as a
/// PIN-encrypted device blob (production Argon2id), so a client that can load a
/// device only through `mobile_unlock` — iOS — opens those server-persisted bytes
/// through its production readers. Android builds the same blob in Kotlin
/// (`FixtureReaderUnlock.kt`); this is the crate doing it once for everyone.
pub(crate) fn generate_fixture_reader_devices() -> Value {
    let mut r = rng("llamenos v2 vectors: fixture-reader-devices");
    let mut devices = serde_json::Map::new();
    for fixture in ["case-record-vectors.json", "stored-record-vectors.json"] {
        let f = load(&format!("tests/fixtures/{fixture}"));
        for reader in f["readers"].as_array().unwrap() {
            let pk = reader["x25519PubkeyHex"].as_str().unwrap().to_string();
            if devices.contains_key(&pk) {
                continue;
            }
            let seed: [u8; 32] = hex::decode(reader["x25519SecretHex"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            let secrets = crate::device_keys::DeviceSecrets {
                signing_seed: bytes32(&mut r),
                encryption_seed: seed,
                kem_seed: None,
            };
            assert_eq!(hex::encode(secrets.encryption_pubkey().to_bytes()), pk);
            let state = crate::device_keys::DeviceKeyState {
                device_id: format!("fixture-{}", reader["name"].as_str().unwrap()),
                signing_pubkey_hex: hex::encode(secrets.signing_pubkey().to_bytes()),
                encryption_pubkey_hex: pk.clone(),
                kem_pubkey_hex: None,
            };
            let mut nonce = [0u8; 12];
            r.fill_bytes(&mut nonce);
            let blob = crate::device_keys::encrypt_device_secrets_with(
                &secrets,
                DEVICE_BLOB_PIN,
                &state,
                &bytes32(&mut r),
                &nonce,
            )
            .unwrap();
            devices.insert(pk, serde_json::to_value(&blob).unwrap());
        }
    }
    json!({
        "description": "The readers of case-record-vectors.json and stored-record-vectors.json as \
                        PIN-encrypted device-key blobs (production Argon2id), keyed by X25519 pubkey. \
                        A client unlocks one with mobile_unlock and opens the fixture through its \
                        production readers.",
        "generator": "packages/crypto/src/vectors.rs (seeded ChaCha20; LLAMENOS_WRITE_VECTORS=1 cargo test --lib vectors)",
        "pin": DEVICE_BLOB_PIN,
        "devices": Value::Object(devices),
    })
}

fn render(v: &Value) -> String {
    let mut s = serde_json::to_string_pretty(v).unwrap();
    s.push('\n');
    s
}

fn check_or_write(path: &str, v: &Value) {
    let full = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    let rendered = render(v);
    if std::env::var_os("LLAMENOS_WRITE_VECTORS").is_some() {
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(&full, rendered).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&full).unwrap_or_else(|_| {
        panic!("{path} is missing — run LLAMENOS_WRITE_VECTORS=1 cargo test --lib vectors")
    });
    assert!(
        committed == rendered,
        "{path} differs from what this crate generates. A wire change must regenerate it \
         (LLAMENOS_WRITE_VECTORS=1 cargo test --lib vectors) and show the diff; never edit it by hand."
    );
}

fn load(path: &str) -> Value {
    let full = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    serde_json::from_str(&std::fs::read_to_string(full).unwrap()).unwrap()
}

fn shape_of(name: &str) -> Shape {
    serde_json::from_value(Value::String(name.into())).unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

fn envelope(v: &Value) -> HpkeEnvelope {
    serde_json::from_value(v.clone()).unwrap()
}

#[test]
fn vectors_are_generated_by_this_crate() {
    check_or_write(HPKE_WRAP_PATH, &generate_hpke_wrap());
    check_or_write(SERVER_EVENT_PATH, &generate_server_event());
    // Production Argon2id only (see generate_fixture_reader_devices).
    if !cfg!(feature = "test-kdf") {
        check_or_write(FIXTURE_DEVICES_PATH, &generate_fixture_reader_devices());
    }
}

#[test]
fn every_fixture_reader_device_unlocks_to_its_reader() {
    if cfg!(feature = "test-kdf") {
        return;
    }
    let f = load(FIXTURE_DEVICES_PATH);
    let pin = f["pin"].as_str().unwrap();
    for (pk, blob) in f["devices"].as_object().unwrap() {
        let blob: crate::device_keys::EncryptedDeviceKeys =
            serde_json::from_value(blob.clone()).unwrap();
        let secrets = crate::device_keys::unlock_device_keys(&blob, pin).unwrap();
        assert_eq!(&hex::encode(secrets.encryption_pubkey().to_bytes()), pk);
    }
}

#[test]
fn hpke_wrap_vectors_open_through_the_shape_reader() {
    let f = load(HPKE_WRAP_PATH);
    let secret: [u8; 32] = hex::decode(f["recipientSecretHex"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let positives = f["positives"].as_array().unwrap();
    assert_eq!(positives.len(), Shape::ALL.len(), "a shape has no vector");
    for p in positives {
        let s = shape_of(p["shape"].as_str().unwrap());
        let fields = strings(&p["aadFields"]);
        assert_eq!(
            hex::encode(s.wrap_aad(&fields).unwrap()),
            p["aadHex"].as_str().unwrap()
        );
        let pt = shape::open_from(&secret, s, &fields, &envelope(&p["envelope"])).unwrap();
        assert_eq!(
            hex::encode(&*pt),
            p["plaintextHex"].as_str().unwrap(),
            "{s:?}"
        );
    }
    for n in f["negatives"].as_array().unwrap() {
        let s = shape_of(n["shape"].as_str().unwrap());
        let err = shape::open_from(
            &secret,
            s,
            &strings(&n["aadFields"]),
            &envelope(&n["envelope"]),
        )
        .expect_err(n["name"].as_str().unwrap());
        assert_eq!(err.code(), n["expect"].as_str().unwrap(), "{}", n["name"]);
    }
}

#[test]
fn server_event_vectors_open_through_the_keyring() {
    let f = load(SERVER_EVENT_PATH);
    let held: Vec<ServerEventKey> = serde_json::from_value(f["heldKeys"].clone()).unwrap();
    // The server side derives exactly the keys it hands out.
    let secret = hex::decode(f["serverSecretHex"].as_str().unwrap()).unwrap();
    for k in &held {
        let derived = events::derive_server_event_key(&secret, &k.hub_id, k.epoch).unwrap();
        assert_eq!(hex::encode(*derived), k.key_hex);
    }
    let ring = EventKeyring::from_keys(&held).unwrap();
    let mut opened = 0;
    for fr in f["frames"].as_array().unwrap() {
        let hub = fr["hubId"].as_str().unwrap();
        let r = ring.open(
            hub,
            fr["kind"].as_u64().unwrap() as u32,
            fr["epoch"].as_u64().unwrap(),
            fr["payload"].as_str().unwrap(),
        );
        if held.iter().any(|k| k.hub_id == hub) {
            assert_eq!(r.unwrap(), fr["plaintext"].as_str().unwrap());
            opened += 1;
        } else {
            assert_eq!(r.unwrap_err().code(), "no_event_key");
        }
    }
    assert_eq!(opened, 3);
    for n in f["negatives"].as_array().unwrap() {
        let err = ring
            .open(
                n["hubId"].as_str().unwrap(),
                n["kind"].as_u64().unwrap() as u32,
                n["epoch"].as_u64().unwrap(),
                n["payload"].as_str().unwrap(),
            )
            .expect_err(n["name"].as_str().unwrap());
        assert_eq!(err.code(), n["expect"].as_str().unwrap(), "{}", n["name"]);
    }
}
