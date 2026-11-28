//! `hub-chain.json` and `recovery.json` (wire spec §6.2, D15): generated here
//! from a seeded ChaCha20 RNG, never edited by hand. See `vectors.rs` for the
//! regeneration command; `vectors_are_generated_by_this_crate` covers these too.
//!
//! **Reading them.** Every case is opened through a platform's production
//! reader. A `hub-chain.json` case is a `HubChainInput` made of the case's
//! `links` (and `anchor`, if any) plus the file's shared `userChains`; a
//! positive expects `head`, `stateHash` and `alerts`, a negative its closed
//! rejection code. A `recovery.json` case verifies `chain` (the recovering
//! user's sigchain) with the file's `userChains`, `hubChains` and the case's
//! `hubAnchors`.

use rand_chacha::ChaCha20Rng;
use serde_json::{json, Value};

use crate::device_keys::DeviceSecrets;
use crate::hub_chain::tests::{bundle_body, genesis_body, Builder, ADMIN_PERMS};
use crate::hub_chain::{
    self, sign_hub_link, sign_recovery_approval, ChainHead, HubAnchor, HubChainInput, HubChainLink,
    UnsignedRecoveryApproval,
};
use crate::sigchain::{create_sigchain_link, sign_device_pop, SigchainLink, DEVICE_KEM_FORMAT};
use crate::vectors::{bytes32, load, rng};

pub(crate) const HUB_CHAIN_PATH: &str = "tests/fixtures/v2/hub-chain.json";
pub(crate) const RECOVERY_PATH: &str = "tests/fixtures/v2/recovery.json";

const HUB: &str = "4f1c2b8e-6a3d-4e5f-9b7a-1c2d3e4f5a6b";

fn dev(r: &mut ChaCha20Rng) -> DeviceSecrets {
    DeviceSecrets {
        signing_seed: bytes32(r),
        encryption_seed: bytes32(r),
        kem_seed: bytes32(r),
    }
}

fn pk(s: &DeviceSecrets) -> String {
    hex::encode(s.signing_pubkey().to_bytes())
}

fn xwing_pk(r: &mut ChaCha20Rng) -> String {
    hex::encode(crate::device_keys::xwing_public_key(&bytes32(r)))
}

fn hex16(r: &mut ChaCha20Rng) -> String {
    hex::encode(&bytes32(r)[..16])
}

fn hex32(r: &mut ChaCha20Rng) -> String {
    hex::encode(bytes32(r))
}

/// One user's sigchain, signed link by link.
struct UserChain(Vec<SigchainLink>);

impl UserChain {
    fn init(s: &DeviceSecrets, name: &str) -> Self {
        let payload = crate::sigchain::user_init_payload(s, name).unwrap();
        UserChain(vec![create_sigchain_link(
            s,
            &format!("{name}-1"),
            name,
            1,
            None,
            "2026-11-28T00:00:00Z",
            &payload,
        )
        .unwrap()])
    }

    fn then(&mut self, signer: &DeviceSecrets, device_id: &str, payload: &Value) -> &mut Self {
        let prev = self.0.last().unwrap();
        let seq = prev.seq + 1;
        let link = create_sigchain_link(
            signer,
            &format!("{device_id}-{seq}"),
            device_id,
            seq,
            Some(prev.entry_hash.clone()),
            &format!("2026-11-28T00:{seq:02}:00Z"),
            &payload.to_string(),
        )
        .unwrap();
        self.0.push(link);
        self
    }

    fn head(&self) -> ChainHead {
        self.head_at(self.0.len() as u64)
    }

    fn head_at(&self, seq: u64) -> ChainHead {
        let l = &self.0[seq as usize - 1];
        ChainHead {
            seq: l.seq,
            hash: l.entry_hash.clone(),
        }
    }
}

fn device_add(user: &str, new: &DeviceSecrets, device_id: &str) -> Value {
    let kem = hex::encode(new.kem_pubkey());
    json!({
        "type": "device_add",
        "deviceId": device_id,
        "devicePubkey": pk(new),
        "deviceEncryptionPubkey": hex::encode(new.encryption_pubkey().to_bytes()),
        "encryptionPubkey": kem,
        "format": DEVICE_KEM_FORMAT,
        "pop": sign_device_pop(new, user, &kem, DEVICE_KEM_FORMAT).unwrap(),
    })
}

