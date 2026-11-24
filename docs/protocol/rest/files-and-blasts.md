# Llamenos Protocol: REST API: files and blasts

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.13 Files

#### Upload Flow

**Never-orphaned write guard (#2174).** The server never holds the key of anything a client seals, so a sealed write whose envelopes leave no admin reader stores a record nobody can ever open, and nothing can repair it afterwards. It is refused at the boundary, by the same rule as notes (§4.7, `assertAdminCanRead`): every envelope set the request carries must include one addressed to a member of the record's hub's `admin` reader set (§2.4.2) or, transitionally, to `ADMIN_DECRYPTION_PUBKEY`. A set that names no admin, or an absent or empty one, is `422`; a hub with no resolvable admin recipient at all is `503`. Nothing is stored or numbered when a write is refused.

Applies to `POST /hubs/:hubId/uploads/init`: `recipientEnvelopes` must include a file-key envelope addressed to an admin reader. It is checked before the file row exists and before any chunk is accepted.

```
POST /api/uploads/init
Permission: files:upload
Body: {
  "totalSize": number,
  "totalChunks": number,
  "conversationId": string,
  "recipientEnvelopes": RecipientEnvelope[],
  "encryptedMetadata": [{ "pubkey": hex64, "encryptedContent": hex, "enc": hex64, "ct": hex }]
  // encryptedMetadata entries use encryptedMetadataEntrySchema — HPKE envelope fields
}
Response: { "uploadId": "uuid", "totalChunks": number }

PUT /api/uploads/:id/chunks/:chunkIndex
Permission: files:upload
Content-Type: application/octet-stream (raw encrypted chunk bytes)
Response: { "chunkIndex": number, "completedChunks": number, "totalChunks": number }

POST /api/uploads/:id/complete
Permission: files:upload
Response: { "fileId": "uuid", "status": "complete" }
Error: 400 "Not all chunks uploaded"

GET /api/uploads/:id/status
Permission: files:upload
Response: {
  "uploadId": string, "status": "uploading"|"complete"|"failed",
  "completedChunks": number, "totalChunks": number, "totalSize": number
}
```

#### File Download

```
GET /api/files/:id/content
Permission: files:download-own (if recipient) or files:download-all
Response: application/octet-stream (encrypted file bytes)
Headers: Cache-Control: private, no-cache

GET /api/files/:id/envelopes
Permission: files:download-own or files:download-all
Response: { "envelopes": RecipientEnvelope[] }
// Non-admin users receive only their own envelope

GET /api/files/:id/metadata
Permission: files:download-own or files:download-all
Response: { "metadata": [{ "pubkey", "encryptedContent", "enc", "ct" }] }
// encryptedMetadataEntrySchema — HPKE envelope fields

POST /api/files/:id/share
Permission: files:share
Body: {
  "envelope": RecipientEnvelope,
  "encryptedMetadata": { "pubkey", "encryptedContent", "enc", "ct" }
  // encryptedMetadataEntrySchema — HPKE envelope fields
}
Response: { "ok": true }
```

### 4.14 Blasts (Message Broadcasting)

#### Subscribers

```
GET /api/blasts/subscribers?page=&limit=&tag=&status=
Auth: Required
Response: { "subscribers": Subscriber[], "total": number }

DELETE /api/blasts/subscribers/:id
Auth: Required
Response: { "ok": true }

GET /api/blasts/subscribers/stats
Auth: Required
Response: { "total": number, "active": number, ... }

POST /api/blasts/subscribers/import
Auth: Required
Body: { "subscribers": [...] }
Response: { "imported": number, ... }
```

#### Blasts

```
GET /api/blasts
Auth: Required
Response: { "blasts": Blast[] }

POST /api/blasts
Auth: Required
Body: { "name", "content": BlastContent, "targetChannels", "targetTags", "targetLanguages" }
Response: Blast

GET /api/blasts/:id
Auth: Required
Response: Blast

PATCH /api/blasts/:id
Auth: Required
Body: partial Blast
Response: Blast

DELETE /api/blasts/:id
Auth: Required
Response: { "ok": true }

POST /api/blasts/:id/send
Auth: Required
Response: { "ok": true, "stats": BlastStats }

POST /api/blasts/:id/schedule
Auth: Required
Body: { "scheduledAt": ISO8601 }
Response: { "ok": true }

POST /api/blasts/:id/cancel
Auth: Required
Response: { "ok": true }
```

#### Blast Settings

```
GET /api/blasts/settings
Auth: Required
Response: BlastSettings

PATCH /api/blasts/settings
Auth: Required
Body: partial BlastSettings
Response: { "ok": true }
```

Hub-scoped: `/api/hubs/:hubId/blasts/*`

