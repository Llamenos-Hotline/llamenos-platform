---
title: API Reference
description: ለLlamenos ሰርቨር የተሟላ REST API endpoint reference።
---

ይህ ሰነድ በLlamenos ሰርቨር የተጋለጡትን ሁሉንም REST API endpoints ይገልጻል። ሁሉም endpoints በ`/api` ቅድመ ቅጥያ አላቸው። ጥያቄዎች እና ምላሾች ካልተለየ በስተቀር JSON ይጠቀማሉ። ሁሉም timestamps ISO 8601 strings ናቸው።

API በ**Cloudflare Workers** (ከDurable Objects ጋር) ወይም **ራስ-አስተናጋጅ** (Node.js + PostgreSQL) ላይ ቢሰራ ተመሳሳይ ነው። ስድስቱ Durable Objects — Identity፣ Settings፣ Records፣ ShiftManager፣ CallRouter፣ እና Conversation — ከታች የተገለጹትን የሎጂካል API domains ያመሳስላሉ።

## Authentication

Llamenos ሁለት authentication mechanisms ይደግፋል። ሁሉም የተረጋገጡ endpoints ከነዚህ አንዱ ያስፈልጋል።

### Schnorr signature auth (ዋና)

እያንዳንዱ የተረጋገጠ ጥያቄ ለHTTP method እና path የተገደበ self-signed BIP-340 Schnorr token ይዟል።

**Header format:**

```
Authorization: Bearer {"pubkey":"<64_hex>","timestamp":<ms>,"token":"<128_hex>"}
```

**Token construction:**

1. መልእክት ይስሩ፦ `llamenos:auth:<pubkey>:<timestamp_ms>:<METHOD>:<path>`
2. በSHA-256 hash ያድርጉ
3. በsecp256k1 secret key BIP-340 Schnorr ያስፈርሙ
4. እንደ inline JSON ከ`pubkey`፣ `timestamp`፣ እና `token` (hex signature) fields ያኮድ ያድርጉ

**Validation rules:**

- Token freshness፦ `|now() - timestamp| <= 300,000 ms` (5-ደቂቃ መስኮት)
- ፊርማ ከተመሳሰለው መልእክት hash ጋር ይረጋገጣል
- Pubkey በidentity store ውስጥ ተመልክቶ የተጠቃሚ መዝገብ ይፈታል

### Session token auth (WebAuthn)

ከWebAuthn authentication ceremony በኋላ፣ ሰርቨር random 256-bit session token ለ8 ሰዓታት ያስታውሳል።

```
Authorization: Session <token_hex>
```

ሰርቨሩ `Session` auth መጀመሪያ ይፈትሻል። Header ከ`Session ` ከጀመረ፣ Schnorr auth አይሞክርም፣ እና vice versa።

---

## Public endpoints

እነዚህ endpoints ምንም authentication አያስፈልጋቸውም።

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

የይፋዊ hub configuration፣ የተንቀሳቀሱ ሰርጦች፣ እና የሰርቨር ማንነት ይመልሳል።

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

ለreproducible build verification build metadata ይመልሳል።

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

በጥሪ ወቅት በስልክ አቅራቢዎች የሚወሰዱ ኦዲዮ ፋይሎችን ይመልሳል።

- `promptType`: `[a-z_-]+`
- `language`: `[a-z]{2,5}(-[A-Z]{2})?`
- **Response:** `audio/wav` binary

### Messaging preferences

ለsubscriber preference management token-የተረጋገጡ የይፋዊ endpoints።

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

Rate limited: በIP 10 ሙከራዎች። `401` ከልክለኛ መረጃዎች።

### Bootstrap (መጀመሪያ አስተዳዳሪ)

```
POST /api/auth/bootstrap
```

መጀመሪያ አስተዳዳሪ መለያ ይመዝገባል። ከአስተዳዳሪ ቀድሞ ካለ `403` ይመልሳል።

**Body:** Login ጋር ተመሳሳይ
**Response:** Login ጋር ተመሳሳይ
Rate limited: በIP 5 ሙከራዎች።

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

