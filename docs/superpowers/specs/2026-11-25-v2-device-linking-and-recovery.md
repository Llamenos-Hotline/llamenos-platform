# v2 device linking, removal and recovery under the hub chain

**Date:** 2026-11-25 · **Base:** `origin/main` @ `417d525ac` · **Epic:** #2975 stages 2–3 (with #2974 stage 2)
**Issues:** #1972 (linking with fresh keys), #2496 (key binding and possession), #1295 and #1032 (recovery), #2963 addendum (the recovery link)
**Builds on:**
- the device-link protocol decision (`2026-10-10-device-link-protocol-decision.md`, #1027): roles, QR, rooms, the claim step, SAS, the §6.12 target payload, and "no private key ever leaves its origin";
- the v2 wire format (#2996): grants (§2.8), D13, D14 and D16;
- reader groups (#2961).

**Status:** SIGNED OFF by the operator, 2026-11-25: L1–L7 as recommended.

The 2026-10-10 decision fixed *how* a device links. This spec fixes what changes once records are
sealed to groups. It also settles the two questions the wire spec handed to #1972: how pilot
devices get an X-Wing encryption key, and what the provisioning channel seals with (D16).

---

## 0. Decisions at a glance

| # | Decision | Recommendation | § |
|---|---|---|---|
| L1 | What the payload adds | **Per-hub anchors.** The PUK is wrapped to the new device's X-Wing key. Grants are not in the payload; they are rows the primary writes once `device_add` lands | 2 |
| L2 | Who may grant a user's new device | **The user's own linked device may grant any group epoch it holds legitimately, to its own user's devices.** This amends wire §2.8 check 3. No admin needs to be online for linking | 3 |
| L3 | The provisioning channel and D16 | **Keep the X25519 ECDH + SAS channel for authentication.** Every secret inside it is wrapped to the new device's X-Wing key | 4 |
| L4 | Pilot devices' X-Wing key | **A new user-sigchain link, `device_kem`**, signed by the device itself and naming its X-Wing key. It comes before the hub's migration genesis | 5 |
| L5 | Key binding (#2496) | **Uniqueness, plus a possession signature in `device_add`.** No KEM challenge, because grants bind the owner (§6) | 6 |
| L6 | Removing a device | **Always rotate every group the user belongs to**, in every hub, whether the device was lost or retired | 7 |
| L7 | Recovery onto a new device | **Self-sealed data at once, through PUK grants.** Role groups follow from a pending grant by an online admin, shown as "waiting for an admin" | 8 |

---

## 1. What changes from v1

In v1, a linked device needed the PUK (#1972) and per-device hub-key envelopes (#1106). Under v2 it
needs:
- the PUK, for user-group epochs (rkind 2 grants, #2961 Model 1);
- **a grant for every group epoch the user is in, in every hub**: user groups, role groups and permission groups (#3025 E2);
- a **trusted anchor for each hub chain** (wire §5.7: "carried in the provisioning payload (#1972)").

Without the anchors, the new device would take its first hub head from the server, which is the
trust-on-first-use that #2963 §3 forbids.

---

## 2. L1: the payload — decided

The §6.12 target bundle (decision §4.4) gains one field, and its PUK wraps change suite:

| Field | Content |
|---|---|
| `pukWraps` | the user's PUK, HPKE-wrapped under **X-Wing** to the new device's claimed X-Wing encryption key (L3), one per PUK generation still in use |
| `deviceAdd` | the mandatory, primary-signed user-sigchain `device_add`: the new device's Ed25519 signing key, its X-Wing encryption key, `format: 2`, and the possession signature (L5) |
| `anchors` | **new:** `[{hub, seq, hash}]`, one per hub the user belongs to, taken from the primary's *verified* chain state |
| `userHead` | the user-sigchain head after `deviceAdd` |

**Grants are not in the payload.** After the new device claims the room, the primary appends
`device_add` to the user chain. It then writes grant rows (wire §2.8) for every group epoch it
holds, addressed to the new device's key, under L2. The new device verifies each grant against its
anchors (checks 1–4). The payload stays small, whatever the number of hubs, and grants are audited
like all other grants.

**Never in the payload,** unchanged from the decision: any device's private key or seed, the PUK
unwrapped, or an optional authorisation proof.

---

## 3. L2: self-grants — decided

Wire §2.8 check 3 requires the granter's user to be able to *manage* the group. For a volunteer's
new phone, that means an admin must be online before the phone can read anything beyond the user's
own group, which is the availability regression #2961 §5 warns about.

**Amendment.** A grant is also valid when **all** of the following hold:
- `owner_user` equals the granter's user;
- `granter_device` is active in that user's chain at `granter_head`;
- the granter itself holds a valid grant for the same `(group, epoch)`;
- the recipient key is a device of that same user, so rkind = 1.

**Why it's safe.** The reader set doesn't change. Membership is per user (check 2), and the user
is already in the group. The new device is authorised by the user's own chain (check 1). The
granter can only pass on what it legitimately holds, and verifiers check that by finding the
granter's own valid grant. A compromised device could do this anyway, because it holds the secret.

**What it does not allow:** granting to another user, granting an epoch the granter doesn't hold,
or granting to the PUK or escrow.

---

## 4. L3: the provisioning channel and D16 — decided

D16 says the room that carries device secrets "seals with X-Wing too".

**Recommended:**
- **Keep** the decision's X25519 ECDH + SAS for authenticating the two screens. The SAS is a human comparison of the ECDH transcript, and a KEM has no symmetric transcript to compare.
- **Every secret inside the bundle is wrapped separately** to the new device's claimed X-Wing key. That covers the PUK wraps, and anything secret added later.
- The outer AEAD carries `deviceAdd`, `anchors` and `userHead`, which are integrity-critical but not secret. They are signed or chain-verifiable anyway.
- A future quantum attacker who recorded the room learns the anchors and the link, both public-ish, and not the PUK.

**Alternative:** replace the ECDH with an X-Wing encapsulation and derive the SAS from the
encapsulation transcript. That is stronger on paper, but it is a new ceremony on four platforms for
data that isn't secret.

---

## 5. L4: giving pilot devices an X-Wing key — decided

Pilot devices hold X25519 encryption keys (D16). Before their hub's migration genesis (wire §3.2),
each needs an X-Wing key that grants and headers can be sealed to.

```json
{ "type": "device_kem", "devicePubkey": "<ed25519, unchanged>", "format": 2,
  "encryptionPubkey": "<X-Wing pk hex>", "pop": "<ed25519 sig by this device>" }
```

- **Signed by the device itself,** not by the primary, because it is the device's own key rotation. It is valid only if that device is active in the user chain.
- The old X25519 key stays readable for format-1 data until the wire spec's cutover (§3.5), then is deleted on the device.
- A device that never comes online before genesis is left out of the genesis member's device set. It links again afterwards.
- The name `device_kem` matches the underscore style of the existing link types (`device_add`, `puk_epoch`).

---

## 6. L5: binding keys to their owner (#2496) — decided

#2496: a member can register another user's encryption key as their own device.

- **Possession signature.** `device_add` and `device_kem` carry `pop = Ed25519(newDeviceSigningKey, L_DEVICE_POP ‖ 0x00 ‖ H(lp(user) ‖ lp(signingPk) ‖ lp(encryptionPk) ‖ u16(format)))`. This proves possession of the signing key, and binds the encryption key to it and to the user.
- **Uniqueness.** The server enforces UNIQUE on signing keys and on encryption keys across all users. Clients refuse a user chain that reuses a key seen in another user's chain.
- **No KEM challenge.** A possession proof for the KEM key would need an extra round trip. It isn't needed. Suppose an attacker registers a victim's encryption key as one of the attacker's own devices.
  - Grants for the **attacker's** groups are then sealed to that key, with `owner_user` = the attacker (wire §2.8 binds the owner).
  - Only the victim holds the matching secret, so only the victim could open them. They would get the attacker's own access, which the attacker could share anyway.
  - The victim's grants still name the victim, and are sealed to the victim's devices.

  The attacker gains nothing, and uniqueness refuses the registration in any case.

---

## 7. L6: removing a device — decided

A removed device holds every epoch secret its user had. Removing it is therefore a removal from
every group the user is in.

1. The user's remaining device appends `device_remove` to the user chain. Then, **in each hub**, it appends a user-group `group_epoch` (`reason: device`), which it may sign as the subject user (wire §5.4).
2. **Role and permission groups** that the user belongs to get a new epoch, created by an admin client as an automatic pending job (#2961 §6). The hub shows "rotation pending" until it is done. Declared-sensitive tiers refuse writes to the stale epoch.
3. The user's next hub action references the post-removal user head, which closes D13's stale-signer window for that hub.

**Recommended: always rotate**, whether the device is reported lost or retired. Separating "retired
and wiped" from "lost" would rest on the user's word about a device nobody can inspect.

**Cost, stated (D16's estimate):** about 6 groups per hub per removal, run by admin clients.

---

## 8. L7: recovery onto a new device — decided

The recovery link is wire D14: K-of-N approvals, a delay, and the emergency floor. After it lands:

- **Self-sealed data opens at once.** The recovered PUK opens rkind-2 grants for the user's user groups (#2961 Model 1).
- **Role and permission groups:** there is no surviving device to self-grant (L2), so an online admin client performs the pending grants automatically (#2961 §5). The user sees "waiting for an admin to finish setup", as a new member does.
- **Until the approvals are verified,** clients refuse to seal PUK or user-group epochs to the recovered device (wire addendum, unchanged).
- **Lost devices.** The recovery flow ends by offering to remove every other device of the user. Removal runs L6. This is the default when the reason is "lost or stolen".
- **#1295 and #1032:** recovery is reachable from the login screen on every client, and the mobile recovery-group models come from the schema. Neither changes the protocol.

---

## 9. Contract surface and gates

**Full-stack PRs** (crate, protocol, worker, vectors, bindings **and every client**, in each PR; the
split by dependency is in the briefs on #2975). The contract they carry:
- the bundle schema with `anchors` and the X-Wing PUK wraps;
- the claim body carrying the X-Wing key;
- the self-grant rule in the grant verifier;
- `device_kem`;
- the `pop` field and key uniqueness;
- the removal job (user-group epoch per hub, plus role-group pending rotation);
- the recovery pending-grant path.

**Vectors:**
- a bundle;
- a valid self-grant;
- a refused self-grant to another user, and a refused self-grant of an epoch the granter lacks;
- `device_kem`;
- a refused reused key;
- a removal that yields a new user-group epoch.

*Revised 2026-11-25 by operator decision.* The original heading said "Contract PR (one: crate, protocol,
worker and vectors)", with clients following. L1–L7 are unchanged.

**Gates (#2975):**
- **Stage 2:** a second device, linked end to end, reads data the first wrote, in every hub the user belongs to, **with no admin online**. A captured payload contains no private key and no seed, and putting one back turns the test red.
- **Stage 3:** recovery onto a new device works on all three clients. Other devices accept it from the chain alone. Its role-group access arrives from an admin's pending grant.
- **Shared with #2961:** a removed device can't read anything written after the removal.

---

## 10. Sign-off

The operator signed off L1–L7 on #2975 on 2026-11-25, every decision as recommended. Build briefs are on #2975.
