---
title: API Reference
description: Complete REST API endpoint reference for the Llamenos server.
---

This document describes every REST API endpoint exposed by the Llamenos server. All endpoints are prefixed with `/api`. Requests and responses use JSON unless otherwise noted. All timestamps are ISO 8601 strings.

The API is the same whether the backend runs on **Cloudflare Workers** (with Durable Objects) or **self-hosted** (Node.js + PostgreSQL). The six Durable Objects — Identity, Settings, Records, ShiftManager, CallRouter, and Conversation — map to logical API domains described below.

## Authentication

Llamenos supports two authentication mechanisms. All authenticated endpoints require one of these.

### Schnorr signature auth (primary)

Every authenticated request carries a self-signed BIP-340 Schnorr token bound to the HTTP method and path.

**Header format:**

```
Authorization: Bearer {"pubkey":"<64_hex>","timestamp":<ms>,"token":"<128_hex>"}
```

**Token construction:**

1. Build the message: `llamenos:auth:<pubkey>:<timestamp_ms>:<METHOD>:<path>`
2. Hash with SHA-256
3. Sign the hash with BIP-340 Schnorr using your secp256k1 secret key
4. Encode as inline JSON with `pubkey`, `timestamp`, and `token` (hex signature) fields

**Validation rules:**

- Token freshness: `|now() - timestamp| <= 300,000 ms` (5-minute window)
- Signature is verified against the reconstructed message hash
- The pubkey is looked up in the identity store to resolve the user record

### Session token auth (WebAuthn)

After a WebAuthn authentication ceremony, the server issues a random 256-bit session token valid for 8 hours.

```
Authorization: Session <token_hex>
```

The server checks `Session` auth first. If the header starts with `Session `, Schnorr auth is not attempted, and vice versa.

---

## Public endpoints

These endpoints require no authentication.

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

Returns public hub configuration, enabled channels, and server identity.

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

Returns build metadata for reproducible build verification.

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

Returns audio files fetched by telephony providers during calls.

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

Rate limited: 10 attempts per IP. Returns `401` on invalid credentials.

### Bootstrap (first admin)

```
POST /api/auth/bootstrap
```

Registers the first admin account. Fails with `403` if an admin already exists.

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

**Auth:** Required. If using Session auth, the token is revoked server-side.

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

All fields are optional. `callPreference` accepts `"phone"`, `"browser"`, or `"both"`.

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

Returns `403` if opt-out is not allowed by admin settings.

---

## WebAuthn

### Login flow

```
POST /api/webauthn/login/options
```

**Auth:** None. Returns `publicKeyCredentialRequestOptions` with a `challengeId`.

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

**Auth:** Required. Returns all registered credentials.

```
DELETE /api/webauthn/credentials/:credId
```

**Auth:** Required. Removes a credential.

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

All volunteer endpoints require `volunteers:read` as a baseline permission.

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

**Auth:** Required (any role). Returns the current user's shift status.

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

Hub-scoped: All shift endpoints are also available at `/api/hubs/:hubId/shifts/*`.

---

## Notes