fn verify(
    links: &[HubChainLink],
    users: &[Vec<SigchainLink>],
    anchor: Option<ChainHead>,
) -> Result<hub_chain::HubChainVerified, crate::CryptoError> {
    hub_chain::verify_hub_chain(&HubChainInput {
        links: links.to_vec(),
        user_chains: users.to_vec(),
        hub_chains: vec![],
        anchor,
        hub_anchors: vec![],
    })
}

/// Re-sign `link` in place with `signer` after editing its body (its entry
/// hash and signature are recomputed, so only the edit is wrong).
fn resign(link: &HubChainLink, signer: &DeviceSecrets, body: Value) -> HubChainLink {
    let u = hub_chain::UnsignedHubLink {
        hub: link.hub.clone(),
        seq: link.seq,
        prev_hash: link.prev_hash.clone(),
        signer_user: link.signer_user.clone(),
        signer_user_head: link.signer_user_head.clone(),
        body,
    };
    sign_hub_link(signer, &u).unwrap()
}

pub(crate) fn generate_hub_chain() -> Value {
    let mut r = rng("llamenos v2 vectors: hub-chain");
    let (alice, bob, carol, carol2) = (dev(&mut r), dev(&mut r), dev(&mut r), dev(&mut r));
    let mallory = dev(&mut r); // a key in no user chain: the server's own
    let ca = UserChain::init(&alice, "alice-1");
    let cb = UserChain::init(&bob, "bob-1");
    // Carol links a second device, then removes the first (user seq 3).
    let mut cc = UserChain::init(&carol, "carol-1");
    cc.then(
        &carol,
        "carol-1",
        &device_add(&pk(&carol), &carol2, "carol-2"),
    );
    let carol_head_before_removal = cc.head();
    cc.then(
        &carol2,
        "carol-2",
        &json!({"type": "device_remove", "deviceId": "carol-1", "devicePubkey": pk(&carol)}),
    );
    let users: Vec<Vec<SigchainLink>> = vec![ca.0.clone(), cb.0.clone(), cc.0.clone()];

    let escrow_pk = xwing_pk(&mut r);
    let escrow_hash = {
        let b = hex::decode(&escrow_pk).unwrap();
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&b))
    };
    let admins_group = hex16(&mut r);
    let carol_group = hex16(&mut r);
    let epoch1_pk = xwing_pk(&mut r);
    let epoch2_pk = xwing_pk(&mut r);
    let carol_epoch_pk = xwing_pk(&mut r);
    let connector_signing = pk(&dev(&mut r));
    let connector_kem = xwing_pk(&mut r);
    let manifest = hex32(&mut r);
    let recovery_pk = xwing_pk(&mut r);
    let commitments = hex32(&mut r);

    let mut holders = vec![pk(&alice), pk(&bob)];
    holders.sort();

    let mut c = Builder::new(HUB);
    c.push(&alice, ca.head(), genesis_body(&pk(&alice)))
        .push(&alice, ca.head(), bundle_body("role-hub-admin", ADMIN_PERMS))
        .push(&alice, ca.head(), bundle_body("role-volunteer", &["calls:answer"]))
        .push(
            &alice,
            ca.head(),
            json!({"type": "role_grant", "user": pk(&bob), "bundle": "role-hub-admin"}),
        )
        .push(
            &bob,
            cb.head(),
            json!({"type": "role_grant", "user": pk(&carol), "bundle": "role-volunteer"}),
        )
        .push(
            &alice,
            ca.head(),
            json!({"type": "escrow_set", "format": 2, "pk": escrow_pk}),
        )
        .push(
            &alice,
            ca.head(),
            json!({"type": "group_epoch", "group": admins_group, "kind": "purpose", "subject": "admin",
                   "epoch": 1, "format": 2, "pk": epoch1_pk, "escrow": escrow_hash, "reason": "create"}),
        );
    // Carol's user group, signed by her FIRST device under a head where it was
    // still active: valid, and the stale-signer alert fires (D13).
    c.push(
        &carol,
        carol_head_before_removal.clone(),
        json!({"type": "group_epoch", "group": carol_group, "kind": "user", "subject": pk(&carol),
               "epoch": 1, "format": 2, "pk": carol_epoch_pk, "escrow": escrow_hash, "reason": "create"}),
    )
    .push(
        &bob,
        cb.head(),
        json!({"type": "connector_enroll", "connector": "intake-1", "signingPk": connector_signing,
               "format": 2, "encryptionPk": connector_kem, "manifestHash": manifest}),
    )
    .push(
        &alice,
        ca.head(),
        json!({"type": "recovery_group", "format": 2, "groupPk": recovery_pk, "threshold": 2,
               "holders": holders, "commitments": commitments, "delayHours": 24, "emergencyFloorHours": 4}),
    )
    .push(
        &bob,
        cb.head(),
        json!({"type": "policy", "kind": "rotation", "group": admins_group, "periodDays": 90}),
    );
    let checkpoint = verify(&c.links, &users, None).unwrap().state_hash;
    c.push(&bob, cb.head(), json!({"type": "checkpoint", "state": checkpoint}))
        .push(
            &bob,
            cb.head(),
            json!({"type": "group_epoch", "group": admins_group, "kind": "purpose", "subject": "admin",
                   "epoch": 2, "format": 2, "pk": epoch2_pk, "escrow": escrow_hash, "reason": "removal"}),
        );
    let valid = c.links.clone();
    let valid_for_cases = valid.clone();

    // Positives: every prefix, with its derived state.
    let mut positives = Vec::new();
    for n in 1..=valid.len() {
        let v = verify(&valid[..n], &users, None).unwrap();
        positives.push(json!({
            "name": format!("prefix-{n}-{}", valid[n - 1].body["type"].as_str().unwrap()),
            "prefix": n,
            "append": [],
            "expect": {"head": v.head, "stateHash": v.state_hash, "state": v.state, "alerts": v.alerts},
        }));
    }
    let full = verify(&valid, &users, None).unwrap();
    positives.push(json!({
        "name": "anchored-at-own-head",
        "prefix": valid.len(),
        "append": [],
        "anchor": full.head,
        "expect": {"head": full.head, "stateHash": full.state_hash, "state": full.state, "alerts": full.alerts},
    }));

    let mut negatives: Vec<Value> = Vec::new();
    let mut neg = |name: &str, links: Vec<HubChainLink>, anchor: Option<ChainHead>, code: &str| {
        let got = verify(&links, &users, anchor.clone())
            .map(|_| "ok".to_string())
            .unwrap_or_else(|e| e.code().to_string());
        assert_eq!(got, code, "{name}");
        // Stored as the longest prefix of the valid chain it shares, plus the rest.
        let prefix = links
            .iter()
            .zip(valid_for_cases.iter())
            .take_while(|(a, b)| a == b)
            .count();
        let append = links[prefix..].to_vec();
        let mut v = json!({"name": name, "prefix": prefix, "append": append, "expect": code});
        if let Some(a) = anchor {
            v["anchor"] = serde_json::to_value(a).unwrap();
        }
        negatives.push(v);
    };

    let prefix = |n: usize| valid[..n].to_vec();
    let with_last = |n: usize, l: HubChainLink| {
        let mut v = valid[..n].to_vec();
        v.push(l);
        v
    };

    // Unsigned and wrongly signed links.
    let mut unsigned = valid[3].clone();
    unsigned.sig = String::new();
    neg(
        "unsigned-link",
        with_last(3, unsigned),
        None,
        "chain_bad_signature",
    );
    let mut wrong = valid[3].clone();
    let mut sig = hex::decode(&wrong.sig).unwrap();
    sig[0] ^= 1;
    wrong.sig = hex::encode(sig);
    neg(
        "wrongly-signed-link",
        with_last(3, wrong),
        None,
        "chain_bad_signature",
    );

    // A signer without permission: the volunteer grants herself admin.
    let b = Builder {
        hub: HUB.into(),
        links: prefix(5),
    };
    let u = b.unsigned(
        &carol2,
        cc.head(),
        json!({"type": "role_grant", "user": pk(&carol), "bundle": "role-hub-admin"}),
    );
    let mut u = u;
    u.signer_user = pk(&carol);
    neg(
        "signer-without-permission",
        with_last(5, sign_hub_link(&carol2, &u).unwrap()),
        None,
        "chain_unauthorised_signer",
    );

    // An unsigned role grant inserted by the server: signed by a key in no
    // user chain, claiming to be the founder.
    let mut u = b.unsigned(
        &mallory,
        ca.head(),
        json!({"type": "role_grant", "user": pk(&mallory), "bundle": "role-hub-admin"}),
    );
    u.signer_user = pk(&alice);
    neg(
        "server-inserted-role-grant",
        with_last(5, sign_hub_link(&mallory, &u).unwrap()),
        None,
        "chain_unauthorised_signer",
    );

    // A user-group epoch signed by someone other than its subject.
    neg(
        "user-group-epoch-signed-by-admin",
        with_last(7, valid[7].clone().tap_signer(&bob, cb.head())),
        None,
        "chain_unauthorised_signer",
    );

    // prevHash and seq gaps.
    let mut bad_prev = valid[4].clone();
    bad_prev.prev_hash = Some("00".repeat(32));
    neg(
        "prev-hash-gap",
        with_last(4, bad_prev),
        None,
        "chain_prev_hash",
    );
    let mut gap = prefix(3);
    gap.push(valid[4].clone());
    neg("seq-gap", gap, None, "chain_seq");

    // The revoked-admin race: Alice revokes Bob at seq 6; Bob's grant, re-signed
    // on top of the revocation, lands after it.
    let mut race = Builder {
        hub: HUB.into(),
        links: prefix(5),
    };
    race.push(
        &alice,
        ca.head(),
        json!({"type": "role_revoke", "user": pk(&bob), "bundle": "role-hub-admin"}),
    );
    race.push(
        &bob,
        cb.head(),
        json!({"type": "role_grant", "user": pk(&mallory), "bundle": "role-hub-admin"}),
    );
    neg(
        "revoked-admin-race",
        race.links.clone(),
        None,
        "chain_unauthorised_signer",
    );

    // An unsorted set, and out-of-profile strings.
    let mut g = genesis_body(&pk(&alice));
    g["members"][0]["bundles"] = json!(["role-z", "role-a"]);
    let gb = Builder::new(HUB);
    neg(
        "unsorted-set",
        vec![sign_out_of_profile(
            &alice,
            &gb.unsigned(&alice, ca.head(), g),
        )],
        None,
        "chain_unsorted_set",
    );
    let mut g = genesis_body(&pk(&alice));
    g["members"][0]["bundles"] = json!(["Hub Admin"]);
    neg(
        "out-of-profile-string",
        vec![sign_out_of_profile(
            &alice,
            &gb.unsigned(&alice, ca.head(), g),
        )],
        None,
        "chain_profile",
    );

    // A forked pair served to two clients. The chains agree to seq 5 and
    // diverge at 6; each client holds an anchor at its own fork's seq 6, and
    // the server serves each the other's.
    let mut fork_a = Builder {
        hub: HUB.into(),
        links: prefix(5),
    };
    fork_a.push(
        &alice,
        ca.head(),
        json!({"type": "role_revoke", "user": pk(&carol), "bundle": "role-volunteer"}),
    );
    let mut fork_b = Builder {
        hub: HUB.into(),
        links: prefix(5),
    };
    fork_b.push(
        &bob,
        cb.head(),
        json!({"type": "role_grant", "user": pk(&carol), "bundle": "role-hub-admin"}),
    );
    let head6 = |l: &[HubChainLink]| ChainHead {
        seq: 6,
        hash: l[5].entry_hash.clone(),
    };
    assert!(verify(&fork_a.links, &users, None).is_ok());
    assert!(verify(&fork_b.links, &users, None).is_ok());
    neg(
        "fork-client-a-served-b",
        fork_b.links.clone(),
        Some(head6(&fork_a.links)),
        "chain_fork",
    );
    neg(
        "fork-client-b-served-a",
        fork_a.links.clone(),
        Some(head6(&fork_b.links)),
        "chain_fork",
    );
    neg(
        "served-chain-shorter-than-anchor",
        prefix(4),
        Some(head6(&fork_a.links)),
        "chain_fork",
    );

    // A server-substituted epoch pk: the signed link's pk swapped.
    let mut swapped = valid[6].clone();
    swapped.body["pk"] = Value::String(xwing_pk(&mut r));
    neg(
        "server-substituted-epoch-pk",
        with_last(6, swapped),
        None,
        "chain_entry_hash",
    );

    // A migration genesis.
    let mut g = genesis_body(&pk(&alice));
    g["migration"] = json!(1);
    neg(
        "genesis-migration-1",
        vec![sign_hub_link(&alice, &gb.unsigned(&alice, ca.head(), g)).unwrap()],
        None,
        "chain_migration_unsupported",
    );

    // Epoch rules, escrow, checkpoint, D13 stale head.
    let mut skip = valid[12].body.clone();
    skip["epoch"] = json!(3);
    neg(
        "epoch-skips",
        with_last(12, resign(&valid[12], &bob, skip)),
        None,
        "chain_epoch",
    );
    let mut no_escrow = valid[6].body.clone();
    no_escrow.as_object_mut().unwrap().remove("escrow");
    neg(
        "epoch-omits-escrow-in-force",
        with_last(6, resign(&valid[6], &alice, no_escrow)),
        None,
        "chain_escrow_mismatch",
    );
    neg(
        "checkpoint-mismatch",
        with_last(
            11,
            resign(
                &valid[11],
                &bob,
                json!({"type": "checkpoint", "state": "00".repeat(32)}),
            ),
        ),
        None,
        "chain_checkpoint_mismatch",
    );
    let mut stale = Builder {
        hub: HUB.into(),
        links: prefix(8),
    };
    stale.push(
        &carol,
        cc.head_at(1),
        json!({"type": "group_epoch", "group": carol_group, "kind": "user", "subject": pk(&carol),
               "epoch": 2, "format": 2, "pk": epoch2_pk, "escrow": escrow_hash, "reason": "device"}),
    );
    neg(
        "stale-user-head",
        stale.links.clone(),
        None,
        "chain_stale_head",
    );

    json!({
        "description": "Hub authority chain (#2963; wire spec 2026-11-24-encryption-v2-wire-format §5, §6.2). Each case is a HubChainInput: links = the first `prefix` links of this file's valid `chain` followed by the case's `append`, its anchor if any, and this file's userChains. A positive expects the head, the derived state, stateHash = SHA-256(canonical(state)) and the advisory alerts; a negative names the closed rejection code. entryHash = SHA-256(canonical(link without entryHash and sig)) under the D10 profile; sig = Ed25519(signerDevice, utf8(L_HUB_CHAIN_SIG) || 0x00 || entryHash); permsHash = SHA-256(lp(L_HUB_BUNDLE_PERMS) || lp(p_1) || ... || lp(p_k)). Until the first bundle policy the founder holds every permission (bootstrap). Format 2 = X-Wing.",
        "format": 2,
        "generator": "packages/crypto/src/hub_chain_vectors.rs (seeded ChaCha20; LLAMENOS_WRITE_VECTORS=1 cargo test --lib vectors)",
        "hub": HUB,
        "userChains": users,
        "chain": valid_for_cases,
        "positives": positives,
        "negatives": negatives,
    })
}

