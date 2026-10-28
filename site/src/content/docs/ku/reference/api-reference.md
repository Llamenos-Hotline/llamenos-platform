---
title: Referansa API
description: Referansa tevahiya endpointên REST API ji bo servera Llamenos.
---

Ev belge her endpointek REST API ya ji hêla servera Llamenos ve hatiye eşkere kirin diyar dike. Hemû endpoint bi pêşgirtiya `/api` ne. Daxwaz û bersiv bi JSON in heke din were gotin. Hemû timestamp stringên ISO 8601 in.

API eynî ye bêyî ka backend li ser **Cloudflare Workers** (bi Durable Objects) an jî **xweser** (Node.js + PostgreSQL) bixebite. Şeş Durable Objects -- Identity, Settings, Records, ShiftManager, CallRouter, û Conversation -- bi navgîniya domainên logîkî yên li jêr hatine diyarkirin têne şîrove kirin.

## Erêkirin

Llamenos du mekanîzmên erêkirinê piştgirî dike. Hemû endpointên erêkirî yek ji van hewce dikin.

### Erêkirina îmaza Schnorr (bingehîn)

Her daxwazek erêkirî tokenek BIP-340 Schnorr-ê ya xwe-îmzekirî ku bi rêbaza HTTP û rêyê ve girêdayî ye, digire.

**Formata header:**

```
Authorization: Bearer {"pubkey":"<64_hex>","timestamp":<ms>,"token":"<128_hex>"}
```

**Avakirina token:**

1. Peyamê ava bikin: `llamenos:auth:<pubkey>:<timestamp_ms>:<METHOD>:<path>`
2. Bi SHA-256 hash bikin
3. Hash bi BIP-340 Schnorr bi karanîna kilîta veşartî ya secp256k1 îmze bikin
4. Wekî JSON-a inline bi zeviyên `pubkey`, `timestamp`, û `token` (îmza hex) kod bikin

**Rêzên erêkirinê:**

- Taziya token: `|now() - timestamp| <= 300,000 ms` (pencereya 5-deqîqe)
- Îmza li hemberî hash-a peyama avakirî tê erêkirin
- Pubkey di store-a nasnameyê de tê lêgerîn da ku tomara bikarhêner were çareser kirin

### Erêkirina tokena danişînê (WebAuthn)

Piştî merasîmek erêkirina WebAuthn, server tokenek rasthatî ya 256-bit ji bo 8 saetan derdixe.

```
Authorization: Session <token_hex>
```

Server pêşî erêkirina `Session` kontrol dike. Heke header bi `Session ` dest pê dike, erêkirina Schnorr nayê ceribandin, û berevajî wê jî.

---

## Endpointên giştî

Ev endpoint erêkirinê hewce nakin.

### Kontrola tenduristiyê

```
GET /api/health
```

**Bersiv:**

```json
{ "status": "ok" }
```

### Mîheng

```
GET /api/config
```

Mîhenga giştî ya hub, kanalên çalak, û nasnameya serverê vedigere.

**Bersiv:**

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

### Verastkirina avakirinê

```
GET /api/config/verify
```

Metadata-ya avakirinê ji bo verastkirina avakirina dubare vedigere.

**Bersiv:**

```json
{
  "version": "1.0.0",
  "commit": "abc1234",
  "buildTime": "2024-01-01T00:00:00Z",
  "verificationUrl": "https://github.com/...",
  "trustAnchor": "GitHub Release checksums + SLSA provenance"
}
```

### Dengê IVR

```
GET /api/ivr-audio/:promptType/:language
```

Pelên dengê vedigere ku di dema bangên de ji hêla pêşkêşkarên telefoniyê ve têne girtin.

- `promptType`: `[a-z_-]+`
- `language`: `[a-z]{2,5}(-[A-Z]{2})?`
- **Bersiv:** `audio/wav` binary

### Tercîhên peyamên

Endpointên giştî yên bi token-ê erêkirî ji bo rêveberiya tercîhên abone.

```
GET  /api/messaging/preferences?token=<hmac_token>
PATCH /api/messaging/preferences?token=<hmac_token>
```

