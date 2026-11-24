# Llamenos Protocol: REST API: conversations, reports and bans

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.9 Conversations

Conversations are served **only** under `/api/hubs/:hubId/conversations` (#2381). There is no unscoped `/api/conversations`: a conversation belongs to one hub, and every read and write below is bounded by the caller's permissions in that hub. The waiting queue in the list is limited to the channels the caller may claim there (`conversations:claim-<channel>` / `claim-any`); a caller who may claim no channel sees no waiting conversation.

```
GET /api/hubs/:hubId/conversations?status=&channel=&page=1&limit=50
Permission: conversations:read-all (all) or conversations:read-assigned (own + waiting)
Response: {
  "conversations": Conversation[],
  "total"?: number,
  "assignedCount"?: number,
  "waitingCount"?: number,
  "claimableChannels"?: string[]
}

GET /api/hubs/:hubId/conversations/stats
Auth: Required
Response: { "total": number, "active": number, "waiting": number, "closed": number }

GET /api/hubs/:hubId/conversations/load
Permission: conversations:read-all
Response: { "loads": { [pubkey: string]: number } }

GET /api/hubs/:hubId/conversations/:id
Auth: Required (access-checked per conversation)
Response: Conversation

GET /api/hubs/:hubId/conversations/:id/messages?page=1&limit=50
Auth: Required (access-checked per conversation)
Response: { "messages": EncryptedMessage[], "total": number }

POST /api/hubs/:hubId/conversations/:id/messages
Permission: conversations:send or conversations:send-any
Body: {
  "encryptedContent": hex,
  "readerEnvelopes": MessageKeyEnvelope[],
  "plaintextForSending"?: string  // For external channels; server sends via adapter then discards
}
Response: EncryptedMessage

PATCH /api/hubs/:hubId/conversations/:id
Permission: conversations:update or assigned volunteer
Body: { "status"?: string, "assignedTo"?: string }
Response: Conversation

POST /api/hubs/:hubId/conversations/:id/claim
Permission: conversations:claim + channel-specific (e.g., conversations:claim-sms)
Response: Conversation
Error: 403 "No permission to claim this channel type"

GET /api/hubs/:hubId/conversations/:id/assignee-envelopes
Permission: conversations:read-all
Response: AssigneeEnvelopeGapsResponse   // ≤ 200 messages, oldest first — see §2.4.1

POST /api/hubs/:hubId/conversations/:id/assignee-envelopes
Permission: conversations:read-all + conversations:update
Body: { "envelopes": [{ "messageId": string, "envelope": RecipientEnvelope }] }  // 1..1000
Response: { "added": number }
Error: 400 recipient not a device key of the current assignee · 404 message not in conversation · 409 no assignee / message has no readers
```

Hub-scoped: `/api/hubs/:hubId/conversations/*`

### 4.10 Reports

Reports are a specialized type of conversation with `metadata.type = "report"`.

```
GET /api/hubs/:hubId/reports?status=&category=&page=1&limit=50
Permission: reports:read-all, reports:read-assigned, or reports:read-own
Response: { "conversations": Conversation[], "total": number }

POST /api/hubs/:hubId/reports
Permission: reports:create
Body: {
  "title": string,
  "category"?: string,
  "encryptedContent": hex,
  "readerEnvelopes": MessageKeyEnvelope[]
}
Response: { "id": string, ... }

GET /api/hubs/:hubId/reports/:id
Permission: reports:read-all, reports:read-assigned (if assigned), or own report
Response: Conversation (with metadata.type = "report")

GET /api/hubs/:hubId/reports/:id/messages?page=1&limit=100
Auth: Required (access-checked)
Response: { "messages": EncryptedMessage[], "total": number }

POST /api/hubs/:hubId/reports/:id/messages
Permission: reports:send-message, reports:send-message-own (own report), or assigned
Body: {
  "encryptedContent": hex,
  "readerEnvelopes": MessageKeyEnvelope[],
  "attachmentIds"?: string[]
}
Response: EncryptedMessage

POST /api/hubs/:hubId/reports/:id/assign
Permission: reports:assign
Body: { "assignedTo": "pubkey_hex" }
Response: Conversation

PATCH /api/hubs/:hubId/reports/:id
Permission: reports:update
Body: { "status"?: string }
Response: Conversation

GET /api/hubs/:hubId/reports/categories
Auth: Required
Response: { "categories": string[] }

GET /api/hubs/:hubId/reports/:id/files
Auth: Required (access-checked)
Response: { "files": FileRecord[] }
```

Hub-only: there is no unscoped `/api/reports` (#2395). `metadata.reportTitle` and `metadata.reportCategory` are stored as the client sends them, so the server can read them.

### 4.11 Bans

```
POST /api/hubs/:hubId/bans
Permission: bans:create
Body: { "phone": string (E.164), "reason": string }
Response: { "ban": BanEntry }

GET /api/hubs/:hubId/bans
Permission: bans:read
Response: { "bans": BanEntry[] }

// BanEntry = { "phoneHash": string, "reason": string, "bannedBy": string, "bannedAt": string }
// phoneHash is the §2.10 banHash for the hub: an opaque unban handle. No number, masked or not.

POST /api/hubs/:hubId/bans/bulk
Permission: bans:bulk-create
Body: { "phones": string[] (E.164), "reason": string }
Response: { "ok": true, "count": number }

DELETE /api/hubs/:hubId/bans/:phoneHash
Permission: bans:delete
Response: { "ok": true }
// :phoneHash is the 64-hex handle from GET /api/hubs/:hubId/bans. A number in the path is refused (400).
```

Hub-only: there is no unscoped `/api/bans` (#2463). It used to serve the platform list behind the hub permissions, so a missing hub meant "every hub". The platform list is §4.47, `/api/admin/bans`.

