# Llamenos Protocol: REST API supplement: endpoint summary and contacts v2

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.24 Additional Endpoints

The following endpoints are implemented but documented here at a high level. For detailed request/response schemas, see `apps/worker/routes/` and the OpenAPI snapshot (`/api/openapi.json`).

#### Contacts & Directory
```
GET    /api/hubs/:hubId/contacts
GET    /api/hubs/:hubId/contacts/:hash
GET    /api/directory
```

#### Records & Entity Schema (CMS)
```
GET    /api/hubs/:hubId/records
POST   /api/hubs/:hubId/records
GET    /api/hubs/:hubId/records/:id
PATCH  /api/hubs/:hubId/records/:id
DELETE /api/hubs/:hubId/records/:id
POST   /api/hubs/:hubId/records/:id/assign
GET    /api/settings/cms         # entity schema definitions
POST   /api/settings/cms
```

#### Recovery Groups
See §4.50 — the complete, authoritative route list.

#### PUK (Per-User Key) Management
```
GET  /api/puk
POST /api/puk/rotate
```

#### Sessions
```
GET    /api/sessions
DELETE /api/sessions/:id
```

#### Security Events
```
GET /api/security-events
GET /api/admin/security-events
```

#### Tags
```
GET    /api/hubs/:hubId/tags
POST   /api/hubs/:hubId/tags
PATCH  /api/hubs/:hubId/tags/:id
DELETE /api/hubs/:hubId/tags/:id
```

#### Teams
```
GET    /api/hubs/:hubId/teams
POST   /api/hubs/:hubId/teams
PATCH  /api/hubs/:hubId/teams/:id
DELETE /api/hubs/:hubId/teams/:id
```

#### Ring Groups
```
GET    /api/hubs/:hubId/ring-groups
POST   /api/hubs/:hubId/ring-groups
GET    /api/hubs/:hubId/ring-groups/:id
PUT    /api/hubs/:hubId/ring-groups/:id
DELETE /api/hubs/:hubId/ring-groups/:id
POST   /api/hubs/:hubId/ring-groups/:id/members
DELETE /api/hubs/:hubId/ring-groups/:id/members
```

#### Retention & Erasure
```
GET    /api/retention
POST   /api/retention
POST   /api/erasure/request
GET    /api/erasure/status
```

#### MLS (Messaging Layer Security)
```
GET    /api/hubs/:hubId/mls/welcome
POST   /api/hubs/:hubId/mls/commit
GET    /api/hubs/:hubId/mls/group-info
```

#### Firehose (LLM Inference)
```
POST /api/firehose/extract
GET  /api/firehose/status
```

#### Geocoding
```
GET /api/geocoding/forward?q=<address>
GET /api/geocoding/reverse?lat=<>&lon=<>
```

#### Account Management
```
GET    /api/account
PATCH  /api/account
DELETE /api/account
```

#### Admin Devices
```
GET /api/admin/devices
```

#### Signal Messaging
```
POST /api/messaging/signal/send
GET  /api/messaging/signal/status
```

#### Provider Setup & Templates
```
GET  /api/provider-setup
POST /api/provider-setup
GET  /api/provider-templates
```

#### Platform Settings & Bans
```
GET  /api/settings/platform
PATCH /api/settings/platform
GET  /api/admin/bans
POST /api/admin/bans
```

#### System & Analytics
```
GET /api/system/status
GET /api/analytics/overview
GET /api/analytics/calls
GET /api/analytics/messages
```

### 4.24 Contacts v2 (Contact Directory)

```
GET    /api/directory
       Permission: contacts:view
       Response: { "contacts": Contact[], "total": number }

GET    /api/directory/:id
       Permission: contacts:view
       Response: Contact

POST   /api/directory
       Permission: contacts:create
       Body: { "encryptedProfile": hex, "identifierHash": string, ... }
       Response: Contact

PATCH  /api/directory/:id
       Permission: contacts:edit
       Body: partial Contact
       Response: Contact

DELETE /api/directory/:id
       Permission: contacts:delete
       Response: { "ok": true }

GET    /api/directory/lookup/:identifierHash
       Permission: contacts:view
       Response: { "contact": Contact | null }

GET    /api/directory/search?tokens=
       Permission: contacts:view
       Response: { "contacts": Contact[] }

POST   /api/directory/:id/relationships
       Permission: contacts:manage-relationships
       Body: { "contactIdB": string, "relationshipType": string }
       Response: ContactRelationship

GET    /api/directory/:id/relationships
       Permission: contacts:view
       Response: { "relationships": ContactRelationship[] }

DELETE /api/directory/:id/relationships/:relId
       Permission: contacts:manage-relationships
       Response: { "ok": true }

GET    /api/directory/groups
       Permission: contacts:manage-groups
       Response: { "groups": AffinityGroup[] }

POST   /api/directory/groups
       Permission: contacts:manage-groups
       Body: { "name": string, "members": [...] }
       Response: AffinityGroup

GET    /api/directory/groups/:groupId
       Permission: contacts:view
       Response: AffinityGroup

PATCH  /api/directory/groups/:groupId
       Permission: contacts:manage-groups
       Body: partial AffinityGroup
       Response: AffinityGroup

DELETE /api/directory/groups/:groupId
       Permission: contacts:manage-groups
       Response: { "ok": true }

POST   /api/directory/groups/:groupId/members
       Permission: contacts:manage-groups
       Body: { "contactId": string }
       Response: GroupMember

DELETE /api/directory/groups/:groupId/members/:contactId
       Permission: contacts:manage-groups
       Response: { "ok": true }

POST   /api/directory/merge
       Permission: contacts:edit
       Body: { "primaryId": string, "secondaryId": string }
       Response: { "primaryId": string, "secondaryId": string }

POST   /api/directory/bulk
       Permission: contacts:edit
       Body: { "action": string, "contactIds": string[] }
       Response: { "affected": number }

POST   /api/directory/bulk-create
       Permission: contacts:create
       Body: { "contacts": ContactInput[] }
       Response: { "created": number }
```

Hub-scoped: `/api/hubs/:hubId/directory/*`

