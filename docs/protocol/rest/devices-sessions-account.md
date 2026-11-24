# Llamenos Protocol: REST API: devices, sessions and account

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.24 Devices

Device registration and push token management. All routes require auth.

```
GET    /api/devices
Auth: Required
Response: { "devices": DeviceDetail[] }

POST   /api/devices/register
Auth: Required
Body: { "platform": "ios"|"android", "pushToken": string, "wakeKeyPublic": hex66, "ed25519Pubkey"?: hex64, "x25519Pubkey"?: hex64, "deviceName"?: string, "deviceModel"?: string, "osVersion"?: string, "appVersion"?: string }
Response: 204 No Content
Rate limit: strict (5/hour)

POST   /api/devices/voip-token
Auth: Required
Body: { "platform": "ios"|"android", "voipToken": string }
Response: 204 No Content

DELETE /api/devices/voip-token
Auth: Required
Response: 204 No Content

PATCH  /api/devices/:id
Auth: Required
Body: { "deviceName": string }
Response: { "id": string, "deviceName": string }

POST   /api/devices/:id/revoke
Auth: Required
Body: { "confirm": true, "signature"?: hex128, "sigchainHash"?: hex64, "sigchainSeqNo"?: number, "sigchainPrevHash"?: hex64 }
Response: { "revoked": true, "deviceId": string, "hubIdsRequiringKeyRotation": string[], "pukRotationNeeded": boolean }
Rate limit: strict (3/hour)

POST   /api/devices/:id/verify
Permission: users:manage-devices
Body: { "signedAuditEntry": hex }
Response: { "verified": true, "verificationId": string }

DELETE /api/devices/:id
Auth: Required
Response: 204 No Content

DELETE /api/devices
Auth: Required
Response: 204 No Content
```

### 4.25 Sessions

Session management. All routes require auth.

```
GET    /api/sessions
Auth: Required
Response: { "sessions": SessionInfo[] }

POST   /api/sessions/terminate-others
Auth: Required
Response: { "terminated": number }
Rate limit: write (10/hour)

DELETE /api/sessions/:id
Auth: Required
Response: 204 No Content
Rate limit: write (10/hour)
```

### 4.26 Security Events

Security event logging for device and session lifecycle.

```
GET /api/security-events
Auth: Required (own events only)
Query: ?limit=&offset=
Response: { "events": SecurityEvent[], "total": number }

GET /api/admin/security-events
Permission: audit:read
Query: ?limit=&offset=
Response: { "events": SecurityEvent[], "total": number }
```

### 4.27 Account

Emergency account lockdown and recovery reporting.

```
POST /api/account/lockdown
Auth: Required (fresh auth — session token not accepted)
Response: { "sessionsTerminated": number, "hubIds": string[] }

POST /api/account/lockdown/complete
Auth: Required
Body: { "pukRotated": boolean, "hubKeysRotated": string[], "hubKeysFailed": string[] }
Response: { "ok": true }
```

### 4.28 Admin Devices

Admin device oversight.

```
GET /api/admin/devices/overview
Permission: users:manage-devices
Query: ?hubId=&limit=&offset=
Response: AdminDeviceOverview
```

