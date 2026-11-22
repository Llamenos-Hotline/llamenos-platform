# Llamenos Protocol: REST API: public endpoints and authentication

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.1 Public Endpoints (No Auth)

#### Health Check

```
GET /api/health
Response: { "status": "ok" }
```

#### Configuration

```
GET /api/config
Response: {
  "hotlineName": "Hotline",
  "hotlineNumber": "+1234567890",
  "channels": {
    "voice": true, "sms": false, "whatsapp": false,
    "signal": false, "rcs": false, "reports": true
  },
  "setupCompleted": true,
  "needsBootstrap": false,
  "hubs": [{ "id": "...", "name": "...", "slug": "...", ... }],
  "defaultHubId": "...",
  "serverWebSocketPubkey": "hex_64",
  "WebSocketRelayUrl": "wss://...",
  "apiVersion": "1.0.0",
  "minApiVersion": "0.9.0",
  "sentryDsn"?: "https://..."   // Optional, only if GlitchTip/Sentry is configured
}
```

#### Build Verification

```
GET /api/config/verify
Response: {
  "version": "1.0.0",
  "commit": "abc1234",
  "buildTime": "2024-01-01T00:00:00Z",
  "verificationUrl": "https://github.com/...",
  "trustAnchor": "GitHub Release checksums + SLSA provenance"
}
```

#### IVR Audio (Public -- Twilio Fetches During Calls)

```
GET /api/ivr-audio/:promptType/:language           // platform default
GET /api/ivr-audio/:hubId/:promptType/:language    // a call in that hub
Response: audio/wav binary
// promptType: [a-z_-]+, language: [a-z]{2,5}(-[A-Z]{2})?
// Both are signed and expiring (?exp=&sig=); the hub is inside the signed path.
// The hub form serves that hub's recording, else the platform default.
```

#### Messaging Preferences (Token-Validated, No Auth)

```
GET /api/messaging/preferences?token=<hmac_token>
Response: subscriber preference data

PATCH /api/messaging/preferences?token=<hmac_token>
Body: { status?: string, language?: string, ... }
```

### 4.2 Authentication

#### Login

```
POST /api/auth/login
Body: { "pubkey": "hex64", "timestamp": ms, "token": "hex128" }
Response: { "ok": true, "roles": ["role-super-admin"] }
Error: 401 { "error": "Invalid credentials" }
Rate limited: 10 attempts per IP
```

#### Bootstrap (First Admin Registration)

```
POST /api/auth/bootstrap
Body: { "pubkey": "hex64", "timestamp": ms, "token": "hex128" }
Response: { "ok": true, "roles": ["role-super-admin"] }
Error: 403 { "error": "Admin already exists" }
Rate limited: 5 attempts per IP
```

#### Get Current User (Auth Required)

```
GET /api/auth/me
Auth: Bearer or Session
Response: {
  "pubkey": "hex64",
  "roles": ["role-super-admin"],
  "permissions": ["*"],
  "primaryRole": { "id": "role-super-admin", "name": "Super Admin", "slug": "super-admin" } | null,
  "name": "Admin",
  "transcriptionEnabled": true,
  "spokenLanguages": ["en", "es"],
  "uiLanguage": "en",
  "profileCompleted": true,
  "onBreak": false,
  "callPreference": "phone",
  "webauthnRequired": false,
  "webauthnRegistered": true,
  "adminDecryptionPubkey"?: "hex64",    // Optional, present for admins
  "serverEventKeyHex"?: "hex64"         // Optional, server event signing key
}
```

#### Logout

```
POST /api/auth/me/logout
Auth: Bearer or Session
Response: { "ok": true }
// If using Session auth, the token is revoked server-side
// If that was the user's LAST live session (same liveness test as the auth
// middleware: not expired, not past its absolute lifetime, signing key not
// revoked), the user is also clocked out of every hub and each is audited as
// `shiftClockOut`. Otherwise they stay on shift and keep ringing on their other
// signed-in devices. Only sessions are revoked — never devices or keys.
// A client MUST send this before discarding its credentials: a logout the
// server never hears about leaves the user clocked in and being rung.
```

#### Update Profile

```
PATCH /api/auth/me/profile
Auth: Required
Body: {
  "name"?: string,
  "phone"?: string (E.164),
  "spokenLanguages"?: string[],
  "uiLanguage"?: string,
  "profileCompleted"?: boolean,
  "callPreference"?: "phone" | "browser" | "both"
}
Response: { "ok": true }
```

#### Update Availability

```
PATCH /api/auth/me/availability
Auth: Required
Body: { "onBreak": boolean }
Response: { "ok": true }
```

#### Update Transcription Preference

```
PATCH /api/auth/me/transcription
Auth: Required
Body: { "enabled": boolean }
Response: { "ok": true }
Error: 403 if opt-out is not allowed by admin
```

### 4.3 WebAuthn

#### Login Flow

```
POST /api/webauthn/login/options
Auth: None
Response: { ...publicKeyCredentialRequestOptions, "challengeId": "uuid" }

POST /api/webauthn/login/verify
Auth: None
Body: { "assertion": WebAuthnAssertion, "challengeId": "uuid" }
Response: { "token": "hex64", "pubkey": "hex64" }
// Returns a session token for subsequent requests
```

#### Registration Flow (Auth Required)

```
POST /api/webauthn/register/options
Auth: Required
Body: { "label": "My Phone" }
Response: { ...publicKeyCredentialCreationOptions, "challengeId": "uuid" }

POST /api/webauthn/register/verify
Auth: Required
Body: { "attestation": WebAuthnAttestation, "label": "My Phone", "challengeId": "uuid" }
Response: { "ok": true }
```

#### Credential Management (Auth Required)

```
GET /api/webauthn/credentials
Auth: Required
Response: { "credentials": [{ "id", "label", "backedUp", "createdAt", "lastUsedAt" }] }

DELETE /api/webauthn/credentials/:credId
Auth: Required
Response: { "ok": true }
```

### 4.4 Invites

#### Public (No Auth)

```
GET /api/invites/validate/:code
Response: { "valid": true, "name": "...", "expiresAt": "..." }
Rate limited: 5 attempts per IP

POST /api/invites/redeem
Body: { "code": "...", "pubkey": "hex64", "timestamp": ms, "token": "hex128", "nonce"?: "..." }
Response: { "volunteer": User }
Rate limited: 5 attempts per IP
Audited: userAdded, with the redeemer as actor and the inviter in the details
409: the invite names no hub (it predates #2194) — nothing is guessed for it
```

`pubkey` is the redeeming device's own Ed25519 signing key, made on that device;
the token proves possession. This is the only way a user is provisioned: no admin,
server or client ever generates a key on someone else's behalf (#1231).

#### Authenticated (Requires `invites:read`)

```
GET /api/invites
Permission: invites:read
Response: { "invites": InviteCode[] }

POST /api/invites
Permission: invites:create (in the invite's hub)
Body: { "name": string, "phone": string (E.164), "roleIds"?: string[], "hubId"?: string }
Response: { "invite": InviteCode }
An invite always names a hub and at least one role (#2194). An omitted hubId
resolves to the sole active hub, else the caller's sole membership, else 400; a
server with no hub yet answers 409. Omitted roleIds take the hub template's
default member role; when it names none, 400.

DELETE /api/invites/:code
Permission: invites:revoke
Response: { "ok": true }
```

