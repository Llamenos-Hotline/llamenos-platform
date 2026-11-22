# Llamenos Protocol: REST API: WebRTC, device provisioning, webhooks and health

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.18 WebRTC

```
GET /api/telephony/webrtc-token
Auth: Required
Response: { "token": string, "provider": string, "identity": string }
Error: 400 "Call preference is set to phone only"

GET /api/telephony/webrtc-status
Auth: Required
Response: { "available": boolean, "provider": "twilio"|"signalwire"|null }
```

### 4.19 Device Provisioning

These are the endpoints the deployed server implements today (`apps/worker/routes/provisioning.ts`). Section 6 specifies the full linking ceremony and marks, per subsection, which parts are in force and which are specified but not yet implemented; §6.14 is the authoritative conformance matrix.

```
POST /api/provision/rooms
Auth: None (new device has no auth)
Body: { "ephemeralPubkey": string }   // hex(ePK), 32-byte X25519 pubkey (64 hex chars)
                                      // server-side validation is min-length 60 only
Response: { "roomId": "uuid", "token": "random_string" }   // token = 16 random bytes, 128 bits

GET /api/provision/rooms/:id?token=<token>
Auth: None (token is the room's access control)
Response, 200, one of:
  { "status": "waiting", "ephemeralPubkey": hex64 }
  { "status": "ready",   "ephemeralPubkey": hex64,
    "encryptedNsec": string,          // §6.7.2 bundle payload, hex186
    "primaryPubkey": hex64 }          // primary Ed25519 signing pubkey
  { "status": "expired" }             // status only; the row is deleted
Room not found: 404.  Wrong token: 403.
Per-room cap: 3 token presentations per room per 10 minutes → 429 + Retry-After.
A "ready" read consumes the room (atomic DELETE … RETURNING); it is single-use.

POST /api/provision/rooms/:id/payload
Auth: Required (primary device must be authenticated)
Body: {
  "token": string,
  "encryptedNsec": string,   // hex(nonce||ct||tag), §6.7.2 — hex186
  "primaryPubkey": string    // primary Ed25519 signing pubkey, hex64
}
Response: { "ok": true }
Room not found: 404.  Wrong token: 403.  Room expired: 410.
```

Field-length validation: the Zod schemas in `packages/protocol/schemas/provisioning.ts`
(`createRoomBodySchema`, `roomPayloadBodySchema`, `provisionRoomResponseSchema`,
`provisionRoomStatusResponseSchema`) enforce only minimum lengths today
(`ephemeralPubkey` ≥ 60 chars; `token`, `encryptedNsec`, `primaryPubkey` ≥ 1).
The exact-length rules in §6.8 are a client-side obligation, not a server guarantee.

The server relays ciphertext only: it cannot decrypt the payload or compute the SAS,
and it stores `encryptedNsec` as an opaque column.

> **Not implemented.** §6.3/§6.8 specify a `POST /api/provision/rooms/:id/claim` step and
> a `primaryClaim` field on the GET response — the primary's signed, per-room ephemeral
> X25519 key (§6.3.1). Neither exists in the server, the database schema, or any client —
> see §6.14. Do not build against them until they land.

### 4.20 Telephony Webhooks

These endpoints are called by telephony providers (Twilio, SignalWire, etc.), not by clients. Each request is validated by the provider's webhook signature, not Llamenos auth. Hub routing is via `?hub=<hubId>` query parameter — except `/call-recording`, whose callback carries none: its hub is resolved from the call (`active_calls`, then `call_records`), and its signature is validated with THAT hub's adapter, the one its recording is then fetched and deleted through (#2309). `/call-status` and `/user-answer` carry none either, and their hub is resolved from the leg's opaque `callToken` ONLY: a status callback with no usable token is answered `200` and acted on not at all — the call SID is never taken from the query, because Plivo's signature leaves the query out and Bandwidth's Basic auth binds no part of the request (#2627). Query values other than an allowlist (`hub`, `lang`, `forceLang`, `auto`, `round`) are never written to the log.

```
POST /api/telephony/incoming
POST /api/telephony/language-selected
POST /api/telephony/captcha
POST /api/telephony/volunteer-answer
POST /api/telephony/call-status
POST /api/telephony/wait-music  (also GET)
POST /api/telephony/queue-exit
POST /api/telephony/voicemail-complete
POST /api/telephony/call-recording
POST /api/telephony/voicemail-recording
```

### 4.21 Messaging Webhooks

These endpoints are called by messaging providers. Each adapter validates its own webhook signature.

```
GET  /api/messaging/whatsapp/webhook    (Meta webhook verification)
GET  /api/messaging/rcs/webhook         (Google RBM webhook verification)
POST /api/messaging/:channel/webhook?hub=<hubId>
// channel: sms | whatsapp | signal | rcs
```

`?hub=` is required on the inbound messaging webhook. The messaging senders are deployment-wide, so the receiving address cannot name a hub the way a dialled voice number does. After the signature check, a message whose URL names no hub gets `400`, and one that names a hub that does not exist gets `404`. Neither is stored (#2395).

### 4.22 Development / Test (Development Environment Only)

```
POST /api/test-reset            (full reset, requires X-Test-Secret header)
POST /api/test-reset-no-admin   (reset without admin)
POST /api/test-reset-records    (light reset, preserves identity/settings)
```

### 4.23 Health Probes

Kubernetes health probes. No auth required.

```
GET /api/health
Response: { "status": "ok" | "degraded", "checks": { postgres, storage, relay, sipBridge }, "version": string }

GET /api/health/live
Response: { "status": "ok", "eventLoopLagMs": number, "heapUsedMb": number }

GET /api/health/ready
Response: { "status": "ok" | "degraded", "checks": { postgres, storage, relay, sipBridge }, "version": string }
```