All note endpoints require `notes:read-own` as a baseline. Clients must encrypt notes before sending (see the [protocol specification](https://github.com/rhonda-rodododo/llamenos-platform/blob/main/docs/protocol/PROTOCOL.md) for ECIES envelope format).

```
GET /api/notes?callId=...&page=1&limit=50
```

**Permission:** `notes:read-own` (own only) or `notes:read-all` (all notes)

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

**Body:** Same shape as POST (with updated encrypted content and envelopes).

Hub-scoped: `/api/hubs/:hubId/notes/*`

---

## Calls

```
GET /api/calls/active
```

**Permission:** `calls:read-active` (caller info redacted) or `calls:read-active-full`

```
GET /api/calls/today-count
```

**Permission:** `calls:read-active`

```
GET /api/calls/presence
```

**Permission:** `calls:read-presence`. Returns volunteer online/busy status.

```
GET /api/calls/history?page=1&limit=50&search=&dateFrom=&dateTo=
```

**Permission:** `calls:read-history`

```
POST /api/calls/:callId/answer
```

**Permission:** `calls:answer`. Returns `409` if the call was already answered.

```
POST /api/calls/:callId/hangup
```

**Permission:** `calls:answer`. Returns `403` if not your call.

```
POST /api/calls/:callId/spam
```

**Permission:** `calls:answer`. Flags the call as spam.

```
GET /api/calls/:callId/recording
```

**Permission:** `calls:read-recording` or answering volunteer.

**Response:** `audio/wav` binary with `Cache-Control: private, no-store`.

```
GET /api/calls/debug
```

**Permission:** `calls:debug`. Returns internal call state for troubleshooting.

Hub-scoped: `/api/hubs/:hubId/calls/*`

---

## Conversations

```
GET /api/conversations?status=&channel=&page=1&limit=50
```

**Permission:** `conversations:read-all` or `conversations:read-assigned` (own + waiting)

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

**Permission:** `conversations:read-all`. Returns per-volunteer conversation counts.

```
GET /api/conversations/:id
```

**Auth:** Required (access-checked per conversation).

```
GET /api/conversations/:id/messages?page=1&limit=50
```

**Auth:** Required (access-checked). Returns encrypted messages.

```
POST /api/conversations/:id/messages
```

**Permission:** `conversations:send` or `conversations:send-any`

**Body:**

```json
{
  "encryptedContent": "hex",
  "readerEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }],
  "plaintextForSending": "Hello"
}
```

The `plaintextForSending` field is used for external channels (SMS, WhatsApp, Signal). The server sends the message via the channel adapter and then discards the plaintext.

```
PATCH /api/conversations/:id
```

**Permission:** `conversations:update` or assigned volunteer

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

Reports are a specialized type of conversation with `metadata.type = "report"`.

```
GET /api/reports?status=&category=&page=1&limit=50
```

**Permission:** `reports:read-all`, `reports:read-assigned`, or `reports:read-own`

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

**Permission:** `reports:read-all`, `reports:read-assigned`, or own report

```
GET /api/reports/:id/messages?page=1&limit=100
```

**Auth:** Required (access-checked)

```
POST /api/reports/:id/messages
```

**Permission:** `reports:send-message`, `reports:send-message-own`, or assigned

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

The `:phone` parameter is URL-encoded E.164 (e.g., `%2B12125551234`).

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

Tests provider credentials without saving.

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

**Auth:** Required (returns fields filtered by role)

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

Returns all available permissions organized by domain.

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

Returns `400` if not all chunks have been uploaded.

```
GET /api/uploads/:id/status
```

**Permission:** `files:upload`

### Download

```
GET /api/files/:id/content
```

**Permission:** `files:download-own` (if recipient) or `files:download-all`

**Response:** `application/octet-stream` (encrypted file bytes)

```
GET /api/files/:id/envelopes
```

**Permission:** `files:download-own` or `files:download-all`

Non-admin users receive only their own envelope.

```
GET /api/files/:id/metadata
```

**Permission:** `files:download-own` or `files:download-all`

```
POST /api/files/:id/share
```

**Permission:** `files:share`

Re-encrypts the file key for a new recipient.

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

**Auth:** Required. Sends the blast immediately.

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

**Auth:** Required (filtered by membership; super admin sees all)

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

**Auth:** Required (hub member). Returns only the requesting user's ECIES-wrapped hub key envelope.

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

Also creates a default hub if none exists.

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

The audit log uses a SHA-256 hash chain (`previousEntryHash` + `entryHash`) for tamper detection.

Hub-scoped: `/api/hubs/:hubId/audit/*`

---

## WebRTC

```
GET /api/telephony/webrtc-token
```

**Auth:** Required

Returns a provider-specific WebRTC token for in-browser call answering.

**Response:**

```json
{ "token": "string", "provider": "twilio", "identity": "hex64" }
```

Returns `400` if call preference is set to phone only.

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

**Auth:** None (new device has no auth)

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

Status transitions: `waiting` -> `ready` -> consumed. Rooms expire after ~5 minutes.

```
POST /api/provision/rooms/:id/payload
```

**Auth:** Required (primary device must be authenticated)

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

Push notifications use a two-tier encryption scheme: a wake key (no PIN required) for notification metadata, and the identity key (PIN required) for sensitive content.

---

## Telephony webhooks

These endpoints are called by telephony providers, not by clients. Each request is validated by the provider's webhook signature.

```
POST /api/telephony/incoming
POST /api/telephony/language-selected
POST /api/telephony/captcha
POST /api/telephony/volunteer-answer
POST /api/telephony/call-status
POST /api/telephony/wait-music          (also GET)
POST /api/telephony/queue-exit
POST /api/telephony/voicemail-complete
POST /api/telephony/call-recording
POST /api/telephony/voicemail-recording
```

Hub routing is via the `?hub=<hubId>` query parameter.

---

## Messaging webhooks

Called by messaging providers. Each adapter validates its own webhook signature.

```
GET  /api/messaging/whatsapp/webhook    (Meta webhook verification)
GET  /api/messaging/rcs/webhook         (Google RBM webhook verification)
POST /api/messaging/:channel/webhook?hub=<hubId>
```

Supported channels: `sms`, `whatsapp`, `signal`, `rcs`.

---

## Hub-scoped routes

All of the following routes are also available with a `/api/hubs/:hubId/` prefix, which scopes them to a specific hub:

- `/api/hubs/:hubId/shifts/*`
- `/api/hubs/:hubId/bans/*`
- `/api/hubs/:hubId/notes/*`
- `/api/hubs/:hubId/calls/*`
- `/api/hubs/:hubId/audit/*`
- `/api/hubs/:hubId/conversations/*`
- `/api/hubs/:hubId/reports/*`
- `/api/hubs/:hubId/blasts/*`

When using hub-scoped routes, the `hubContext` middleware resolves hub-specific permissions for the user.

---

## Error responses

All error responses follow this format:

```json
{ "error": "Human-readable error message" }
```

Common HTTP status codes:

| Code | Meaning |
|------|---------|
| `400` | Bad request (malformed body, missing fields, validation failure) |
| `401` | Unauthorized (missing or invalid auth token) |
| `403` | Forbidden (valid auth but insufficient permissions) |
| `404` | Not found |
| `409` | Conflict (e.g., call already answered, resource already exists) |
| `429` | Too many requests (rate limited) |
| `500` | Internal server error |

---

## Permission reference

Permissions follow the `domain:action` format. Users are assigned roles, and each role bundles a set of permissions. Effective permissions are the union of all assigned roles.

Wildcard `*` grants all permissions. Domain wildcard `domain:*` grants all actions in that domain.

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
| **Super Admin** | `role-super-admin` | `*` (all permissions) |
| **Hub Admin** | `role-hub-admin` | `volunteers:*`, `shifts:*`, `settings:*`, `audit:read`, `bans:*`, `invites:*`, `notes:read-all`, `reports:*`, `conversations:*`, `calls:*`, `blasts:*`, `files:*` |
| **Reviewer** | `role-reviewer` | `notes:read-assigned`, `reports:read-assigned`, `reports:assign`, `reports:update`, `conversations:read-assigned`, `conversations:send`, `files:download-own`, `files:upload` |
| **Volunteer** | `role-volunteer` | `calls:answer`, `calls:read-active`, `notes:create`, `notes:read-own`, `notes:update-own`, `conversations:claim`, `conversations:send`, `conversations:read-assigned`, `bans:report`, `files:upload`, `files:download-own` |
| **Reporter** | `role-reporter` | `reports:create`, `reports:read-own`, `reports:send-message-own`, `files:upload`, `files:download-own` |

---

## Development / test endpoints

Available only in development environments.

```
POST /api/test-reset            (full reset, requires X-Test-Secret header)
POST /api/test-reset-no-admin   (reset without admin)
POST /api/test-reset-records    (light reset, preserves identity/settings)
```
