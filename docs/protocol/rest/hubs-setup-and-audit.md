# Llamenos Protocol: REST API: hubs, setup wizard and audit log

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.15 Hubs

```
GET /api/hubs
Auth: Required (filtered by membership; super admin sees all)
Response: { "hubs": Hub[] }

POST /api/hubs
Permission: system:manage-hubs
Body: { "name": string, "slug"?: string, "description"?: string, "phoneNumber"?: string }
Response: { "hub": Hub }

GET /api/hubs/:hubId
Auth: Required (membership checked)
Response: { "hub": Hub }

GET /api/hubs/:hubId/permissions/me
Auth: Required (membership checked; 404 unknown hub, 403 no role in it)
Response: { "hubId": string, "permissions": string[] }
// The caller's own permissions IN this hub: exactly the set `hubContext` authorises the request with
// (that hub's role assignment, plus a super-admin's globals). `/auth/me` returns only the account-wide
// union, which describes no single hub, and `/settings/users/:id/effective-permissions` needs a GLOBAL
// `users:read` that a member whose roles are all hub-scoped does not hold. Clients gate what they RENDER
// for the hub being browsed on this; it is browsing context only and never gates call, relay or
// notification handling, which span every member hub (#1101).

PATCH /api/hubs/:hubId
Permission: system:manage-hubs
Body: partial Hub
Response: Hub

POST /api/hubs/:hubId/members
Permission: users:manage-roles
Body: { "pubkey": hex64, "roleIds": string[] }
Response: { "ok": true }

DELETE /api/hubs/:hubId/members/:pubkey
Permission: users:manage-roles
Response: { "ok": true }
// Admin invariant: a hub always has at least one admin. ONE definition of "an admin of hub H"
// (apps/worker/lib/hub-admin.ts `administersHub`) serves both this invariant and the POST /notes
// envelope guard (below): an active, un-erased user, with no erasure request in flight and no revoked
// signing key, who HOLDS IN H (users.hub_roles) roles granting both settings:manage and notes:read-all.
// Super-admins are zero-knowledge and are NEVER readers of any hub's data (operator decision D1): the
// global role-super-admin confers no admin authority here, is not counted, and is not a recipient. A
// super-admin counts only for a hub in which it also holds an admin role in hub_roles, like any member.
// A hub whose only "admin" is a super-admin therefore has no admin, and its real hub admin cannot leave.
// The admin readers of a hub are its admins' devices plus its optional escrow key (§2.4.2).
// POST /hubs creates the hub and its creator's admin assignment atomically, and every change that would
// leave a hub with none of those -- demoting or removing the member (above), PATCH/DELETE
// /api/users/:pubkey (deactivate, delete, rewrite hubRoles), editing or deleting the role that confers
// admin, and account erasure -- is refused with 409 and leaves nothing changed. Erasure of a hub's only
// admin is deferred, not denied: it succeeds once another admin exists.
// Envelope guard, same set: POST /notes (and note edit, note replies, client-sealed outbound messages,
// reports) require at least one envelope addressed to a member of the RECORD'S hub's admin reader set
// (readersFor(hub, admin), §2.4.2: its admins' device keys and its escrow key), or, TRANSITIONALLY, to
// ADMIN_DECRYPTION_PUBKEY, which every shipped client still seals to and which is in no reader set
// (422 otherwise). A record with no hub has no reader set, so only the transitional key is accepted.
// If none exists, the write is REFUSED with 503 and an operator-visible error is logged; it is not stored.
// What this still does NOT guarantee (tracked in #2190): that a hub admin can open a given note.
// Clients seal only to ADMIN_DECRYPTION_PUBKEY until they seal to GET /api/hubs/:hubId/readers, so a hub
// admin reads a note only if its sealer addressed one of their devices. Deleting ADMIN_DECRYPTION_PUBKEY
// from the guard and from every server seal follows the client change.
// The check is race-free: guards take advisory locks (the role catalog shared, then each affected hub)
// BEFORE reading role definitions and counting, and a role-definition edit takes the catalog lock exclusively.

GET /api/hubs/:hubId/key
Auth: Required (hub member)
Response: { "envelope": RecipientKeyEnvelope }
// Returns only the requesting user's envelope; 404 when the hub holds none for them (§2.7)

GET /api/hubs/:hubId/key/recipients
Authority: hubs:manage-keys OR hub admin, held through roles IN THIS HUB (a global super-admin's `*` does not count)
Response: { "generation": int, "epoch": int, "rotation": { "proof", "check" } | null,
            "envelopes": RecipientKeyEnvelope[], "members": [{ "pubkey", "encryptionPubkey": hex64 | null }],
            "rotationRequired": bool, "sealed"?: { "tags": [...], "teams": [...], "roles": [...] } }
// HubKeyRecipientsResponse, read in one snapshot (§2.7). 409 for a shredded hub.

PUT /api/hubs/:hubId/key
Authority: hubs:manage-keys OR hub admin, held through roles IN THIS HUB
Body: { "envelopes": RecipientKeyEnvelope[], "expectedGeneration": int }
Response: { "ok": true, "generation": int }  // HubKeySetResponse
// Compare-and-set (§2.7): 409 when the hub is no longer at expectedGeneration, or is shredded.

GET /api/hubs/:hubId/key/rotation
Auth: Required (hub member)
Response: { "epoch": int, "rotation": { "proof": hex, "check": hex } | null }  // HubKeyRotationResponse
// The statement a device verifies under the key it holds before adopting a rotated key (§2.7 Key Rotation).

POST /api/hubs/:hubId/key/rotate
Authority: hubs:manage-keys OR hub admin, held through roles IN THIS HUB
Body: { "expectedGeneration": int, "envelopes": RecipientEnvelope[], "rotation": { "proof", "check" },
        "resealed": { "tags": [{ from, to }], "teams": [{ from, to }], "roles": [{ from, to }] } }
Response: { "generation": int, "epoch": int }  // HubKeyRotateResponse
// One transaction (§2.7 Key Rotation): 409 on a stale generation, a member left out, a value not
// re-sealed or changed since the read, or a shredded hub; 403 for a wrap addressed to a non-member.

GET /api/hubs/:hubId/readers?purpose=admin|call-history|shift-overrides
Auth: Required (hub member)
Response: { "hubId": string, "purpose": "admin" | "call-history" | "shift-overrides", "recipients": hex64[] }  // HubReadersResponse
// The hub's reader set for the purpose (§2.4.2): X25519 device keys of every member holding the
// purpose's permissions in this hub's own role assignments, then the hub escrow key. Never an Ed25519
// identity key, never ADMIN_DECRYPTION_PUBKEY, never a super-admin's device unless it holds the
// permissions through a role in this hub. `purpose` outside the enum is 400.

GET /api/hubs/:hubId/escrow-key
Permission: hubs:read
Response: { "escrowPubkey"?: hex64 }  // HubEscrowKeyResponse; absent when the hub has none

PUT /api/hubs/:hubId/escrow-key
Authority: hubs:manage-keys AND every reader purpose's permissions, held through roles IN THIS HUB
           (users.hub_roles only; a global super-admin's `*` does not count)
Body: { "escrowPubkey": hex64 }  // SetHubEscrowKeyBody; X25519
Response: { "ok": true }
// Installs or rotates the escrow key. 403 without the authority above. 409 when the key is a registered
// device's X25519 key, a user's Ed25519 identity key, or ADMIN_DECRYPTION_PUBKEY. Audited (hubEscrowKeySet). Rotation does not
// re-seal history.

DELETE /api/hubs/:hubId/escrow-key
Authority: as PUT
Response: { "ok": true }
// 409 when the escrow key is the hub's only admin reader (no hub admin has a registered device):
// removing it would empty the admin reader set (A8). Audited (hubEscrowKeyCleared).
```