/// Sign `u` WITHOUT the profile check, as a non-conforming writer would: the
/// hash is SHA-256 of serde_json's sorted compact form. Only for negative vectors.
fn sign_out_of_profile(signer: &DeviceSecrets, u: &hub_chain::UnsignedHubLink) -> HubChainLink {
    use ed25519_dalek::Signer;
    let mut v = serde_json::to_value(u).unwrap();
    v["signerDevice"] = Value::String(pk(signer));
    let hash =
        <sha2::Sha256 as sha2::Digest>::digest(serde_json::to_string(&v).unwrap().as_bytes());
    let mut msg = crate::labels::LABEL_HUB_CHAIN_SIG.as_bytes().to_vec();
    msg.push(0);
    msg.extend_from_slice(&hash);
    hub_chain::assemble_hub_link_unchecked(
        u,
        &pk(signer),
        &hex::encode(hash),
        &hex::encode(signer.signing_key().sign(&msg).to_bytes()),
    )
}

trait TapSigner {
    fn tap_signer(self, signer: &DeviceSecrets, head: ChainHead) -> HubChainLink;
}

impl TapSigner for HubChainLink {
    /// Re-sign this link as `signer` (signerUser = signer's user), keeping its body.
    fn tap_signer(self, signer: &DeviceSecrets, head: ChainHead) -> HubChainLink {
        let u = hub_chain::UnsignedHubLink {
            hub: self.hub.clone(),
            seq: self.seq,
            prev_hash: self.prev_hash.clone(),
            signer_user: pk(signer),
            signer_user_head: head,
            body: self.body.clone(),
        };
        sign_hub_link(signer, &u).unwrap()
    }
}

