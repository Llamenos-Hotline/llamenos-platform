# Llamenos Protocol: REST API supplement: records, schema, security events, tags, teams, PUK, sessions

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.25 Records (Case Management)

> See **Section 4.31 Records** for the full endpoint reference. Section 4.31 is the canonical and complete documentation for all `/api/hubs/:hubId/records` endpoints.

### 4.26 Entity Schema (Case Management Configuration)

Mounted at `/api/settings/cms`.

```
GET    /api/settings/cms/case-management
       Permission: settings:read
       Response: { "enabled": boolean }

PUT    /api/settings/cms/case-management
       Permission: settings:manage-cms
       Body: { "enabled": boolean }
       Response: { "enabled": boolean }

GET    /api/settings/cms/auto-assignment
       Permission: settings:read
       Response: { "enabled": boolean }

PUT    /api/settings/cms/auto-assignment
       Permission: cases:manage
       Body: { "enabled": boolean }
       Response: { "enabled": boolean }

GET    /api/settings/cms/cross-hub
       Permission: settings:read
       Response: { "enabled": boolean }

PUT    /api/settings/cms/cross-hub
       Permission: settings:manage-cms
       Body: { "enabled": boolean }
       Response: { "enabled": boolean }

GET    /api/settings/cms/entity-types?hubId=
       Permission: settings:read | cases:read-own | cases:read-assigned | cases:create
       Response: { "entityTypes": EntityTypeDefinition[] }

POST   /api/settings/cms/entity-types
       Permission: cases:manage-types
       Body: EntityTypeDefinition
       Response: EntityTypeDefinition

GET    /api/settings/cms/entity-types/:id
       Permission: settings:read
       Response: EntityTypeDefinition

PATCH  /api/settings/cms/entity-types/:id
       Permission: cases:manage-types
       Body: partial EntityTypeDefinition
       Response: EntityTypeDefinition

DELETE /api/settings/cms/entity-types/:id
       Permission: cases:manage-types
       Response: { "ok": true }

PATCH  /api/settings/cms/entity-types/:id/customize
       Permission: cases:manage-types
       Body: { "labelOverrides": Record<string, string>, ... }
       Response: EntityTypeDefinition

GET    /api/settings/cms/relationship-types
       Permission: settings:read
       Response: { "relationshipTypes": RelationshipTypeDefinition[] }

POST   /api/settings/cms/relationship-types
       Permission: cases:manage-types
       Body: RelationshipTypeDefinition
       Response: RelationshipTypeDefinition

PATCH  /api/settings/cms/relationship-types/:id
       Permission: cases:manage-types
       Body: partial RelationshipTypeDefinition
       Response: RelationshipTypeDefinition

DELETE /api/settings/cms/relationship-types/:id
       Permission: cases:manage-types
       Response: { "ok": true }

POST   /api/settings/cms/case-number
       Permission: cases:create
       Body: { "prefix": string, "year"?: number }
       Response: { "number": string }

GET    /api/settings/cms/templates
       Permission: settings:read
       Response: { "templates": Template[], "appliedTemplateIds": string[] }

GET    /api/settings/cms/templates/updates
       Permission: settings:read
       Response: { "updates": TemplateUpdate[] }

GET    /api/settings/cms/templates/:id
       Permission: settings:read
       Response: Template

POST   /api/settings/cms/templates/apply
       Permission: cases:manage-types
       Body: { "templateId": string }
       Response: { "applied": true, "entityTypes": number, ... }

GET    /api/settings/cms/report-types?hubId=
       Permission: settings:read
       Response: { "reportTypes": CmsReportTypeDefinition[] }

POST   /api/settings/cms/report-types
       Permission: cases:manage-types
       Body: CmsReportTypeDefinition
       Response: CmsReportTypeDefinition

GET    /api/settings/cms/report-types/:id
       Permission: settings:read
       Response: CmsReportTypeDefinition

PATCH  /api/settings/cms/report-types/:id
       Permission: cases:manage-types
       Body: partial CmsReportTypeDefinition
       Response: CmsReportTypeDefinition

DELETE /api/settings/cms/report-types/:id
       Permission: cases:manage-types
       Response: { "ok": true }
```

### 4.28 Security Events

```
GET    /api/security-events?limit=&offset=
       Auth: Required (own events only)
       Response: { "events": SecurityEvent[], "total": number }

GET    /api/admin/security-events?limit=&offset=
       Permission: audit:read
       Response: { "events": SecurityEvent[], "total": number }
```

### 4.29 Tags

Hub-scoped: `/api/hubs/:hubId/tags/*`

```
GET    /api/hubs/:hubId/tags
       Permission: tags:view
       Response: { "tags": Tag[] }

POST   /api/hubs/:hubId/tags
       Permission: tags:create
       Body: { "id": string, "name": string, "encryptedLabel": hex, "color": string, "encryptedCategory"?: hex }
       Response: Tag

PATCH  /api/hubs/:hubId/tags/:tagId
       Permission: tags:manage
       Body: partial Tag
       Response: Tag

DELETE /api/hubs/:hubId/tags/:tagId
       Permission: tags:manage
       Response: { "removedFromContacts": number }
```

### 4.30 Teams

Hub-scoped: `/api/hubs/:hubId/teams/*`

```
GET    /api/hubs/:hubId/teams
       Permission: teams:read
       Response: { "teams": Team[] }

POST   /api/hubs/:hubId/teams
       Permission: teams:manage
       Body: { "id": string, "encryptedName": hex, "encryptedDescription"?: hex }
       Response: Team

GET    /api/hubs/:hubId/teams/:teamId
       Permission: teams:read
       Response: Team

PATCH  /api/hubs/:hubId/teams/:teamId
       Permission: teams:manage
       Body: partial Team
       Response: Team

DELETE /api/hubs/:hubId/teams/:teamId
       Permission: teams:manage
       Response: { "ok": true }

GET    /api/hubs/:hubId/teams/:teamId/members
       Permission: teams:read
       Response: { "members": TeamMember[] }

POST   /api/hubs/:hubId/teams/:teamId/members
       Permission: teams:manage
       Body: { "pubkeys": string[] }
       Response: { "ok": true }

DELETE /api/hubs/:hubId/teams/:teamId/members/:userPubkey
       Permission: teams:manage
       Response: { "ok": true }

GET    /api/hubs/:hubId/teams/:teamId/contacts
       Permission: teams:read
       Response: { "assignments": ContactTeamAssignment[] }

POST   /api/hubs/:hubId/teams/:teamId/contacts
       Permission: teams:manage
       Body: { "contactIds": string[] }
       Response: { "ok": true }

DELETE /api/hubs/:hubId/teams/:teamId/contacts/:contactId
       Permission: teams:manage
       Response: { "ok": true }
```

### 4.31 PUK (Per-User Key)

```
POST   /api/puk/envelopes
       Auth: Required
       Body: { "envelopes": [{ "deviceId": string, "generation": number, "envelope": hex }] }
       Response: { "distributed": number, "envelopes": PukEnvelope[] }

GET    /api/puk/envelopes/:deviceId
       Auth: Required (own envelopes only)
       Response: PukEnvelope
```

### 4.32 Sessions

```
GET    /api/sessions
       Auth: Required
       Response: { "sessions": Session[] }

POST   /api/sessions/terminate-others
       Auth: Required
       Response: { "terminated": number }

DELETE /api/sessions/:id
       Auth: Required
       Response: 204 No Content
```