**Auth:** Required። Session auth ከሆነ፣ token በሰርቨር ጎን ይሰረዛል።

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

ሁሉም fields አማራጭ ናቸው። `callPreference` `"phone"`፣ `"browser"`፣ ወይም `"both"` ይቀበላል።

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

`403` ይመልሳል ከአስተዳዳሪ ቅንጅቶች opt-out ካልተፈቀደ።

---

## WebAuthn

### Login flow

```
POST /api/webauthn/login/options
```

**Auth:** None። `publicKeyCredentialRequestOptions` ከ`challengeId` ጋር ይመልሳል።

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

**Auth:** Required። ሁሉንም የተመዘገቡ credentials ይመልሳል።

```
DELETE /api/webauthn/credentials/:credId
```

**Auth:** Required። credential ያስወግዳል።

---

## Invites

### Public

```
GET /api/invites/validate/:code
```

Rate limited: በIP 5 ሙከራዎች።

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

Rate limited: በIP 5 ሙከራዎች።

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

ሁሉም volunteer endpoints `volunteers:read` እንደ baseline permission ይጠይቃሉ።

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

**Body:** Partial volunteer fields (`name`፣ `phone`፣ `roles`፣ `active`፣ ወዘተ)

```
DELETE /api/volunteers/:targetPubkey
```

**Permission:** `volunteers:delete`

---

## Shifts

```
GET /api/shifts/my-status
```

**Auth:** Required (ማንኛውም ሚና)። የአሁኑ ተጠቃሚ shift ሁኔታ ይመልሳል።

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

Hub-scoped: ሁሉም shift endpoints በ`/api/hubs/:hubId/shifts/*` ላይ ይገኛሉ።

---

## Notes

