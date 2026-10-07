---
title: مرجع API
description: مرجع کامل endpointهای REST API برای سرور Llámenos.
---

این سند هر endpoint REST API را که توسط سرور Llámenos در معرض دید قرار گرفته توصیف می‌کند. همه endpointها با `/api` پیشوند دارند. درخواست‌ها و پاسخ‌ها مگر در موارد دیگر از JSON استفاده می‌کنند. همه timestampها رشته‌های ISO 8601 هستند.

API یکسان است چه بک‌اند روی **Cloudflare Workers** (با Durable Objects) یا **میزبانی شخصی** (Node.js + PostgreSQL) اجرا شود. شش Durable Object — Identity، Settings، Records، ShiftManager، CallRouter و Conversation — به دامنه‌های API منطقی که در زیر توصیف شده‌اند نگاشت می‌شوند.

## احراز هویت

Llámenos از دو مکانیسم احراز هویت پشتیبانی می‌کند. همه endpointهای احراز هویت‌شده به یکی از این‌ها نیاز دارند.

### احراز هویت امضای Schnorr (اصلی)

هر درخواست احراز هویت‌شده یک توکن Schnorr خودامضای BIP-340 را حمل می‌کند که به روش HTTP و مسیر محدود شده است.

**فرمت هدر:**

```
Authorization: Bearer {"pubkey":"<64_hex>","timestamp":<ms>,"token":"<128_hex>"}
```

**ساخت توکن:**

۱. پیام را بسازید: `llamenos:auth:<pubkey>:<timestamp_ms>:<METHOD>:<path>`
۲. با SHA-256 هش کنید
۳. هش را با Schnorr BIP-340 با استفاده از کلید مخفی secp256k1 خود امضا کنید
۴. به صورت JSON درون‌خطی با فیلدهای `pubkey`، `timestamp` و `token` (امضای hex) کدگذاری کنید

**قوانین اعتبارسنجی:**

- تازگی توکن: `|now() - timestamp| <= 300,000 ms` (پنجره ۵ دقیقه‌ای)
- امضا در برابر هش پیام بازسازی‌شده تأیید می‌شود
- pubkey در فروشگاه هویت برای حل رکورد کاربر جستجو می‌شود

### احراز هویت توکن نشست (WebAuthn)

پس از یک مراسم احراز هویت WebAuthn، سرور یک توکن نشست تصادفی ۲۵۶ بیتی صادر می‌کند که برای ۸ ساعت معتبر است.

```
Authorization: Session <token_hex>
```

سرور ابتدا احراز هویت `Session` را بررسی می‌کند. اگر هدر با `Session ` شروع شود، احراز هویت Schnorr تلاش نمی‌شود و بالعکس.

---

## endpointهای عمومی

این endpointها نیازی به احراز هویت ندارند.

### بررسی سلامت

```
GET /api/health
```

**پاسخ:**

```json
{ "status": "ok" }
```

### پیکربندی

```
GET /api/config
```

پیکربندی عمومی hub، کانال‌های فعال و هویت سرور را برمی‌گرداند.

**پاسخ:**

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

### تأیید ساخت

```
GET /api/config/verify
```

متاداده ساخت را برای تأیید ساخت قابل بازتولید برمی‌گرداند.

**پاسخ:**

```json
{
  "version": "1.0.0",
  "commit": "abc1234",
  "buildTime": "2024-01-01T00:00:00Z",
  "verificationUrl": "https://github.com/...",
  "trustAnchor": "GitHub Release checksums + SLSA provenance"
}
```

### صدای IVR

```
GET /api/ivr-audio/:promptType/:language
```

فایل‌های صوتی را که توسط ارائه‌دهندگان تلفنی در طول تماس‌ها واکشی می‌شوند برمی‌گرداند.

- `promptType`: `[a-z_-]+`
- `language`: `[a-z]{2,5}(-[A-Z]{2})?`
- **پاسخ:** باینری `audio/wav`

### ترجیحات پیام‌رسانی

endpointهای عمومی تأییدشده با توکن برای مدیریت ترجیحات مشترک.

```
GET  /api/messaging/preferences?token=<hmac_token>
PATCH /api/messaging/preferences?token=<hmac_token>
```

**بدنه PATCH:**

```json
{ "status": "active", "language": "es" }
```

---

## endpointهای احراز هویت

### ورود

```
POST /api/auth/login
```

