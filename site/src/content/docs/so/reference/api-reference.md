---
title: API Reference
description: Complete REST API endpoint reference for the Llamenos server.
---

Document-gaani wuxuu sharxayaa every REST API endpoint exposed by Llamenos server. Dhammaan endpoints waxay ku bilaabmaan `/api`. Requests iyo responses waxay isticmaalaan JSON haddii aan si kale loo sheegin. Dhammaan timestamps waxay ahaan karaan ISO 8601 strings.

API-ga waa isku mid haddii backend-ka ku shaqeeyo **Cloudflare Workers** (with Durable Objects) ama **self-hosted** (Node.js + PostgreSQL). Lixda Durable Objects — Identity, Settings, Records, ShiftManager, CallRouter, iyo Conversation — waxay u dhigmaan logical API domains hoos ku sharxan.

## Authentication

Llamenos waxay taageertaa laba authentication mechanism. Dhammaan authenticated endpoints waxay u baahan yihiin mid ka mid ah kuwan.

### Schnorr signature auth (primary)

Every authenticated request waxay wadataa self-signed BIP-340 Schnorr token bound to HTTP method iyo path.

**Header format:**

```
Authorization: Bearer {"pubkey":"<64_hex>","timestamp":<ms>,"token":"<128_hex>"}
```

**Token construction:**

1. Dhiso message-ka: `llamenos:auth:<pubkey>:<timestamp_ms>:<METHOD>:<path>`
2. Hash with SHA-256
3. Sign hash with BIP-340 Schnorr iyadoo isticmaalayo your secp256k1 secret key
4. Encode as inline JSON with `pubkey`, `timestamp`, iyo `token` (hex signature) fields

**Validation rules:**

- Token freshness: `|now() - timestamp| <= 300,000 ms` (5-minute window)
- Signature waxaa la verify gareeyaa against reconstructed message hash
- Pubkey waxaa loo eegaa in identity store si loo resolve gareyo user record

### Session token auth (WebAuthn)

Kadib WebAuthn authentication ceremony, server-ka waxay soo bixisaa random 256-bit session token valid for 8 hours.

```
Authorization: Session <token_hex>
```

Server-ka waxay eegtaa `Session` auth marka hore. Haddii header-ka uu ku bilaabmo `Session `, Schnorr auth ma isku daydo, iyo vice versa.

---

## Public endpoints

Endpoint-yadan ma u baahnato authentication.

### Health check

```
GET /api/health
```

**Response:**

```json
{ "status": "ok" }
```

### Configuration

```
GET /api/config
```

Soo celiyaa public hub configuration, enabled channels, iyo server identity.

**Response:**

```json
{
  "hotlineName": "Hotline",
  "hotlineNumber": "+1234567890",
  "channels": {
    "voice": true, "sms": false, "whatsapp": false,
    "signal": false, "rcs": false, "reports": true
  },
  "setupCompleted": true,
  "needsBootstrap": false,
  "hubs": [{ "id": "...", "name": "...", "slug": "..." }],
  "defaultHubId": "...",
  "serverWebSocketPubkey": "hex_64",
  "WebSocketRelayUrl": "wss://..."
}
```

### Build verification

```
GET /api/config/verify
```

Soo celiyaa build metadata for reproducible build verification.

**Response:**

```json
{
  "version": "1.0.0",
  "commit": "abc1234",
  "buildTime": "2024-01-01T00:00:00Z",
  "verificationUrl": "https://github.com/...",
  "trustAnchor": "GitHub Release checksums + SLSA provenance"
}
```

### IVR audio

```
GET /api/ivr-audio/:promptType/:language
```

Soo celiyaa audio files fetched by telephony providers during calls.

- `promptType`: `[a-z_-]+`
- `language`: `[a-z]{2,5}(-[A-Z]{2})?`
- **Response:** `audio/wav` binary

### Messaging preferences

Token-validated public endpoints for subscriber preference management.

```
GET  /api/messaging/preferences?token=<hmac_token>
PATCH /api/messaging/preferences?token=<hmac_token>
```

**PATCH body:**

```json
{ "status": "active", "language": "es" }
```

---

## Authentication endpoints

### Login

