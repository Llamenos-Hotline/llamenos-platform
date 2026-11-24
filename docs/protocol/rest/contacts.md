# Llamenos Protocol: REST API: contacts

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.29 Contacts (Legacy)

Legacy contact timeline aggregation. Hub-scoped.

```
GET /api/hubs/:hubId/contacts
Permission: contacts:view
Query: ?page=&limit=
Response: { "contacts": ContactTimeline[], "total": number }

GET /api/hubs/:hubId/contacts/:hash
Permission: contacts:view
Response: { "notes": EncryptedNote[], "conversations": Conversation[] }
```

Hub-only: there is no unscoped `/api/contacts` (#2395).

### 4.30 Contact Directory (v2)

E2EE contact directory with affinity groups and relationships. Mounted at `/api/directory`. Hub-scoped only.

```
GET    /api/hubs/:hubId/directory/envelope-recipients
Permission: contacts:view | contacts:create | contacts:edit | contacts:manage-relationships | contacts:manage-groups
Response: { "summary": hex[], "pii": hex[], "admin": hex[] }
Errors: 503 when the hub has no admin reader (no admin device registered and no escrow key)

GET    /api/hubs/:hubId/directory
Permission: contacts:view
Query: ?page=&limit=&contactTypeHash=
Response: { "contacts": Contact[], "total": number }

GET    /api/hubs/:hubId/directory/lookup/:identifierHash
Permission: contacts:view
Response: { "contact": Contact | null }

GET    /api/hubs/:hubId/directory/search?tokens=<comma-separated>
Permission: contacts:view
Response: { "contacts": Contact[] }

POST   /api/hubs/:hubId/directory
Permission: contacts:create
Body: CreateContactBody
Response: Contact (201)

GET    /api/hubs/:hubId/directory/:id
Permission: contacts:view
Response: Contact

PATCH  /api/hubs/:hubId/directory/:id
Permission: contacts:edit
Body: UpdateContactBody
Response: Contact

DELETE /api/hubs/:hubId/directory/:id
Permission: contacts:delete
Response: { "ok": true }

POST   /api/hubs/:hubId/directory/:id/relationships
Permission: contacts:manage-relationships
Body: { "contactIdB": string, "relationshipType": string, "encryptedMetadata"?: hex }
Response: ContactRelationship (201)

DELETE /api/hubs/:hubId/directory/:id/relationships/:relId
Permission: contacts:manage-relationships
Response: { "ok": true }

GET    /api/hubs/:hubId/directory/:id/relationships
Permission: contacts:view
Response: { "relationships": ContactRelationship[] }

GET    /api/hubs/:hubId/directory/:id/groups
Permission: contacts:view
Response: { "groups": AffinityGroup[] }

POST   /api/hubs/:hubId/directory/merge
Permission: contacts:edit
Body: { "primaryId": string, "secondaryId": string, "reEncryptedProfiles": {...} }
Response: { "primaryId": string, "secondaryId": string }

POST   /api/hubs/:hubId/directory/bulk
Permission: contacts:edit
Body: BulkContactActionBody
Response: { "affected": number }

POST   /api/hubs/:hubId/directory/bulk-create
Permission: contacts:create
Body: { "contacts": CreateContactBody[] }
Response: { "created": number } (201)

// Affinity Groups
GET    /api/hubs/:hubId/directory/groups
Permission: contacts:manage-groups
Response: { "groups": AffinityGroup[] }

POST   /api/hubs/:hubId/directory/groups
Permission: contacts:manage-groups
Body: { "encryptedName": hex, "members": [{ "contactId": string, "role"?: string }] }
Response: AffinityGroup (201)

GET    /api/hubs/:hubId/directory/groups/:groupId
Permission: contacts:view
Response: { ...AffinityGroup, "members": GroupMember[] }

PATCH  /api/hubs/:hubId/directory/groups/:groupId
Permission: contacts:manage-groups
Body: { "encryptedName"?: hex }
Response: AffinityGroup

DELETE /api/hubs/:hubId/directory/groups/:groupId
Permission: contacts:manage-groups
Response: { "ok": true }

POST   /api/hubs/:hubId/directory/groups/:groupId/members
Permission: contacts:manage-groups
Body: { "contactId": string, "role"?: string }
Response: GroupMember (201)

DELETE /api/hubs/:hubId/directory/groups/:groupId/members/:contactId
Permission: contacts:manage-groups
Response: { "ok": true }

GET    /api/hubs/:hubId/directory/groups/:groupId/members
Permission: contacts:view
Response: { "members": GroupMember[] }
```

**Contact readers (#2741).** `GET /api/hubs/:hubId/directory/envelope-recipients` names the X25519 device keys a client seals a contact write to, per tier, so that no client guesses. Like every records recipients route it is hub-only: a hub-only member holds no global role, and a call outside `/hubs/:hubId` is `404` — there is no hubless reader set. Every entry is a registered device's X25519 key or the hub's escrow key, never an Ed25519 identity key, and the tiers are decided by the permissions a member holds IN THAT HUB (their hub role assignments only — a global super-admin's `*` is a reader of no hub), never by a role id or name:

| Tier | Seals | Readers |
|------|-------|---------|
| `summary` | `encryptedSummary` | holders of `contacts:view` or `contacts:view-pii`, plus `admin` |
| `pii` | `encryptedPII` | holders of `contacts:view-pii`, plus `admin` |
| `admin` | payloads no member below an admin may read (affinity groups, relationships) | holders of the admin minimum (`settings:manage` + `notes:read-all`), plus the hub's escrow key |

`contacts:search` alone is not a reader: it finds a contact, it does not read it. The hub's escrow key is a member of every tier (§2.4.2); setting it therefore requires holding `contacts:view` and `contacts:view-pii` in the hub as well. Contacts have no per-record assignment, so one answer serves create and edit. Every tier contains `admin`: when the hub has no admin reader the server answers `503` rather than name a set without one, and a client MUST refuse to seal to a set holding none. A failed lookup falls back to the sealing device plus the admin key and never to another key (the same contract as §4.31 records).

