# Llamenos Protocol: REST API: Signal and firehose

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.40 Signal Admin

Signal-specific admin routes for identity trust and queue monitoring.

```
GET /api/messaging/signal/identities
Permission: settings:manage-messaging
Query: ?hub=<hubId>
Response: { "identities": SignalIdentityRecord[] }

GET /api/messaging/signal/identities/untrusted
Permission: settings:manage-messaging
Query: ?hub=<hubId>
Response: { "identities": SignalIdentityRecord[] }

POST /api/messaging/signal/identities/trust
Permission: settings:manage-messaging
Body: { "uuid": string, "trustLevel": "trusted"|"untrusted"|"verified", "hubId"?: string }
Response: { "success": boolean }

GET /api/messaging/signal/queue/stats
Permission: settings:manage-messaging
Query: ?hub=<hubId>
Response: SignalQueueStats

GET /api/messaging/signal/queue/dead-letters
Permission: settings:manage-messaging
Query: ?hub=<hubId>
Response: { "deadLetters": unknown[] }

POST /api/messaging/signal/queue/retry/:id
Permission: settings:manage-messaging
Response: { "success": boolean }
```

### 4.41 Firehose

Firehose connection management for inference agents. Hub-scoped and global.

```
GET    /api/firehose
Permission: firehose:read
Response: { "connections": FirehoseConnection[] }

POST   /api/firehose
Permission: firehose:manage
Body: CreateFirehoseConnectionBody
Response: { "connection": FirehoseConnection } (201)

GET    /api/firehose/status
Permission: firehose:read
Response: { "statuses": FirehoseConnectionStatus[] }

GET    /api/firehose/:id
Permission: firehose:read
Response: { "connection": FirehoseConnection }

PATCH  /api/firehose/:id
Permission: firehose:manage
Body: UpdateFirehoseConnectionBody
Response: { "connection": FirehoseConnection }

DELETE /api/firehose/:id
Permission: firehose:manage
Response: { "ok": true }

POST   /api/firehose/:id/activate
Permission: firehose:manage
Response: { "connection": FirehoseConnection }

POST   /api/firehose/:id/pause
Permission: firehose:manage
Response: { "connection": FirehoseConnection }

GET    /api/firehose/:id/buffer
Permission: firehose:read
Response: { "connectionId": string, "bufferSize": number, "agentRunning": boolean, "extractionIntervalSec": number, "bufferTtlDays": number }

DELETE /api/firehose/:id/buffer
Permission: firehose:manage
Response: { "purged": number }

POST   /api/firehose/:id/optout
Permission: firehose:read
Response: { "id": string, "connectionId": string, "userId": string, "optedOutAt": ISO8601 }

DELETE /api/firehose/:id/optout
Permission: firehose:read
Response: { "ok": true }
```

Hub-scoped: `/api/hubs/:hubId/firehose/*`

### 4.42 Signal Notifications

Zero-knowledge Signal notification sidecar integration.

```
GET    /api/signal-notification/contact
Auth: Required
Response: { "identifierHash": hex, "identifierCiphertext": hex, "identifierEnvelope": hex, "identifierType": string, "verifiedAt"?: ISO8601, "updatedAt": ISO8601 }
Error: 404 if not registered

PUT    /api/signal-notification/contact
Auth: Required
Body: { "identifierHash": hex, "identifierCiphertext": hex, "identifierEnvelope": hex, "identifierType": string }
Response: { "ok": true }

POST   /api/signal-notification/contact/sidecar-token
Auth: Required
Response: { "token": string, "sidecarUrl": string }

DELETE /api/signal-notification/contact
Auth: Required
Response: 204 No Content

GET    /api/signal-notification/hmac-key
Auth: Required
Response: { "hmacKey": hex }

GET    /api/signal-notification/security-prefs
Auth: Required
Response: SecurityPrefs

PATCH  /api/signal-notification/security-prefs
Auth: Required
Body: SecurityPrefsPatch
Response: SecurityPrefs

POST   /api/signal-notification/digest/run
Permission: system:admin
Body: { "cadence"?: "daily"|"weekly" }
Response: DigestResult
```