**بدنه:**

```json
{ "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

**پاسخ:**

```json
{ "ok": true, "roles": ["role-super-admin"] }
```

محدود شده به نرخ: ۱۰ تلاش در IP. `401` را در اعتبارنامه نامعتبر برمی‌گرداند.

### Bootstrap (اولین مدیر)

```
POST /api/auth/bootstrap
```

اولین حساب مدیر را ثبت می‌کند. با `403` شکست می‌خورد اگر قبلاً یک مدیر وجود داشته باشد.

**بدنه:** همانند ورود.
**پاسخ:** همانند ورود.
محدود شده به نرخ: ۵ تلاش در IP.

### دریافت کاربر فعلی

```
GET /api/auth/me
```

**احراز هویت:** الزامی

**پاسخ:**

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

### خروج

```
POST /api/auth/me/logout
```

**احراز هویت:** الزامی. اگر از احراز هویت Session استفاده می‌شود، توکن سمت سرور لغو می‌شود.

### به‌روزرسانی پروفایل

```
PATCH /api/auth/me/profile
```

**احراز هویت:** الزامی

**بدنه:**

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

همه فیلدها اختیاری هستند. `callPreference` مقادیر `"phone"`، `"browser"` یا `"both"` را می‌پذیرد.

### به‌روزرسانی دسترسی

```
PATCH /api/auth/me/availability
```

**احراز هویت:** الزامی

**بدنه:**

```json
{ "onBreak": true }
```

### به‌روزرسانی ترجیح رونویسی

```
PATCH /api/auth/me/transcription
```

**احراز هویت:** الزامی

**بدنه:**

```json
{ "enabled": false }
```

`403` را برمی‌گرداند اگر انصراف توسط تنظیمات مدیر مجاز نباشد.

---

## WebAuthn

### جریان ورود

```
POST /api/webauthn/login/options
```

**احراز هویت:** هیچ. `publicKeyCredentialRequestOptions` را با یک `challengeId` برمی‌گرداند.

```
POST /api/webauthn/login/verify
```

**احراز هویت:** هیچ

**بدنه:**

```json
{ "assertion": {}, "challengeId": "uuid" }
```

**پاسخ:**

```json
{ "token": "hex64", "pubkey": "hex64" }
```

### جریان ثبت نام

```
POST /api/webauthn/register/options
```

**احراز هویت:** الزامی

**بدنه:**

```json
{ "label": "My Phone" }
```

```
POST /api/webauthn/register/verify
```

**احراز هویت:** الزامی

**بدنه:**

```json
{ "attestation": {}, "label": "My Phone", "challengeId": "uuid" }
```

### مدیریت اعتبارنامه

```
GET /api/webauthn/credentials
```

**احراز هویت:** الزامی. همه اعتبارنامه‌های ثبت‌شده را برمی‌گرداند.

```
DELETE /api/webauthn/credentials/:credId
```

**احراز هویت:** الزامی. یک اعتبارنامه را حذف می‌کند.

---

## دعوت‌نامه‌ها

### عمومی

```
GET /api/invites/validate/:code
```

محدود شده به نرخ: ۵ تلاش در IP.

**پاسخ:**

```json
{ "valid": true, "name": "...", "expiresAt": "..." }
```

```
POST /api/invites/redeem
```

**بدنه:**

```json
{ "code": "...", "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

محدود شده به نرخ: ۵ تلاش در IP.

### احراز هویت‌شده

```
GET /api/invites
```

**مجوز:** `invites:read`

```
POST /api/invites
```

**مجوز:** `invites:create`

**بدنه:**

```json
{ "name": "Jane Doe", "phone": "+1234567890", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/invites/:code
```

**مجوز:** `invites:revoke`

---

## داوطلبان

همه endpointهای داوطلب به `volunteers:read` به عنوان مجوز پایه نیاز دارند.

```
GET /api/volunteers
```

**مجوز:** `volunteers:read`

```
POST /api/volunteers
```

**مجوز:** `volunteers:create`

**بدنه:**

```json
{ "name": "string", "phone": "string", "roleIds": ["string"], "pubkey": "string" }
```

```
PATCH /api/volunteers/:targetPubkey
```

**مجوز:** `volunteers:update`

**بدنه:** فیلدهای جزئی داوطلب (`name`، `phone`، `roles`، `active` و غیره)

```
DELETE /api/volunteers/:targetPubkey
```

**مجوز:** `volunteers:delete`

---

## شیفت‌ها

```
GET /api/shifts/my-status
```

**احراز هویت:** الزامی (هر نقشی). وضعیت شیفت فعلی کاربر را برمی‌گرداند.

```
GET /api/shifts
```

**مجوز:** `shifts:read`

```
POST /api/shifts
```

**مجوز:** `shifts:create`

**بدنه:**

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

**مجوز:** `shifts:update`

```
DELETE /api/shifts/:id
```

**مجوز:** `shifts:delete`

### گروه زنگ بازگشتی

```
GET /api/shifts/fallback
```

**مجوز:** `shifts:manage-fallback`

```
PUT /api/shifts/fallback
```

**مجوز:** `shifts:manage-fallback`

**بدنه:**

```json
{ "fallbackPubkeys": ["hex64", "hex64"] }
```

محدود به hub: همه endpointهای شیفت همچنین در `/api/hubs/:hubId/shifts/*` در دسترس هستند.

---

## یادداشت‌ها

همه endpointهای یادداشت به `notes:read-own` به عنوان پایه نیاز دارند. کلاینت‌ها باید یادداشت‌ها را قبل از ارسال رمزنگاری کنند (برای قالب envelope ECIES به [مشخصات پروتکل](https://github.com/rhonda-rodododo/llamenos-platform/blob/main/docs/protocol/PROTOCOL.md) مراجعه کنید).

```
GET /api/notes?callId=...&page=1&limit=50
```

**مجوز:** `notes:read-own` (فقط خود) یا `notes:read-all` (همه یادداشت‌ها)

**پاسخ:**

```json
{ "notes": [], "total": 0 }
```

```
POST /api/notes
```

**مجوز:** `notes:create`

**بدنه:**

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

**مجوز:** `notes:update-own`

**بدنه:** همان شکل POST (با محتوای رمزنگاری شده و envelopeهای به‌روزرسانی‌شده).

محدود به hub: `/api/hubs/:hubId/notes/*`

---

## تماس‌ها

```
GET /api/calls/active
```

**مجوز:** `calls:read-active` (اطلاعات تماس‌گیرنده حذف شده) یا `calls:read-active-full`

```
GET /api/calls/today-count
```

**مجوز:** `calls:read-active`

```
GET /api/calls/presence
```

**مجوز:** `calls:read-presence`. وضعیت آنلاین/مشغول داوطلب را برمی‌گرداند.

```
GET /api/calls/history?page=1&limit=50&search=&dateFrom=&dateTo=
```

**مجوز:** `calls:read-history`

```
POST /api/calls/:callId/answer
```

**مجوز:** `calls:answer`. `409` را برمی‌گرداند اگر تماس قبلاً پاسخ داده شده باشد.

```
POST /api/calls/:callId/hangup
```

**مجوز:** `calls:answer`. `403` را برمی‌گرداند اگر تماس شما نباشد.

```
POST /api/calls/:callId/spam
```

**مجوز:** `calls:answer`. تماس را به عنوان هرزنامه علامت‌گذاری می‌کند.

```
GET /api/calls/:callId/recording
```

**مجوز:** `calls:read-recording` یا داوطلب پاسخ‌دهنده.

**پاسخ:** باینری `audio/wav` با `Cache-Control: private, no-store`.

```
GET /api/calls/debug
```

**مجوز:** `calls:debug`. وضعیت داخلی تماس را برای عیب‌یابی برمی‌گرداند.

محدود به hub: `/api/hubs/:hubId/calls/*`

---

## مکالمات

```
GET /api/conversations?status=&channel=&page=1&limit=50
```

**مجوز:** `conversations:read-all` یا `conversations:read-assigned` (خود + در انتظار)

**پاسخ:**

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

**احراز هویت:** الزامی

**پاسخ:**

```json
{ "total": 0, "active": 0, "waiting": 0, "closed": 0 }
```

```
GET /api/conversations/load
```

**مجوز:** `conversations:read-all`. تعداد مکالمات برای هر داوطلب را برمی‌گرداند.

```
GET /api/conversations/:id
```

**احراز هویت:** الزامی (دسترسی برای هر مکالمه بررسی می‌شود).

```
GET /api/conversations/:id/messages?page=1&limit=50
```

**احراز هویت:** الزامی (دسترسی بررسی می‌شود). پیام‌های رمزنگاری شده را برمی‌گرداند.

```
POST /api/conversations/:id/messages
```

**مجوز:** `conversations:send` یا `conversations:send-any`

**بدنه:**

```json
{
  "encryptedContent": "hex",
  "readerEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }],
  "plaintextForSending": "Hello"
}
```

فیلد `plaintextForSending` برای کانال‌های خارجی (SMS، WhatsApp، Signal) استفاده می‌شود. سرور پیام را از طریق آداپتور کانال ارسال می‌کند و سپس متن ساده را دور می‌ریزد.

```
PATCH /api/conversations/:id
```

**مجوز:** `conversations:update` یا داوطلب تعیین‌شده

**بدنه:**

```json
{ "status": "closed", "assignedTo": "hex64" }
```

```
POST /api/conversations/:id/claim
```

**مجوز:** `conversations:claim` + مخصوص کانال (مثلاً `conversations:claim-sms`)

محدود به hub: `/api/hubs/:hubId/conversations/*`

---

## گزارش‌ها

گزارش‌ها یک نوع تخصصی مکالمه با `metadata.type = "report"` هستند.

```
GET /api/reports?status=&category=&page=1&limit=50
```

**مجوز:** `reports:read-all`، `reports:read-assigned` یا `reports:read-own`

```
POST /api/reports
```

**مجوز:** `reports:create`

**بدنه:**

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

**مجوز:** `reports:read-all`، `reports:read-assigned` یا گزارش خود

```
GET /api/reports/:id/messages?page=1&limit=100
```

**احراز هویت:** الزامی (دسترسی بررسی می‌شود)

```
POST /api/reports/:id/messages
```

**مجوز:** `reports:send-message`، `reports:send-message-own` یا تعیین‌شده

**بدنه:**

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

**مجوز:** `reports:assign`

**بدنه:**

```json
{ "assignedTo": "hex64" }
```

```
PATCH /api/reports/:id
```

**مجوز:** `reports:update`

```
GET /api/reports/categories
```

**احراز هویت:** الزامی

```
GET /api/reports/:id/files
```

**احراز هویت:** الزامی (دسترسی بررسی می‌شود)

محدود به hub: `/api/hubs/:hubId/reports/*`

---

## مسدودها

```
POST /api/bans
```

**مجوز:** `bans:report`

**بدنه:**

```json
{ "phone": "+1234567890", "reason": "Spam caller" }
```

```
GET /api/bans
```

**مجوز:** `bans:read`

```
POST /api/bans/bulk
```

**مجوز:** `bans:bulk-create`

**بدنه:**

```json
{ "phones": ["+1234567890", "+0987654321"], "reason": "Imported ban list" }
```

```
DELETE /api/bans/:phone
```

**مجوز:** `bans:delete`

پارامتر `:phone` به صورت URL-encoded E.164 است (مثلاً `%2B12125551234`).

محدود به hub: `/api/hubs/:hubId/bans/*`

---

## تنظیمات

### ارائه‌دهنده تلفنی

```
GET /api/settings/telephony-provider
```

**مجوز:** `settings:manage-telephony`

```
PATCH /api/settings/telephony-provider
```

**مجوز:** `settings:manage-telephony`

**بدنه:** `TelephonyProviderConfig` (نوع ارائه‌دهنده + اعتبارنامه‌ها)

```
POST /api/settings/telephony-provider/test
```

**مجوز:** `settings:manage-telephony`

اعتبارنامه‌های ارائه‌دهنده را بدون ذخیره تست می‌کند.

### پیام‌رسانی

```
GET /api/settings/messaging
```

**مجوز:** `settings:manage-messaging`

```
PATCH /api/settings/messaging
```

**مجوز:** `settings:manage-messaging`

### کاهش هرزنامه

```
GET /api/settings/spam
```

**مجوز:** `settings:manage-spam`

```
PATCH /api/settings/spam
```

**مجوز:** `settings:manage-spam`

### تنظیمات تماس

```
GET /api/settings/call
```

**مجوز:** `settings:manage`

```
PATCH /api/settings/call
```

**مجوز:** `settings:manage`

### زبان‌های IVR

```
GET /api/settings/ivr-languages
```

**مجوز:** `settings:manage-ivr`

```
PATCH /api/settings/ivr-languages
```

**مجوز:** `settings:manage-ivr`

**بدنه:**

```json
{ "enabledLanguages": ["en", "es", "zh"] }
```

### صدای IVR

```
GET /api/settings/ivr-audio
```

**مجوز:** `settings:manage-ivr`

```
PUT /api/settings/ivr-audio/:promptType/:language
```

**مجوز:** `settings:manage-ivr`
**Content-Type:** `application/octet-stream` (بایت‌های صدای خام)

```
DELETE /api/settings/ivr-audio/:promptType/:language
```

**مجوز:** `settings:manage-ivr`

### رونویسی

```
GET /api/settings/transcription
```

**احراز هویت:** الزامی (هر نقشی)

**پاسخ:**

```json
{ "globalEnabled": true, "allowVolunteerOptOut": false }
```

```
PATCH /api/settings/transcription
```

**مجوز:** `settings:manage-transcription`

### فیلدهای سفارشی

```
GET /api/settings/custom-fields
```

**احراز هویت:** الزامی (فیلدها بر اساس نقش فیلتر می‌شوند)

```
PUT /api/settings/custom-fields
```

**مجوز:** `settings:manage-fields`

**بدنه:**

```json
{ "fields": [{ "id": "uuid", "name": "severity", "label": "Severity Rating", "type": "select", "required": true, "options": ["low", "medium", "high"], "visibleToVolunteers": true, "editableByVolunteers": true, "context": "call-notes", "order": 0 }] }
```

### تنظیمات WebAuthn

```
GET /api/settings/webauthn
```

**مجوز:** `settings:manage`

```
PATCH /api/settings/webauthn
```

**مجوز:** `settings:manage`

**بدنه:**

```json
{ "requireForAdmins": true, "requireForVolunteers": false }
```

### نقش‌ها (PBAC)

```
GET /api/settings/roles
```

**احراز هویت:** الزامی

```
POST /api/settings/roles
```

**مجوز:** `system:manage-roles`

**بدنه:**

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

**مجوز:** `system:manage-roles`

```
DELETE /api/settings/roles/:id
```

**مجوز:** `system:manage-roles`

### کاتالوگ مجوزها

```
GET /api/settings/permissions
```

**مجوز:** `system:manage-roles`

همه مجوزهای موجود را بر اساس دامنه سازماندهی شده برمی‌گرداند.

### وضعیت راه‌اندازی

```
GET /api/settings/setup
```

**مجوز:** `settings:manage`

```
PATCH /api/settings/setup
```

**مجوز:** `settings:manage`

---

## فایل‌ها

### جریان آپلود

آپلود تکه‌تکه برای پیوست‌های فایل رمزنگاری شده.

```
POST /api/uploads/init
```

**مجوز:** `files:upload`

**بدنه:**

```json
{
  "totalSize": 1048576,
  "totalChunks": 4,
  "conversationId": "uuid",
  "recipientEnvelopes": [],
  "encryptedMetadata": [{ "pubkey": "hex64", "encryptedContent": "hex", "ephemeralPubkey": "hex" }]
}
```

**پاسخ:**

```json
{ "uploadId": "uuid", "totalChunks": 4 }
```

```
PUT /api/uploads/:id/chunks/:chunkIndex
```

**مجوز:** `files:upload`
**Content-Type:** `application/octet-stream` (بایت‌های تکه رمزنگاری شده خام)

**پاسخ:**

```json
{ "chunkIndex": 0, "completedChunks": 1, "totalChunks": 4 }
```

```
POST /api/uploads/:id/complete
```

**مجوز:** `files:upload`

**پاسخ:**

```json
{ "fileId": "uuid", "status": "complete" }
```

`400` را برمی‌گرداند اگر همه تکه‌ها آپلود نشده باشند.

```
GET /api/uploads/:id/status
```

**مجوز:** `files:upload`

### دانلود

```
GET /api/files/:id/content
```

**مجوز:** `files:download-own` (اگر گیرنده) یا `files:download-all`

**پاسخ:** `application/octet-stream` (بایت‌های فایل رمزنگاری شده)

```
GET /api/files/:id/envelopes
```

**مجوز:** `files:download-own` یا `files:download-all`

کاربران غیرمدیر فقط envelope خود را دریافت می‌کنند.

```
GET /api/files/:id/metadata
```

**مجوز:** `files:download-own` یا `files:download-all`

```
POST /api/files/:id/share
```

**مجوز:** `files:share`

کلید فایل را برای یک گیرنده جدید دوباره رمزنگاری می‌کند.

---

## Blastها (پخش پیام)

### مشترکین

```
GET /api/blasts/subscribers?page=&limit=&tag=&status=
```

**احراز هویت:** الزامی

```
DELETE /api/blasts/subscribers/:id
```

**احراز هویت:** الزامی

```
GET /api/blasts/subscribers/stats
```

**احراز هویت:** الزامی

```
POST /api/blasts/subscribers/import
```

**احراز هویت:** الزامی

**بدنه:**

```json
{ "subscribers": [{ "phone": "+1234567890", "tags": ["alerts"] }] }
```

### Blastها

```
GET /api/blasts
```

**احراز هویت:** الزامی

```
POST /api/blasts
```

**احراز هویت:** الزامی

**بدنه:**

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

**احراز هویت:** الزامی

```
PATCH /api/blasts/:id
```

**احراز هویت:** الزامی

```
DELETE /api/blasts/:id
```

**احراز هویت:** الزامی

```
POST /api/blasts/:id/send
```

**احراز هویت:** الزامی. بلافاصله blast را ارسال می‌کند.

```
POST /api/blasts/:id/schedule
```

**احراز هویت:** الزامی

**بدنه:**

```json
{ "scheduledAt": "2026-03-01T12:00:00Z" }
```

```
POST /api/blasts/:id/cancel
```

**احراز هویت:** الزامی. یک blast زمان‌بندی شده را لغو می‌کند.

### تنظیمات Blast

```
GET /api/blasts/settings
```

**احراز هویت:** الزامی

```
PATCH /api/blasts/settings
```

**احراز هویت:** الزامی

محدود به hub: `/api/hubs/:hubId/blasts/*`

---

## Hubها

مدیریت چند مستأجر hub.

```
GET /api/hubs
```

**احراز هویت:** الزامی (فیلتر شده بر اساس عضویت؛ سوپر ادمین همه را می‌بیند)

```
POST /api/hubs
```

**مجوز:** `system:manage-hubs`

**بدنه:**

```json
{ "name": "NYC Hub", "slug": "nyc", "description": "New York City operations", "phoneNumber": "+1234567890" }
```

```
GET /api/hubs/:hubId
```

**احراز هویت:** الزامی (عضویت بررسی می‌شود)

```
PATCH /api/hubs/:hubId
```

**مجوز:** `system:manage-hubs`

### اعضای hub

```
POST /api/hubs/:hubId/members
```

**مجوز:** `volunteers:manage-roles`

**بدنه:**

```json
{ "pubkey": "hex64", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/hubs/:hubId/members/:pubkey
```

**مجوز:** `volunteers:manage-roles`

### مدیریت کلید hub

```
GET /api/hubs/:hubId/key
```

**احراز هویت:** الزامی (عضو hub). فقط envelope کلید hub wrapped با ECIES برای کاربر درخواست‌کننده را برمی‌گرداند.

```
PUT /api/hubs/:hubId/key
```

**مجوز:** `system:manage-hubs`

**بدنه:**

```json
{ "envelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }] }
```

---

## جادوگر راه‌اندازی

```
GET /api/setup/state
```

**احراز هویت:** الزامی

```
PATCH /api/setup/state
```

**مجوز:** `settings:manage`

```
POST /api/setup/complete
```

**مجوز:** `settings:manage`

**بدنه:**

```json
{}
```

همچنین یک hub پیش‌فرض ایجاد می‌کند اگر هیچ‌کدام وجود نداشته باشد.

### تست کانال‌ها

```
POST /api/setup/test/signal
```

**مجوز:** `settings:manage-messaging`

**بدنه:**

```json
{ "bridgeUrl": "http://signal-cli:8080", "bridgeApiKey": "secret" }
```

```
POST /api/setup/test/whatsapp
```

**مجوز:** `settings:manage-messaging`

**بدنه:**

```json
{ "phoneNumberId": "123456", "accessToken": "EAAx..." }
```

---

## گزارش حسابرسی

```
GET /api/audit?page=1&limit=50&actorPubkey=&eventType=&dateFrom=&dateTo=&search=
```

**مجوز:** `audit:read`

**پاسخ:**

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

گزارش حسابرسی از یک زنجیره هش SHA-256 (`previousEntryHash` + `entryHash`) برای تشخیص دستکاری استفاده می‌کند.

محدود به hub: `/api/hubs/:hubId/audit/*`

---

## WebRTC

```
GET /api/telephony/webrtc-token
```

**احراز هویت:** الزامی

یک توکن WebRTC مخصوص ارائه‌دهنده برای پاسخ‌گویی به تماس در مرورگر برمی‌گرداند.

**پاسخ:**

```json
{ "token": "string", "provider": "twilio", "identity": "hex64" }
```

`400` را برمی‌گرداند اگر ترجیح تماس روی تلفن تنظیم شده باشد.

```
GET /api/telephony/webrtc-status
```

**احراز هویت:** الزامی

**پاسخ:**

```json
{ "available": true, "provider": "twilio" }
```

---

## تدارک دستگاه

برای پیوند دادن دستگاه‌های جدید به یک حساب موجود از طریق تبادل کلید ephemeral ECDH.

```
POST /api/provision/rooms
```

**احراز هویت:** هیچ (دستگاه جدید هنوز احراز هویت ندارد)

**بدنه:**

```json
{ "ephemeralPubkey": "hex66" }
```

**پاسخ:**

```json
{ "roomId": "uuid", "token": "random_string" }
```

```
GET /api/provision/rooms/:id?token=<token>
```

**احراز هویت:** هیچ

**پاسخ:**

```json
{
  "status": "waiting",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64",
  "ephemeralPubkey": "hex66"
}
```

گذار وضعیت: `waiting` -> `ready` -> consumed. اتاق‌ها پس از ~۵ دقیقه منقضی می‌شوند.

```
POST /api/provision/rooms/:id/payload
```

**احراز هویت:** الزامی (دستگاه اصلی باید احراز هویت شده باشد)

**بدنه:**

```json
{
  "token": "string",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64"
}
```

---

## اعلان‌های فشاری (موبایل)

```
POST /api/devices/register
```

**احراز هویت:** الزامی

**بدنه:**

```json
{
  "platform": "ios",
  "pushToken": "apns_device_token",
  "voipToken": "ios_voip_push_token",
  "wakeKeyEnvelope": { "wrappedKey": "hex", "ephemeralPubkey": "hex" }
}
```

**پاسخ:**

```json
{ "deviceId": "uuid" }
```

اعلان‌های فشاری از یک طرح رمزنگاری دو لایه استفاده می‌کنند: یک کلید wake (بدون نیاز به PIN) برای متاداده اعلان، و کلید هویت (نیاز به PIN) برای محتوای حساس.

---

## webhookهای تلفنی

این endpointها توسط ارائه‌دهندگان تلفنی، نه کلاینت‌ها، فراخوانی می‌شوند. هر درخواست توسط امضای webhook ارائه‌دهنده اعتبارسنجی می‌شود.

```
POST /api/telephony/incoming
POST /api/telephony/language-selected
POST /api/telephony/captcha
POST /api/telephony/volunteer-answer
POST /api/telephony/call-status
POST /api/telephony/wait-music          (همچنین GET)
POST /api/telephony/queue-exit
POST /api/telephony/voicemail-complete
POST /api/telephony/call-recording
POST /api/telephony/voicemail-recording
```

مسیریابی hub از طریق پارامتر query `?hub=<hubId>` انجام می‌شود.

---

## webhookهای پیام‌رسانی

توسط ارائه‌دهندگان پیام‌رسانی فراخوانی می‌شوند. هر آداپتور امضای webhook خود را اعتبارسنجی می‌کند.

```
GET  /api/messaging/whatsapp/webhook    (تأیید webhook Meta)
GET  /api/messaging/rcs/webhook         (تأیید webhook Google RBM)
POST /api/messaging/:channel/webhook?hub=<hubId>
```

کانال‌های پشتیبانی‌شده: `sms`، `whatsapp`، `signal`، `rcs`.

---

## مسیرهای محدود به hub

همه مسیرهای زیر همچنین با پیشوند `/api/hubs/:hubId/` در دسترس هستند که آنها را به یک hub خاص محدود می‌کند:

- `/api/hubs/:hubId/shifts/*`
- `/api/hubs/:hubId/bans/*`
- `/api/hubs/:hubId/notes/*`
- `/api/hubs/:hubId/calls/*`
- `/api/hubs/:hubId/audit/*`
- `/api/hubs/:hubId/conversations/*`
- `/api/hubs/:hubId/reports/*`
- `/api/hubs/:hubId/blasts/*`

هنگام استفاده از مسیرهای محدود به hub، میان‌افزار `hubContext` مجوزهای مخصوص hub را برای کاربر حل می‌کند.

---

## پاسخ‌های خطا

همه پاسخ‌های خطا از این قالب پیروی می‌کنند:

```json
{ "error": "پیام خطای قابل فهم برای انسان" }
```

کدهای وضعیت HTTP رایج:

| کد | معنی |
|---|---|
| `400` | درخواست بد (بدنه malformed، فیلدهای گمشده، شکست اعتبارسنجی) |
| `401` | غیرمجاز (توکن auth گمشده یا نامعتبر) |
| `403` | ممنوع (auth معتبر اما مجوزهای ناکافی) |
| `404` | یافت نشد |
| `409` | تضاد (مثلاً تماس قبلاً پاسخ داده شده، منبع قبلاً وجود دارد) |
| `429` | درخواست‌های بیش از حد (محدود شده به نرخ) |
| `500` | خطای داخلی سرور |

---

## مرجع مجوزها

مجوزها از قالب `domain:action` پیروی می‌کنند. کاربران به نقش‌ها اختصاص داده می‌شوند و هر نقش مجموعه‌ای از مجوزها را در بر می‌گیرد. مجوزهای مؤثر اجتماع همه نقش‌های اختصاص داده شده است.

Wildcard `*` همه مجوزها را اعطا می‌کند. Wildcard دامنه `domain:*` همه عملیات در آن دامنه را اعطا می‌کند.

| دامنه | مجوزها |
|---|---|
| **calls** | `answer`، `read-active`، `read-active-full`، `read-history`، `read-presence`، `read-recording`، `debug` |
| **notes** | `create`، `read-own`، `read-all`، `read-assigned`، `update-own` |
| **reports** | `create`، `read-own`، `read-all`، `read-assigned`، `assign`، `update`، `send-message-own`، `send-message` |
| **conversations** | `read-assigned`، `read-all`، `claim`، `claim-sms`، `claim-whatsapp`، `claim-signal`، `claim-rcs`، `claim-web`، `claim-any`، `send`، `send-any`، `update` |
| **volunteers** | `read`، `create`، `update`، `delete`، `manage-roles` |
| **shifts** | `read-own`، `read`، `create`، `update`، `delete`، `manage-fallback` |
| **bans** | `report`، `read`، `create`، `bulk-create`، `delete` |
| **invites** | `read`، `create`، `revoke` |
| **settings** | `read`، `manage`، `manage-telephony`، `manage-messaging`، `manage-spam`، `manage-ivr`، `manage-fields`، `manage-transcription` |
| **audit** | `read` |
| **blasts** | `read`، `send`، `manage`، `schedule` |
| **files** | `upload`، `download-own`، `download-all`، `share` |
| **system** | `manage-roles`، `manage-hubs`، `manage-instance` |

### نقش‌های پیش‌فرض

| نقش | Slug | مجوزهای کلیدی |
|---|---|---|
| **Super Admin** | `role-super-admin` | `*` (همه مجوزها) |
| **Hub Admin** | `role-hub-admin` | `volunteers:*`، `shifts:*`، `settings:*`، `audit:read`، `bans:*`، `invites:*`، `notes:read-all`، `reports:*`، `conversations:*`، `calls:*`، `blasts:*`، `files:*` |
| **Reviewer** | `role-reviewer` | `notes:read-assigned`، `reports:read-assigned`، `reports:assign`، `reports:update`، `conversations:read-assigned`، `conversations:send`، `files:download-own`، `files:upload` |
| **Volunteer** | `role-volunteer` | `calls:answer`، `calls:read-active`، `notes:create`، `notes:read-own`، `notes:update-own`، `conversations:claim`، `conversations:send`، `conversations:read-assigned`، `bans:report`، `files:upload`، `files:download-own` |
| **Reporter** | `role-reporter` | `reports:create`، `reports:read-own`، `reports:send-message-own`، `files:upload`، `files:download-own` |

---

## endpointهای توسعه / تست

فقط در محیط‌های توسعه در دسترس هستند.

```
POST /api/test-reset            (بازنشانی کامل، نیاز به هدر X-Test-Secret)
POST /api/test-reset-no-admin   (بازنشانی بدون مدیر)
POST /api/test-reset-records    (بازنشانی سبک، هویت/تنظیمات را حفظ می‌کند)
```
