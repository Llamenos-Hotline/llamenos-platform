# Llamenos Protocol: REST API supplement: erasure, retention, firehose, geocoding, MLS, incidents

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.33 Erasure (GDPR Right to be Forgotten)

```
GET    /api/erasure/me
       Permission: erasure:request-self
       Response: { "request": ErasureRequest | null }

POST   /api/erasure/me
       Permission: erasure:request-self
       Body: { "justification": string }
       Response: { "request": ErasureRequest }

POST   /api/erasure/me/emergency
       Permission: erasure:request-self
       Body: { "justification": string, "coApproverPubkey": hex, "coApproverSignature": hex, "timestamp": number }
       Response: { "request": ErasureRequest }

DELETE /api/erasure/me
       Permission: erasure:request-self
       Response: { "ok": true }

GET    /api/hubs/:hubId/erasure/requests?status=&limit=&offset=
       Permission: erasure:admin
       Response: { "requests": ErasureRequest[], "total": number }

POST   /api/hubs/:hubId/erasure/:userId
       Permission: erasure:admin
       Body: { "justification": string }
       Response: { "ok": true, "envelopeRevocationJobIds": string[] }

POST   /api/hubs/:hubId/erasure/:userId/wipe-device/:devicePubkey
       Permission: erasure:admin
       Body: { "reason": string }
       Response: { "ok": true }

GET    /api/hubs/:hubId/erasure/envelope-revocation-jobs?userId=
       Permission: erasure:admin
       Response: { "jobs": EnvelopeRevocationJob[] }

(Hub-scoped since #2363 — see §4.45 for the scoping rules and the platform-scope `GET /api/erasure/platform/requests`.)
```

### 4.34 Retention

```
GET    /api/retention
       Permission: retention:manage
       Response: { "settings": RetentionSetting[] }

PATCH  /api/retention
       Permission: retention:manage
       Body: { "settings": [{ "category": string, "retentionDays": number }] }
       Response: { "settings": RetentionSetting[] }

GET    /api/retention/platform-floors
       Permission: system:manage-instance
       Response: { "floors": RetentionFloor[] }

PATCH  /api/retention/platform-floors
       Permission: system:manage-instance
       Body: { "floors": [{ "category": string, "minRetentionDays": number }] }
       Response: { "floors": RetentionFloor[] }
```

Hub-scoped: `/api/hubs/:hubId/retention/*`

### 4.35 Firehose (Inference Agent)

```
GET    /api/firehose
       Permission: firehose:read
       Response: { "connections": FirehoseConnection[] }

POST   /api/firehose
       Permission: firehose:manage
       Body: FirehoseConnectionInput
       Response: { "connection": FirehoseConnection }

GET    /api/firehose/:id
       Permission: firehose:read
       Response: { "connection": FirehoseConnection }

PATCH  /api/firehose/:id
       Permission: firehose:manage
       Body: partial FirehoseConnectionInput
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
       Response: { "connectionId": string, "bufferSize": number, "agentRunning": boolean }

DELETE /api/firehose/:id/buffer
       Permission: firehose:manage
       Response: { "purged": number }

POST   /api/firehose/:id/optout
       Permission: firehose:read
       Response: OptoutRecord

DELETE /api/firehose/:id/optout
       Permission: firehose:read
       Response: { "ok": true }

GET    /api/firehose/status
       Permission: firehose:read
       Response: { "statuses": FirehoseStatus[] }
```

Hub-scoped: `/api/hubs/:hubId/firehose/*`

### 4.36 Geocoding

```
POST   /api/geocoding/autocomplete
       Permission: notes:read-own (baseline volunteer access)
       Body: { "query": string, "limit"?: number }
       Response: LocationResult[]

POST   /api/geocoding/geocode
       Permission: notes:read-own
       Body: { "address": string }
       Response: LocationResult | null

POST   /api/geocoding/reverse
       Permission: notes:read-own
       Body: { "lat": number, "lon": number }
       Response: LocationResult | null
```

### 4.37 MLS (Message Layer Security)

Hub-scoped: `/api/hubs/:hubId/mls/*`. Phase 6 feature for hub-state group messaging.

```
POST   /api/hubs/:hubId/mls/commit
       Auth: Required (hub member)
       Body: { "recipientDeviceIds": string[], "payload": base64url }
       Response: 204 No Content

POST   /api/hubs/:hubId/mls/welcome
       Auth: Required (hub member)
       Body: { "recipientDeviceId": string, "payload": base64url }
       Response: 204 No Content

GET    /api/hubs/:hubId/mls/messages?deviceId=
       Auth: Required (hub member)
       Response: { "messages": MlsMessage[] }

POST   /api/hubs/:hubId/mls/key-packages?deviceId=
       Auth: Required (hub member)
       Body: { "keyPackages": base64url[] }
       Response: 204 No Content
```