**Laşê PATCH:**

```json
{ "status": "active", "language": "es" }
```

---

## Endpointên erêkirinê

### Têketin

```
POST /api/auth/login
```

**Laş:**

```json
{ "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

**Bersiv:**

```json
{ "ok": true, "roles": ["role-super-admin"] }
```

Rêjeya sînorkirî: 10 hewldan ji bo IP. `401` li ser nasnameyên ne derbasdar vedigere.

### Bootstrap (rêveberê yekem)

```
POST /api/auth/bootstrap
```

Hesabê rêveberê yekem tomar dike. Bi `403` têkstûr e heke rêveberek berê hebe.

**Laş:** Wekî têketinê.
**Bersiv:** Wekî têketinê.
Rêjeya sînorkirî: 5 hewldan ji bo IP.

### Bikarhênerê heyî bistînin

```
GET /api/auth/me
```

**Erêkirin:** Pêwîst e

**Bersiv:**

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

### Derketin

```
POST /api/auth/me/logout
```

**Erêkirin:** Pêwîst e. Heke erêkirina Session were bikar anîn, token li aliyê serverê betal dibe.

### Profîl nûve bikin

```
PATCH /api/auth/me/profile
```

**Erêkirin:** Pêwîst e

**Laş:**

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

Hemû zevî bijarte ne. `callPreference` `"phone"`, `"browser"`, an `"both"` qebûl dike.

### Berdestiyê nûve bikin

```
PATCH /api/auth/me/availability
```

**Erêkirin:** Pêwîst e

**Laş:**

```json
{ "onBreak": true }
```

### Tercîha transkripsiyonê nûve bikin

```
PATCH /api/auth/me/transcription
```

**Erêkirin:** Pêwîst e

**Laş:**

```json
{ "enabled": false }
```

`403` vedigere heke derketina bijarte ji hêla mîhengên rêveber ve neyê destûr kirin.

---

## WebAuthn

### Rêya têketinê

```
POST /api/webauthn/login/options
```

**Erêkirin:** Tune. `publicKeyCredentialRequestOptions` bi `challengeId` vedigere.

```
POST /api/webauthn/login/verify
```

**Erêkirin:** Tune

**Laş:**

```json
{ "assertion": {}, "challengeId": "uuid" }
```

**Bersiv:**

```json
{ "token": "hex64", "pubkey": "hex64" }
```

### Rêya tomarkirinê

```
POST /api/webauthn/register/options
```

**Erêkirin:** Pêwîst e

**Laş:**

```json
{ "label": "My Phone" }
```

```
POST /api/webauthn/register/verify
```

**Erêkirin:** Pêwîst e

**Laş:**

```json
{ "attestation": {}, "label": "My Phone", "challengeId": "uuid" }
```

### Rêveberiya nasnameyê

```
GET /api/webauthn/credentials
```

**Erêkirin:** Pêwîst e. Hemû nasnameyên tomarkirî vedigere.

```
DELETE /api/webauthn/credentials/:credId
```

**Erêkirin:** Pêwîst e. Nasnameyek jê dike.

---

## Vexwarin

### Giştî

```
GET /api/invites/validate/:code
```

Rêjeya sînorkirî: 5 hewldan ji bo IP.

**Bersiv:**

```json
{ "valid": true, "name": "...", "expiresAt": "..." }
```

```
POST /api/invites/redeem
```

**Laş:**

```json
{ "code": "...", "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

Rêjeya sînorkirî: 5 hewldan ji bo IP.

### Erêkirî

```
GET /api/invites
```

**Maf:** `invites:read`

```
POST /api/invites
```

**Maf:** `invites:create`

**Laş:**

```json
{ "name": "Jane Doe", "phone": "+1234567890", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/invites/:code
```

**Maf:** `invites:revoke`

---

## Xwebexş

Hemû endpointên xwebexşê kêmtirîn mafê `volunteers:read` hewce dikin.

```
GET /api/volunteers
```

**Maf:** `volunteers:read`

```
POST /api/volunteers
```

**Maf:** `volunteers:create`

**Laş:**

```json
{ "name": "string", "phone": "string", "roleIds": ["string"], "pubkey": "string" }
```

```
PATCH /api/volunteers/:targetPubkey
```

**Maf:** `volunteers:update`

**Laş:** Zeviyên xwebexşê yên parçeyî (`name`, `phone`, `roles`, `active`, hwd.)

```
DELETE /api/volunteers/:targetPubkey
```

**Maf:** `volunteers:delete`

---

## Şev

```
GET /api/shifts/my-status
```

**Erêkirin:** Pêwîst e (her rol). Statûya şevê ya bikarhênerê heyî vedigere.

```
GET /api/shifts
```

**Maf:** `shifts:read`

```
POST /api/shifts
```

**Maf:** `shifts:create`

**Laş:**

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

**Maf:** `shifts:update`

```
DELETE /api/shifts/:id
```

**Maf:** `shifts:delete`

### Komika fallback a dengê

```
GET /api/shifts/fallback
```

**Maf:** `shifts:manage-fallback`

```
PUT /api/shifts/fallback
```

**Maf:** `shifts:manage-fallback`

**Laş:**

```json
{ "fallbackPubkeys": ["hex64", "hex64"] }
```

Li ser bingeha hub: Hemû endpointên şevê li ser `/api/hubs/:hubId/shifts/*` jî berdest in.

---

## Nîşok

Hemû endpointên nîşokê kêmtirîn mafê `notes:read-own` hewce dikin. Xerîdar divê berî şandinê nîşokan şîfre bikin (ji bo formata envelope-a ECIES, [specîfîkasyona protokolê](https://github.com/rhonda-rodododo/llamenos-platform/blob/main/docs/protocol/PROTOCOL.md) bibînin).

```
GET /api/notes?callId=...&page=1&limit=50
```

**Maf:** `notes:read-own` (tenê ya xwe) an `notes:read-all` (hemû nîşok)

**Bersiv:**

```json
{ "notes": [], "total": 0 }
```

```
POST /api/notes
```

**Maf:** `notes:create`

**Laş:**

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

**Maf:** `notes:update-own`

**Laş:** Heman şêweya POST (bi naveroka şîfrekirî û envelope-yên nûvekirî).

Li ser bingeha hub: `/api/hubs/:hubId/notes/*`

---

## Bang

```
GET /api/calls/active
```

**Maf:** `calls:read-active` (agahiya bangê redacted) an `calls:read-active-full`

```
GET /api/calls/today-count
```

**Maf:** `calls:read-active`

```
GET /api/calls/presence
```

**Maf:** `calls:read-presence`. Statûya online/bizî ya xwebexşan vedigere.

```
GET /api/calls/history?page=1&limit=50&search=&dateFrom=&dateTo=
```

**Maf:** `calls:read-history`

```
POST /api/calls/:callId/answer
```

**Maf:** `calls:answer`. `409` vedigere heke bang berê hatibe bersivandin.

```
POST /api/calls/:callId/hangup
```

**Maf:** `calls:answer`. `403` vedigere heke ne bangê we be.

```
POST /api/calls/:callId/spam
```

**Maf:** `calls:answer`. Bangê wekî spam nîşan dike.

```
GET /api/calls/:callId/recording
```

**Maf:** `calls:read-recording` an jî xwebexşê bersivandî.

**Bersiv:** `audio/wav` binary bi `Cache-Control: private, no-store`.

```
GET /api/calls/debug
```

**Maf:** `calls:debug`. Statûya hundurîn a bangê ji bo çareserkirina arîşeyan vedigere.

Li ser bingeha hub: `/api/hubs/:hubId/calls/*`

---

## Dîalog

```
GET /api/conversations?status=&channel=&page=1&limit=50
```

**Maf:** `conversations:read-all` an `conversations:read-assigned` (ya xwe + li benda)

**Bersiv:**

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

**Erêkirin:** Pêwîst e

**Bersiv:**

```json
{ "total": 0, "active": 0, "waiting": 0, "closed": 0 }
```

```
GET /api/conversations/load
```

**Maf:** `conversations:read-all`. Hejmarên dîalogê ji bo her xwebexşek vedigere.

```
GET /api/conversations/:id
```

**Erêkirin:** Pêwîst e (gihiştina li ser bingeha dîalogê were kontrol kirin).

```
GET /api/conversations/:id/messages?page=1&limit=50
```

**Erêkirin:** Pêwîst e (gihiştina li ser bingeha dîalogê were kontrol kirin). Peyamên şîfrekirî vedigere.

```
POST /api/conversations/:id/messages
```

**Maf:** `conversations:send` an `conversations:send-any`

**Laş:**

```json
{
  "encryptedContent": "hex",
  "readerEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }],
  "plaintextForSending": "Hello"
}
```

Zeviya `plaintextForSending` ji bo kanalên derve (SMS, WhatsApp, Signal) tê bikar anîn. Server peyamê bi navgîniya adaptera kanalê dişîne û paşê plaintext jê diavêje.

```
PATCH /api/conversations/:id
```

**Maf:** `conversations:update` an jî xwebexşê hatiye erêkirin

**Laş:**

```json
{ "status": "closed", "assignedTo": "hex64" }
```

```
POST /api/conversations/:id/claim
```

**Maf:** `conversations:claim` + taybetî ji bo kanalê (mînak, `conversations:claim-sms`)

Li ser bingeha hub: `/api/hubs/:hubId/conversations/*`

---

## Raport

Raport cureyekî taybetî yên dîalogê ne ku `metadata.type = "report"`.

```
GET /api/reports?status=&category=&page=1&limit=50
```

**Maf:** `reports:read-all`, `reports:read-assigned`, an `reports:read-own`

```
POST /api/reports
```

**Maf:** `reports:create`

**Laş:**

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

**Maf:** `reports:read-all`, `reports:read-assigned`, an raporta xwe

```
GET /api/reports/:id/messages?page=1&limit=100
```

**Erêkirin:** Pêwîst e (gihiştina li ser bingeha dîalogê were kontrol kirin)

```
POST /api/reports/:id/messages
```

**Maf:** `reports:send-message`, `reports:send-message-own`, an jî yê hatiye erêkirin

**Laş:**

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

**Maf:** `reports:assign`

**Laş:**

```json
{ "assignedTo": "hex64" }
```

```
PATCH /api/reports/:id
```

**Maf:** `reports:update`

```
GET /api/reports/categories
```

**Erêkirin:** Pêwîst e

```
GET /api/reports/:id/files
```

**Erêkirin:** Pêwîst e (gihiştina li ser bingeha dîalogê were kontrol kirin)

Li ser bingeha hub: `/api/hubs/:hubId/reports/*`

---

## Qedexe

```
POST /api/bans
```

**Maf:** `bans:report`

**Laş:**

```json
{ "phone": "+1234567890", "reason": "Spam caller" }
```

```
GET /api/bans
```

**Maf:** `bans:read`

```
POST /api/bans/bulk
```

**Maf:** `bans:bulk-create`

**Laş:**

```json
{ "phones": ["+1234567890", "+0987654321"], "reason": "Imported ban list" }
```

```
DELETE /api/bans/:phone
```

**Maf:** `bans:delete`

Parametreyê `:phone` E.164 ya URL-encoded e (mînak, `%2B12125551234`).

Li ser bingeha hub: `/api/hubs/:hubId/bans/*`

---

## Mîheng

### Pêşkêşkarê telefoniyê

```
GET /api/settings/telephony-provider
```

**Maf:** `settings:manage-telephony`

```
PATCH /api/settings/telephony-provider
```

**Maf:** `settings:manage-telephony`

**Laş:** `TelephonyProviderConfig` (cureyê pêşkêşkar + nasname)

```
POST /api/settings/telephony-provider/test
```

**Maf:** `settings:manage-telephony`

Nasnameyên pêşkêşkar bêyî tomarkirinê biceribîne.

### Peyam

```
GET /api/settings/messaging
```

**Maf:** `settings:manage-messaging`

```
PATCH /api/settings/messaging
```

**Maf:** `settings:manage-messaging`

### Spam mitigation

```
GET /api/settings/spam
```

**Maf:** `settings:manage-spam`

```
PATCH /api/settings/spam
```

**Maf:** `settings:manage-spam`

### Mîhengên bangê

```
GET /api/settings/call
```

**Maf:** `settings:manage`

```
PATCH /api/settings/call
```

**Maf:** `settings:manage`

### Zimanên IVR

```
GET /api/settings/ivr-languages
```

**Maf:** `settings:manage-ivr`

```
PATCH /api/settings/ivr-languages
```

**Maf:** `settings:manage-ivr`

**Laş:**

```json
{ "enabledLanguages": ["en", "es", "zh"] }
```

### Dengê IVR

```
GET /api/settings/ivr-audio
```

**Maf:** `settings:manage-ivr`

```
PUT /api/settings/ivr-audio/:promptType/:language
```

**Maf:** `settings:manage-ivr`
**Content-Type:** `application/octet-stream` (byteyên dengê yên rast)

```
DELETE /api/settings/ivr-audio/:promptType/:language
```

**Maf:** `settings:manage-ivr`

### Transkripsiyon

```
GET /api/settings/transcription
```

**Erêkirin:** Pêwîst e (her rol)

**Bersiv:**

```json
{ "globalEnabled": true, "allowVolunteerOptOut": false }
```

```
PATCH /api/settings/transcription
```

**Maf:** `settings:manage-transcription`

### Zeviyên xweser

```
GET /api/settings/custom-fields
```

**Erêkirin:** Pêwîst e (zewiyên li gorî rolê vedigere)

```
PUT /api/settings/custom-fields
```

**Maf:** `settings:manage-fields`

**Laş:**

```json
{ "fields": [{ "id": "uuid", "name": "severity", "label": "Severity Rating", "type": "select", "required": true, "options": ["low", "medium", "high"], "visibleToVolunteers": true, "editableByVolunteers": true, "context": "call-notes", "order": 0 }] }
```

### Mîhengên WebAuthn

```
GET /api/settings/webauthn
```

**Maf:** `settings:manage`

```
PATCH /api/settings/webauthn
```

**Maf:** `settings:manage`

**Laş:**

```json
{ "requireForAdmins": true, "requireForVolunteers": false }
```

### Rol (PBAC)

```
GET /api/settings/roles
```

**Erêkirin:** Pêwîst e

```
POST /api/settings/roles
```

**Maf:** `system:manage-roles`

**Laş:**

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

**Maf:** `system:manage-roles`

```
DELETE /api/settings/roles/:id
```

**Maf:** `system:manage-roles`

### Kataloga mafan

```
GET /api/settings/permissions
```

**Maf:** `system:manage-roles`

Hemû mafên berdest li gorî domainê rêz dike.

### Statûya sazkirinê

```
GET /api/settings/setup
```

**Maf:** `settings:manage`

```
PATCH /api/settings/setup
```

**Maf:** `settings:manage`

---

## Pel

### Rêya barkirinê

Barkirina parçeyî ji bo pêvekên pelê yên şîfrekirî.

```
POST /api/uploads/init
```

**Maf:** `files:upload`

**Laş:**

```json
{
  "totalSize": 1048576,
  "totalChunks": 4,
  "conversationId": "uuid",
  "recipientEnvelopes": [],
  "encryptedMetadata": [{ "pubkey": "hex64", "encryptedContent": "hex", "ephemeralPubkey": "hex" }]
}
```

**Bersiv:**

```json
{ "uploadId": "uuid", "totalChunks": 4 }
```

```
PUT /api/uploads/:id/chunks/:chunkIndex
```

**Maf:** `files:upload`
**Content-Type:** `application/octet-stream` (byteyên parçeyî yên şîfrekirî yên rast)

**Bersiv:**

```json
{ "chunkIndex": 0, "completedChunks": 1, "totalChunks": 4 }
```

```
POST /api/uploads/:id/complete
```

**Maf:** `files:upload`

**Bersiv:**

```json
{ "fileId": "uuid", "status": "complete" }
```

`400` vedigere heke ne hemû parçe hatine barkirin.

```
GET /api/uploads/:id/status
```

**Maf:** `files:upload`

### Daxistin

```
GET /api/files/:id/content
```

**Maf:** `files:download-own` (heke wergir be) an `files:download-all`

**Bersiv:** `application/octet-stream` (byteyên pelê yên şîfrekirî)

```
GET /api/files/:id/envelopes
```

**Maf:** `files:download-own` an `files:download-all`

Bikarhênerên ne-rêveber tenê envelope-a xwe werdigirin.

```
GET /api/files/:id/metadata
```

**Maf:** `files:download-own` an `files:download-all`

```
POST /api/files/:id/share
```

**Maf:** `files:share`

Kilîta pelê ji bo wergirek nû dîsa şîfre dike.

---

## Blasts (belavkirina peyamê)

### Abone

```
GET /api/blasts/subscribers?page=&limit=&tag=&status=
```

**Erêkirin:** Pêwîst e

```
DELETE /api/blasts/subscribers/:id
```

**Erêkirin:** Pêwîst e

```
GET /api/blasts/subscribers/stats
```

**Erêkirin:** Pêwîst e

```
POST /api/blasts/subscribers/import
```

**Erêkirin:** Pêwîst e

**Laş:**

```json
{ "subscribers": [{ "phone": "+1234567890", "tags": ["alerts"] }] }
```

### Blasts

```
GET /api/blasts
```

**Erêkirin:** Pêwîst e

```
POST /api/blasts
```

**Erêkirin:** Pêwîst e

**Laş:**

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

**Erêkirin:** Pêwîst e

```
PATCH /api/blasts/:id
```

**Erêkirin:** Pêwîst e

```
DELETE /api/blasts/:id
```

**Erêkirin:** Pêwîst e

```
POST /api/blasts/:id/send
```

**Erêkirin:** Pêwîst e. Blast bi rasterast dişîne.

```
POST /api/blasts/:id/schedule
```

**Erêkirin:** Pêwîst e

**Laş:**

```json
{ "scheduledAt": "2026-03-01T12:00:00Z" }
```

```
POST /api/blasts/:id/cancel
```

**Erêkirin:** Pêwîst e. Blast-ê plankirî betal dike.

### Mîhengên blast

```
GET /api/blasts/settings
```

**Erêkirin:** Pêwîst e

```
PATCH /api/blasts/settings
```

**Erêkirin:** Pêwîst e

Li ser bingeha hub: `/api/hubs/:hubId/blasts/*`

---

## Hub

Rêveberiya hub-a pir-kirêdar.

```
GET /api/hubs
```

**Erêkirin:** Pêwîst e (li gorî endametiyê hatiye parzûn kirin; super admin hemûyan dibîne)

```
POST /api/hubs
```

**Maf:** `system:manage-hubs`

**Laş:**

```json
{ "name": "NYC Hub", "slug": "nyc", "description": "New York City operations", "phoneNumber": "+1234567890" }
```

```
GET /api/hubs/:hubId
```

**Erêkirin:** Pêwîst e (endametî hatiye kontrol kirin)

```
PATCH /api/hubs/:hubId
```

**Maf:** `system:manage-hubs`

### Endamên hub

```
POST /api/hubs/:hubId/members
```

**Maf:** `volunteers:manage-roles`

**Laş:**

```json
{ "pubkey": "hex64", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/hubs/:hubId/members/:pubkey
```

**Maf:** `volunteers:manage-roles`

### Rêveberiya kilîta hub

```
GET /api/hubs/:hubId/key
```

**Erêkirin:** Pêwîst e (endamê hub). Tenê envelope-a kilîta hub-a ECIES-wrapped ya bikarhênerê daxwazker vedigere.

```
PUT /api/hubs/:hubId/key
```

**Maf:** `system:manage-hubs`

**Laş:**

```json
{ "envelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }] }
```

---

## Sihêrbara sazkirinê

```
GET /api/setup/state
```

**Erêkirin:** Pêwîst e

```
PATCH /api/setup/state
```

**Maf:** `settings:manage`

```
POST /api/setup/complete
```

**Maf:** `settings:manage`

**Laş:**

```json
{}
```

Her weha hub-ek xwerû çêdike heke tune be.

### Testên kanalê

```
POST /api/setup/test/signal
```

**Maf:** `settings:manage-messaging`

**Laş:**

```json
{ "bridgeUrl": "http://signal-cli:8080", "bridgeApiKey": "secret" }
```

```
POST /api/setup/test/whatsapp
```

**Maf:** `settings:manage-messaging`

**Laş:**

```json
{ "phoneNumberId": "123456", "accessToken": "EAAx..." }
```

---

## Log-a kontrolê

```
GET /api/audit?page=1&limit=50&actorPubkey=&eventType=&dateFrom=&dateTo=&search=
```

**Maf:** `audit:read`

**Bersiv:**

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

Log-a kontrolê zincîrek hash-a SHA-256 (`previousEntryHash` + `entryHash`) ji bo kifşkirina guhartinê bikar tîne.

Li ser bingeha hub: `/api/hubs/:hubId/audit/*`

---

## WebRTC

```
GET /api/telephony/webrtc-token
```

**Erêkirin:** Pêwîst e

Tokenek WebRTC ya taybetî ji bo bersiva bangê di gerokê de vedigere.

**Bersiv:**

```json
{ "token": "string", "provider": "twilio", "identity": "hex64" }
```

`400` vedigere heke tercîha bangê tenê li ser telefonê hatibe sazkirin.

```
GET /api/telephony/webrtc-status
```

**Erêkirin:** Pêwîst e

**Bersiv:**

```json
{ "available": true, "provider": "twilio" }
```

---

## Provisioninga amûrê

Ji bo girêdana amûrên nû bi hesabek heyî bi navgîniya guhertoyek ECDH-ê ya demkî.

```
POST /api/provision/rooms
```

**Erêkirin:** Tune (amûra nû erêkirinê tune)

**Laş:**

```json
{ "ephemeralPubkey": "hex66" }
```

**Bersiv:**

```json
{ "roomId": "uuid", "token": "random_string" }
```

```
GET /api/provision/rooms/:id?token=<token>
```

**Erêkirin:** Tune

**Bersiv:**

```json
{
  "status": "waiting",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64",
  "ephemeralPubkey": "hex66"
}
```

Guherînên statûyê: `waiting` -> `ready` -> consumed. Oda piştî ~5 deqîqan biqede.

```
POST /api/provision/rooms/:id/payload
```

**Erêkirin:** Pêwîst e (amûra bingehîn divê erêkirî be)

**Laş:**

```json
{
  "token": "string",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64"
}
```

---

## Hişyariyên push (mobîl)

```
POST /api/devices/register
```

**Erêkirin:** Pêwîst e

**Laş:**

```json
{
  "platform": "ios",
  "pushToken": "apns_device_token",
  "voipToken": "ios_voip_push_token",
  "wakeKeyEnvelope": { "wrappedKey": "hex", "ephemeralPubkey": "hex" }
}
```

**Bersiv:**

```json
{ "deviceId": "uuid" }
```

Hişyariyên push sêwiranek şîfrekirina du-astî bikar tînin: kilîtek wake (PIN ne hewce) ji bo metadata-ya hişyariyê, û kilîta nasnameyê (PIN hewce) ji bo naveroka hesas.

---

## Webhookên telefoniyê

Ev endpoint ji hêla pêşkêşkarên telefoniyê ve têne gazî kirin, ne ji hêla xerîdar ve. Her daxwaz ji hêla îmaza webhookê ya pêşkêşkar ve tê erêkirin.

```
POST /api/telephony/incoming
POST /api/telephony/language-selected
POST /api/telephony/captcha
POST /api/telephony/volunteer-answer
POST /api/telephony/call-status
POST /api/telephony/wait-music          (her weha GET)
POST /api/telephony/queue-exit
POST /api/telephony/voicemail-complete
POST /api/telephony/call-recording
POST /api/telephony/voicemail-recording
```

Rêveberiya hub bi navgîniya parametreya query `?hub=<hubId>` tê kirin.

---

## Webhookên peyamên

Ji hêla pêşkêşkarên peyamê ve têne gazî kirin. Her adapter îmaza webhookê ya xwe erê dike.

```
GET  /api/messaging/whatsapp/webhook    (verastkirina webhookê ya Meta)
GET  /api/messaging/rcs/webhook         (verastkirina webhookê ya Google RBM)
POST /api/messaging/:channel/webhook?hub=<hubId>
```

Kanalên piştgirî: `sms`, `whatsapp`, `signal`, `rcs`.

---

## Rêyên li ser bingeha hub

Hemû rêyên li jêr bi pêşgirtiya `/api/hubs/:hubId/` jî berdest in, ku wan li ser hub-ek taybetî sînordar dike:

- `/api/hubs/:hubId/shifts/*`
- `/api/hubs/:hubId/bans/*`
- `/api/hubs/:hubId/notes/*`
- `/api/hubs/:hubId/calls/*`
- `/api/hubs/:hubId/audit/*`
- `/api/hubs/:hubId/conversations/*`
- `/api/hubs/:hubId/reports/*`
- `/api/hubs/:hubId/blasts/*`

Dema ku rêyên li ser bingeha hub têne bikar anîn, middleware-ê `hubContext` mafên taybetî yên hub-ê ji bo bikarhênerê çareser dike.

---

## Bersivên çewtiyê

Hemû bersivên çewtiyê vê formata bişopînin:

```json
{ "error": "Peyama çewtiyê ya ji bo mirovan" }
```

Kodên statûya HTTP-ya hevpar:

| Kod | Wate |
|------|---------|
| `400` | Daxwaza çewt (laşê xerab, zeviyên winda, têkiliya erêkirinê) |
| `401` | Ne-erêkirî (tokena erêkirinê winda an ne derbasdar) |
| `403` | Qedexe (erêkirin derbasdar e lê maf têr nake) |
| `404` | Nehat dîtin |
| `409` | Nakokî (mînak, bang berê hatiye bersivandin, çavkanî berê heye) |
| `429` | Zêde daxwaz (rêjeya sînorkirî) |
| `500` | Çewtiya hundurîn a serverê |

---

## Referansa mafan

Maf forma `domain:action` bişopînin. Bikarhêner têne erêkirin bi rol, û her rol komikek mafan digire. Mafên bandor yekbûna hemû rolan hatine erêkirin e.

Wildcard `*` hemû mafan dide. Wildcard-a domainê `domain:*` hemû kiryarên di wê domainê de dide.

| Domain | Maf |
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

### Rolên xwerû

| Rol | Slug | Mafên sereke |
|------|------|-----------------|
| **Super Admin** | `role-super-admin` | `*` (hemû maf) |
| **Hub Admin** | `role-hub-admin` | `volunteers:*`, `shifts:*`, `settings:*`, `audit:read`, `bans:*`, `invites:*`, `notes:read-all`, `reports:*`, `conversations:*`, `calls:*`, `blasts:*`, `files:*` |
| **Reviewer** | `role-reviewer` | `notes:read-assigned`, `reports:read-assigned`, `reports:assign`, `reports:update`, `conversations:read-assigned`, `conversations:send`, `files:download-own`, `files:upload` |
| **Volunteer** | `role-volunteer` | `calls:answer`, `calls:read-active`, `notes:create`, `notes:read-own`, `notes:update-own`, `conversations:claim`, `conversations:send`, `conversations:read-assigned`, `bans:report`, `files:upload`, `files:download-own` |
| **Reporter** | `role-reporter` | `reports:create`, `reports:read-own`, `reports:send-message-own`, `files:upload`, `files:download-own` |

---

## Endpointên pêşvebirinê / testê

Tenê di jîngehên pêşvebirinê de berdest in.

```
POST /api/test-reset            (reset-a tevahî, header-a X-Test-Secret hewce dike)
POST /api/test-reset-no-admin   (reset bêyî rêveber)
POST /api/test-reset-records    (reset-a sivik, nasname/mîheng diparêze)
```