pub(crate) fn generate_recovery() -> Value {
    let mut r = rng("llamenos v2 vectors: recovery");
    let (alice, bob, dave, erin, erin2) = (
        dev(&mut r),
        dev(&mut r),
        dev(&mut r),
        dev(&mut r),
        dev(&mut r),
    );
    let ca = UserChain::init(&alice, "alice-1");
    let cb = UserChain::init(&bob, "bob-1");
    let cd = UserChain::init(&dave, "dave-1");
    let ce = UserChain::init(&erin, "erin-1");
    let mut holders = vec![pk(&bob), pk(&dave)];
    holders.sort();

    let mut c = Builder::new(HUB);
    c.push(&alice, ca.head(), genesis_body(&pk(&alice)))
        .push(
            &alice,
            ca.head(),
            bundle_body("role-hub-admin", ADMIN_PERMS),
        )
        .push(
            &alice,
            ca.head(),
            bundle_body("role-volunteer", &["calls:answer"]),
        );
    for u in [&bob, &dave, &erin] {
        c.push(
            &alice,
            ca.head(),
            json!({"type": "role_grant", "user": pk(u), "bundle": "role-volunteer"}),
        );
    }
    c.push(
        &alice,
        ca.head(),
        json!({"type": "recovery_group", "format": 2, "groupPk": xwing_pk(&mut r), "threshold": 2,
               "holders": holders, "commitments": hex32(&mut r), "delayHours": 24, "emergencyFloorHours": 4}),
    );
    let hub_links = c.links.clone();
    let hub_head = ChainHead {
        seq: hub_links.len() as u64,
        hash: hub_links.last().unwrap().entry_hash.clone(),
    };
    let session = "0d9f6c2a-7b1e-4a3c-8d5f-2e6b9a1c4d7e";
    let approval =
        |holder: &DeviceSecrets, session: &str, new: &DeviceSecrets| UnsignedRecoveryApproval {
            hub: HUB.into(),
            hub_head: hub_head.clone(),
            subject_user: pk(&erin),
            new_signing_pk: pk(new),
            new_encryption_pk: hex::encode(new.kem_pubkey()),
            session: session.into(),
            holder_user: pk(holder),
        };
    let signed = |holder: &DeviceSecrets, a: UnsignedRecoveryApproval| {
        sign_recovery_approval(holder, &a).unwrap()
    };
    let sorted = |mut v: Vec<Value>| {
        v.sort_by(|a, b| a["holderUser"].as_str().cmp(&b["holderUser"].as_str()));
        v
    };
    let good = sorted(vec![
        signed(&bob, approval(&bob, session, &erin2)),
        signed(&dave, approval(&dave, session, &erin2)),
    ]);
    let link_payload = |approvals: Vec<Value>, emergency: Option<Value>| {
        let mut p = json!({
            "type": "recovery_device_add",
            "devicePubkey": pk(&erin2),
            "encryptionPubkey": hex::encode(erin2.kem_pubkey()),
            "format": DEVICE_KEM_FORMAT,
            "hub": HUB,
            "hubHead": hub_head,
            "session": session,
            "approvals": approvals,
        });
        if let Some(e) = emergency {
            p["emergency"] = e;
        }
        p
    };
    let chain_with = |payload: Value| {
        let mut e = UserChain(ce.0.clone());
        e.then(&erin2, "erin-2", &payload);
        e.0
    };
    let users: Vec<Vec<SigchainLink>> = vec![ca.0.clone(), cb.0.clone(), cd.0.clone()];
    let anchors = vec![HubAnchor {
        hub: HUB.into(),
        head: hub_head.clone(),
    }];
    let run = |chain: &[SigchainLink], anchors: &[HubAnchor]| {
        hub_chain::verify_sigchain_in_context(
            chain,
            &users,
            std::slice::from_ref(&hub_links),
            anchors,
        )
    };

    let mut positives = Vec::new();
    let ok_chain = chain_with(link_payload(good.clone(), None));
    let st = run(&ok_chain, &anchors).unwrap();
    positives.push(
        json!({"name": "threshold-approvals", "chain": ok_chain, "hubAnchors": anchors,
                          "expect": {"activeDevicePubkeys": st.active_device_pubkeys}}),
    );
    let emergency = signed(&alice, approval(&alice, session, &erin2));
    let em_chain = chain_with(link_payload(good.clone(), Some(emergency.clone())));
    let st = run(&em_chain, &anchors).unwrap();
    positives.push(json!({"name": "threshold-approvals-with-emergency", "chain": em_chain, "hubAnchors": anchors,
                          "expect": {"activeDevicePubkeys": st.active_device_pubkeys}}));

    let mut negatives = Vec::new();
    let mut neg = |name: &str, chain: Vec<SigchainLink>, anchors: &[HubAnchor], code: &str| {
        let got = run(&chain, anchors)
            .map(|_| "ok".to_string())
            .unwrap_or_else(|e| e.code().to_string());
        assert_eq!(got, code, "{name}");
        negatives
            .push(json!({"name": name, "chain": chain, "hubAnchors": anchors, "expect": code}));
    };
    neg(
        "k-minus-1-approvals",
        chain_with(link_payload(good[..1].to_vec(), None)),
        &anchors,
        "recovery_threshold",
    );
    neg(
        "duplicate-holders",
        chain_with(link_payload(vec![good[0].clone(), good[0].clone()], None)),
        &anchors,
        "recovery_duplicate_holder",
    );
    let other = dev(&mut r);
    neg(
        "approval-over-other-device-keys",
        chain_with(link_payload(
            sorted(vec![
                signed(&bob, approval(&bob, session, &other)),
                signed(&dave, approval(&dave, session, &erin2)),
            ]),
            None,
        )),
        &anchors,
        "recovery_approval_mismatch",
    );
    neg(
        "approval-over-other-session",
        chain_with(link_payload(
            sorted(vec![
                signed(&bob, approval(&bob, "other-session", &erin2)),
                signed(&dave, approval(&dave, session, &erin2)),
            ]),
            None,
        )),
        &anchors,
        "recovery_approval_mismatch",
    );
    neg(
        "holder-outside-the-set",
        chain_with(link_payload(
            sorted(vec![
                signed(&alice, approval(&alice, session, &erin2)),
                signed(&dave, approval(&dave, session, &erin2)),
            ]),
            None,
        )),
        &anchors,
        "recovery_not_holder",
    );
    neg(
        "emergency-standing-in-for-threshold",
        chain_with(link_payload(good[..1].to_vec(), Some(emergency))),
        &anchors,
        "recovery_threshold",
    );
    let mut forged = good.clone();
    let mut sig = hex::decode(forged[0]["sig"].as_str().unwrap()).unwrap();
    sig[0] ^= 1;
    forged[0]["sig"] = Value::String(hex::encode(sig));
    neg(
        "approval-bad-signature",
        chain_with(link_payload(forged, None)),
        &anchors,
        "recovery_bad_signature",
    );
    neg(
        "hub-chain-without-anchor",
        ok_chain_clone(&positives),
        &[],
        "recovery_unverifiable",
    );

    // The approval signing message, pinned.
    let a = approval(&bob, session, &erin2);
    let msg = hub_chain::recovery_approval_signing_message(&a, &pk(&bob)).unwrap();

    json!({
        "description": "Recovery approvals and recovery_device_add (#2963; wire spec §5.8, D14). Each case verifies `chain` (the recovering user's sigchain) with this file's userChains (holders and the hub's signers), hubChains and the case's hubAnchors. sig = Ed25519(holderDevice, utf8(L_RECOVERY_APPROVAL) || 0x00 || SHA-256(canonical(approval without sig))). The link is valid only with >= threshold approvals from distinct holders as of hubHead; an emergency approval never counts toward the threshold.",
        "format": 2,
        "generator": "packages/crypto/src/hub_chain_vectors.rs (seeded ChaCha20; LLAMENOS_WRITE_VECTORS=1 cargo test --lib vectors)",
        "hub": HUB,
        "userChains": users,
        "hubChains": [hub_links],
        "approvalMessage": {"approval": a, "holderDevice": pk(&bob), "messageHex": hex::encode(msg)},
        "positives": positives,
        "negatives": negatives,
    })
}

