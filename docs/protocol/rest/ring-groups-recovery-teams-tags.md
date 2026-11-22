# Llamenos Protocol: REST API: ring groups, recovery group, teams and tags

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.49 Ring Groups

Encrypted ring groups for parallel call routing. Hub-scoped only.

```
GET    /api/hubs/:hubId/ring-groups
Permission: shifts:manage-ring-groups
Response: { "ringGroups": RingGroupSummary[] }

POST   /api/hubs/:hubId/ring-groups
Permission: shifts:manage-ring-groups
Body: { "encryptedName": hex }
Response: RingGroup

GET    /api/hubs/:hubId/ring-groups/:id
Permission: shifts:manage-ring-groups
Response: RingGroup

PUT    /api/hubs/:hubId/ring-groups/:id
Permission: shifts:manage-ring-groups
Body: { "encryptedName"?: hex }
Response: RingGroup

DELETE /api/hubs/:hubId/ring-groups/:id
Permission: shifts:manage-ring-groups
Response: { "ok": true }

POST   /api/hubs/:hubId/ring-groups/:id/members
Permission: shifts:manage-ring-groups
Body: { "pubkeys": string[] }
Response: RingGroup

DELETE /api/hubs/:hubId/ring-groups/:id/members
Permission: shifts:manage-ring-groups
Body: { "pubkeys": string[] }
Response: RingGroup
```

### 4.50 Recovery Group

Social recovery with Shamir secret sharing. This is the **only** specification of the recovery-group routes; it is checked against `apps/worker/routes/recovery-group.ts`. Every route below is mounted **unscoped** (`/api/recovery-group/*`, never `/api/hubs/:hubId/...`) — the hub is named in the body, query, or path where it matters, and the route enforces hub membership itself. Clients MUST NOT hub-prefix these paths.

**Unauthenticated (rate-limited):**
```
POST /api/recovery-group/initiate
Body: { "hubId": uuid, "userIdentifier": string, "newDevicePubkey": hex64 }
Response: { "sessionId": uuid, "verificationSent": boolean }
Rate limit: 10/5min per IP. The response shape is identical whether or not the
user exists (anti-enumeration).

POST /api/recovery-group/initiate/verify
Body: { "sessionId": uuid, "verificationCode": string }
Response: { "ok": boolean, "expiresAt": ISO-8601 }
Attempts per session are capped.

POST /api/recovery-group/session/:id/complete
Body: { "sigchainSeqNo": int, "sigchainPayload": object, "signature": hex128,
        "prevHash": hex64 | null, "hash": hex64, "signerDeviceId": string,
        "timestamp": ISO-8601 }
Response: { "ok": boolean, "sigchainLink": SigchainLink }
The recovering device has no prior session, so this is unauthenticated. The link
is signed by the NEW device's own key and is accepted only once the session is
`active` (>= threshold contributions) and its post-verification delay has
elapsed. `sigchainPayload` MUST carry `{ sessionId, contributingHolderPubkeys }`;
the server verifies both independently.

GET  /api/recovery-group/user-envelope/:hubId?sessionId=<uuid>
Response: { "envelope": string | null }
Session-scoped: released only after the delay has elapsed and the threshold of
contributions has been received.
```

**Authenticated:**
```
POST /api/recovery-group/enroll
Permission: recovery:manage (and membership of the hub)
Body: RecoveryGroupEnrollBody
Response: { "ok": true }

POST /api/recovery-group/rotate
Permission: recovery:manage (and membership of the hub)
Body: { hubId, threshold, totalShares, groupPublicKey, shareEnvelopes, shareCommitments,
        duressCommitments?, sigchainLinkHash, delayHours?, emergencyFloorHours?,
        rewrappedUserEnvelopes: [{ userPubkey, envelope }] }
Response: { "ok": true }
Atomic: replaces the group and re-wraps every user envelope in one transaction.
Each shareEnvelopes entry (enroll and rotate) is
  { holderPubkey, shareEnvelope, livenessPublicKey: hex64 }
where livenessPublicKey is derived from that holder's share — see "Share liveness proofs".

GET  /api/recovery-group/sessions?hubId=<uuid>
Permission: recovery:view (and membership of the hub)
Response: { sessionId, hubId, userPubkey, newDevicePubkey, status, signalVerified,
           expiresAt, createdAt, completedAt, cancelledAt, cancelledBy }[]

GET  /api/recovery-group/:hubId
Permission: recovery:view (and membership of the hub)
Response: RecoveryGroupInfo

POST /api/recovery-group/session/:id/contribute
Permission: recovery:hold-share (and current hub membership + enrollment)
Body: { "encryptedShare": hex, "contributorSignature": hex128 }
Response: { "ok": boolean, "status": RecoverySessionStatus, "contributionCount": number }

GET  /api/recovery-group/session/:id
Permission: recovery:view (and membership of the session's hub)
Response: RecoverySessionStatusResponse

POST /api/recovery-group/session/:id/emergency
Permission: recovery:approve
Body: { "approverPubkey": hex64, "justification": string, "signature": hex128 }
Response: { "ok": true }

POST /api/recovery-group/session/:id/cancel
Auth: Required
Response: { "ok": true }

POST /api/recovery-group/user-envelope
Auth: Required
Body: { "hubId": uuid, "envelope": string }
Response: { "ok": true }

POST /api/recovery-group/shares/liveness/challenge
Permission: recovery:hold-share (and current hub membership + enrollment)
Body: { "hubId": uuid }
Response: { "challenge": hex64, "expiresAt": iso8601 }   (single use, 5 minutes)

POST /api/recovery-group/shares/liveness
Permission: recovery:hold-share (and current hub membership + enrollment)
Body: { "hubId": uuid, "challenge": hex64, "proof": hex128 }
Response: { "ok": true, "verifiedAt": iso8601 }

GET  /api/recovery-group/shares/my?hubId=<uuid>
Permission: recovery:hold-share (and current hub membership + enrollment)
Response: MyShareEnvelopeResponse = { "hubId": uuid, "shareEnvelope": string }
```

