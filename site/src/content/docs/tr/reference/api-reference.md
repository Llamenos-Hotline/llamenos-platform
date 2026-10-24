---
title: API Referansı
description: Llamenos sunucusu için eksiksiz REST API uç noktası referansı.
---

Bu belge, Llamenos sunucusu tarafından sunulan her REST API uç noktasını açıklar. Tüm uç noktalar `/api` ile ön eklenir. Aksi belirtilmediği sürece istekler ve yanıtlar JSON kullanır. Tüm zaman damgaları ISO 8601 dizeleridir.

API, arka uç ister **Cloudflare Workers** (Durable Objects ile) isterse **kendi kendine barındırılan** (Node.js + PostgreSQL) olsun aynıdır. Altı Durable Object — Identity, Settings, Records, ShiftManager, CallRouter ve Conversation — aşağıda açıklanan mantıksal API alanlarına karşılık gelir.

## Kimlik Doğrulama

Llamenos iki kimlik doğrulama mekanizmasını destekler. Tüm kimliği doğrulanmış uç noktalar bunlardan birini gerektirir.

### Schnorr imzası ile kimlik doğrulama (birincil)

Her kimliği doğrulanmış istek, HTTP yöntemine ve yola bağlı, kendi kendine imzalanmış bir BIP-340 Schnorr belirteci taşır.

**Başlık formatı:**

```
Authorization: Bearer {"pubkey":"<64_hex>","timestamp":<ms>,"token":"<128_hex>"}
```

**Belirteç oluşturma:**

1. Mesajı oluşturun: `llamenos:auth:<pubkey>:<timestamp_ms>:<METHOD>:<path>`
2. SHA-256 ile hashleyin
3. Hash'i, secp256k1 gizli anahtarınızı kullanarak BIP-340 Schnorr ile imzalayın
4. `pubkey`, `timestamp` ve `token` (onaltılık imza) alanlarıyla satır içi JSON olarak kodlayın

**Doğrulama kuralları:**

- Belirteç tazeliği: `|now() - timestamp| <= 300.000 ms` (5 dakikalık pencere)
- İmza, yeniden oluşturulan mesaj hash'ine karşı doğrulanır
- Ortak anahtar, kullanıcı kaydını çözümlemek için kimlik deposunda aranır

### Oturum belirteci ile kimlik doğrulama (WebAuthn)

Bir WebAuthn kimlik doğrulama töreninden sonra sunucu, 8 saat geçerli rastgele 256 bitlik bir oturum belirteci yayınlar.

```
Authorization: Session <token_hex>
```

Sunucu önce `Session` kimlik doğrulamasını kontrol eder. Başlık `Session ` ile başlıyorsa Schnorr kimlik doğrulaması denenmez ve bunun tersi de geçerlidir.

---

## Genel uç noktalar

Bu uç noktalar herhangi bir kimlik doğrulama gerektirmez.

### Sağlık kontrolü

```
GET /api/health
```

**Yanıt:**

```json
{ "status": "ok" }
```

### Yapılandırma

```
GET /api/config
```

Genel merkez yapılandırmasını, etkin kanalları ve sunucu kimliğini döndürür.

**Yanıt:**

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

### Derleme doğrulama

```
GET /api/config/verify
```

Yeniden üretilebilir derleme doğrulaması için derleme meta verilerini döndürür.

**Yanıt:**

```json
{
  "version": "1.0.0",
  "commit": "abc1234",
  "buildTime": "2024-01-01T00:00:00Z",
  "verificationUrl": "https://github.com/...",
  "trustAnchor": "GitHub Release checksums + SLSA provenance"
}
```

### IVR ses

```
GET /api/ivr-audio/:promptType/:language
```

Çağrılar sırasında telefon sağlayıcıları tarafından getirilen ses dosyalarını döndürür.

- `promptType`: `[a-z_-]+`
- `language`: `[a-z]{2,5}(-[A-Z]{2})?`
- **Yanıt:** `audio/wav` ikili

### Mesajlaşma tercihleri

Abone tercih yönetimi için belirteçle doğrulanmış genel uç noktalar.