ሁሉም note endpoints `notes:read-own` እንደ baseline ይጠይቃሉ። Clients notes ከመላክ በፊት መመስጠን አለባቸው (ECIES envelope format ለማየት [protocol specification](https://github.com/rhonda-rodododo/llamenos-platform/blob/main/docs/protocol/PROTOCOL.md) ይመልከቱ)።

```
GET /api/notes?callId=...&page=1&limit=50
```

**Permission:** `notes:read-own` (የራስ ብቻ) ወይም `notes:read-all` (ሁሉም notes)

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

**Body:** POST ጋር ተመሳሳይ ቅርጸት (የተዘመነ encrypted content እና envelopes ጋር)።

Hub-scoped: `/api/hubs/:hubId/notes/*`

---

## Calls

```
GET /api/calls/active
```

**Permission:** `calls:read-active` (caller info redacted) ወይም `calls:read-active-full`

```
GET /api/calls/today-count
```

**Permission:** `calls:read-active`

```
GET /api/calls/presence
```

**Permission:** `calls:read-presence`። የበጎ ፈቃደኛ online/busy ሁኔታ ይመልሳል።

```
GET /api/calls/history?page=1&limit=50&search=&dateFrom=&dateTo=
```

**Permission:** `calls:read-history`

```
POST /api/calls/:callId/answer
```

**Permission:** `calls:answer`። ከቀድሞ የተመለሰ ከሆነ `409` ይመልሳል።

```
POST /api/calls/:callId/hangup
```

**Permission:** `calls:answer`። የእርስዎ ጥሪ ካልሆነ `403`።

```
POST /api/calls/:callId/spam
```

**Permission:** `calls:answer`። ጥሪውን እንደ spam ያመለክታል።

```
GET /api/calls/:callId/recording
```

**Permission:** `calls:read-recording` ወይም የመለሰው በጎ ፈቃደኛ።

**Response:** `audio/wav` binary ከ`Cache-Control: private, no-store`።

```
GET /api/calls/debug
```

**Permission:** `calls:debug`። ለtroubleshooting ውስጣዊ ጥሪ ሁኔታ ይመልሳል።

Hub-scoped: `/api/hubs/:hubId/calls/*`

---

## Conversations

```
GET /api/conversations?status=&channel=&page=1&limit=50
```

**Permission:** `conversations:read-all` ወይም `conversations:read-assigned` (የራስ + የሚጠባበቁ)

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

**Permission:** `conversations:read-all`። በበጎ ፈቃደኛ የconversation ብዛቶችን ይመልሳል።

```
GET /api/conversations/:id
```

**Auth:** Required (per conversation access-checked)።

```
GET /api/conversations/:id/messages?page=1&limit=50
```

**Auth:** Required (access-checked)። የተመሰጠሩ መልእክቶችን ይመልሳል።

```
POST /api/conversations/:id/messages
```

**Permission:** `conversations:send` ወይም `conversations:send-any`

**Body:**

```json
{
  "encryptedContent": "hex",
  "readerEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }],
  "plaintextForSending": "Hello"
}
```

`plaintextForSending` field ለውጫዊ ሰርጦች (SMS፣ WhatsApp፣ Signal) ይጠቀማል። ሰርቨሩ መልእክቱን በchannel adapter በኩል ይልካል እና ከዚያ plaintext ያጥፋል።

```
PATCH /api/conversations/:id
```

**Permission:** `conversations:update` ወይም የተመደበ በጎ ፈቃደኛ

**Body:**

```json
{ "status": "closed", "assignedTo": "hex64" }
```

```
POST /api/conversations/:id/claim
```

**Permission:** `conversations:claim` + channel-specific (ለምሳሌ፣ `conversations:claim-sms`)

Hub-scoped: `/api/hubs/:hubId/conversations/*`

---

## Reports

Reports `metadata.type = "report"` ያላቸው የተለዩ የconversation አይነቶች ናቸው።

```
GET /api/reports?status=&category=&page=1&limit=50
```

**Permission:** `reports:read-all`፣ `reports:read-assigned`፣ ወይም `reports:read-own`

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

**Permission:** `reports:read-all`፣ `reports:read-assigned`፣ ወይም የራስ report

```
GET /api/reports/:id/messages?page=1&limit=100
```

**Auth:** Required (access-checked)

```
POST /api/reports/:id/messages
```

**Permission:** `reports:send-message`፣ `reports:send-message-own`፣ ወይም የተመደበ

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

`:phone` parameter URL-encoded E.164 ነው (ለምሳሌ፣ `%2B12125551234`)።

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

**Body:** `TelephonyProviderConfig` (provider አይነት + መረጃዎች)

```
POST /api/settings/telephony-provider/test
```

**Permission:** `settings:manage-telephony`

መረጃዎችን ሳይቆም provider credentials ይሞክራል።

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

**Auth:** Required (ማንኛውም ሚና)

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

**Auth:** Required (per role የተጣሉ fields ይመልሳል)

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

ሁሉንም ይገኛሉ permissions በdomain ተከፋፍለው ይመልሳል።

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

ለተመሰጠረ ፋይል አባሪዎች chunked upload።

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

ሁሉም chunks ካልተጫኑ `400` ይመልሳል።

```
GET /api/uploads/:id/status
```

**Permission:** `files:upload`

### Download

```
GET /api/files/:id/content
```

**Permission:** `files:download-own` (ከrecipient ከሆነ) ወይም `files:download-all`

**Response:** `application/octet-stream` (encrypted file bytes)

```
GET /api/files/:id/envelopes
```

**Permission:** `files:download-own` ወይም `files:download-all`

Non-admin users የራሳቸውን envelope ብቻ ይቀበላሉ።

```
GET /api/files/:id/metadata
```

**Permission:** `files:download-own` ወይም `files:download-all`

```
POST /api/files/:id/share
```

**Permission:** `files:share`

ለአዲስ recipient ፋይል ቁልፍ እንደገና ይመሰጥራል።

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

**Auth:** Required። blast በቅጽበት ይልካል።

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

**Auth:** Required። የተያዘ blast ይሰርዛል።

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

Multi-tenant hub management።

```
GET /api/hubs
```

**Auth:** Required (በmembership የተጣሉ; super admin ሁሉን ያያል)

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

**Auth:** Required (hub member)። ለጥያቄው የሚሰጥውን ተጠቃሚ ECIES-wrapped hub key envelope ብቻ ይመልሳል።

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

ከዚህ በተጨማረ ከhub የለም ከሆነ ነባሪ hub ይፍጥራል።

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

Audit log SHA-256 hash chain (`previousEntryHash` + `entryHash`) ለtamper detection ይጠቀማል።

Hub-scoped: `/api/hubs/:hubId/audit/*`

---

## WebRTC

```
GET /api/telephony/webrtc-token
```

**Auth:** Required

ለአሳሽ ጥሪ መመለስ provider-specific WebRTC token ይመልሳል።

**Response:**

```json
{ "token": "string", "provider": "twilio", "identity": "hex64" }
```

ጥሪ ምርጫ phone only ከሆነ `400` ይመልሳል።

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

አዲስ መሳሪያዎችን በephemeral ECDH key exchange በኩል ወደ አሁኑ መለያ ለማጣመር።

```
POST /api/provision/rooms
```

**Auth:** None (አዲስ መሳሪያ ምንም auth የለውም)

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

ሁኔታ transitions: `waiting` -> `ready` -> consumed። Rooms ከ~5 ደቂቃዎች በኋላ ያብቃሉ።

```
POST /api/provision/rooms/:id/payload
```

**Auth:** Required (primary device መረጋገጥ አለበት)

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

Push notifications ሁለት-ደረጃ encryption scheme ይጠቀማሉ፦ notification metadata ለwake key (PIN አያስፈልግም) እና ለስሜታዊ ይዘት identity key (PIN ያስፈልጋል)።

---

## Telephony webhooks

እነዚህ endpoints በስልክ አቅራቢዎች ይጠራሉ፣ በclients አይደሉም። እያንዳንዱ ጥያቄ በአቅራቢው webhook ፊርማ ይረጋገጣል።

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

Hub routing በ`?hub=<hubId>` query parameter በኩል ነው።

---

## Messaging webhooks

በመልእክት አቅራቢዎች ይጠራሉ። እያንዳንዱ adapter የራሱን webhook ፊርማ ያረጋገጣል።

```
GET  /api/messaging/whatsapp/webhook    (Meta webhook verification)
GET  /api/messaging/rcs/webhook         (Google RBM webhook verification)
POST /api/messaging/:channel/webhook?hub=<hubId>
```

የተደገፉ ሰርጦች፦ `sms`፣ `whatsapp`፣ `signal`፣ `rcs`።

---

## Hub-scoped routes

ሁሉንም የሚከተሉ routes በ`/api/hubs/:hubId/` ቅድመ ቅጥያ ጋር ይገኛሉ፣ ይህም ወደ ተወሰነ hub ያጣማል፦

- `/api/hubs/:hubId/shifts/*`
- `/api/hubs/:hubId/bans/*`
- `/api/hubs/:hubId/notes/*`
- `/api/hubs/:hubId/calls/*`
- `/api/hubs/:hubId/audit/*`
- `/api/hubs/:hubId/conversations/*`
- `/api/hubs/:hubId/reports/*`
- `/api/hubs/:hubId/blasts/*`

Hub-scoped routes ሲጠቀሙ፣ `hubContext` middleware ለተጠቃሚ hub-specific permissions ይፈታል።

---

## Error responses

ሁሉም error responses ይህን ቅርጸት ይከተላሉ፦

```json
{ "error": "Human-readable error message" }
```

ተለምዶ የሆኑ HTTP status codes፦

| Code | ትርጉም |
|------|---------|
| `400` | Bad request (malformed body፣ የጎደሉ fields፣ validation failure) |
| `401` | Unauthorized (የጎደለ ወይም ከልክለኛ auth token) |
| `403` | Forbidden (ትክክለኛ auth ግን insufficient permissions) |
| `404` | Not found |
| `409` | Conflict (ለምሳሌ፣ ጥሪ ቀድሞ ተመልሷል፣ resource ቀድሞ አለ) |
| `429` | Too many requests (rate limited) |
| `500` | Internal server error |

---

## Permission reference

Permissions `domain:action` ቅርጸት ይከተላሉ። ተጠቃሚዎች roles ያገኛሉ፣ እያንዳንዱ role permissions ስብስብ ያጣምራል። Effective permissions ከሁሉም የተመደቡ roles union ናቸው።

Wildcard `*` ሁሉንም permissions ይሰጣል። Domain wildcard `domain:*` በዚያ domain ውስጥ ሁሉንም actions ይሰጣል።

| Domain | Permissions |
|--------|-------------|
| **calls** | `answer`፣ `read-active`፣ `read-active-full`፣ `read-history`፣ `read-presence`፣ `read-recording`፣ `debug` |
| **notes** | `create`፣ `read-own`፣ `read-all`፣ `read-assigned`፣ `update-own` |
| **reports** | `create`፣ `read-own`፣ `read-all`፣ `read-assigned`፣ `assign`፣ `update`፣ `send-message-own`፣ `send-message` |
| **conversations** | `read-assigned`፣ `read-all`፣ `claim`፣ `claim-sms`፣ `claim-whatsapp`፣ `claim-signal`፣ `claim-rcs`፣ `claim-web`፣ `claim-any`፣ `send`፣ `send-any`፣ `update` |
| **volunteers** | `read`፣ `create`፣ `update`፣ `delete`፣ `manage-roles` |
| **shifts** | `read-own`፣ `read`፣ `create`፣ `update`፣ `delete`፣ `manage-fallback` |
| **bans** | `report`፣ `read`፣ `create`፣ `bulk-create`፣ `delete` |
| **invites** | `read`፣ `create`፣ `revoke` |
| **settings** | `read`፣ `manage`፣ `manage-telephony`፣ `manage-messaging`፣ `manage-spam`፣ `manage-ivr`፣ `manage-fields`፣ `manage-transcription` |
| **audit** | `read` |
| **blasts** | `read`፣ `send`፣ `manage`፣ `schedule` |
| **files** | `upload`፣ `download-own`፣ `download-all`፣ `share` |
| **system** | `manage-roles`፣ `manage-hubs`፣ `manage-instance` |

### Default roles

| Role | Slug | Key permissions |
|------|------|-----------------|
| **Super Admin** | `role-super-admin` | `*` (ሁሉም permissions) |
| **Hub Admin** | `role-hub-admin` | `volunteers:*`፣ `shifts:*`፣ `settings:*`፣ `audit:read`፣ `bans:*`፣ `invites:*`፣ `notes:read-all`፣ `reports:*`፣ `conversations:*`፣ `calls:*`፣ `blasts:*`፣ `files:*` |
| **Reviewer** | `role-reviewer` | `notes:read-assigned`፣ `reports:read-assigned`፣ `reports:assign`፣ `reports:update`፣ `conversations:read-assigned`፣ `conversations:send`፣ `files:download-own`፣ `files:upload` |
| **Volunteer** | `role-volunteer` | `calls:answer`፣ `calls:read-active`፣ `notes:create`፣ `notes:read-own`፣ `notes:update-own`፣ `conversations:claim`፣ `conversations:send`፣ `conversations:read-assigned`፣ `bans:report`፣ `files:upload`፣ `files:download-own` |
| **Reporter** | `role-reporter` | `reports:create`፣ `reports:read-own`፣ `reports:send-message-own`፣ `files:upload`፣ `files:download-own` |

---

## Development / test endpoints

በdevelopment environments ብቻ ይገኛሉ።

```
POST /api/test-reset            (ሙሉ reset፣ X-Test-Secret header ያስፈልጋል)
POST /api/test-reset-no-admin   (ከአስተዳዳሪ ያለ reset)
POST /api/test-reset-records    (light reset፣ identity/settings ይጠብቃል)
```