fn ok_chain_clone(positives: &[Value]) -> Vec<SigchainLink> {
    serde_json::from_value(positives[0]["chain"].clone()).unwrap()
}

fn hub_case_input(f: &Value, case: &Value) -> HubChainInput {
    let chain: Vec<HubChainLink> = serde_json::from_value(f["chain"].clone()).unwrap();
    let append: Vec<HubChainLink> = serde_json::from_value(case["append"].clone()).unwrap();
    let n = case["prefix"].as_u64().unwrap() as usize;
    let links = chain[..n].iter().cloned().chain(append).collect();
    HubChainInput {
        links,
        user_chains: serde_json::from_value(f["userChains"].clone()).unwrap(),
        hub_chains: vec![],
        anchor: case
            .get("anchor")
            .map(|a| serde_json::from_value(a.clone()).unwrap()),
        hub_anchors: vec![],
    }
}

#[test]
fn hub_chain_vectors_open_through_verify_hub_chain() {
    let f = load(HUB_CHAIN_PATH);
    let positives = f["positives"].as_array().unwrap();
    assert_eq!(positives.len(), 14);
    for p in positives {
        let v = hub_chain::verify_hub_chain(&hub_case_input(&f, p)).unwrap();
        assert_eq!(
            serde_json::to_value(&v.head).unwrap(),
            p["expect"]["head"],
            "{}",
            p["name"]
        );
        assert_eq!(
            v.state_hash,
            p["expect"]["stateHash"].as_str().unwrap(),
            "{}",
            p["name"]
        );
        assert_eq!(
            serde_json::to_value(&v.state).unwrap(),
            p["expect"]["state"],
            "{}",
            p["name"]
        );
        assert_eq!(
            serde_json::to_value(&v.alerts).unwrap(),
            p["expect"]["alerts"],
            "{}",
            p["name"]
        );
    }
    let negatives = f["negatives"].as_array().unwrap();
    assert_eq!(negatives.len(), 19);
    for n in negatives {
        let err = hub_chain::verify_hub_chain(&hub_case_input(&f, n))
            .expect_err(n["name"].as_str().unwrap());
        assert_eq!(
            err.code(),
            n["expect"].as_str().unwrap(),
            "{}: {err}",
            n["name"]
        );
    }
}