`GET /shares/my` returns **only the calling holder's own** envelope — the HPKE
envelope (label `LABEL_RECOVERY_GROUP_SHARE_WRAP`) sealing that holder's Shamir
share to their own key. The holder is the authenticated pubkey and is never a
parameter: `hubId` selects which hub's share, nothing selects whose. Any
`holderPubkey`/`pubkey` a caller adds is ignored. The server answers `403
"Not a share holder for this hub"` — one message — whether the caller is no
longer a member of the hub, was never enrolled, or the hub has no recovery
group, so the route cannot be used to probe enrollment. A holder cannot take part
in recovery without this route: it is the only way to get the envelope they must
open to produce a `contribute` payload.

**Share liveness proofs** (#2782) let a holder demonstrate, before any recovery
is needed, that they can still produce their share — without the share, or
anything that narrows it, reaching the server. Defined in
`packages/crypto/src/recovery_liveness.rs`:

```
seed      = HKDF-SHA256(ikm = x || y, salt = none, info = LABEL_RECOVERY_LIVENESS_PROOF, L = 32)
(sk, pk)  = Ed25519 keypair from seed            // pk = the holder's livenessPublicKey
message   = UTF-8(LABEL_RECOVERY_LIVENESS_PROOF) || 0x00
            || u32be(len(hubId)) || UTF-8(hubId)
            || u32be(len(holderPubkey)) || UTF-8(holderPubkey)
            || challenge (32 bytes)
proof     = Ed25519.sign(sk, message)
```

The enrolling client computes `livenessPublicKey` per share at split time (the
share commitment cannot serve: a hash commitment is checkable only by a holder
of the share). `holderPubkey` is the authenticated caller's signing pubkey. The
server consumes the challenge atomically before verifying, so a challenge is
single-use whatever the outcome. An unknown, expired, reused or other-hub
challenge is `409` and changes nothing. A proof that does not verify is `403`:
it clears the holder's `lastLivenessProof` and records `lastLivenessFailure`
(both in `shareHolderLiveness`), so a holder who cannot produce their share
never reads as healthy. A share row enrolled without a liveness key gets `409`
from the challenge endpoint until the group is rotated. Clients sign inside
Rust (`recovery_share_liveness_proof_from_state` on desktop,
`mobile_recovery_share_liveness_proof` on iOS/Android): the share is opened
and used without entering the webview, Swift or Kotlin.

### 4.51 Teams

Hub-scoped team management for contact assignment.

```
GET    /api/hubs/:hubId/teams
Permission: teams:read
Response: { "teams": Team[] }

POST   /api/hubs/:hubId/teams
Permission: teams:manage
Body: { "id"?: string, "encryptedName": hex, "encryptedDescription"?: hex }
Response: Team

GET    /api/hubs/:hubId/teams/:teamId
Permission: teams:read
Response: Team

PATCH  /api/hubs/:hubId/teams/:teamId
Permission: teams:manage
Body: { "encryptedName"?: hex, "encryptedDescription"?: hex }
Response: Team

DELETE /api/hubs/:hubId/teams/:teamId
Permission: teams:manage
Response: { "ok": true }

GET    /api/hubs/:hubId/teams/:teamId/members
Permission: teams:read
Response: { "members": TeamMember[] }

POST   /api/hubs/:hubId/teams/:teamId/members
Permission: teams:manage
Body: { "pubkeys": string[] }
Response: { "ok": true }

DELETE /api/hubs/:hubId/teams/:teamId/members/:userPubkey
Permission: teams:manage
Response: { "ok": true }

GET    /api/hubs/:hubId/teams/:teamId/contacts
Permission: teams:read
Response: { "assignments": ContactTeamAssignment[] }

POST   /api/hubs/:hubId/teams/:teamId/contacts
Permission: teams:manage
Body: { "contactIds": string[] }
Response: { "ok": true }

DELETE /api/hubs/:hubId/teams/:teamId/contacts/:contactId
Permission: teams:manage
Response: { "ok": true }
```

### 4.52 Tags

Hub-scoped tags for contact categorization.

```
GET    /api/hubs/:hubId/tags
Permission: tags:view
Response: { "tags": Tag[] }

POST   /api/hubs/:hubId/tags
Permission: tags:create
Body: { "id"?: string, "name": string, "encryptedLabel": hex, "color"?: string, "encryptedCategory"?: hex }
Response: Tag

PATCH  /api/hubs/:hubId/tags/:tagId
Permission: tags:manage
Body: { "name"?: string, "encryptedLabel"?: hex, "color"?: string, "encryptedCategory"?: hex }
Response: Tag

DELETE /api/hubs/:hubId/tags/:tagId
Permission: tags:manage
Response: { "removedFromContacts": number }
```

