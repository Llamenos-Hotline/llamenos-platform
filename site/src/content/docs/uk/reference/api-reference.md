---
title: Довідник API
description: Повний довідник REST API-ендпоінтів сервера Llamenos.
---

Цей документ описує кожен REST API-ендпоінт, який надає сервер Llamenos. Усі ендпоінти мають префікс `/api`. Запити та відповіді використовують JSON, якщо не вказано інше. Усі мітки часу — це рядки у форматі ISO 8601.

API однаковий незалежно від того, чи працює бекенд на **Cloudflare Workers** (з Durable Objects) або **самостійно розміщеному сервері** (Node.js + PostgreSQL). Шість Durable Objects — Identity, Settings, Records, ShiftManager, CallRouter та Conversation — відповідають логічним доменам API, описаним нижче.

## Аутентифікація

Llamenos підтримує два механізми аутентифікації. Усі автентифіковані ендпоінти вимагають один із них.

### Аутентифікація за підписом Schnorr (основна)

Кожен автентифікований запит містить самопідписаний токен BIP-340 Schnorr, прив'язаний до HTTP-методу та шляху.

**Формат заголовка:**

```
Authorization: Bearer {"pubkey":"<64_hex>","timestamp":<ms>,"token":"<128_hex>"}
```

**Конструкція токена:**

1. Сформуйте повідомлення: `llamenos:auth:<pubkey>:<timestamp_ms>:<METHOD>:<path>`
2. Хешуйте за допомогою SHA-256
3. Підпишіть хеш за допомогою BIP-340 Schnorr, використовуючи ваш секретний ключ secp256k1
4. Закодуйте як вбудований JSON із полями `pubkey`, `timestamp` та `token` (hex-підпис)

**Правила валідації:**

- Актуальність токена: `|now() - timestamp| <= 300,000 ms` (5-хвилинне вікно)
- Підпис перевіряється на відповідність відновленому хешу повідомлення
- Публічний ключ шукається в сховищі ідентичності для розв'язання запису користувача

### Аутентифікація за сесійним токеном (WebAuthn)

Після церемонії аутентифікації WebAuthn сервер видає випадковий 256-бітний сесійний токен, дійсний протягом 8 годин.

```
Authorization: Session <token_hex>
```

Сервер спочатку перевіряє `Session` аутентифікацію. Якщо заголовок починається з `Session `, аутентифікація Schnorr не намагається, і навпаки.

---

## Публічні ендпоінти

Ці ендпоінти не вимагають аутентифікації.

### Перевірка стану

```
GET /api/health
```

**Відповідь:**

```json
{ "status": "ok" }
```

### Конфігурація

```
GET /api/config
```

Повертає публічну конфігурацію хабу, увімкнені канали та ідентифікатор сервера.

**Відповідь:**

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

### Верифікація збірки

```
GET /api/config/verify
```

Повертає метадані збірки для верифікації відтворюваної збірки.

**Відповідь:**

```json
{
  "version": "1.0.0",
  "commit": "abc1234",
  "buildTime": "2024-01-01T00:00:00Z",
  "verificationUrl": "https://github.com/...",
  "trustAnchor": "GitHub Release checksums + SLSA provenance"
}
```

### IVR-аудіо

```
GET /api/ivr-audio/:promptType/:language
```

Повертає аудіофайли, які отримують телефонні провайдери під час дзвінків.

- `promptType`: `[a-z_-]+`
- `language`: `[a-z]{2,5}(-[A-Z]{2})?`
- **Відповідь:** `audio/wav` бінарні дані

### Налаштування повідомлень

Публічні ендпоінти з валідацією токена для керування налаштуваннями абонента.

```
GET  /api/messaging/preferences?token=<hmac_token>
PATCH /api/messaging/preferences?token=<hmac_token>
```

**Тіло PATCH:**

```json
{ "status": "active", "language": "es" }
```

---

## Ендпоінти аутентифікації

### Вхід

```
POST /api/auth/login
```