```
POST /api/auth/login
```

**Body:**

```json
{ "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

**Response:**

```json
{ "ok": true, "roles": ["role-super-admin"] }
```

Rate limited: 10 attempts per IP. Soo celiyaa `401` on invalid credentials.

### Bootstrap (first admin)

```
POST /api/auth/bootstrap
```

Diiwaangeliyaa first admin account. Fails with `403` haddii admin hore uu jiro.

**Body:** Same as login.
**Response:** Same as login.
Rate limited: 5 attempts per IP.

### Get current user

```
GET /api/auth/me
```

**Auth:** Required

**Response:**

```json
{
  "pubkey": "hex64",
  "roles": ["role-super-admin"],
  "permissions": ["*"],
  "primaryRole": { "id": "role-super-admin", "name": "Super Admin", "slug": "super-admin" },
  "name": "Admin",
  "transcriptionEnabled": true,
  "spokenLanguages": ["en", "es"],
  "uiLanguage": "en",
  "profileCompleted": true,
  "onBreak": false,
  "callPreference": "phone",
  "webauthnRequired": false,
  "webauthnRegistered": true,
  "adminPubkey": "hex64",
  "adminDecryptionPubkey": "hex64"
}
```

### Logout

```
POST /api/auth/me/logout
```

**Auth:** Required. Haddii isticmaalayo Session auth, token-ka waa la revoke gareeyaa server-side.

### Update profile

```
PATCH /api/auth/me/profile
```

**Auth:** Required

**Body:**

```json
{
  "name": "string",
  "phone": "+1234567890",
  "spokenLanguages": ["en", "es"],
  "uiLanguage": "en",
  "profileCompleted": true,
  "callPreference": "phone"
}
```

Dhammaan fields waa ikhtiyaar. `callPreference` waxay aqbashaa `"phone"`, `"browser"`, ama `"both"`.

### Update availability

```
PATCH /api/auth/me/availability
```

**Auth:** Required

**Body:**

```json
{ "onBreak": true }
```

### Update transcription preference

```
PATCH /api/auth/me/transcription
```

**Auth:** Required

**Body:**

```json
{ "enabled": false }
```

Soo celiyaa `403` haddii opt-out aan la oggolaan by admin settings.

---

## WebAuthn

### Login flow

```
POST /api/webauthn/login/options
```

**Auth:** None. Soo celiyaa `publicKeyCredentialRequestOptions` with `challengeId`.

```
POST /api/webauthn/login/verify
```

**Auth:** None

**Body:**

```json
{ "assertion": {}, "challengeId": "uuid" }
```

**Response:**

```json
{ "token": "hex64", "pubkey": "hex64" }
```

### Registration flow

```
POST /api/webauthn/register/options
```

**Auth:** Required

**Body:**

```json
{ "label": "My Phone" }
```

```
POST /api/webauthn/register/verify
```

**Auth:** Required

**Body:**

```json
{ "attestation": {}, "label": "My Phone", "challengeId": "uuid" }
```

### Credential management

```
GET /api/webauthn/credentials
```

**Auth:** Required. Soo celiyaa dhammaan registered credentials.

```
DELETE /api/webauthn/credentials/:credId
```

**Auth:** Required. Ka saartaa credential.

---

## Invites

### Public

```
GET /api/invites/validate/:code
```

Rate limited: 5 attempts per IP.

**Response:**

```json
{ "valid": true, "name": "...", "expiresAt": "..." }
```

```
POST /api/invites/redeem
```

**Body:**

```json
{ "code": "...", "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

Rate limited: 5 attempts per IP.

### Authenticated

```
GET /api/invites
```

**Permission:** `invites:read`

```
POST /api/invites
```

**Permission:** `invites:create`

**Body:**

```json
{ "name": "Jane Doe", "phone": "+1234567890", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/invites/:code
```

**Permission:** `invites:revoke`

---

## Volunteers

Dhammaan volunteer endpoints waxay u baahan yihiin `volunteers:read` as baseline permission.

```
GET /api/volunteers
```

**Permission:** `volunteers:read`

```
POST /api/volunteers
```

**Permission:** `volunteers:create`

**Body:**

```json
{ "name": "string", "phone": "string", "roleIds": ["string"], "pubkey": "string" }
```

```
PATCH /api/volunteers/:targetPubkey
```

**Permission:** `volunteers:update`

**Body:** Partial volunteer fields (`name`, `phone`, `roles`, `active`, etc.)

```
DELETE /api/volunteers/:targetPubkey
```

**Permission:** `volunteers:delete`

---

## Shifts

```
GET /api/shifts/my-status
```

**Auth:** Required (any role). Soo celiyaa current user's shift status.

```
GET /api/shifts
```

**Permission:** `shifts:read`

```
POST /api/shifts
```

**Permission:** `shifts:create`

**Body:**

```json
{
  "name": "Morning Shift",
  "startTime": "09:00",
  "endTime": "17:00",
  "days": [1, 2, 3, 4, 5],
  "volunteerPubkeys": ["hex64", "hex64"]
}
```

```
PATCH /api/shifts/:id
```

**Permission:** `shifts:update`

```
DELETE /api/shifts/:id
```

**Permission:** `shifts:delete`

### Fallback ring group

```
GET /api/shifts/fallback
```

**Permission:** `shifts:manage-fallback`

```
PUT /api/shifts/fallback
```

**Permission:** `shifts:manage-fallback`

**Body:**

```json
{ "fallbackPubkeys": ["hex64", "hex64"] }
```

Hub-scoped: Dhammaan shift endpoints waxay sidoo kale la heli karaan at `/api/hubs/:hubId/shifts/*`.

---

## Notes

Dhammaan note endpoints waxay u baahan yihiin `notes:read-own` as baseline. Clients waa inay encrypt gareyaan notes ka hor inta aanay soo dirin (eeg [protocol specification](https://github.com/rhonda-rodododo/llamenos-platform/blob/main/docs/protocol/PROTOCOL.md) for ECIES envelope format).

```
GET /api/notes?callId=...&page=1&limit=50
```

**Permission:** `notes:read-own` (own kaliya) ama `notes:read-all` (dhammaan notes)

**Response:**

```json
{ "notes": [], "total": 0 }
```

```
POST /api/notes
```

**Permission:** `notes:create`

**Body:**

```json
{
  "callId": "uuid",
  "encryptedContent": "hex",
  "authorEnvelope": { "wrappedKey": "hex", "ephemeralPubkey": "hex" },
  "adminEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }]
}
```

```
PATCH /api/notes/:id
```

**Permission:** `notes:update-own`

**Body:** Same shape as POST (with updated encrypted content iyo envelopes).

Hub-scoped: `/api/hubs/:hubId/notes/*`

---

## Calls

```
GET /api/calls/active
```

**Permission:** `calls:read-active` (caller info redacted) ama `calls:read-active-full`

```
GET /api/calls/today-count
```

**Permission:** `calls:read-active`

```
GET /api/calls/presence
```

**Permission:** `calls:read-presence`. Soo celiyaa volunteer online/busy status.

```
GET /api/calls/history?page=1&limit=50&search=&dateFrom=&dateTo=
```

**Permission:** `calls:read-history`

```
POST /api/calls/:callId/answer
```

**Permission:** `calls:answer`. Soo celiyaa `409` haddii call-ka horey loo jawaabay.

```
POST /api/calls/:callId/hangup
```

**Permission:** `calls:answer`. Soo celiyaa `403` haddii aan ahayn your call.

```
POST /api/calls/:callId/spam
```

**Permission:** `calls:answer`. Flags call-ka as spam.

```
GET /api/calls/:callId/recording
```

**Permission:** `calls:read-recording` ama answering volunteer.

**Response:** `audio/wav` binary with `Cache-Control: private, no-store`.

```
GET /api/calls/debug
```

**Permission:** `calls:debug`. Soo celiyaa internal call state for troubleshooting.

Hub-scoped: `/api/hubs/:hubId/calls/*`

---

## Conversations

```
GET /api/conversations?status=&channel=&page=1&limit=50
```

**Permission:** `conversations:read-all` ama `conversations:read-assigned` (own + waiting)

**Response:**

```json
{
  "conversations": [],
  "total": 0,
  "assignedCount": 0,
  "waitingCount": 0,
  "claimableChannels": ["sms", "whatsapp"]
}
```

```
GET /api/conversations/stats
```

**Auth:** Required

**Response:**

```json
{ "total": 0, "active": 0, "waiting": 0, "closed": 0 }
```

```
GET /api/conversations/load
```

**Permission:** `conversations:read-all`. Soo celiyaa per-volunteer conversation counts.

```
GET /api/conversations/:id
```

**Auth:** Required (access-checked per conversation).

```
GET /api/conversations/:id/messages?page=1&limit=50
```

**Auth:** Required (access-checked). Soo celiyaa encrypted messages.

```
POST /api/conversations/:id/messages
```

**Permission:** `conversations:send` ama `conversations:send-any`

**Body:**

```json
{
  "encryptedContent": "hex",
  "readerEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }],
  "plaintextForSending": "Hello"
}
```

`plaintextForSending` field waxaa loo isticmaalaa external channels (SMS, WhatsApp, Signal). Server-ka wuxuu soo dirayaa message via channel adapter kadibna wuu tirtirayaa plaintext.

```
PATCH /api/conversations/:id
```

**Permission:** `conversations:update` ama assigned volunteer

**Body:**

```json
{ "status": "closed", "assignedTo": "hex64" }
```

```
POST /api/conversations/:id/claim
```

**Permission:** `conversations:claim` + channel-specific (e.g., `conversations:claim-sms`)

Hub-scoped: `/api/hubs/:hubId/conversations/*`

---

## Reports

Reports waa nooc gaar ah oo conversation ah with `metadata.type = "report"`.

```
GET /api/reports?status=&category=&page=1&limit=50
```

**Permission:** `reports:read-all`, `reports:read-assigned`, ama `reports:read-own`

```
POST /api/reports
```

**Permission:** `reports:create`

**Body:**

```json
{
  "title": "Report title",
  "category": "safety",
  "encryptedContent": "hex",
  "readerEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }]
}
```

```
GET /api/reports/:id
```

**Permission:** `reports:read-all`, `reports:read-assigned`, ama own report

```
GET /api/reports/:id/messages?page=1&limit=100
```

**Auth:** Required (access-checked)

```
POST /api/reports/:id/messages
```

**Permission:** `reports:send-message`, `reports:send-message-own`, ama assigned

**Body:**

```json
{
  "encryptedContent": "hex",
  "readerEnvelopes": [],
  "attachmentIds": ["uuid"]
}
```

```
POST /api/reports/:id/assign
```

**Permission:** `reports:assign`

**Body:**

```json
{ "assignedTo": "hex64" }
```

```
PATCH /api/reports/:id
```

**Permission:** `reports:update`

```
GET /api/reports/categories
```

**Auth:** Required

```
GET /api/reports/:id/files
```

**Auth:** Required (access-checked)

Hub-scoped: `/api/hubs/:hubId/reports/*`

---

## Bans

```
POST /api/bans
```

**Permission:** `bans:report`

**Body:**

```json
{ "phone": "+1234567890", "reason": "Spam caller" }
```

```
GET /api/bans
```

**Permission:** `bans:read`

```
POST /api/bans/bulk
```

**Permission:** `bans:bulk-create`

**Body:**

```json
{ "phones": ["+1234567890", "+0987654321"], "reason": "Imported ban list" }
```

```
DELETE /api/bans/:phone
```

**Permission:** `bans:delete`

`:phone` parameter waa URL-encoded E.164 (e.g., `%2B12125551234`).

Hub-scoped: `/api/hubs/:hubId/bans/*`

---

## Settings

### Telephony provider

```
GET /api/settings/telephony-provider
```

**Permission:** `settings:manage-telephony`

```
PATCH /api/settings/telephony-provider
```

**Permission:** `settings:manage-telephony`

**Body:** `TelephonyProviderConfig` (provider type + credentials)

```
POST /api/settings/telephony-provider/test
```

**Permission:** `settings:manage-telephony`

Tests provider credentials badal la'aan saving.

### Messaging

```
GET /api/settings/messaging
```

**Permission:** `settings:manage-messaging`

```
PATCH /api/settings/messaging
```

**Permission:** `settings:manage-messaging`

### Spam mitigation

```
GET /api/settings/spam
```

**Permission:** `settings:manage-spam`

```
PATCH /api/settings/spam
```

**Permission:** `settings:manage-spam`

### Call settings

```
GET /api/settings/call
```

**Permission:** `settings:manage`

```
PATCH /api/settings/call
```

**Permission:** `settings:manage`

### IVR languages

```
GET /api/settings/ivr-languages
```

**Permission:** `settings:manage-ivr`

```
PATCH /api/settings/ivr-languages
```

**Permission:** `settings:manage-ivr`

**Body:**

```json
{ "enabledLanguages": ["en", "es", "zh"] }
```

### IVR audio

```
GET /api/settings/ivr-audio
```

**Permission:** `settings:manage-ivr`

```
PUT /api/settings/ivr-audio/:promptType/:language
```

**Permission:** `settings:manage-ivr`
**Content-Type:** `application/octet-stream` (raw audio bytes)

```
DELETE /api/settings/ivr-audio/:promptType/:language
```

**Permission:** `settings:manage-ivr`

### Transcription

```
GET /api/settings/transcription
```

**Auth:** Required (any role)

**Response:**

```json
{ "globalEnabled": true, "allowVolunteerOptOut": false }
```

```
PATCH /api/settings/transcription
```

**Permission:** `settings:manage-transcription`

### Custom fields

```
GET /api/settings/custom-fields
```

**Auth:** Required (soo celiyaa fields filtered by role)

```
PUT /api/settings/custom-fields
```

**Permission:** `settings:manage-fields`

**Body:**

```json
{ "fields": [{ "id": "uuid", "name": "severity", "label": "Severity Rating", "type": "select", "required": true, "options": ["low", "medium", "high"], "visibleToVolunteers": true, "editableByVolunteers": true, "context": "call-notes", "order": 0 }] }
```

### WebAuthn settings

```
GET /api/settings/webauthn
```

**Permission:** `settings:manage`

```
PATCH /api/settings/webauthn
```

**Permission:** `settings:manage`

**Body:**

```json
{ "requireForAdmins": true, "requireForVolunteers": false }
```

### Roles (PBAC)

```
GET /api/settings/roles
```

**Auth:** Required

```
POST /api/settings/roles
```

**Permission:** `system:manage-roles`

**Body:**

```json
{
  "name": "Supervisor",
  "slug": "supervisor",
  "permissions": ["notes:read-all", "calls:read-history"],
  "description": "Can read all notes and call history"
}
```

```
PATCH /api/settings/roles/:id
```

**Permission:** `system:manage-roles`

```
DELETE /api/settings/roles/:id
```

**Permission:** `system:manage-roles`

### Permissions catalog

```
GET /api/settings/permissions
```

**Permission:** `system:manage-roles`

Soo celiyaa dhammaan permissions la heli karo organized by domain.

### Setup state

```
GET /api/settings/setup
```

**Permission:** `settings:manage`

```
PATCH /api/settings/setup
```

**Permission:** `settings:manage`

---

## Files

### Upload flow

Chunked upload for encrypted file attachments.

```
POST /api/uploads/init
```

**Permission:** `files:upload`

**Body:**

```json
{
  "totalSize": 1048576,
  "totalChunks": 4,
  "conversationId": "uuid",
  "recipientEnvelopes": [],
  "encryptedMetadata": [{ "pubkey": "hex64", "encryptedContent": "hex", "ephemeralPubkey": "hex" }]
}
```

**Response:**

```json
{ "uploadId": "uuid", "totalChunks": 4 }
```

```
PUT /api/uploads/:id/chunks/:chunkIndex
```

**Permission:** `files:upload`
**Content-Type:** `application/octet-stream` (raw encrypted chunk bytes)

**Response:**

```json
{ "chunkIndex": 0, "completedChunks": 1, "totalChunks": 4 }
```

```
POST /api/uploads/:id/complete
```

**Permission:** `files:upload`

**Response:**

```json
{ "fileId": "uuid", "status": "complete" }
```

Soo celiyaa `400` haddii aan dhammaan chunks la upload-gareyn.

```
GET /api/uploads/:id/status
```

**Permission:** `files:upload`

### Download

```
GET /api/files/:id/content
```

**Permission:** `files:download-own` (haddii recipient) ama `files:download-all`

**Response:** `application/octet-stream` (encrypted file bytes)

```
GET /api/files/:id/envelopes
```

**Permission:** `files:download-own` ama `files:download-all`

Non-admin users waxay heshaa kaliya their own envelope.

```
GET /api/files/:id/metadata
```

**Permission:** `files:download-own` ama `files:download-all`

```
POST /api/files/:id/share
```

**Permission:** `files:share`

Re-encrypts file key for a new recipient.

---

## Blasts (message broadcasting)

### Subscribers

```
GET /api/blasts/subscribers?page=&limit=&tag=&status=
```

**Auth:** Required

```
DELETE /api/blasts/subscribers/:id
```

**Auth:** Required

```
GET /api/blasts/subscribers/stats
```

**Auth:** Required

```
POST /api/blasts/subscribers/import
```

**Auth:** Required

**Body:**

```json
{ "subscribers": [{ "phone": "+1234567890", "tags": ["alerts"] }] }
```

### Blasts

```
GET /api/blasts
```

**Auth:** Required

```
POST /api/blasts
```

**Auth:** Required

**Body:**

```json
{
  "name": "Emergency alert",
  "content": { "sms": "Alert text", "whatsapp": "Alert text" },
  "targetChannels": ["sms", "whatsapp"],
  "targetTags": ["alerts"],
  "targetLanguages": ["en", "es"]
}
```

```
GET /api/blasts/:id
```

**Auth:** Required

```
PATCH /api/blasts/:id
```

**Auth:** Required

```
DELETE /api/blasts/:id
```

**Auth:** Required

```
POST /api/blasts/:id/send
```

**Auth:** Required. Soo dirayaa blast-ka si toos ah.

```
POST /api/blasts/:id/schedule
```

**Auth:** Required

**Body:**

```json
{ "scheduledAt": "2026-03-01T12:00:00Z" }
```

```
POST /api/blasts/:id/cancel
```

**Auth:** Required. Cancels a scheduled blast.

### Blast settings

```
GET /api/blasts/settings
```

**Auth:** Required

```
PATCH /api/blasts/settings
```

**Auth:** Required

Hub-scoped: `/api/hubs/:hubId/blasts/*`

---

## Hubs

Multi-tenant hub management.

```
GET /api/hubs
```

**Auth:** Required (filtered by membership; super admin arkaa dhammaan)

```
POST /api/hubs
```

**Permission:** `system:manage-hubs`

**Body:**

```json
{ "name": "NYC Hub", "slug": "nyc", "description": "New York City operations", "phoneNumber": "+1234567890" }
```

```
GET /api/hubs/:hubId
```

**Auth:** Required (membership checked)

```
PATCH /api/hubs/:hubId
```

**Permission:** `system:manage-hubs`

### Hub members

```
POST /api/hubs/:hubId/members
```

**Permission:** `volunteers:manage-roles`

**Body:**

```json
{ "pubkey": "hex64", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/hubs/:hubId/members/:pubkey
```

**Permission:** `volunteers:manage-roles`

### Hub key management

```
GET /api/hubs/:hubId/key
```

**Auth:** Required (hub member). Soo celiyaa kaliya requesting user's ECIES-wrapped hub key envelope.

```
PUT /api/hubs/:hubId/key
```

**Permission:** `system:manage-hubs`

**Body:**

```json
{ "envelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }] }
```

---

## Setup wizard

```
GET /api/setup/state
```

**Auth:** Required

```
PATCH /api/setup/state
```

**Permission:** `settings:manage`

```
POST /api/setup/complete
```

**Permission:** `settings:manage`

**Body:**

```json
{}
```

Sidoo kale creates a default hub haddii aan jirin.

### Channel tests

```
POST /api/setup/test/signal
```

**Permission:** `settings:manage-messaging`

**Body:**

```json
{ "bridgeUrl": "http://signal-cli:8080", "bridgeApiKey": "secret" }
```

```
POST /api/setup/test/whatsapp
```

**Permission:** `settings:manage-messaging`

**Body:**

```json
{ "phoneNumberId": "123456", "accessToken": "EAAx..." }
```

---

## Audit log

```
GET /api/audit?page=1&limit=50&actorPubkey=&eventType=&dateFrom=&dateTo=&search=
```

**Permission:** `audit:read`

**Response:**

```json
{
  "entries": [{
    "id": "uuid",
    "event": "note.created",
    "actorPubkey": "hex64",
    "details": {},
    "createdAt": "2026-01-01T00:00:00Z",
    "previousEntryHash": "hex64",
    "entryHash": "hex64"
  }],
  "total": 100
}
```

Audit log-ga waxa uu isticmaalaa SHA-256 hash chain (`previousEntryHash` + `entryHash`) for tamper detection.

Hub-scoped: `/api/hubs/:hubId/audit/*`

---

## WebRTC

```
GET /api/telephony/webrtc-token
```

**Auth:** Required

Soo celiyaa provider-specific WebRTC token for in-browser call answering.

**Response:**

```json
{ "token": "string", "provider": "twilio", "identity": "hex64" }
```

Soo celiyaa `400` haddii call preference la set gareeyay to phone kaliya.

```
GET /api/telephony/webrtc-status
```

**Auth:** Required

**Response:**

```json
{ "available": true, "provider": "twilio" }
```

---

## Device provisioning

For linking new devices to an existing account via ephemeral ECDH key exchange.

```
POST /api/provision/rooms
```

**Auth:** None (new device ma leh auth)

**Body:**

```json
{ "ephemeralPubkey": "hex66" }
```

**Response:**

```json
{ "roomId": "uuid", "token": "random_string" }
```

```
GET /api/provision/rooms/:id?token=<token>
```

**Auth:** None

**Response:**

```json
{
  "status": "waiting",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64",
  "ephemeralPubkey": "hex66"
}
```

Status transitions: `waiting` -> `ready` -> consumed. Rooms expire kadib ~5 minutes.

```
POST /api/provision/rooms/:id/payload
```

**Auth:** Required (primary device waa inuu authenticated yahay)

**Body:**

```json
{
  "token": "string",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64"
}
```

---

## Push notifications (mobile)

```
POST /api/devices/register
```

**Auth:** Required

**Body:**

```json
{
  "platform": "ios",
  "pushToken": "apns_device_token",
  "voipToken": "ios_voip_push_token",
  "wakeKeyEnvelope": { "wrappedKey": "hex", "ephemeralPubkey": "hex" }
}
```

**Response:**

```json
{ "deviceId": "uuid" }
```

Push notifications waxay isticmaalaan two-tier encryption scheme: wake key (ma u baahnato PIN) for notification metadata, iyo identity key (PIN required) for sensitive content.

---

## Telephony webhooks

Endpoint-yadan waxaa soo wacaa telephony providers, ma aha clients. Each request waxaa validate gareeyaa by provider's webhook signature.

```
POST /api/telephony/incoming
POST /api/telephony/language-selected
POST /api/telephony/captcha
POST /api/telephony/volunteer-answer
POST /api/telephony/call-status
POST /api/telephony/wait-music          (sidoo kale GET)
POST /api/telephony/queue-exit
POST /api/telephony/voicemail-complete
POST /api/telephony/call-recording
POST /api/telephony/voicemail-recording
```

Hub routing waxaa lagu sameeyaa via `?hub=<hubId>` query parameter.

---

## Messaging webhooks

Waxaa soo wacaa messaging providers. Each adapter waxay validate gareysaa webhook signature-ka.

```
GET  /api/messaging/whatsapp/webhook    (Meta webhook verification)
GET  /api/messaging/rcs/webhook         (Google RBM webhook verification)
POST /api/messaging/:channel/webhook?hub=<hubId>
```

Channels la taageero: `sms`, `whatsapp`, `signal`, `rcs`.

---

## Hub-scoped routes

Dhammaan routes-ka soo socda waxay sidoo kale la heli karaan with `/api/hubs/:hubId/` prefix, taasoo scope gareysa to a specific hub:

- `/api/hubs/:hubId/shifts/*`
- `/api/hubs/:hubId/bans/*`
- `/api/hubs/:hubId/notes/*`
- `/api/hubs/:hubId/calls/*`
- `/api/hubs/:hubId/audit/*`
- `/api/hubs/:hubId/conversations/*`
- `/api/hubs/:hubId/reports/*`
- `/api/hubs/:hubId/blasts/*`

Marka la isticmaalayo hub-scoped routes, `hubContext` middleware waxay resolve gareysaa hub-specific permissions for user.

---

## Error responses

Dhammaan error responses waxay raacayaan format-kan:

```json
{ "error": "Human-readable error message" }
```

Common HTTP status codes:

| Code | Macnaha |
|------|---------|
| `400` | Bad request (malformed body, missing fields, validation failure) |
| `401` | Unauthorized (missing ama invalid auth token) |
| `403` | Forbidden (valid auth laakiin permissions insufficient) |
| `404` | Not found |
| `409` | Conflict (e.g., call already answered, resource already exists) |
| `429` | Too many requests (rate limited) |
| `500` | Internal server error |

---

## Permission reference

Permissions waxay raacayaan `domain:action` format. Users waxay leeyihiin roles, iyo each role waxay bundle gareysaa set of permissions. Effective permissions waxay ahaan karaan union of all assigned roles.

Wildcard `*` grants dhammaan permissions. Domain wildcard `domain:*` grants dhammaan actions in domain-kaas.

| Domain | Permissions |
|--------|-------------|
| **calls** | `answer`, `read-active`, `read-active-full`, `read-history`, `read-presence`, `read-recording`, `debug` |
| **notes** | `create`, `read-own`, `read-all`, `read-assigned`, `update-own` |
| **reports** | `create`, `read-own`, `read-all`, `read-assigned`, `assign`, `update`, `send-message-own`, `send-message` |
| **conversations** | `read-assigned`, `read-all`, `claim`, `claim-sms`, `claim-whatsapp`, `claim-signal`, `claim-rcs`, `claim-web`, `claim-any`, `send`, `send-any`, `update` |
| **volunteers** | `read`, `create`, `update`, `delete`, `manage-roles` |
| **shifts** | `read-own`, `read`, `create`, `update`, `delete`, `manage-fallback` |
| **bans** | `report`, `read`, `create`, `bulk-create`, `delete` |
| **invites** | `read`, `create`, `revoke` |
| **settings** | `read`, `manage`, `manage-telephony`, `manage-messaging`, `manage-spam`, `manage-ivr`, `manage-fields`, `manage-transcription` |
| **audit** | `read` |
| **blasts** | `read`, `send`, `manage`, `schedule` |
| **files** | `upload`, `download-own`, `download-all`, `share` |
| **system** | `manage-roles`, `manage-hubs`, `manage-instance` |

### Default roles

| Role | Slug | Key permissions |
|------|------|-----------------|
| **Super Admin** | `role-super-admin` | `*` (dhammaan permissions) |
| **Hub Admin** | `role-hub-admin` | `volunteers:*`, `shifts:*`, `settings:*`, `audit:read`, `bans:*`, `invites:*`, `notes:read-all`, `reports:*`, `conversations:*`, `calls:*`, `blasts:*`, `files:*` |
| **Reviewer** | `role-reviewer` | `notes:read-assigned`, `reports:read-assigned`, `reports:assign`, `reports:update`, `conversations:read-assigned`, `conversations:send`, `files:download-own`, `files:upload` |
| **Volunteer** | `role-volunteer` | `calls:answer`, `calls:read-active`, `notes:create`, `notes:read-own`, `notes:update-own`, `conversations:claim`, `conversations:send`, `conversations:read-assigned`, `bans:report`, `files:upload`, `files:download-own` |
| **Reporter** | `role-reporter` | `reports:create`, `reports:read-own`, `reports:send-message-own`, `files:upload`, `files:download-own` |

---

## Development / test endpoints

Available kaliya in development environments.

```
POST /api/test-reset            (full reset, requires X-Test-Secret header)
POST /api/test-reset-no-admin   (reset without admin)
POST /api/test-reset-records    (light reset, preserves identity/settings)
```
