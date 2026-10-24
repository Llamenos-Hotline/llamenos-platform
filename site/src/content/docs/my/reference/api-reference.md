---
title: API ကိုးကား
description: Llámenos ဆာဗာအတွက် REST API endpoint ကိုးကားအပြည့်အစုံ။
---

ဤစာတမ်းသည် Llámenos ဆာဗာမှ ထုတ်ဖော်ပြသထားသော REST API endpoint တိုင်းကို ဖော်ပြသည်။ endpoint အားလုံးကို `/api` ဖြင့် ရှေ့ဆွဲထားသည်။ တောင်းဆိုမှုများနှင့် တုံ့ပြန်မှုများသည် အခြားသတ်မှတ်ချက်မရှိပါက JSON ကို အသုံးပြုသည်။ အချိန်တံဆိပ်အားလုံးသည် ISO 8601 စာကြောင်းများဖြစ်သည်။

backend သည် **Cloudflare Workers** (Durable Objects များဖြင့်) သို့မဟုတ် **ကိုယ်တိုင်လက်ခံဆောင်ရွက်ထား** (Node.js + PostgreSQL) ပေါ်တွင် လည်ပတ်သည်ဖြစ်စေ API သည် အတူတူပင်ဖြစ်သည်။ Durable Objects ခြောက်ခု — Identity, Settings, Records, ShiftManager, CallRouter နှင့် Conversation — တို့သည် အောက်တွင်ဖော်ပြထားသော ယုတ္တိရှိ API ဒိုမိန်းများသို့ မြေပုံဆွဲသည်။

## စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း

Llámenos သည် စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း ယန္တရားနှစ်ခုကို ပံ့ပိုးသည်။ စစ်မှန်ကြောင်းအထောက်အထားပြထားသော endpoint အားလုံးသည် ဤအရာများထဲမှ တစ်ခုကို လိုအပ်သည်။

### Schnorr လက်မှတ် စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း (အဓိက)

စစ်မှန်ကြောင်းအထောက်အထားပြထားသော တောင်းဆိုမှုတိုင်းသည် HTTP နည်းလမ်းနှင့် လမ်းကြောင်းတွင် ချည်နှောင်ထားသော ကိုယ်တိုင်လက်မှတ်ထိုး BIP-340 Schnorr token တစ်ခုကို သယ်ဆောင်သည်။

**Header ပုံစံ-**

```
Authorization: Bearer {"pubkey":"<64_hex>","timestamp":<ms>,"token":"<128_hex>"}
```

**Token တည်ဆောက်ခြင်း-**

၁။ မက်ဆေ့ချ်ကို တည်ဆောက်ပါ: `llamenos:auth:<pubkey>:<timestamp_ms>:<METHOD>:<path>`
၂။ SHA-256 ဖြင့် hash လုပ်ပါ
၃။ သင်၏ secp256k1 လျှို့ဝှက်သော့ကို အသုံးပြု၍ BIP-340 Schnorr ဖြင့် hash ကို လက်မှတ်ရေးထိုးပါ
၄. `pubkey`၊ `timestamp` နှင့် `token` (hex လက်မှတ်) အကွက်များပါသော inline JSON အဖြစ် ကုဒ်လုပ်ပါ

**အတည်ပြုခြင်းစည်းမျဉ်းများ-**

- Token အသစ်ဖြစ်မှု: `|now() - timestamp| <= 300,000 ms` (၅ မိနစ်ကြားကာလ)
- လက်မှတ်ကို ပြန်လည်တည်ဆောက်ထားသော မက်ဆေ့ချ် hash နှင့် အတည်ပြုသည်
- အသုံးပြုသူမှတ်တမ်းကို ဖြေရှင်းရန် အထောက်အထားသိုလှောင်ခန်းတွင် pubkey ကို ရှာဖွေသည်

### Session token စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း (WebAuthn)

WebAuthn စစ်မှန်ကြောင်း အခမ်းအနားတစ်ခုပြီးနောက်၊ ဆာဗာသည် ၈ နာရီကြာ သက်တမ်းရှိသော ကျပန်း 256-bit session token တစ်ခုကို ထုတ်ပေးသည်။

```
Authorization: Session <token_hex>
```

ဆာဗာသည် `Session` စစ်မှန်ကြောင်းအထောက်အထားပြခြင်းကို ဦးစွာစစ်ဆေးသည်။ header သည် `Session ` ဖြင့် စတင်ပါက Schnorr စစ်မှန်ကြောင်းအထောက်အထားပြခြင်းကို မကြိုးစားတော့ပါ၊ နှင့် အပြန်အလှန်လည်း ထို့အတူဖြစ်သည်။

---

## အများသုံး endpoint များ

ဤ endpoint များသည် စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း မလိုအပ်ပါ။

### ကျန်းမာရေးစစ်ဆေးခြင်း

```
GET /api/health
```

**တုံ့ပြန်မှု-**

```json
{ "status": "ok" }
```

### ဖွဲ့စည်းမှု

```
GET /api/config
```

အများသုံး hub ဖွဲ့စည်းမှု၊ ဖွင့်ထားသော ချန်နယ်များနှင့် ဆာဗာအထောက်အထားကို ပြန်ပေးသည်။

**တုံ့ပြန်မှု-**

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

### တည်ဆောက်မှုအတည်ပြုချက်

```
GET /api/config/verify
```

ပြန်လည်ထုတ်လုပ်နိုင်သော တည်ဆောက်မှုအတည်ပြုချက်အတွက် တည်ဆောက်မှုမက်တာဒေတာကို ပြန်ပေးသည်။

**တုံ့ပြန်မှု-**

```json
{
  "version": "1.0.0",
  "commit": "abc1234",
  "buildTime": "2024-01-01T00:00:00Z",
  "verificationUrl": "https://github.com/...",
  "trustAnchor": "GitHub Release checksums + SLSA provenance"
}
```