```
GET  /api/messaging/preferences?token=<hmac_token>
PATCH /api/messaging/preferences?token=<hmac_token>
```

**PATCH gövdesi:**

```json
{ "status": "active", "language": "es" }
```

---

## Kimlik doğrulama uç noktaları

### Giriş

```
POST /api/auth/login
```

**Gövde:**

```json
{ "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

**Yanıt:**

```json
{ "ok": true, "roles": ["role-super-admin"] }
```

Hız sınırlı: IP başına 10 deneme. Geçersiz kimlik bilgilerinde `401` döndürür.

### Önyükleme (ilk yönetici)

```
POST /api/auth/bootstrap
```

İlk yönetici hesabını kaydeder. Zaten bir yönetici varsa `403` ile başarısız olur.

**Gövde:** Giriş ile aynı.
**Yanıt:** Giriş ile aynı.
Hız sınırlı: IP başına 5 deneme.

### Geçerli kullanıcıyı al

```
GET /api/auth/me
```

**Kimlik doğrulama:** Gerekli

**Yanıt:**

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

### Çıkış

```
POST /api/auth/me/logout
```

**Kimlik doğrulama:** Gerekli. Oturum kimlik doğrulaması kullanılıyorsa, belirteç sunucu tarafında iptal edilir.

### Profil güncelle

```
PATCH /api/auth/me/profile
```

**Kimlik doğrulama:** Gerekli

**Gövde:**

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

Tüm alanlar isteğe bağlıdır. `callPreference` şu değerleri alır: `"phone"`, `"browser"` veya `"both"`.

### Müsaitlik durumunu güncelle

```
PATCH /api/auth/me/availability
```

**Kimlik doğrulama:** Gerekli

**Gövde:**

```json
{ "onBreak": true }
```

### Transkripsiyon tercihini güncelle

```
PATCH /api/auth/me/transcription
```

**Kimlik doğrulama:** Gerekli

**Gövde:**

```json
{ "enabled": false }
```

Yönetici ayarları tarafından devre dışı bırakmaya izin verilmiyorsa `403` döndürür.

---

## WebAuthn

### Giriş akışı

```
POST /api/webauthn/login/options
```

**Kimlik doğrulama:** Yok. Bir `challengeId` ile `publicKeyCredentialRequestOptions` döndürür.

```
POST /api/webauthn/login/verify
```

**Kimlik doğrulama:** Yok

**Gövde:**

```json
{ "assertion": {}, "challengeId": "uuid" }
```

**Yanıt:**

```json
{ "token": "hex64", "pubkey": "hex64" }
```

### Kayıt akışı

```
POST /api/webauthn/register/options
```

**Kimlik doğrulama:** Gerekli

**Gövde:**

```json
{ "label": "My Phone" }
```

```
POST /api/webauthn/register/verify
```

**Kimlik doğrulama:** Gerekli

**Gövde:**

```json
{ "attestation": {}, "label": "My Phone", "challengeId": "uuid" }
```

### Kimlik bilgisi yönetimi

```
GET /api/webauthn/credentials
```

**Kimlik doğrulama:** Gerekli. Kayıtlı tüm kimlik bilgilerini döndürür.

```
DELETE /api/webauthn/credentials/:credId
```

**Kimlik doğrulama:** Gerekli. Bir kimlik bilgisini kaldırır.

---

## Davetiyeler

### Genel

```
GET /api/invites/validate/:code
```

Hız sınırlı: IP başına 5 deneme.

**Yanıt:**

```json
{ "valid": true, "name": "...", "expiresAt": "..." }
```

```
POST /api/invites/redeem
```

**Gövde:**

```json
{ "code": "...", "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

Hız sınırlı: IP başına 5 deneme.

### Kimliği doğrulanmış

```
GET /api/invites
```

**İzin:** `invites:read`

```
POST /api/invites
```

**İzin:** `invites:create`

**Gövde:**

```json
{ "name": "Jane Doe", "phone": "+1234567890", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/invites/:code
```

**İzin:** `invites:revoke`

---

## Gönüllüler

Tüm gönüllü uç noktaları, temel izin olarak `volunteers:read` gerektirir.

```
GET /api/volunteers
```

**İzin:** `volunteers:read`

```
POST /api/volunteers
```

**İzin:** `volunteers:create`

**Gövde:**

```json
{ "name": "string", "phone": "string", "roleIds": ["string"], "pubkey": "string" }
```

```
PATCH /api/volunteers/:targetPubkey
```

**İzin:** `volunteers:update`

**Gövde:** Kısmi gönüllü alanları (`name`, `phone`, `roles`, `active`, vb.)

```
DELETE /api/volunteers/:targetPubkey
```

**İzin:** `volunteers:delete`

---

## Vardiyalar

```
GET /api/shifts/my-status
```

**Kimlik doğrulama:** Gerekli (herhangi bir rol). Geçerli kullanıcının vardiya durumunu döndürür.

```
GET /api/shifts
```

**İzin:** `shifts:read`

```
POST /api/shifts
```

**İzin:** `shifts:create`

**Gövde:**

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

**İzin:** `shifts:update`

```
DELETE /api/shifts/:id
```

**İzin:** `shifts:delete`

### Yedek halka grubu

```
GET /api/shifts/fallback
```

**İzin:** `shifts:manage-fallback`

```
PUT /api/shifts/fallback
```

**İzin:** `shifts:manage-fallback`

**Gövde:**

```json
{ "fallbackPubkeys": ["hex64", "hex64"] }
```

Merkez kapsamlı: Tüm vardiya uç noktalarına `/api/hubs/:hubId/shifts/*` adresinden de erişilebilir.

---

## Notlar

Tüm not uç noktaları temel olarak `notes:read-own` gerektirir. İstemciler, göndermeden önce notları şifrelemelidir (ECIES zarf formatı için [protokol belirtimine](https://github.com/rhonda-rodododo/llamenos-platform/blob/main/docs/protocol/PROTOCOL.md) bakın).

```
GET /api/notes?callId=...&page=1&limit=50
```

**İzin:** `notes:read-own` (yalnızca kendi notları) veya `notes:read-all` (tüm notlar)

**Yanıt:**

```json
{ "notes": [], "total": 0 }
```

```
POST /api/notes
```

**İzin:** `notes:create`

**Gövde:**

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

**İzin:** `notes:update-own`

**Gövde:** POST ile aynı yapı (güncellenmiş şifrelenmiş içerik ve zarflarla).

Merkez kapsamlı: `/api/hubs/:hubId/notes/*`

---

## Çağrılar

```
GET /api/calls/active
```

**İzin:** `calls:read-active` (çağıran bilgisi gizlenir) veya `calls:read-active-full`

```
GET /api/calls/today-count
```

**İzin:** `calls:read-active`

```
GET /api/calls/presence
```

**İzin:** `calls:read-presence`. Gönüllülerin çevrimiçi/meşgul durumunu döndürür.

```
GET /api/calls/history?page=1&limit=50&search=&dateFrom=&dateTo=
```

**İzin:** `calls:read-history`

```
POST /api/calls/:callId/answer
```

**İzin:** `calls:answer`. Çağrı daha önce yanıtlanmışsa `409` döndürür.

```
POST /api/calls/:callId/hangup
```

**İzin:** `calls:answer`. Çağrı size ait değilse `403` döndürür.

```
POST /api/calls/:callId/spam
```

**İzin:** `calls:answer`. Çağrıyı spam olarak işaretler.

```
GET /api/calls/:callId/recording
```

**İzin:** `calls:read-recording` veya yanıtlayan gönüllü.

**Yanıt:** `audio/wav` ikili, `Cache-Control: private, no-store` ile birlikte.

```
GET /api/calls/debug
```

**İzin:** `calls:debug`. Sorun giderme için dahili çağrı durumunu döndürür.

Merkez kapsamlı: `/api/hubs/:hubId/calls/*`

---

## Görüşmeler

```
GET /api/conversations?status=&channel=&page=1&limit=50
```

**İzin:** `conversations:read-all` veya `conversations:read-assigned` (kendine ait + bekleyenler)

**Yanıt:**

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

**Kimlik doğrulama:** Gerekli

**Yanıt:**

```json
{ "total": 0, "active": 0, "waiting": 0, "closed": 0 }
```

```
GET /api/conversations/load
```

**İzin:** `conversations:read-all`. Gönüllü başına görüşme sayılarını döndürür.

```
GET /api/conversations/:id
```

**Kimlik doğrulama:** Gerekli (görüşme başına erişim kontrolü yapılır).

```
GET /api/conversations/:id/messages?page=1&limit=50
```

**Kimlik doğrulama:** Gerekli (erişim kontrollü). Şifrelenmiş mesajları döndürür.

```
POST /api/conversations/:id/messages
```

**İzin:** `conversations:send` veya `conversations:send-any`

**Gövde:**

```json
{
  "encryptedContent": "hex",
  "readerEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }],
  "plaintextForSending": "Hello"
}
```

`plaintextForSending` alanı harici kanallar (SMS, WhatsApp, Signal) için kullanılır. Sunucu, mesajı kanal bağdaştırıcısı aracılığıyla gönderir ve ardından düz metni atar.

```
PATCH /api/conversations/:id
```

**İzin:** `conversations:update` veya atanmış gönüllü

**Gövde:**

```json
{ "status": "closed", "assignedTo": "hex64" }
```

```
POST /api/conversations/:id/claim
```

**İzin:** `conversations:claim` + kanala özgü (örn. `conversations:claim-sms`)

Merkez kapsamlı: `/api/hubs/:hubId/conversations/*`

---

## Raporlar

Raporlar, `metadata.type = "report"` olan özel bir görüşme türüdür.

```
GET /api/reports?status=&category=&page=1&limit=50
```

**İzin:** `reports:read-all`, `reports:read-assigned` veya `reports:read-own`

```
POST /api/reports
```

**İzin:** `reports:create`

**Gövde:**

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

**İzin:** `reports:read-all`, `reports:read-assigned` veya kendi raporu

```
GET /api/reports/:id/messages?page=1&limit=100
```

**Kimlik doğrulama:** Gerekli (erişim kontrollü)

```
POST /api/reports/:id/messages
```

**İzin:** `reports:send-message`, `reports:send-message-own` veya atanmış

**Gövde:**

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

**İzin:** `reports:assign`

**Gövde:**

```json
{ "assignedTo": "hex64" }
```

```
PATCH /api/reports/:id
```

**İzin:** `reports:update`

```
GET /api/reports/categories
```

**Kimlik doğrulama:** Gerekli

```
GET /api/reports/:id/files
```

**Kimlik doğrulama:** Gerekli (erişim kontrollü)

Merkez kapsamlı: `/api/hubs/:hubId/reports/*`

---

## Yasaklamalar

```
POST /api/bans
```

**İzin:** `bans:report`

**Gövde:**

```json
{ "phone": "+1234567890", "reason": "Spam caller" }
```

```
GET /api/bans
```

**İzin:** `bans:read`

```
POST /api/bans/bulk
```

**İzin:** `bans:bulk-create`

**Gövde:**

```json
{ "phones": ["+1234567890", "+0987654321"], "reason": "Imported ban list" }
```

```
DELETE /api/bans/:phone
```

**İzin:** `bans:delete`

`:phone` parametresi URL kodlu E.164'tür (örn. `%2B12125551234`).

Merkez kapsamlı: `/api/hubs/:hubId/bans/*`

---

## Ayarlar

### Telefon sağlayıcısı

```
GET /api/settings/telephony-provider
```

**İzin:** `settings:manage-telephony`

```
PATCH /api/settings/telephony-provider
```

**İzin:** `settings:manage-telephony`

**Gövde:** `TelephonyProviderConfig` (sağlayıcı türü + kimlik bilgileri)

```
POST /api/settings/telephony-provider/test
```

**İzin:** `settings:manage-telephony`

Sağlayıcı kimlik bilgilerini kaydetmeden test eder.

### Mesajlaşma

```
GET /api/settings/messaging
```

**İzin:** `settings:manage-messaging`

```
PATCH /api/settings/messaging
```

**İzin:** `settings:manage-messaging`

### Spam azaltma

```
GET /api/settings/spam
```

**İzin:** `settings:manage-spam`

```
PATCH /api/settings/spam
```

**İzin:** `settings:manage-spam`

### Çağrı ayarları

```
GET /api/settings/call
```

**İzin:** `settings:manage`

```
PATCH /api/settings/call
```

**İzin:** `settings:manage`

### IVR dilleri

```
GET /api/settings/ivr-languages
```

**İzin:** `settings:manage-ivr`

```
PATCH /api/settings/ivr-languages
```

**İzin:** `settings:manage-ivr`

**Gövde:**

```json
{ "enabledLanguages": ["en", "es", "zh"] }
```

### IVR ses

```
GET /api/settings/ivr-audio
```

**İzin:** `settings:manage-ivr`

```
PUT /api/settings/ivr-audio/:promptType/:language
```

**İzin:** `settings:manage-ivr`
**Content-Type:** `application/octet-stream` (ham ses baytları)

```
DELETE /api/settings/ivr-audio/:promptType/:language
```

**İzin:** `settings:manage-ivr`

### Transkripsiyon

```
GET /api/settings/transcription
```

**Kimlik doğrulama:** Gerekli (herhangi bir rol)

**Yanıt:**

```json
{ "globalEnabled": true, "allowVolunteerOptOut": false }
```

```
PATCH /api/settings/transcription
```

**İzin:** `settings:manage-transcription`

### Özel alanlar

```
GET /api/settings/custom-fields
```

**Kimlik doğrulama:** Gerekli (role göre filtrelenmiş alanları döndürür)

```
PUT /api/settings/custom-fields
```

**İzin:** `settings:manage-fields`

**Gövde:**

```json
{ "fields": [{ "id": "uuid", "name": "severity", "label": "Severity Rating", "type": "select", "required": true, "options": ["low", "medium", "high"], "visibleToVolunteers": true, "editableByVolunteers": true, "context": "call-notes", "order": 0 }] }
```

### WebAuthn ayarları

```
GET /api/settings/webauthn
```

**İzin:** `settings:manage`

```
PATCH /api/settings/webauthn
```

**İzin:** `settings:manage`

**Gövde:**

```json
{ "requireForAdmins": true, "requireForVolunteers": false }
```

### Roller (PBAC)

```
GET /api/settings/roles
```

**Kimlik doğrulama:** Gerekli

```
POST /api/settings/roles
```

**İzin:** `system:manage-roles`

**Gövde:**

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

**İzin:** `system:manage-roles`

```
DELETE /api/settings/roles/:id
```

**İzin:** `system:manage-roles`

### İzin kataloğu

```
GET /api/settings/permissions
```

**İzin:** `system:manage-roles`

Alana göre düzenlenmiş tüm kullanılabilir izinleri döndürür.

### Kurulum durumu

```
GET /api/settings/setup
```

**İzin:** `settings:manage`

```
PATCH /api/settings/setup
```

**İzin:** `settings:manage`

---

## Dosyalar

### Yükleme akışı

Şifrelenmiş dosya ekleri için parçalı yükleme.

```
POST /api/uploads/init
```

**İzin:** `files:upload`

**Gövde:**

```json
{
  "totalSize": 1048576,
  "totalChunks": 4,
  "conversationId": "uuid",
  "recipientEnvelopes": [],
  "encryptedMetadata": [{ "pubkey": "hex64", "encryptedContent": "hex", "ephemeralPubkey": "hex" }]
}
```

**Yanıt:**

```json
{ "uploadId": "uuid", "totalChunks": 4 }
```

```
PUT /api/uploads/:id/chunks/:chunkIndex
```

**İzin:** `files:upload`
**Content-Type:** `application/octet-stream` (ham şifrelenmiş parça baytları)

**Yanıt:**

```json
{ "chunkIndex": 0, "completedChunks": 1, "totalChunks": 4 }
```

```
POST /api/uploads/:id/complete
```

**İzin:** `files:upload`

**Yanıt:**

```json
{ "fileId": "uuid", "status": "complete" }
```

Tüm parçalar yüklenmemişse `400` döndürür.

```
GET /api/uploads/:id/status
```

**İzin:** `files:upload`

### İndirme

```
GET /api/files/:id/content
```

**İzin:** `files:download-own` (alıcı ise) veya `files:download-all`

**Yanıt:** `application/octet-stream` (şifrelenmiş dosya baytları)

```
GET /api/files/:id/envelopes
```

**İzin:** `files:download-own` veya `files:download-all`

Yönetici olmayan kullanıcılar yalnızca kendi zarfını alır.

```
GET /api/files/:id/metadata
```

**İzin:** `files:download-own` veya `files:download-all`

```
POST /api/files/:id/share
```

**İzin:** `files:share`

Dosya anahtarını yeni bir alıcı için yeniden şifreler.

---

## Yayınlar (toplu mesaj)

### Aboneler

```
GET /api/blasts/subscribers?page=&limit=&tag=&status=
```

**Kimlik doğrulama:** Gerekli

```
DELETE /api/blasts/subscribers/:id
```

**Kimlik doğrulama:** Gerekli

```
GET /api/blasts/subscribers/stats
```

**Kimlik doğrulama:** Gerekli

```
POST /api/blasts/subscribers/import
```

**Kimlik doğrulama:** Gerekli

**Gövde:**

```json
{ "subscribers": [{ "phone": "+1234567890", "tags": ["alerts"] }] }
```

### Yayınlar

```
GET /api/blasts
```

**Kimlik doğrulama:** Gerekli

```
POST /api/blasts
```

**Kimlik doğrulama:** Gerekli

**Gövde:**

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

**Kimlik doğrulama:** Gerekli

```
PATCH /api/blasts/:id
```

**Kimlik doğrulama:** Gerekli

```
DELETE /api/blasts/:id
```

**Kimlik doğrulama:** Gerekli

```
POST /api/blasts/:id/send
```

**Kimlik doğrulama:** Gerekli. Yayını hemen gönderir.

```
POST /api/blasts/:id/schedule
```

**Kimlik doğrulama:** Gerekli

**Gövde:**

```json
{ "scheduledAt": "2026-03-01T12:00:00Z" }
```

```
POST /api/blasts/:id/cancel
```

**Kimlik doğrulama:** Gerekli. Zamanlanmış bir yayını iptal eder.

### Yayın ayarları

```
GET /api/blasts/settings
```

**Kimlik doğrulama:** Gerekli

```
PATCH /api/blasts/settings
```

**Kimlik doğrulama:** Gerekli

Merkez kapsamlı: `/api/hubs/:hubId/blasts/*`

---

## Merkezler

Çok kiracılı merkez yönetimi.

```
GET /api/hubs
```

**Kimlik doğrulama:** Gerekli (üyeliğe göre filtrelenir; süper yönetici tümünü görür)

```
POST /api/hubs
```

**İzin:** `system:manage-hubs`

**Gövde:**

```json
{ "name": "NYC Hub", "slug": "nyc", "description": "New York City operations", "phoneNumber": "+1234567890" }
```

```
GET /api/hubs/:hubId
```

**Kimlik doğrulama:** Gerekli (üyelik kontrol edilir)

```
PATCH /api/hubs/:hubId
```

**İzin:** `system:manage-hubs`

### Merkez üyeleri

```
POST /api/hubs/:hubId/members
```

**İzin:** `volunteers:manage-roles`

**Gövde:**

```json
{ "pubkey": "hex64", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/hubs/:hubId/members/:pubkey
```

**İzin:** `volunteers:manage-roles`

### Merkez anahtar yönetimi

```
GET /api/hubs/:hubId/key
```

**Kimlik doğrulama:** Gerekli (merkez üyesi). Yalnızca istekte bulunan kullanıcının HPKE ile sarılmış merkez anahtar zarfını döndürür.

```
PUT /api/hubs/:hubId/key
```

**İzin:** `system:manage-hubs`

**Gövde:**

```json
{ "envelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }] }
```

---

## Kurulum sihirbazı

```
GET /api/setup/state
```

**Kimlik doğrulama:** Gerekli

```
PATCH /api/setup/state
```

**İzin:** `settings:manage`

```
POST /api/setup/complete
```

**İzin:** `settings:manage`

**Gövde:**

```json
{}
```

Ayrıca hiçbiri yoksa varsayılan bir merkez oluşturur.

### Kanal testleri

```
POST /api/setup/test/signal
```

**İzin:** `settings:manage-messaging`

**Gövde:**

```json
{ "bridgeUrl": "http://signal-cli:8080", "bridgeApiKey": "secret" }
```

```
POST /api/setup/test/whatsapp
```

**İzin:** `settings:manage-messaging`

**Gövde:**

```json
{ "phoneNumberId": "123456", "accessToken": "EAAx..." }
```

---

## Denetim günlüğü

```
GET /api/audit?page=1&limit=50&actorPubkey=&eventType=&dateFrom=&dateTo=&search=
```

**İzin:** `audit:read`

**Yanıt:**

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

Denetim günlüğü, kurcalamayı tespit etmek için bir SHA-256 hash zinciri (`previousEntryHash` + `entryHash`) kullanır.

Merkez kapsamlı: `/api/hubs/:hubId/audit/*`

---

## WebRTC

```
GET /api/telephony/webrtc-token
```

**Kimlik doğrulama:** Gerekli

Tarayıcı içinden çağrı yanıtlamak için sağlayıcıya özgü bir WebRTC belirteci döndürür.

**Yanıt:**

```json
{ "token": "string", "provider": "twilio", "identity": "hex64" }
```

Çağrı tercihi yalnızca telefon olarak ayarlanmışsa `400` döndürür.

```
GET /api/telephony/webrtc-status
```

**Kimlik doğrulama:** Gerekli

**Yanıt:**

```json
{ "available": true, "provider": "twilio" }
```

---

## Cihaz sağlama

Yeni cihazları geçici ECDH anahtar değişimi yoluyla mevcut bir hesaba bağlamak için.

```
POST /api/provision/rooms
```

**Kimlik doğrulama:** Yok (yeni cihazın kimlik doğrulaması yoktur)

**Gövde:**

```json
{ "ephemeralPubkey": "hex66" }
```

**Yanıt:**

```json
{ "roomId": "uuid", "token": "random_string" }
```

```
GET /api/provision/rooms/:id?token=<token>
```

**Kimlik doğrulama:** Yok

**Yanıt:**

```json
{
  "status": "waiting",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64",
  "ephemeralPubkey": "hex66"
}
```

Durum geçişleri: `waiting` -> `ready` -> tüketildi. Odalar yaklaşık 5 dakika sonra sona erer.

```
POST /api/provision/rooms/:id/payload
```

**Kimlik doğrulama:** Gerekli (birincil cihazın kimliği doğrulanmış olmalıdır)

**Gövde:**

```json
{
  "token": "string",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64"
}
```

---

## Push bildirimleri (mobil)

```
POST /api/devices/register
```

**Kimlik doğrulama:** Gerekli

**Gövde:**

```json
{
  "platform": "ios",
  "pushToken": "apns_device_token",
  "voipToken": "ios_voip_push_token",
  "wakeKeyEnvelope": { "wrappedKey": "hex", "ephemeralPubkey": "hex" }
}
```

**Yanıt:**

```json
{ "deviceId": "uuid" }
```

Push bildirimleri iki katmanlı bir şifreleme düzeni kullanır: bildirim meta verileri için bir uyandırma anahtarı (PIN gerektirmez) ve hassas içerik için kimlik anahtarı (PIN gerektirir).

---

## Telefon webhook'ları

Bu uç noktalar istemciler tarafından değil, telefon sağlayıcıları tarafından çağrılır. Her istek, sağlayıcının webhook imzasıyla doğrulanır.

```
POST /api/telephony/incoming
POST /api/telephony/language-selected
POST /api/telephony/captcha
POST /api/telephony/volunteer-answer
POST /api/telephony/call-status
POST /api/telephony/wait-music          (ayrıca GET)
POST /api/telephony/queue-exit
POST /api/telephony/voicemail-complete
POST /api/telephony/call-recording
POST /api/telephony/voicemail-recording
```

Merkez yönlendirmesi `?hub=<hubId>` sorgu parametresi ile yapılır.

---

## Mesajlaşma webhook'ları

Mesajlaşma sağlayıcıları tarafından çağrılır. Her bağdaştırıcı kendi webhook imzasını doğrular.

```
GET  /api/messaging/whatsapp/webhook    (Meta webhook doğrulaması)
GET  /api/messaging/rcs/webhook         (Google RBM webhook doğrulaması)
POST /api/messaging/:channel/webhook?hub=<hubId>
```

Desteklenen kanallar: `sms`, `whatsapp`, `signal`, `rcs`.

---

## Merkez kapsamlı yollar

Aşağıdaki yolların tümü, bunları belirli bir merkeze kapsamlandıran bir `/api/hubs/:hubId/` ön ekiyle de kullanılabilir:

- `/api/hubs/:hubId/shifts/*`
- `/api/hubs/:hubId/bans/*`
- `/api/hubs/:hubId/notes/*`
- `/api/hubs/:hubId/calls/*`
- `/api/hubs/:hubId/audit/*`
- `/api/hubs/:hubId/conversations/*`
- `/api/hubs/:hubId/reports/*`
- `/api/hubs/:hubId/blasts/*`

Merkez kapsamlı yollar kullanılırken, `hubContext` ara yazılımı kullanıcı için merkeze özgü izinleri çözümler.

---

## Hata yanıtları

Tüm hata yanıtları şu formatı izler:

```json
{ "error": "Human-readable error message" }
```

Yaygın HTTP durum kodları:

| Kod | Anlamı |
|------|--------|
| `400` | Hatalı istek (hatalı gövde, eksik alanlar, doğrulama hatası) |
| `401` | Yetkisiz (eksik veya geçersiz kimlik doğrulama belirteci) |
| `403` | Yasak (geçerli kimlik doğrulama ancak yetersiz izinler) |
| `404` | Bulunamadı |
| `409` | Çakışma (örn. çağrı zaten yanıtlanmış, kaynak zaten mevcut) |
| `429` | Çok fazla istek (hız sınırı) |
| `500` | İç sunucu hatası |

---

## İzin referansı

İzinler `domain:action` formatını izler. Kullanıcılara roller atanır ve her rol bir dizi izni bir araya getirir. Etkin izinler, atanan tüm rollerin birleşimidir.

Joker karakter `*` tüm izinleri verir. Alan joker karakteri `domain:*` o alandaki tüm eylemleri verir.

| Alan | İzinler |
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

### Varsayılan roller

| Rol | Slug | Anahtar izinler |
|------|------|-----------------|
| **Süper Yönetici** | `role-super-admin` | `*` (tüm izinler) |
| **Merkez Yöneticisi** | `role-hub-admin` | `volunteers:*`, `shifts:*`, `settings:*`, `audit:read`, `bans:*`, `invites:*`, `notes:read-all`, `reports:*`, `conversations:*`, `calls:*`, `blasts:*`, `files:*` |
| **İncelemeci** | `role-reviewer` | `notes:read-assigned`, `reports:read-assigned`, `reports:assign`, `reports:update`, `conversations:read-assigned`, `conversations:send`, `files:download-own`, `files:upload` |
| **Gönüllü** | `role-volunteer` | `calls:answer`, `calls:read-active`, `notes:create`, `notes:read-own`, `notes:update-own`, `conversations:claim`, `conversations:send`, `conversations:read-assigned`, `bans:report`, `files:upload`, `files:download-own` |
| **Raporlayıcı** | `role-reporter` | `reports:create`, `reports:read-own`, `reports:send-message-own`, `files:upload`, `files:download-own` |

---

## Geliştirme / test uç noktaları

Yalnızca geliştirme ortamlarında kullanılabilir.

```
POST /api/test-reset            (tam sıfırlama, X-Test-Secret başlığı gerektirir)
POST /api/test-reset-no-admin   (yönetici olmadan sıfırlama)
POST /api/test-reset-records    (hafif sıfırlama, kimlik/ayarları korur)
```
