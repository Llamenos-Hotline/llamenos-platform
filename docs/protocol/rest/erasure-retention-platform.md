# Llamenos Protocol: REST API: erasure, retention and platform administration

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.45 Erasure

GDPR/right-to-be-forgotten account erasure.

```
GET    /api/erasure/me
Permission: erasure:request-self
Response: { "request": ErasureRequest | null }

POST   /api/erasure/me
Permission: erasure:request-self
Body: { "justification": string }
Response: { "request": ErasureRequest }

POST   /api/erasure/me/emergency
Permission: erasure:request-self
Body: { "justification": string, "coApproverPubkey": hex64, "coApproverSignature": hex128, "timestamp": number }
Response: { "request": ErasureRequest }

DELETE /api/erasure/me
Permission: erasure:request-self
Response: { "ok": true }

GET    /api/hubs/:hubId/erasure/requests
Permission: erasure:admin (resolved in :hubId)
Query: ?status=&limit=&offset=
Response: { "requests": ErasureRequest[], "total": number }
Only the requests that CONCERN :hubId: a shred of it, or a person's erasure whose subject belongs to it.
Another hub's requests are never listed. Without a hub path: 400.

GET    /api/erasure/platform/requests
Permission: system:manage-instance (global roles; never a hub-resolved set)
Query: ?status=&limit=&offset=
Response: { "requests": ErasureRequest[], "total": number }
Only the requests that concern NO hub that exists (a subject who belongs to none, or a shred of a hub
that is gone). Never a hub's requests, for any holder. Under a hub path: 400.

POST   /api/hubs/:hubId/erasure/:userId
Permission: erasure:admin
Body: { "justification": string }
Response: { "ok": true, "envelopeRevocationJobIds": string[] }
POST   /api/erasure/:userId           (subject belongs to no hub; needs system:manage-instance as well)
403 unless :userId belongs to :hubId AND the caller holds erasure:admin in EVERY hub :userId belongs to.

POST   /api/hubs/:hubId/erasure/:userId/wipe-device/:devicePubkey
Permission: erasure:admin
Body: { "reason"?: string }
Response: { "ok": true }
Same subject rule as erasure above.

GET    /api/hubs/:hubId/erasure/envelope-revocation-jobs
Permission: erasure:admin
Query: ?userId=
Response: { "jobs": EnvelopeRevocationJob[] }
Only :hubId's jobs. Without a hub path: 400.
```

### 4.46 Retention

Data retention settings per hub and platform-wide floors.

```
GET    /api/retention
Permission: retention:manage
Response: { "settings": RetentionSetting[] }

PATCH  /api/retention
Permission: retention:manage
Body: { "settings": [{ "category": string, "retentionDays": number }] }
Response: { "settings": RetentionSetting[] }

GET    /api/retention/platform-floors
Permission: system:manage-instance
Response: { "floors": RetentionFloor[] }

PATCH  /api/retention/platform-floors
Permission: system:manage-instance
Body: { "floors": [{ "category": string, "minRetentionDays": number }] }
Response: { "floors": RetentionFloor[] }
```

Hub-scoped: `/api/hubs/:hubId/retention/*`

### 4.47 Platform Bans

Platform-scoped bans (cross-hub). Requires `bans:*-platform` permissions. Under `/api/admin/`, beside the platform audit chain and platform incidents (#2463). The platform scope is a named resource, never a hub request with the hub left out.

```
GET    /api/admin/bans
Permission: bans:read-platform
Query: ?limit=&offset=
Response: { "bans": PlatformBan[], "total": number }

POST   /api/admin/bans/evaluate
Permission: bans:create-platform    // rate-limited per admin; audited (platformBanDigestsEvaluated)
Body: { "blindedElements": string[] (1..100, 64-hex ristretto255 elements) }
Response: { "evaluatedElements": string[] }   // in request order, under the platform key
// 400 for an element that is not a valid group element; 429 when rate-limited.

POST   /api/admin/bans
Permission: bans:create-platform
Body: { "phoneHash": string (128-hex ban digest, §2.10), "reason"?: string }
Response: { "ok": true }
// A plaintext "phone" is refused (400): the server never receives the number.

POST   /api/admin/bans/bulk
Permission: bans:create-platform
Body: { "phoneHashes": string[] (1..500), "reason"?: string }
Response: { "ok": true, "count": number }

DELETE /api/admin/bans/:id
Permission: bans:delete-platform
Response: { "ok": true }

POST   /api/admin/bans/search/evaluate
Permission: bans:read-platform      // rate-limited per admin; audited (platformBanSearchEvaluated)
Body: { "blindedElement": string }
Response: { "evaluations": [{ "hubId"?: string, "evaluatedElement": string }] }
// One per scope: no hubId = the platform, then every hub.

POST   /api/admin/bans/search
Permission: bans:read-platform
Body: { "lookups": [{ "hubId"?: string, "phoneHash": string }] (1..1000) }
Response: { "bans": [{ id, hubId: string | null, phoneHash, reason, bannedBy, bannedAt }] }
// Each digest only selects rows of its own scope.

POST   /api/admin/bans/promote
Permission: bans:create-platform
Body: { "banId": string, "sourcePhoneHash": string, "phoneHash": string }
Response: { "ok": true }
// The number is entered again and digested under the source hub's key and the platform's (§2.10).
// sourcePhoneHash must equal the stored hub ban, else 400 — a mistyped number cannot ban someone
// else. phoneHash is what the platform ban stores. The server cannot link the two digests itself.
```

### 4.48 Platform Settings

Instance-level platform settings. Super-admin only.

```
GET   /api/settings/platform
Permission: system:manage-instance
Response: { "settings": PlatformSettings }

PATCH /api/settings/platform
Permission: system:manage-instance
Body: UpdatePlatformSettingsBody
Response: { "settings": PlatformSettings }
```