### IVR အသံ

```
GET /api/ivr-audio/:promptType/:language
```

ခေါ်ဆိုမှုများအတွင်း တယ်လီဖုန်းဝန်ဆောင်မှုပေးသူများမှ ရယူသော အသံဖိုင်များကို ပြန်ပေးသည်။

- `promptType`: `[a-z_-]+`
- `language`: `[a-z]{2,5}(-[A-Z]{2})?`
- **တုံ့ပြန်မှု:** `audio/wav` binary

### မက်ဆေ့ချ်ပို့ခြင်း ဦးစားပေးမှုများ

စာရင်းသွင်းသူ ဦးစားပေးမှုစီမံခန့်ခွဲမှုအတွက် token-အတည်ပြုထားသော အများသုံး endpoint များ။

```
GET  /api/messaging/preferences?token=<hmac_token>
PATCH /api/messaging/preferences?token=<hmac_token>
```

**PATCH ကိုယ်ထည်-**

```json
{ "status": "active", "language": "es" }
```

---

## စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း endpoint များ

### အကောင့်ဝင်ခြင်း

```
POST /api/auth/login
```

**ကိုယ်ထည်-**

```json
{ "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

**တုံ့ပြန်မှု-**

```json
{ "ok": true, "roles": ["role-super-admin"] }
```

နှုန်းကန့်သတ်ထား: IP တစ်ခုလျှင် ကြိုးစားမှု ၁၀ ကြိမ်။ မှားယွင်းသော အထောက်အထားများအတွက် `401` ကို ပြန်ပေးသည်။

### Bootstrap (ပထမဆုံး အက်ဒမင်)

```
POST /api/auth/bootstrap
```

ပထမဆုံး အက်ဒမင်အကောင့်ကို မှတ်ပုံတင်သည်။ အက်ဒမင်တစ်ဦးရှိနှင့်ပြီးပါက `403` ဖြင့် မအောင်မြင်ပါ။

**ကိုယ်ထည်:** အကောင့်ဝင်ခြင်းနှင့် အတူတူ။
**တုံ့ပြန်မှု:** အကောင့်ဝင်ခြင်းနှင့် အတူတူ။
နှုန်းကန့်သတ်ထား: IP တစ်ခုလျှင် ကြိုးစားမှု ၅ ကြိမ်။

### လက်ရှိအသုံးပြုသူကို ရယူခြင်း

```
GET /api/auth/me
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**တုံ့ပြန်မှု-**

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

### အကောင့်မှထွက်ခြင်း

```
POST /api/auth/me/logout
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်။ Session စစ်မှန်ကြောင်းအထောက်အထားပြခြင်းကို အသုံးပြုပါက token ကို ဆာဗာဘက်ခြမ်းတွင် ပြန်လည်ရုပ်သိမ်းသည်။

### ပရိုဖိုင်အပ်ဒိတ်

```
PATCH /api/auth/me/profile
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**ကိုယ်ထည်-**

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

အကွက်အားလုံးသည် ချန်လှပ်နိုင်သည်။ `callPreference` သည် `"phone"`, `"browser"` သို့မဟုတ် `"both"` ကို လက်ခံသည်။

### ရရှိနိုင်မှုအပ်ဒိတ်

```
PATCH /api/auth/me/availability
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**ကိုယ်ထည်-**

```json
{ "onBreak": true }
```

### စကားဝိုင်းမှတ်တမ်းဦးစားပေးမှုအပ်ဒိတ်

```
PATCH /api/auth/me/transcription
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**ကိုယ်ထည်-**

```json
{ "enabled": false }
```

အက်ဒမင်ဆက်တင်များမှ ငြင်းပယ်ခွင့်ကို ခွင့်မပြုပါက `403` ကို ပြန်ပေးသည်။

---

## WebAuthn

### အကောင့်ဝင်ခြင်းလုပ်ငန်းစဉ်

```
POST /api/webauthn/login/options
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** မလိုအပ်။ `challengeId` ပါသော `publicKeyCredentialRequestOptions` ကို ပြန်ပေးသည်။

```
POST /api/webauthn/login/verify
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** မလိုအပ်

**ကိုယ်ထည်-**

```json
{ "assertion": {}, "challengeId": "uuid" }
```

**တုံ့ပြန်မှု-**

```json
{ "token": "hex64", "pubkey": "hex64" }
```

### မှတ်ပုံတင်ခြင်းလုပ်ငန်းစဉ်

```
POST /api/webauthn/register/options
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**ကိုယ်ထည်-**

```json
{ "label": "My Phone" }
```

```
POST /api/webauthn/register/verify
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**ကိုယ်ထည်-**

```json
{ "attestation": {}, "label": "My Phone", "challengeId": "uuid" }
```

### အထောက်အထားစီမံခန့်ခွဲမှု

```
GET /api/webauthn/credentials
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်။ မှတ်ပုံတင်ထားသော အထောက်အထားအားလုံးကို ပြန်ပေးသည်။

```
DELETE /api/webauthn/credentials/:credId
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်။ အထောက်အထားတစ်ခုကို ဖယ်ရှားသည်။

---

## ဖိတ်ကြားချက်များ

### အများသုံး

```
GET /api/invites/validate/:code
```

နှုန်းကန့်သတ်ထား: IP တစ်ခုလျှင် ကြိုးစားမှု ၅ ကြိမ်။

**တုံ့ပြန်မှု-**

```json
{ "valid": true, "name": "...", "expiresAt": "..." }
```

```
POST /api/invites/redeem
```

**ကိုယ်ထည်-**