**Тіло:**

```json
{ "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

**Відповідь:**

```json
{ "ok": true, "roles": ["role-super-admin"] }
```

Обмеження швидкості: 10 спроб на IP. Повертає `401` при недійсних облікових даних.

### Первинне налаштування (перший адмін)

```
POST /api/auth/bootstrap
```

Реєструє перший обліковий запис адміністратора. Повертає `403`, якщо адміністратор вже існує.

**Тіло:** Таке ж, як для входу.
**Відповідь:** Таке ж, як для входу.
Обмеження швидкості: 5 спроб на IP.

### Отримати поточного користувача

```
GET /api/auth/me
```

**Аутентифікація:** Обов'язкова

**Відповідь:**

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

### Вихід

```
POST /api/auth/me/logout
```

**Аутентифікація:** Обов'язкова. Якщо використовується Session аутентифікація, токен відкликується на стороні сервера.

### Оновити профіль

```
PATCH /api/auth/me/profile
```

**Аутентифікація:** Обов'язкова

**Тіло:**

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

Усі поля необов'язкові. `callPreference` приймає `"phone"`, `"browser"` або `"both"`.

### Оновити доступність

```
PATCH /api/auth/me/availability
```

**Аутентифікація:** Обов'язкова

**Тіло:**

```json
{ "onBreak": true }
```

### Оновити налаштування транскрипції

```
PATCH /api/auth/me/transcription
```

**Аутентифікація:** Обов'язкова

**Тіло:**

```json
{ "enabled": false }
```

Повертає `403`, якщо відмова від транскрипції не дозволена налаштуваннями адміністратора.

---

## WebAuthn

### Процес входу

```
POST /api/webauthn/login/options
```

**Аутентифікація:** Не потрібна. Повертає `publicKeyCredentialRequestOptions` із `challengeId`.

```
POST /api/webauthn/login/verify
```

**Аутентифікація:** Не потрібна

**Тіло:**

```json
{ "assertion": {}, "challengeId": "uuid" }
```

**Відповідь:**

```json
{ "token": "hex64", "pubkey": "hex64" }
```

### Процес реєстрації

```
POST /api/webauthn/register/options
```

**Аутентифікація:** Обов'язкова

**Тіло:**

```json
{ "label": "My Phone" }
```

```
POST /api/webauthn/register/verify
```

**Аутентифікація:** Обов'язкова

**Тіло:**

```json
{ "attestation": {}, "label": "My Phone", "challengeId": "uuid" }
```

### Керування обліковими даними

```
GET /api/webauthn/credentials
```

**Аутентифікація:** Обов'язкова. Повертає всі зареєстровані облікові дані.

```
DELETE /api/webauthn/credentials/:credId
```

**Аутентифікація:** Обов'язкова. Видаляє облікові дані.

---

## Запрошення

### Публічні

```
GET /api/invites/validate/:code
```

Обмеження швидкості: 5 спроб на IP.

**Відповідь:**

```json
{ "valid": true, "name": "...", "expiresAt": "..." }
```

```
POST /api/invites/redeem
```

**Тіло:**

```json
{ "code": "...", "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

Обмеження швидкості: 5 спроб на IP.

### Автентифіковані

```
GET /api/invites
```

**Дозвіл:** `invites:read`

```
POST /api/invites
```

**Дозвіл:** `invites:create`

**Тіло:**

```json
{ "name": "Jane Doe", "phone": "+1234567890", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/invites/:code
```

**Дозвіл:** `invites:revoke`

---

## Волонтери

Усі ендпоінти волонтерів вимагають `volunteers:read` як базовий дозвіл.

```
GET /api/volunteers
```

**Дозвіл:** `volunteers:read`

```
POST /api/volunteers
```

**Дозвіл:** `volunteers:create`

**Тіло:**

```json
{ "name": "string", "phone": "string", "roleIds": ["string"], "pubkey": "string" }
```

```
PATCH /api/volunteers/:targetPubkey
```

**Дозвіл:** `volunteers:update`

**Тіло:** Часткові поля волонтера (`name`, `phone`, `roles`, `active` тощо)

```
DELETE /api/volunteers/:targetPubkey
```

**Дозвіл:** `volunteers:delete`

---

## Зміни

```
GET /api/shifts/my-status
```

**Аутентифікація:** Обов'язкова (будь-яка роль). Повертає поточний статус зміни користувача.

```
GET /api/shifts
```

**Дозвіл:** `shifts:read`

```
POST /api/shifts
```

**Дозвіл:** `shifts:create`

**Тіло:**

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

**Дозвіл:** `shifts:update`

```
DELETE /api/shifts/:id
```

**Дозвіл:** `shifts:delete`

### Резервна група дзвінків

```
GET /api/shifts/fallback
```

**Дозвіл:** `shifts:manage-fallback`

```
PUT /api/shifts/fallback
```

**Дозвіл:** `shifts:manage-fallback`

**Тіло:**

```json
{ "fallbackPubkeys": ["hex64", "hex64"] }
```

Область хабу: Усі ендпоінти змін також доступні за адресою `/api/hubs/:hubId/shifts/*`.

---

## Нотатки

Усі ендпоінти нотаток вимагають `notes:read-own` як базовий дозвіл. Клієнти повинні шифрувати нотатки перед відправкою (див. [специфікацію протоколу](https://github.com/rhonda-rodododo/llamenos-platform/blob/main/docs/protocol/PROTOCOL.md) для формату конверта ECIES).

```
GET /api/notes?callId=...&page=1&limit=50
```

**Дозвіл:** `notes:read-own` (тільки свої) або `notes:read-all` (усі нотатки)

**Відповідь:**

```json
{ "notes": [], "total": 0 }
```

```
POST /api/notes
```

**Дозвіл:** `notes:create`

**Тіло:**

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

**Дозвіл:** `notes:update-own`

**Тіло:** Така ж структура, як POST (із оновленим зашифрованим вмістом та конвертами).

Область хабу: `/api/hubs/:hubId/notes/*`

---

## Дзвінки

```
GET /api/calls/active
```

**Дозвіл:** `calls:read-active` (інформація про абонента прихована) або `calls:read-active-full`

```
GET /api/calls/today-count
```

**Дозвіл:** `calls:read-active`

```
GET /api/calls/presence
```

**Дозвіл:** `calls:read-presence`. Повертає статус онлайн/зайнятий волонтерів.

```
GET /api/calls/history?page=1&limit=50&search=&dateFrom=&dateTo=
```

**Дозвіл:** `calls:read-history`

```
POST /api/calls/:callId/answer
```

**Дозвіл:** `calls:answer`. Повертає `409`, якщо дзвінок вже відповіли.

```
POST /api/calls/:callId/hangup
```

**Дозвіл:** `calls:answer`. Повертає `403`, якщо це не ваш дзвінок.

```
POST /api/calls/:callId/spam
```

**Дозвіл:** `calls:answer`. Позначає дзвінок як спам.

```
GET /api/calls/:callId/recording
```

**Дозвіл:** `calls:read-recording` або волонтер, який відповів.

**Відповідь:** `audio/wav` бінарні дані з `Cache-Control: private, no-store`.

```
GET /api/calls/debug
```

**Дозвіл:** `calls:debug`. Повертає внутрішній стан дзвінка для усунення несправностей.

Область хабу: `/api/hubs/:hubId/calls/*`

---

## Розмови

```
GET /api/conversations?status=&channel=&page=1&limit=50
```

**Дозвіл:** `conversations:read-all` або `conversations:read-assigned` (свої + очікуючі)

**Відповідь:**

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

**Аутентифікація:** Обов'язкова

**Відповідь:**

```json
{ "total": 0, "active": 0, "waiting": 0, "closed": 0 }
```

```
GET /api/conversations/load
```

**Дозвіл:** `conversations:read-all`. Повертає кількість розмов на волонтера.

```
GET /api/conversations/:id
```

**Аутентифікація:** Обов'язкова (доступ перевіряється для кожної розмови).

```
GET /api/conversations/:id/messages?page=1&limit=50
```

**Аутентифікація:** Обов'язкова (доступ перевіряється). Повертає зашифровані повідомлення.

```
POST /api/conversations/:id/messages
```

**Дозвіл:** `conversations:send` або `conversations:send-any`

**Тіло:**

```json
{
  "encryptedContent": "hex",
  "readerEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }],
  "plaintextForSending": "Hello"
}
```

Поле `plaintextForSending` використовується для зовнішніх каналів (SMS, WhatsApp, Signal). Сервер надсилає повідомлення через адаптер каналу, а потім відкидає відкритий текст.

```
PATCH /api/conversations/:id
```

**Дозвіл:** `conversations:update` або призначений волонтер

**Тіло:**

```json
{ "status": "closed", "assignedTo": "hex64" }
```

```
POST /api/conversations/:id/claim
```

**Дозвіл:** `conversations:claim` + специфічний для каналу (наприклад, `conversations:claim-sms`)

Область хабу: `/api/hubs/:hubId/conversations/*`

---

## Звіти

Звіти — це спеціалізований тип розмови з `metadata.type = "report"`.

```
GET /api/reports?status=&category=&page=1&limit=50
```

**Дозвіл:** `reports:read-all`, `reports:read-assigned` або `reports:read-own`

```
POST /api/reports
```

**Дозвіл:** `reports:create`

**Тіло:**

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

**Дозвіл:** `reports:read-all`, `reports:read-assigned` або власний звіт

```
GET /api/reports/:id/messages?page=1&limit=100
```

**Аутентифікація:** Обов'язкова (доступ перевіряється)

```
POST /api/reports/:id/messages
```

**Дозвіл:** `reports:send-message`, `reports:send-message-own` або призначений

**Тіло:**

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

**Дозвіл:** `reports:assign`

**Тіло:**

```json
{ "assignedTo": "hex64" }
```

```
PATCH /api/reports/:id
```

**Дозвіл:** `reports:update`

```
GET /api/reports/categories
```

**Аутентифікація:** Обов'язкова

```
GET /api/reports/:id/files
```

**Аутентифікація:** Обов'язкова (доступ перевіряється)

Область хабу: `/api/hubs/:hubId/reports/*`

---

## Блокування

```
POST /api/bans
```

**Дозвіл:** `bans:report`

**Тіло:**

```json
{ "phone": "+1234567890", "reason": "Spam caller" }
```

```
GET /api/bans
```

**Дозвіл:** `bans:read`

```
POST /api/bans/bulk
```

**Дозвіл:** `bans:bulk-create`

**Тіло:**

```json
{ "phones": ["+1234567890", "+0987654321"], "reason": "Imported ban list" }
```

```
DELETE /api/bans/:phone
```

**Дозвіл:** `bans:delete`

Параметр `:phone` — це URL-кодований E.164 (наприклад, `%2B12125551234`).

Область хабу: `/api/hubs/:hubId/bans/*`

---

## Налаштування

### Телефонний провайдер

```
GET /api/settings/telephony-provider
```

**Дозвіл:** `settings:manage-telephony`

```
PATCH /api/settings/telephony-provider
```

**Дозвіл:** `settings:manage-telephony`

**Тіло:** `TelephonyProviderConfig` (тип провайдера + облікові дані)

```
POST /api/settings/telephony-provider/test
```

**Дозвіл:** `settings:manage-telephony`

Тестує облікові дані провайдера без збереження.

### Повідомлення

```
GET /api/settings/messaging
```

**Дозвіл:** `settings:manage-messaging`

```
PATCH /api/settings/messaging
```

**Дозвіл:** `settings:manage-messaging`

### Боротьба зі спамом

```
GET /api/settings/spam
```

**Дозвіл:** `settings:manage-spam`

```
PATCH /api/settings/spam
```

**Дозвіл:** `settings:manage-spam`

### Налаштування дзвінків

```
GET /api/settings/call
```

**Дозвіл:** `settings:manage`

```
PATCH /api/settings/call
```

**Дозвіл:** `settings:manage`

### IVR-мови

```
GET /api/settings/ivr-languages
```

**Дозвіл:** `settings:manage-ivr`

```
PATCH /api/settings/ivr-languages
```

**Дозвіл:** `settings:manage-ivr`

**Тіло:**

```json
{ "enabledLanguages": ["en", "es", "zh"] }
```

### IVR-аудіо

```
GET /api/settings/ivr-audio
```

**Дозвіл:** `settings:manage-ivr`

```
PUT /api/settings/ivr-audio/:promptType/:language
```

**Дозвіл:** `settings:manage-ivr`
**Content-Type:** `application/octet-stream` (сирий аудіо-байти)

```
DELETE /api/settings/ivr-audio/:promptType/:language
```

**Дозвіл:** `settings:manage-ivr`

### Транскрипція

```
GET /api/settings/transcription
```

**Аутентифікація:** Обов'язкова (будь-яка роль)

**Відповідь:**

```json
{ "globalEnabled": true, "allowVolunteerOptOut": false }
```

```
PATCH /api/settings/transcription
```

**Дозвіл:** `settings:manage-transcription`

### Користувацькі поля

```
GET /api/settings/custom-fields
```

**Аутентифікація:** Обов'язкова (повертає поля, відфільтровані за роллю)

```
PUT /api/settings/custom-fields
```

**Дозвіл:** `settings:manage-fields`

**Тіло:**

```json
{ "fields": [{ "id": "uuid", "name": "severity", "label": "Severity Rating", "type": "select", "required": true, "options": ["low", "medium", "high"], "visibleToVolunteers": true, "editableByVolunteers": true, "context": "call-notes", "order": 0 }] }
```

### Налаштування WebAuthn

```
GET /api/settings/webauthn
```

**Дозвіл:** `settings:manage`

```
PATCH /api/settings/webauthn
```

**Дозвіл:** `settings:manage`

**Тіло:**

```json
{ "requireForAdmins": true, "requireForVolunteers": false }
```

### Ролі (PBAC)

```
GET /api/settings/roles
```

**Аутентифікація:** Обов'язкова

```
POST /api/settings/roles
```

**Дозвіл:** `system:manage-roles`

**Тіло:**

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

**Дозвіл:** `system:manage-roles`

```
DELETE /api/settings/roles/:id
```

**Дозвіл:** `system:manage-roles`

### Каталог дозволів

```
GET /api/settings/permissions
```

**Дозвіл:** `system:manage-roles`

Повертає всі доступні дозволи, згруповані за доменами.

### Стан налаштування

```
GET /api/settings/setup
```

**Дозвіл:** `settings:manage`

```
PATCH /api/settings/setup
```

**Дозвіл:** `settings:manage`

---

## Файли

### Процес завантаження

Фрагментоване завантаження для зашифрованих вкладень файлів.

```
POST /api/uploads/init
```

**Дозвіл:** `files:upload`

**Тіло:**

```json
{
  "totalSize": 1048576,
  "totalChunks": 4,
  "conversationId": "uuid",
  "recipientEnvelopes": [],
  "encryptedMetadata": [{ "pubkey": "hex64", "encryptedContent": "hex", "ephemeralPubkey": "hex" }]
}
```

**Відповідь:**

```json
{ "uploadId": "uuid", "totalChunks": 4 }
```

```
PUT /api/uploads/:id/chunks/:chunkIndex
```

**Дозвіл:** `files:upload`
**Content-Type:** `application/octet-stream` (сирий зашифрований фрагмент)

**Відповідь:**

```json
{ "chunkIndex": 0, "completedChunks": 1, "totalChunks": 4 }
```

```
POST /api/uploads/:id/complete
```

**Дозвіл:** `files:upload`

**Відповідь:**

```json
{ "fileId": "uuid", "status": "complete" }
```

Повертає `400`, якщо не всі фрагменти завантажено.

```
GET /api/uploads/:id/status
```

**Дозвіл:** `files:upload`

### Завантаження

```
GET /api/files/:id/content
```

**Дозвіл:** `files:download-own` (якщо отримувач) або `files:download-all`

**Відповідь:** `application/octet-stream` (зашифровані байти файлу)

```
GET /api/files/:id/envelopes
```

**Дозвіл:** `files:download-own` або `files:download-all`

Користувачі, які не є адміністраторами, отримують лише свій власний конверт.

```
GET /api/files/:id/metadata
```

**Дозвіл:** `files:download-own` або `files:download-all`

```
POST /api/files/:id/share
```

**Дозвіл:** `files:share`

Повторно шифрує ключ файлу для нового отримувача.

---

## Розсилки (трансляція повідомлень)

### Абоненти

```
GET /api/blasts/subscribers?page=&limit=&tag=&status=
```

**Аутентифікація:** Обов'язкова

```
DELETE /api/blasts/subscribers/:id
```

**Аутентифікація:** Обов'язкова

```
GET /api/blasts/subscribers/stats
```

**Аутентифікація:** Обов'язкова

```
POST /api/blasts/subscribers/import
```

**Аутентифікація:** Обов'язкова

**Тіло:**

```json
{ "subscribers": [{ "phone": "+1234567890", "tags": ["alerts"] }] }
```

### Розсилки

```
GET /api/blasts
```

**Аутентифікація:** Обов'язкова

```
POST /api/blasts
```

**Аутентифікація:** Обов'язкова

**Тіло:**

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

**Аутентифікація:** Обов'язкова

```
PATCH /api/blasts/:id
```

**Аутентифікація:** Обов'язкова

```
DELETE /api/blasts/:id
```

**Аутентифікація:** Обов'язкова

```
POST /api/blasts/:id/send
```

**Аутентифікація:** Обов'язкова. Надсилає розсилку негайно.

```
POST /api/blasts/:id/schedule
```

**Аутентифікація:** Обов'язкова

**Тіло:**

```json
{ "scheduledAt": "2026-03-01T12:00:00Z" }
```

```
POST /api/blasts/:id/cancel
```

**Аутентифікація:** Обов'язкова. Скасовує заплановану розсилку.

### Налаштування розсилок

```
GET /api/blasts/settings
```

**Аутентифікація:** Обов'язкова

```
PATCH /api/blasts/settings
```

**Аутентифікація:** Обов'язкова

Область хабу: `/api/hubs/:hubId/blasts/*`

---

## Хаби

Керування багатоклієнтськими хабами.

```
GET /api/hubs
```

**Аутентифікація:** Обов'язкова (відфільтровано за членством; суперадмін бачить усі)

```
POST /api/hubs
```

**Дозвіл:** `system:manage-hubs`

**Тіло:**

```json
{ "name": "NYC Hub", "slug": "nyc", "description": "New York City operations", "phoneNumber": "+1234567890" }
```

```
GET /api/hubs/:hubId
```

**Аутентифікація:** Обов'язкова (перевіряється членство)

```
PATCH /api/hubs/:hubId
```

**Дозвіл:** `system:manage-hubs`

### Члени хабу

```
POST /api/hubs/:hubId/members
```

**Дозвіл:** `volunteers:manage-roles`

**Тіло:**

```json
{ "pubkey": "hex64", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/hubs/:hubId/members/:pubkey
```

**Дозвіл:** `volunteers:manage-roles`

### Керування ключами хабу

```
GET /api/hubs/:hubId/key
```

**Аутентифікація:** Обов'язкова (член хабу). Повертає лише конверт ключа хабу, загорнутий ECIES для користувача, який робить запит.

```
PUT /api/hubs/:hubId/key
```

**Дозвіл:** `system:manage-hubs`

**Тіло:**

```json
{ "envelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }] }
```

---

## Майстер налаштування

```
GET /api/setup/state
```

**Аутентифікація:** Обов'язкова

```
PATCH /api/setup/state
```

**Дозвіл:** `settings:manage`

```
POST /api/setup/complete
```

**Дозвіл:** `settings:manage`

**Тіло:**

```json
{}
```

Також створює типовий хаб, якщо його ще не існує.

### Тести каналів

```
POST /api/setup/test/signal
```

**Дозвіл:** `settings:manage-messaging`

**Тіло:**

```json
{ "bridgeUrl": "http://signal-cli:8080", "bridgeApiKey": "secret" }
```

```
POST /api/setup/test/whatsapp
```

**Дозвіл:** `settings:manage-messaging`

**Тіло:**

```json
{ "phoneNumberId": "123456", "accessToken": "EAAx..." }
```

---

## Журнал аудиту

```
GET /api/audit?page=1&limit=50&actorPubkey=&eventType=&dateFrom=&dateTo=&search=
```

**Дозвіл:** `audit:read`

**Відповідь:**

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

Журнал аудиту використовує ланцюг хешів SHA-256 (`previousEntryHash` + `entryHash`) для виявлення підробки.

Область хабу: `/api/hubs/:hubId/audit/*`

---

## WebRTC

```
GET /api/telephony/webrtc-token
```

**Аутентифікація:** Обов'язкова

Повертає токен WebRTC від провайдера для відповіді на дзвінки в браузері.

**Відповідь:**

```json
{ "token": "string", "provider": "twilio", "identity": "hex64" }
```

Повертає `400`, якщо налаштування дзвінків встановлено лише на телефон.

```
GET /api/telephony/webrtc-status
```

**Аутентифікація:** Обов'язкова

**Відповідь:**

```json
{ "available": true, "provider": "twilio" }
```

---

## Підготовка пристрою

Для прив'язки нових пристроїв до існуючого облікового запису через епемеральний обмін ключами ECDH.

```
POST /api/provision/rooms
```

**Аутентифікація:** Не потрібна (новий пристрій не має аутентифікації)

**Тіло:**

```json
{ "ephemeralPubkey": "hex66" }
```

**Відповідь:**

```json
{ "roomId": "uuid", "token": "random_string" }
```

```
GET /api/provision/rooms/:id?token=<token>
```

**Аутентифікація:** Не потрібна

**Відповідь:**

```json
{
  "status": "waiting",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64",
  "ephemeralPubkey": "hex66"
}
```

Переходи статусу: `waiting` -> `ready` -> consumed. Кімнати закінчуються через ~5 хвилин.

```
POST /api/provision/rooms/:id/payload
```

**Аутентифікація:** Обов'язкова (основний пристрій повинен бути автентифікований)

**Тіло:**

```json
{
  "token": "string",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64"
}
```

---

## Push-сповіщення (мобільні)

```
POST /api/devices/register
```

**Аутентифікація:** Обов'язкова

**Тіло:**

```json
{
  "platform": "ios",
  "pushToken": "apns_device_token",
  "voipToken": "ios_voip_push_token",
  "wakeKeyEnvelope": { "wrappedKey": "hex", "ephemeralPubkey": "hex" }
}
```

**Відповідь:**

```json
{ "deviceId": "uuid" }
```

Push-сповіщення використовують двоступеневу схему шифрування: ключ пробудження (не потрібен PIN) для метаданих сповіщення та ключ ідентичності (потрібен PIN) для конфіденційного вмісту.

---

## Телефонні вебхуки

Ці ендпоінти викликаються телефонними провайдерами, а не клієнтами. Кожен запит валідується підписом вебхуку провайдера.

```
POST /api/telephony/incoming
POST /api/telephony/language-selected
POST /api/telephony/captcha
POST /api/telephony/volunteer-answer
POST /api/telephony/call-status
POST /api/telephony/wait-music          (також GET)
POST /api/telephony/queue-exit
POST /api/telephony/voicemail-complete
POST /api/telephony/call-recording
POST /api/telephony/voicemail-recording
```

Маршрутизація хабу здійснюється через параметр запиту `?hub=<hubId>`.

---

## Вебхуки повідомлень

Викликаються провайдерами повідомлень. Кожен адаптер валідує власний підпис вебхуку.

```
GET  /api/messaging/whatsapp/webhook    (верифікація вебхуку Meta)
GET  /api/messaging/rcs/webhook         (верифікація вебхуку Google RBM)
POST /api/messaging/:channel/webhook?hub=<hubId>
```

Підтримувані канали: `sms`, `whatsapp`, `signal`, `rcs`.

---

## Маршрути з областю хабу

Усі наступні маршрути також доступні з префіксом `/api/hubs/:hubId/`, який обмежує їх конкретним хабом:

- `/api/hubs/:hubId/shifts/*`
- `/api/hubs/:hubId/bans/*`
- `/api/hubs/:hubId/notes/*`
- `/api/hubs/:hubId/calls/*`
- `/api/hubs/:hubId/audit/*`
- `/api/hubs/:hubId/conversations/*`
- `/api/hubs/:hubId/reports/*`
- `/api/hubs/:hubId/blasts/*`

При використанні маршрутів з областю хабу проміжний обробник `hubContext` розв'язує дозволи хабу для користувача.

---

## Відповіді з помилками

Усі відповіді з помилками мають такий формат:

```json
{ "error": "Human-readable error message" }
```

Поширені HTTP-коди статусу:

| Код | Значення |
|------|---------|
| `400` | Неправильний запит (пошкоджене тіло, відсутні поля, помилка валідації) |
| `401` | Неавторизовано (відсутній або недійсний токен аутентифікації) |
| `403` | Заборонено (дійсна аутентифікація, але недостатньо дозволів) |
| `404` | Не знайдено |
| `409` | Конфлікт (наприклад, дзвінок вже відповіли, ресурс вже існує) |
| `429` | Занадто багато запитів (обмеження швидкості) |
| `500` | Внутрішня помилка сервера |

---

## Довідник дозволів

Дозволи мають формат `domain:action`. Користувачам призначаються ролі, і кожна роль об'єднує набір дозволів. Ефективні дозволи — це об'єднання всіх призначених ролей.

Wildcard `*` надає всі дозволи. Доменний wildcard `domain:*` надає всі дії в цьому домені.

| Домен | Дозволи |
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

### Типові ролі

| Роль | Slug | Ключові дозволи |
|------|------|-----------------|
| **Super Admin** | `role-super-admin` | `*` (усі дозволи) |
| **Hub Admin** | `role-hub-admin` | `volunteers:*`, `shifts:*`, `settings:*`, `audit:read`, `bans:*`, `invites:*`, `notes:read-all`, `reports:*`, `conversations:*`, `calls:*`, `blasts:*`, `files:*` |
| **Reviewer** | `role-reviewer` | `notes:read-assigned`, `reports:read-assigned`, `reports:assign`, `reports:update`, `conversations:read-assigned`, `conversations:send`, `files:download-own`, `files:upload` |
| **Volunteer** | `role-volunteer` | `calls:answer`, `calls:read-active`, `notes:create`, `notes:read-own`, `notes:update-own`, `conversations:claim`, `conversations:send`, `conversations:read-assigned`, `bans:report`, `files:upload`, `files:download-own` |
| **Reporter** | `role-reporter` | `reports:create`, `reports:read-own`, `reports:send-message-own`, `files:upload`, `files:download-own` |

---

## Ендпоінти розробки / тестування

Доступні лише в середовищах розробки.

```
POST /api/test-reset            (повне скидання, вимагає заголовка X-Test-Secret)
POST /api/test-reset-no-admin   (скидання без адміністратора)
POST /api/test-reset-records    (легке скидання, зберігає ідентичність/налаштування)
```