#[test]
fn recovery_vectors_open_through_verify_sigchain_in_context() {
    let f = load(RECOVERY_PATH);
    let users: Vec<Vec<SigchainLink>> = serde_json::from_value(f["userChains"].clone()).unwrap();
    let hubs: Vec<Vec<HubChainLink>> = serde_json::from_value(f["hubChains"].clone()).unwrap();
    let am = &f["approvalMessage"];
    let a: UnsignedRecoveryApproval = serde_json::from_value(am["approval"].clone()).unwrap();
    let msg =
        hub_chain::recovery_approval_signing_message(&a, am["holderDevice"].as_str().unwrap())
            .unwrap();
    assert_eq!(hex::encode(msg), am["messageHex"].as_str().unwrap());
    let case = |c: &Value| {
        let chain: Vec<SigchainLink> = serde_json::from_value(c["chain"].clone()).unwrap();
        let anchors: Vec<HubAnchor> = serde_json::from_value(c["hubAnchors"].clone()).unwrap();
        hub_chain::verify_sigchain_in_context(&chain, &users, &hubs, &anchors)
    };
    for p in f["positives"].as_array().unwrap() {
        let st = case(p).unwrap();
        assert_eq!(
            serde_json::to_value(&st.active_device_pubkeys).unwrap(),
            p["expect"]["activeDevicePubkeys"],
            "{}",
            p["name"]
        );
    }
    let negatives = f["negatives"].as_array().unwrap();
    assert_eq!(negatives.len(), 8);
    for n in negatives {
        let err = case(n).expect_err(n["name"].as_str().unwrap());
        assert_eq!(
            err.code(),
            n["expect"].as_str().unwrap(),
            "{}: {err}",
            n["name"]
        );
    }
    // Without any hub context a recovered user's chain is never accepted on trust.
    let chain: Vec<SigchainLink> =
        serde_json::from_value(f["positives"][0]["chain"].clone()).unwrap();
    assert_eq!(
        crate::sigchain::verify_sigchain(&chain).unwrap_err().code(),
        "recovery_unverifiable"
    );
}