```json
{ "code": "...", "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

နှုန်းကန့်သတ်ထား: IP တစ်ခုလျှင် ကြိုးစားမှု ၅ ကြိမ်။

### စစ်မှန်ကြောင်းအထောက်အထားပြထား

```
GET /api/invites
```

**ခွင့်ပြုချက်:** `invites:read`

```
POST /api/invites
```

**ခွင့်ပြုချက်:** `invites:create`

**ကိုယ်ထည်-**

```json
{ "name": "Jane Doe", "phone": "+1234567890", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/invites/:code
```

**ခွင့်ပြုချက်:** `invites:revoke`

---

## စေတနာ့ဝန်ထမ်းများ

စေတနာ့ဝန်ထမ်း endpoint အားလုံးသည် အခြေခံခွင့်ပြုချက်အဖြစ် `volunteers:read` လိုအပ်သည်။

```
GET /api/volunteers
```

**ခွင့်ပြုချက်:** `volunteers:read`

```
POST /api/volunteers
```

**ခွင့်ပြုချက်:** `volunteers:create`

**ကိုယ်ထည်-**

```json
{ "name": "string", "phone": "string", "roleIds": ["string"], "pubkey": "string" }
```

```
PATCH /api/volunteers/:targetPubkey
```

**ခွင့်ပြုချက်:** `volunteers:update`

**ကိုယ်ထည်:** တစ်စိတ်တစ်ပိုင်း စေတနာ့ဝန်ထမ်းအကွက်များ (`name`, `phone`, `roles`, `active`, စသည်)

```
DELETE /api/volunteers/:targetPubkey
```

**ခွင့်ပြုချက်:** `volunteers:delete`

---

## အလုပ်ချိန်များ

```
GET /api/shifts/my-status
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည် (မည်သည့်အခန်းကဏ္ဍမဆို)။ လက်ရှိအသုံးပြုသူ၏ အလုပ်ချိန်အခြေအနေကို ပြန်ပေးသည်။

```
GET /api/shifts
```

**ခွင့်ပြုချက်:** `shifts:read`

```
POST /api/shifts
```

**ခွင့်ပြုချက်:** `shifts:create`

**ကိုယ်ထည်-**

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

**ခွင့်ပြုချက်:** `shifts:update`

```
DELETE /api/shifts/:id
```

**ခွင့်ပြုချက်:** `shifts:delete`

### အရန်ခေါ်ဆိုမှုအဖွဲ့

```
GET /api/shifts/fallback
```

**ခွင့်ပြုချက်:** `shifts:manage-fallback`

```
PUT /api/shifts/fallback
```

**ခွင့်ပြုချက်:** `shifts:manage-fallback`

**ကိုယ်ထည်-**

```json
{ "fallbackPubkeys": ["hex64", "hex64"] }
```

Hub-ဘောင်သတ်မှတ်ထား: အလုပ်ချိန် endpoint အားလုံးသည် ` /api/hubs/:hubId/shifts/*` တွင်လည်း ရရှိနိုင်သည်။

---

## မှတ်စုများ

မှတ်စု endpoint အားလုံးသည် အခြေခံအဖြစ် `notes:read-own` လိုအပ်သည်။ Client များသည် မပို့မီ မှတ်စုများကို ကုဒ်ဝှက်ရမည် (ECIES စာအိတ်ပုံစံအတွက် [ပရိုတိုကောသတ်မှတ်ချက်](https://github.com/rhonda-rodododo/llamenos-platform/blob/main/docs/protocol/PROTOCOL.md) ကို ကြည့်ပါ)။

```
GET /api/notes?callId=...&page=1&limit=50
```

**ခွင့်ပြုချက်:** `notes:read-own` (ကိုယ်ပိုင်သာ) သို့မဟုတ် `notes:read-all` (မှတ်စုအားလုံး)

**တုံ့ပြန်မှု-**

```json
{ "notes": [], "total": 0 }
```

```
POST /api/notes
```

**ခွင့်ပြုချက်:** `notes:create`

**ကိုယ်ထည်-**

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

**ခွင့်ပြုချက်:** `notes:update-own`

**ကိုယ်ထည်:** POST နှင့် ပုံစံတူ (အပ်ဒိတ်လုပ်ထားသော ကုဒ်ဝှက်ထားသောအကြောင်းအရာနှင့် စာအိတ်များဖြင့်)။

Hub-ဘောင်သတ်မှတ်ထား: `/api/hubs/:hubId/notes/*`

---

## ခေါ်ဆိုမှုများ

```
GET /api/calls/active
```

**ခွင့်ပြုချက်:** `calls:read-active` (ခေါ်ဆိုသူအချက်အလက် ဖျောက်ထား) သို့မဟုတ် `calls:read-active-full`

```
GET /api/calls/today-count
```

**ခွင့်ပြုချက်:** `calls:read-active`

```
GET /api/calls/presence
```

**ခွင့်ပြုချက်:** `calls:read-presence`။ စေတနာ့ဝန်ထမ်း အွန်လိုင်း/အလုပ်များ အခြေအနေကို ပြန်ပေးသည်။

```
GET /api/calls/history?page=1&limit=50&search=&dateFrom=&dateTo=
```

**ခွင့်ပြုချက်:** `calls:read-history`

```
POST /api/calls/:callId/answer
```

**ခွင့်ပြုချက်:** `calls:answer`။ ခေါ်ဆိုမှုကို ဖြေကြားပြီးသားဖြစ်ပါက `409` ကို ပြန်ပေးသည်။

```
POST /api/calls/:callId/hangup
```

**ခွင့်ပြုချက်:** `calls:answer`။ သင့်ခေါ်ဆိုမှုမဟုတ်ပါက `403` ကို ပြန်ပေးသည်။

```
POST /api/calls/:callId/spam
```

**ခွင့်ပြုချက်:** `calls:answer`။ ခေါ်ဆိုမှုကို စပမ်းအဖြစ် မှတ်သားသည်။

```
GET /api/calls/:callId/recording
```

**ခွင့်ပြုချက်:** `calls:read-recording` သို့မဟုတ် ဖြေကြားသော စေတနာ့ဝန်ထမ်း။

**တုံ့ပြန်မှု:** `Cache-Control: private, no-store` ပါသော `audio/wav` binary။

```
GET /api/calls/debug
```

**ခွင့်ပြုချက်:** `calls:debug`။ ပြဿနာဖြေရှင်းခြင်းအတွက် အတွင်းပိုင်းခေါ်ဆိုမှုအခြေအနေကို ပြန်ပေးသည်။

Hub-ဘောင်သတ်မှတ်ထား: `/api/hubs/:hubId/calls/*`

---

## ဆွေးနွေးမှုများ

```
GET /api/conversations?status=&channel=&page=1&limit=50
```

**ခွင့်ပြုချက်:** `conversations:read-all` သို့မဟုတ် `conversations:read-assigned` (ကိုယ်ပိုင် + စောင့်ဆိုင်းနေသော)

**တုံ့ပြန်မှု-**

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

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**တုံ့ပြန်မှု-**

```json
{ "total": 0, "active": 0, "waiting": 0, "closed": 0 }
```

```
GET /api/conversations/load
```

**ခွင့်ပြုချက်:** `conversations:read-all`။ စေတနာ့ဝန်ထမ်းတစ်ဦးချင်းအလိုက် ဆွေးနွေးမှုအရေအတွက်များကို ပြန်ပေးသည်။

```
GET /api/conversations/:id
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည် (ဆွေးနွေးမှုအလိုက် ဝင်ရောက်ခွင့်စစ်ဆေးထား)။

```
GET /api/conversations/:id/messages?page=1&limit=50
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည် (ဝင်ရောက်ခွင့်စစ်ဆေးထား)။ ကုဒ်ဝှက်ထားသော မက်ဆေ့ချ်များကို ပြန်ပေးသည်။

```
POST /api/conversations/:id/messages
```

**ခွင့်ပြုချက်:** `conversations:send` သို့မဟုတ် `conversations:send-any`

**ကိုယ်ထည်-**

```json
{
  "encryptedContent": "hex",
  "readerEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }],
  "plaintextForSending": "Hello"
}
```

`plaintextForSending` အကွက်ကို ပြင်ပချန်နယ်များ (SMS, WhatsApp, Signal) အတွက် အသုံးပြုသည်။ ဆာဗာသည် ချန်နယ် adapter မှတစ်ဆင့် မက်ဆေ့ချ်ကိုပို့ပြီး ရိုးရိုးစာသားကို စွန့်ပစ်သည်။

```
PATCH /api/conversations/:id
```

**ခွင့်ပြုချက်:** `conversations:update` သို့မဟုတ် သတ်မှတ်ထားသော စေတနာ့ဝန်ထမ်း

**ကိုယ်ထည်-**

```json
{ "status": "closed", "assignedTo": "hex64" }
```

```
POST /api/conversations/:id/claim
```

**ခွင့်ပြုချက်:** `conversations:claim` + ချန်နယ်အလိုက် (ဥပမာ၊ `conversations:claim-sms`)

Hub-ဘောင်သတ်မှတ်ထား: `/api/hubs/:hubId/conversations/*`

---

## အစီရင်ခံစာများ

အစီရင်ခံစာများသည် `metadata.type = "report"` ပါသော အထူးပြုဆွေးနွေးမှုအမျိုးအစားတစ်ခုဖြစ်သည်။

```
GET /api/reports?status=&category=&page=1&limit=50
```

**ခွင့်ပြုချက်:** `reports:read-all`, `reports:read-assigned` သို့မဟုတ် `reports:read-own`

```
POST /api/reports
```

**ခွင့်ပြုချက်:** `reports:create`

**ကိုယ်ထည်-**

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

**ခွင့်ပြုချက်:** `reports:read-all`, `reports:read-assigned` သို့မဟုတ် ကိုယ်ပိုင်အစီရင်ခံစာ

```
GET /api/reports/:id/messages?page=1&limit=100
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည် (ဝင်ရောက်ခွင့်စစ်ဆေးထား)

```
POST /api/reports/:id/messages
```

**ခွင့်ပြုချက်:** `reports:send-message`, `reports:send-message-own` သို့မဟုတ် သတ်မှတ်ထား

**ကိုယ်ထည်-**

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

**ခွင့်ပြုချက်:** `reports:assign`

**ကိုယ်ထည်-**

```json
{ "assignedTo": "hex64" }
```

```
PATCH /api/reports/:id
```

**ခွင့်ပြုချက်:** `reports:update`

```
GET /api/reports/categories
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

```
GET /api/reports/:id/files
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည် (ဝင်ရောက်ခွင့်စစ်ဆေးထား)

Hub-ဘောင်သတ်မှတ်ထား: `/api/hubs/:hubId/reports/*`

---

## တားမြစ်စာရင်းများ

```
POST /api/bans
```

**ခွင့်ပြုချက်:** `bans:report`

**ကိုယ်ထည်-**

```json
{ "phone": "+1234567890", "reason": "Spam caller" }
```

```
GET /api/bans
```

**ခွင့်ပြုချက်:** `bans:read`

```
POST /api/bans/bulk
```

**ခွင့်ပြုချက်:** `bans:bulk-create`

**ကိုယ်ထည်-**

```json
{ "phones": ["+1234567890", "+0987654321"], "reason": "Imported ban list" }
```

```
DELETE /api/bans/:phone
```

**ခွင့်ပြုချက်:** `bans:delete`

`:phone` ကန့်သတ်ချက်သည် URL-ကုဒ်လုပ်ထားသော E.164 (ဥပမာ၊ `%2B12125551234`) ဖြစ်သည်။

Hub-ဘောင်သတ်မှတ်ထား: `/api/hubs/:hubId/bans/*`

---

## ဆက်တင်များ

### တယ်လီဖုန်းဝန်ဆောင်မှုပေးသူ

```
GET /api/settings/telephony-provider
```

**ခွင့်ပြုချက်:** `settings:manage-telephony`

```
PATCH /api/settings/telephony-provider
```

**ခွင့်ပြုချက်:** `settings:manage-telephony`

**ကိုယ်ထည်:** `TelephonyProviderConfig` (ဝန်ဆောင်မှုပေးသူအမျိုးအစား + အထောက်အထားများ)

```
POST /api/settings/telephony-provider/test
```

**ခွင့်ပြုချက်:** `settings:manage-telephony`

သိမ်းဆည်းခြင်းမရှိဘဲ ဝန်ဆောင်မှုပေးသူအထောက်အထားများကို စမ်းသပ်သည်။

### မက်ဆေ့ချ်ပို့ခြင်း

```
GET /api/settings/messaging
```

**ခွင့်ပြုချက်:** `settings:manage-messaging`

```
PATCH /api/settings/messaging
```

**ခွင့်ပြုချက်:** `settings:manage-messaging`

### စပမ်းလျှော့ချရေး

```
GET /api/settings/spam
```

**ခွင့်ပြုချက်:** `settings:manage-spam`

```
PATCH /api/settings/spam
```

**ခွင့်ပြုချက်:** `settings:manage-spam`

### ခေါ်ဆိုမှုဆက်တင်များ

```
GET /api/settings/call
```

**ခွင့်ပြုချက်:** `settings:manage`

```
PATCH /api/settings/call
```

**ခွင့်ပြုချက်:** `settings:manage`

### IVR ဘာသာစကားများ

```
GET /api/settings/ivr-languages
```

**ခွင့်ပြုချက်:** `settings:manage-ivr`

```
PATCH /api/settings/ivr-languages
```

**ခွင့်ပြုချက်:** `settings:manage-ivr`

**ကိုယ်ထည်-**

```json
{ "enabledLanguages": ["en", "es", "zh"] }
```

### IVR အသံ

```
GET /api/settings/ivr-audio
```

**ခွင့်ပြုချက်:** `settings:manage-ivr`

```
PUT /api/settings/ivr-audio/:promptType/:language
```

**ခွင့်ပြုချက်:** `settings:manage-ivr`
**Content-Type:** `application/octet-stream` (အသံ bytes အစိမ်း)

```
DELETE /api/settings/ivr-audio/:promptType/:language
```

**ခွင့်ပြုချက်:** `settings:manage-ivr`

### စကားဝိုင်းမှတ်တမ်း

```
GET /api/settings/transcription
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည် (မည်သည့်အခန်းကဏ္ဍမဆို)

**တုံ့ပြန်မှု-**

```json
{ "globalEnabled": true, "allowVolunteerOptOut": false }
```

```
PATCH /api/settings/transcription
```

**ခွင့်ပြုချက်:** `settings:manage-transcription`

### စိတ်ကြိုက်အကွက်များ

```
GET /api/settings/custom-fields
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည် (အခန်းကဏ္ဍအလိုက် စစ်ထုတ်ထားသော အကွက်များကို ပြန်ပေးသည်)

```
PUT /api/settings/custom-fields
```

**ခွင့်ပြုချက်:** `settings:manage-fields`

**ကိုယ်ထည်-**

```json
{ "fields": [{ "id": "uuid", "name": "severity", "label": "Severity Rating", "type": "select", "required": true, "options": ["low", "medium", "high"], "visibleToVolunteers": true, "editableByVolunteers": true, "context": "call-notes", "order": 0 }] }
```

### WebAuthn ဆက်တင်များ

```
GET /api/settings/webauthn
```

**ခွင့်ပြုချက်:** `settings:manage`

```
PATCH /api/settings/webauthn
```

**ခွင့်ပြုချက်:** `settings:manage`

**ကိုယ်ထည်-**

```json
{ "requireForAdmins": true, "requireForVolunteers": false }
```

### အခန်းကဏ္ဍများ (PBAC)

```
GET /api/settings/roles
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

```
POST /api/settings/roles
```

**ခွင့်ပြုချက်:** `system:manage-roles`

**ကိုယ်ထည်-**

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

**ခွင့်ပြုချက်:** `system:manage-roles`

```
DELETE /api/settings/roles/:id
```

**ခွင့်ပြုချက်:** `system:manage-roles`

### ခွင့်ပြုချက်များစာရင်း

```
GET /api/settings/permissions
```

**ခွင့်ပြုချက်:** `system:manage-roles`

ဒိုမိန်းအလိုက် စုစည်းထားသော ရရှိနိုင်သည့် ခွင့်ပြုချက်အားလုံးကို ပြန်ပေးသည်။

### တည်ဆောက်မှုအခြေအနေ

```
GET /api/settings/setup
```

**ခွင့်ပြုချက်:** `settings:manage`

```
PATCH /api/settings/setup
```

**ခွင့်ပြုချက်:** `settings:manage`

---

## ဖိုင်များ

### အပ်လုဒ်လုပ်ငန်းစဉ်

ကုဒ်ဝှက်ထားသော ဖိုင်ပူးတွဲမှုများအတွက် အပိုင်းလိုက်အပ်လုဒ်။

```
POST /api/uploads/init
```

**ခွင့်ပြုချက်:** `files:upload`

**ကိုယ်ထည်-**

```json
{
  "totalSize": 1048576,
  "totalChunks": 4,
  "conversationId": "uuid",
  "recipientEnvelopes": [],
  "encryptedMetadata": [{ "pubkey": "hex64", "encryptedContent": "hex", "ephemeralPubkey": "hex" }]
}
```

**တုံ့ပြန်မှု-**

```json
{ "uploadId": "uuid", "totalChunks": 4 }
```

```
PUT /api/uploads/:id/chunks/:chunkIndex
```

**ခွင့်ပြုချက်:** `files:upload`
**Content-Type:** `application/octet-stream` (ကုဒ်ဝှက်ထားသော အပိုင်း bytes အစိမ်းများ)

**တုံ့ပြန်မှု-**

```json
{ "chunkIndex": 0, "completedChunks": 1, "totalChunks": 4 }
```

```
POST /api/uploads/:id/complete
```

**ခွင့်ပြုချက်:** `files:upload`

**တုံ့ပြန်မှု-**

```json
{ "fileId": "uuid", "status": "complete" }
```

အပိုင်းအားလုံးကို အပ်လုဒ်မလုပ်ရသေးပါက `400` ကို ပြန်ပေးသည်။

```
GET /api/uploads/:id/status
```

**ခွင့်ပြုချက်:** `files:upload`

### ဒေါင်းလုဒ်

```
GET /api/files/:id/content
```

**ခွင့်ပြုချက်:** `files:download-own` (လက်ခံသူဖြစ်ပါက) သို့မဟုတ် `files:download-all`

**တုံ့ပြန်မှု:** `application/octet-stream` (ကုဒ်ဝှက်ထားသော ဖိုင် bytes)

```
GET /api/files/:id/envelopes
```

**ခွင့်ပြုချက်:** `files:download-own` သို့မဟုတ် `files:download-all`

အက်ဒမင်မဟုတ်သော သုံးစွဲသူများသည် ၎င်းတို့၏ ကိုယ်ပိုင်စာအိတ်ကိုသာ ရရှိသည်။

```
GET /api/files/:id/metadata
```

**ခွင့်ပြုချက်:** `files:download-own` သို့မဟုတ် `files:download-all`

```
POST /api/files/:id/share
```

**ခွင့်ပြုချက်:** `files:share`

လက်ခံသူအသစ်အတွက် ဖိုင်သော့ကို ပြန်လည်ကုဒ်ဝှက်သည်။

---

## Blasts (မက်ဆေ့ချ်ထုတ်လွှင့်ခြင်း)

### စာရင်းသွင်းသူများ

```
GET /api/blasts/subscribers?page=&limit=&tag=&status=
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

```
DELETE /api/blasts/subscribers/:id
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

```
GET /api/blasts/subscribers/stats
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

```
POST /api/blasts/subscribers/import
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**ကိုယ်ထည်-**

```json
{ "subscribers": [{ "phone": "+1234567890", "tags": ["alerts"] }] }
```

### Blasts

```
GET /api/blasts
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

```
POST /api/blasts
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**ကိုယ်ထည်-**

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

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

```
PATCH /api/blasts/:id
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

```
DELETE /api/blasts/:id
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

```
POST /api/blasts/:id/send
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်။ blast ကို ချက်ချင်းပို့သည်။

```
POST /api/blasts/:id/schedule
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**ကိုယ်ထည်-**

```json
{ "scheduledAt": "2026-03-01T12:00:00Z" }
```

```
POST /api/blasts/:id/cancel
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်။ စီစဉ်ထားသော blast ကို ပယ်ဖျက်သည်။

### Blast ဆက်တင်များ

```
GET /api/blasts/settings
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

```
PATCH /api/blasts/settings
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

Hub-ဘောင်သတ်မှတ်ထား: `/api/hubs/:hubId/blasts/*`

---

## Hubs

လူများစုငှားရမ်းသူ hub စီမံခန့်ခွဲမှု။

```
GET /api/hubs
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည် (အဖွဲ့ဝင်အဖြစ်အလိုက် စစ်ထုတ်ထား; စူပါအက်ဒမင်က အားလုံးကိုမြင်)

```
POST /api/hubs
```

**ခွင့်ပြုချက်:** `system:manage-hubs`

**ကိုယ်ထည်-**

```json
{ "name": "NYC Hub", "slug": "nyc", "description": "New York City operations", "phoneNumber": "+1234567890" }
```

```
GET /api/hubs/:hubId
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည် (အဖွဲ့ဝင်အဖြစ်စစ်ဆေးထား)

```
PATCH /api/hubs/:hubId
```

**ခွင့်ပြုချက်:** `system:manage-hubs`

### Hub အဖွဲ့ဝင်များ

```
POST /api/hubs/:hubId/members
```

**ခွင့်ပြုချက်:** `volunteers:manage-roles`

**ကိုယ်ထည်-**

```json
{ "pubkey": "hex64", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/hubs/:hubId/members/:pubkey
```

**ခွင့်ပြုချက်:** `volunteers:manage-roles`

### Hub သော့စီမံခန့်ခွဲမှု

```
GET /api/hubs/:hubId/key
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည် (hub အဖွဲ့ဝင်)။ တောင်းဆိုသော သုံးစွဲသူ၏ ECIES-ထုပ်ပိုးထားသော hub သော့စာအိတ်ကိုသာ ပြန်ပေးသည်။

```
PUT /api/hubs/:hubId/key
```

**ခွင့်ပြုချက်:** `system:manage-hubs`

**ကိုယ်ထည်-**

```json
{ "envelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }] }
```

---

## တည်ဆောက်မှုလမ်းညွှန်

```
GET /api/setup/state
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

```
PATCH /api/setup/state
```

**ခွင့်ပြုချက်:** `settings:manage`

```
POST /api/setup/complete
```

**ခွင့်ပြုချက်:** `settings:manage`

**ကိုယ်ထည်-**

```json
{}
```

မရှိသေးပါက ပုံသေ hub တစ်ခုကိုလည်း ဖန်တီးသည်။

### ချန်နယ်စမ်းသပ်မှုများ

```
POST /api/setup/test/signal
```

**ခွင့်ပြုချက်:** `settings:manage-messaging`

**ကိုယ်ထည်-**

```json
{ "bridgeUrl": "http://signal-cli:8080", "bridgeApiKey": "secret" }
```

```
POST /api/setup/test/whatsapp
```

**ခွင့်ပြုချက်:** `settings:manage-messaging`

**ကိုယ်ထည်-**

```json
{ "phoneNumberId": "123456", "accessToken": "EAAx..." }
```

---

## စာရင်းစစ်မှတ်တမ်း

```
GET /api/audit?page=1&limit=50&actorPubkey=&eventType=&dateFrom=&dateTo=&search=
```

**ခွင့်ပြုချက်:** `audit:read`

**တုံ့ပြန်မှု-**

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

စာရင်းစစ်မှတ်တမ်းသည် အနှောင့်အယှက်ရှာဖွေခြင်းအတွက် SHA-256 hash ကွင်းဆက် (`previousEntryHash` + `entryHash`) ကို အသုံးပြုသည်။

Hub-ဘောင်သတ်မှတ်ထား: `/api/hubs/:hubId/audit/*`

---

## WebRTC

```
GET /api/telephony/webrtc-token
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

ဘရောက်ဆာအတွင်း ခေါ်ဆိုမှုဖြေကြားခြင်းအတွက် ဝန်ဆောင်မှုပေးသူအလိုက် WebRTC token ကို ပြန်ပေးသည်။

**တုံ့ပြန်မှု-**

```json
{ "token": "string", "provider": "twilio", "identity": "hex64" }
```

ခေါ်ဆိုမှုဦးစားပေးမှုကို ဖုန်းသာသတ်မှတ်ထားပါက `400` ကို ပြန်ပေးသည်။

```
GET /api/telephony/webrtc-status
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**တုံ့ပြန်မှု-**

```json
{ "available": true, "provider": "twilio" }
```

---

## စက်ပစ္စည်းထောက်ပံ့ခြင်း

လက်ရှိအကောင့်သို့ စက်ပစ္စည်းအသစ်များကို ခဏတာ ECDH သော့လဲလှယ်ခြင်းမှတစ်ဆင့် ချိတ်ဆက်ရန်အတွက်။

```
POST /api/provision/rooms
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** မလိုအပ် (စက်ပစ္စည်းအသစ်တွင် စစ်မှန်ကြောင်းအထောက်အထားမရှိ)

**ကိုယ်ထည်-**

```json
{ "ephemeralPubkey": "hex66" }
```

**တုံ့ပြန်မှု-**

```json
{ "roomId": "uuid", "token": "random_string" }
```

```
GET /api/provision/rooms/:id?token=<token>
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** မလိုအပ်

**တုံ့ပြန်မှု-**

```json
{
  "status": "waiting",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64",
  "ephemeralPubkey": "hex66"
}
```

အခြေအနေပြောင်းလဲမှုများ: `waiting` -> `ready` -> သုံးပြီး။ အခန်းများသည် ~၅ မိနစ်အကြာတွင် သက်တမ်းကုန်သည်။

```
POST /api/provision/rooms/:id/payload
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည် (အဓိကစက်ပစ္စည်း စစ်မှန်ကြောင်းအထောက်အထားပြထားရမည်)

**ကိုယ်ထည်-**

```json
{
  "token": "string",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64"
}
```

---

## Push အကြောင်းကြားချက်များ (မိုဘိုင်း)

```
POST /api/devices/register
```

**စစ်မှန်ကြောင်းအထောက်အထားပြခြင်း:** လိုအပ်သည်

**ကိုယ်ထည်-**

```json
{
  "platform": "ios",
  "pushToken": "apns_device_token",
  "voipToken": "ios_voip_push_token",
  "wakeKeyEnvelope": { "wrappedKey": "hex", "ephemeralPubkey": "hex" }
}
```

**တုံ့ပြန်မှု-**

```json
{ "deviceId": "uuid" }
```

Push အကြောင်းကြားချက်များသည် အဆင့်နှစ်ဆင့် ကုဒ်ဝှက်စနစ်ကို အသုံးပြုသည်- အကြောင်းကြားချက်မက်တာဒေတာအတွက် နှိုးသော့ (PIN မလိုအပ်) နှင့် ထိလွယ်ရှလွယ်အကြောင်းအရာအတွက် မှတ်ပုံတင်သော့ (PIN လိုအပ်) တို့ဖြစ်သည်။

---

## တယ်လီဖုန်းဝန်ဆောင်မှုပေးသူ webhooks

ဤ endpoint များကို client များမဟုတ်ဘဲ တယ်လီဖုန်းဝန်ဆောင်မှုပေးသူများက ခေါ်ဆိုသည်။ တောင်းဆိုမှုတစ်ခုစီကို ဝန်ဆောင်မှုပေးသူ၏ webhook လက်မှတ်ဖြင့် အတည်ပြုသည်။

```
POST /api/telephony/incoming
POST /api/telephony/language-selected
POST /api/telephony/captcha
POST /api/telephony/volunteer-answer
POST /api/telephony/call-status
POST /api/telephony/wait-music          (GET လည်းရ)
POST /api/telephony/queue-exit
POST /api/telephony/voicemail-complete
POST /api/telephony/call-recording
POST /api/telephony/voicemail-recording
```

Hub လမ်းကြောင်းသတ်မှတ်ခြင်းသည် `?hub=<hubId>` query parameter မှတစ်ဆင့် ဖြစ်သည်။

---

## မက်ဆေ့ချ်ပို့ခြင်း webhooks

မက်ဆေ့ချ်ဝန်ဆောင်မှုပေးသူများက ခေါ်ဆိုသည်။ adapter တစ်ခုစီသည် ၎င်း၏ကိုယ်ပိုင် webhook လက်မှတ်ကို အတည်ပြုသည်။

```
GET  /api/messaging/whatsapp/webhook    (Meta webhook အတည်ပြုခြင်း)
GET  /api/messaging/rcs/webhook         (Google RBM webhook အတည်ပြုခြင်း)
POST /api/messaging/:channel/webhook?hub=<hubId>
```

ပံ့ပိုးထားသော ချန်နယ်များ: `sms`, `whatsapp`, `signal`, `rcs`။

---

## Hub-ဘောင်သတ်မှတ်ထားသော လမ်းကြောင်းများ

အောက်ပါလမ်းကြောင်းအားလုံးသည် `/api/hubs/:hubId/` ရှေ့ဆွဲဖြင့်လည်း ရရှိနိုင်ပြီး ၎င်းတို့ကို သတ်မှတ် hub တစ်ခုတွင် ဘောင်သတ်မှတ်သည်-

- `/api/hubs/:hubId/shifts/*`
- `/api/hubs/:hubId/bans/*`
- `/api/hubs/:hubId/notes/*`
- `/api/hubs/:hubId/calls/*`
- `/api/hubs/:hubId/audit/*`
- `/api/hubs/:hubId/conversations/*`
- `/api/hubs/:hubId/reports/*`
- `/api/hubs/:hubId/blasts/*`

Hub-ဘောင်သတ်မှတ်ထားသော လမ်းကြောင်းများကို အသုံးပြုသောအခါ `hubContext` middleware သည် သုံးစွဲသူအတွက် hub-အလိုက် ခွင့်ပြုချက်များကို ဖြေရှင်းပေးသည်။

---

## အမှားတုံ့ပြန်မှုများ

အမှားတုံ့ပြန်မှုအားလုံးသည် ဤပုံစံအတိုင်း လိုက်နာသည်-

```json
{ "error": "Human-readable error message" }
```

အသုံးများသော HTTP အခြေအနေကုဒ်များ-

| ကုဒ် | အဓိပ္ပာယ် |
|---|---|
| `400` | တောင်းဆိုမှုမမှန်ကန် (ကိုယ်ထည်ပုံစံမကျ၊ အကွက်များပျောက်ဆုံး၊ အတည်ပြုချက်မအောင်မြင်) |
| `401` | ခွင့်ပြုချက်မရှိ (စစ်မှန်ကြောင်းအထောက်အထားပြ token ပျောက်ဆုံး သို့မဟုတ် မမှန်ကန်) |
| `403` | တားမြစ်ထား (တရားဝင်စစ်မှန်ကြောင်းအထောက်အထားရှိသော်လည်း ခွင့်ပြုချက်မလုံလောက်) |
| `404` | ရှာမတွေ့ |
| `409` | ပဋိပက္ခ (ဥပမာ၊ ခေါ်ဆိုမှုကို ဖြေကြားပြီးသား၊ အရင်းအမြစ်ရှိနှင့်ပြီးသား) |
| `429` | တောင်းဆိုမှုများလွန်းသည် (နှုန်းကန့်သတ်ထား) |
| `500` | အတွင်းပိုင်းဆာဗာအမှား |

---

## ခွင့်ပြုချက်ကိုးကား

ခွင့်ပြုချက်များသည် `domain:action` ပုံစံအတိုင်း လိုက်နာသည်။ သုံးစွဲသူများကို အခန်းကဏ္ဍများ သတ်မှတ်ပေးထားပြီး အခန်းကဏ္ဍတစ်ခုစီသည် ခွင့်ပြုချက်အစုတစ်ခုကို စုစည်းထားသည်။ ထိရောက်သောခွင့်ပြုချက်များသည် သတ်မှတ်ထားသော အခန်းကဏ္ဍအားလုံး၏ ပေါင်းစည်းမှုဖြစ်သည်။

Wildcard `*` သည် ခွင့်ပြုချက်အားလုံးကို ပေးအပ်သည်။ ဒိုမိန်း wildcard `domain:*` သည် ထိုဒိုမိန်းရှိ လုပ်ဆောင်ချက်အားလုံးကို ပေးအပ်သည်။

| ဒိုမိန်း | ခွင့်ပြုချက်များ |
|---|---|
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

### ပုံသေအခန်းကဏ္ဍများ

| အခန်းကဏ္ဍ | Slug | အဓိကခွင့်ပြုချက်များ |
|---|---|---|
| **စူပါအက်ဒမင်** | `role-super-admin` | `*` (ခွင့်ပြုချက်အားလုံး) |
| **Hub အက်ဒမင်** | `role-hub-admin` | `volunteers:*`, `shifts:*`, `settings:*`, `audit:read`, `bans:*`, `invites:*`, `notes:read-all`, `reports:*`, `conversations:*`, `calls:*`, `blasts:*`, `files:*` |
| **ပြန်လည်သုံးသပ်သူ** | `role-reviewer` | `notes:read-assigned`, `reports:read-assigned`, `reports:assign`, `reports:update`, `conversations:read-assigned`, `conversations:send`, `files:download-own`, `files:upload` |
| **စေတနာ့ဝန်ထမ်း** | `role-volunteer` | `calls:answer`, `calls:read-active`, `notes:create`, `notes:read-own`, `notes:update-own`, `conversations:claim`, `conversations:send`, `conversations:read-assigned`, `bans:report`, `files:upload`, `files:download-own` |
| **အစီရင်ခံသူ** | `role-reporter` | `reports:create`, `reports:read-own`, `reports:send-message-own`, `files:upload`, `files:download-own` |

---

## ဖွံ့ဖြိုးတိုးတက်ရေး / စမ်းသပ်မှု endpoint များ

ဖွံ့ဖြိုးတိုးတက်ရေးပတ်ဝန်းကျင်များတွင်သာ ရရှိနိုင်သည်။

```
POST /api/test-reset            (အပြည့်အဝပြန်သတ်မှတ်ခြင်း, X-Test-Secret header လိုအပ်)
POST /api/test-reset-no-admin   (အက်ဒမင်မပါဘဲ ပြန်သတ်မှတ်ခြင်း)
POST /api/test-reset-records    (ပေါ့ပါးသောပြန်သတ်မှတ်ခြင်း, identity/settings ကိုထိန်းသိမ်းထား)
```