### 4.38 Additional Endpoints

The following endpoints are also implemented. See `apps/worker/routes/` for full details:

- **`/api/admin/security-events`** — Admin security event log (see Section 4.26)
- **`/api/hubs/:hubId/events/*`** — Deprecated calendar/scheduling events (Sunset: 2026-07-01); migrate to Records API (Section 4.31)
- **`/api/system/*`** — System status and health diagnostics
- **`/api/analytics/*`** — Usage analytics and metrics
- **`/api/account/*`** — Account-level operations
- **`/api/provider-setup/*`** — Telephony/messaging provider configuration
- **`/api/provider-templates/*`** — Provider template management
- **`/api/hubs/:hubId/ring-groups/*`** — Call ring group management
- **`/api/admin/bans/*`** — Platform-level ban management
- **`/api/settings/platform/*`** — Platform-level settings
- **`/api/signal-notification/*`** — Signal notifier integration
- **`/api/hubs/:hubId/onboard/*`** — Hub onboarding flows

### 4.39 Hub Incidents

Every automatic defence (CAPTCHA, rate limiting, the over-limit message, ban
matches, provider-media deletion, erasure deadlines, ban expiry) reports
through ONE aggregate incident per hub and category while it is acting, so the
people responsible know it is happening. An incident never names a caller, a
number, a provider call id or any record id.

```
GET /api/hubs/:hubId/incidents?open=true
Auth: Required (any hub member)
Response: {
  "incidents": HubIncident[]   // only the categories the caller's permissions in this hub reach
}
HubIncident: {
  "id": string, "hubId": string,
  "category": "spam" | "provider-media" | "erasure-deadline" | "ban-expiry",   // extensible: render an unknown value generically
  "severity": "notify" | "record",
  "openedAt": iso8601, "lastSignalAt": iso8601, "closedAt": iso8601 | null,
  "counts": { [kind: string]: integer }, "totalCount": integer,
  "peakPerMinute": integer, "oldestAgeSeconds": integer | null
}
```

Reach is a permission per category — never a role:

| Category | Permission |
|----------|------------|
| `spam` | `settings:manage-spam` |
| `provider-media` | `telephony:manage-providers` |
| `erasure-deadline` | `erasure:admin` |
| `ban-expiry` | `system:view-bans` |

Delivery:

- **Relay** — `KIND_HUB_INCIDENT` (1050), content exactly `{"incidentId": string, "state": "opened" | "updated" | "closed"}`. The relay fans out to every hub member, so it carries no category, counts or severity. A client holding any category permission refetches the GET above; a client holding none ignores it.
- **Push** — `notify` incidents only, to permission holders who are members of the hub. Wake payload `{"hubId": string, "type": "incident"}` and nothing else; the app shows `incident.push` and opens the incident view.
- **Signal** — `notify` incidents only, to permission holders whose alert channel is Signal: the localized `incident.signalAlert` (category + state).
- **Rate** — one announcement on open, at most one `updated` per category window, one on close. `record` incidents are visible (relay, banner, GET) but never push or alert. A `record` incident escalating to `notify` interrupts once, as "opened".

`erasure-deadline` counts two kinds: `overdue` (an unfinished request past its deadline) and `failed` (a request the erasure worker gave up on; it ends when the request is retried or abandoned). A request is attributed to every hub its subject belongs to.

**Platform incidents.** Something that concerns the instance rather than any hub — an erasure whose subject belongs to no hub — opens an incident with no hub:

```
GET /api/admin/incidents?open=true
Permission: system:manage-instance   // from the caller's GLOBAL roles; hub roles never grant it
Response: { "incidents": PlatformIncident[] }   // HubIncident without "hubId"
```

A platform incident has no relay event and no push wake (both are routed by hub). Holders of the platform permission are paged on the Signal alert and read the detail from the GET above.

**Retrying and abandoning a failed erasure request:**

```
POST /api/erasure/requests/:id/retry          (also under /api/hubs/:hubId/…)
POST /api/erasure/requests/:id/abandon        Body: { "justification": string }
Response: { "request": ErasureRequest }   // status "pending" after retry, "abandoned" after abandon
```

Allowed for `erasure:admin` holders of a hub the request concerns, acting in that hub; for a request whose subject belongs to no hub, only the platform permission. Abandoning a *person's* erasure is the platform permission's alone (their data lives in every hub they belong to). An `abandoned` request is not `completed`: `executedAt` stays null, and who/when/why is recorded on the request and in the audit log (`erasureAbandoned`, `erasureRetried`).

---