### 4.16 Setup Wizard

```
GET /api/setup/state
Auth: Required
Response: SetupState

PATCH /api/setup/state
Permission: settings:manage
Body: partial SetupState
Response: SetupState

POST /api/setup/complete
Permission: settings:manage
Body: {}
Response: SetupState
// Also creates a default hub if none exists

POST /api/setup/test/signal
Permission: settings:manage-messaging
Body: { "bridgeUrl": string, "bridgeApiKey": string }
Response: { "ok": true } or { "ok": false, "error": "..." }

POST /api/setup/test/whatsapp
Permission: settings:manage-messaging
Body: { "phoneNumberId": string, "accessToken": string }
Response: { "ok": true } or { "ok": false, "error": "..." }
```

### 4.17 Audit Log

There are two kinds of chain: one per hub, and the platform chain (`hub_id IS NULL`) for deployment-level actions. Each has its own route and permission. A missing hub id never means "every hub's log" (#2395).

```
GET /api/hubs/:hubId/audit?page=1&limit=50&actorPubkey=&eventType=&dateFrom=&dateTo=&search=
Permission: audit:read (in the hub)
Response: {
  "entries": AuditLogEntry[],
  "total": number
}

GET /api/hubs/:hubId/audit/verify?limit=500&offset=0
Permission: audit:read (in the hub)
Response: ChainVerificationResult

GET /api/admin/audit?page=1&limit=50&actorPubkey=&eventType=&dateFrom=&dateTo=&search=
GET /api/admin/audit/verify?limit=500&offset=0
Permission: system:view-audit
The platform chain only. It holds no hub's entries.
```

