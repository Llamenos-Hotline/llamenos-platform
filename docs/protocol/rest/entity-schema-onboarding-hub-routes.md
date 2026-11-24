# Llamenos Protocol: REST API: entity schema, hub onboarding and hub-scoped routes

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.53 Entity Schema (Case Management)

Entity types, relationship types, report types, templates, and case numbering. Mounted at `/api/settings/cms`.

```
GET  /api/settings/cms/case-management
Permission: settings:read
Response: { "enabled": boolean }

PUT  /api/settings/cms/case-management
Permission: settings:manage-cms
Body: { "enabled": boolean }
Response: { "enabled": boolean }

GET  /api/settings/cms/auto-assignment
Permission: settings:read
Response: { "enabled": boolean }

PUT  /api/settings/cms/auto-assignment
Permission: cases:manage
Body: { "enabled": boolean }
Response: { "enabled": boolean }

GET  /api/settings/cms/cross-hub
Permission: settings:read
Response: { "enabled": boolean }

PUT  /api/settings/cms/cross-hub
Permission: settings:manage-cms
Body: { "enabled": boolean }
Response: { "enabled": boolean }

// Entity Types
GET    /api/settings/cms/entity-types
Permission: settings:read | cases:read-own | cases:read-assigned | cases:create
Query: ?hubId=
Response: { "entityTypes": EntityTypeDefinition[] }

POST   /api/settings/cms/entity-types
Permission: cases:manage-types
Body: CreateEntityTypeBody
Response: EntityTypeDefinition

GET    /api/settings/cms/entity-types/:id
Permission: settings:read
Response: EntityTypeDefinition

PATCH  /api/settings/cms/entity-types/:id
Permission: cases:manage-types
Body: UpdateEntityTypeBody
Response: EntityTypeDefinition

DELETE /api/settings/cms/entity-types/:id
Permission: cases:manage-types
Response: { "ok": true }

PATCH  /api/settings/cms/entity-types/:id/customize
Permission: cases:manage-types
Body: { "encryptedLabel"?: hex, "icon"?: string, "color"?: string }
Response: EntityTypeDefinition

// Relationship Types
GET    /api/settings/cms/relationship-types
Permission: settings:read
Response: { "relationshipTypes": RelationshipTypeDefinition[] }

POST   /api/settings/cms/relationship-types
Permission: cases:manage-types
Body: CreateRelationshipTypeBody
Response: RelationshipTypeDefinition

GET    /api/settings/cms/relationship-types/:id
Permission: settings:read
Response: RelationshipTypeDefinition

PATCH  /api/settings/cms/relationship-types/:id
Permission: cases:manage-types
Body: UpdateRelationshipTypeBody
Response: RelationshipTypeDefinition

DELETE /api/settings/cms/relationship-types/:id
Permission: cases:manage-types
Response: { "ok": true }

// Report Types
GET    /api/settings/cms/report-types
Permission: settings:read
Query: ?hubId=
Response: { "reportTypes": ReportTypeDefinition[] }

POST   /api/settings/cms/report-types
Permission: cases:manage-types
Body: CreateCmsReportTypeBody
Response: ReportTypeDefinition

GET    /api/settings/cms/report-types/:id
Permission: settings:read
Response: ReportTypeDefinition

PATCH  /api/settings/cms/report-types/:id
Permission: cases:manage-types
Body: UpdateCmsReportTypeBody
Response: ReportTypeDefinition

DELETE /api/settings/cms/report-types/:id
Permission: cases:manage-types
Response: { "ok": true }

// Case Number Generation
POST   /api/settings/cms/case-number
Permission: cases:create
Body: { "prefix": string, "year"?: number, "hubId"?: string }
Response: { "number": string }

// Templates
GET    /api/settings/cms/templates
Permission: settings:read
Response: { "templates": TemplateSummary[], "appliedTemplateIds": string[] }

GET    /api/settings/cms/templates/updates
Permission: settings:read
Response: { "updates": TemplateUpdate[] }

GET    /api/settings/cms/templates/:id
Permission: settings:read
Response: TemplateDetail

POST   /api/settings/cms/templates/apply
Permission: cases:manage-types
Body: { "templateId": string }
Response: { "applied": true, "entityTypes": number, "relationshipTypes": number, "reportTypes": number, "suggestedRoles": SuggestedRole[] } (201)

```

Hub-scoped: `/api/hubs/:hubId/settings/cms/*`

### 4.54 Hub Onboarding

Hub-specific onboarding and provider configuration. Hub-scoped only.

```
POST /api/hubs/:hubId/onboard
Permission: hubs:configure
Body: { "templateId"?: string }
Response: { "onboarding": HubOnboardingState }
Rate limit: 10/min

GET  /api/hubs/:hubId/onboard/status
Permission: telephony:view-providers
Response: { "onboarding": HubOnboardingState | null }

PUT  /api/hubs/:hubId/onboard/step
Permission: hubs:configure
Body: { "step": string, "data"?: { "channelConfig"?: ChannelConfig } }
Response: { "onboarding": HubOnboardingState }

GET  /api/hubs/:hubId/onboard/provider-status
Permission: telephony:view-providers
Response: { "status": HubSetupStatus }

GET  /api/hubs/:hubId/onboard/usage
Permission: telephony:view-providers
Response: { "usage": HubUsage }

PUT  /api/hubs/:hubId/onboard/quotas
Permission: system:manage-instance
Body: HubQuota
Response: { "quotas": HubQuota }

PUT  /api/hubs/:hubId/onboard/channels
Permission: hubs:configure
Body: { "channel": string, "enabled": boolean }
Response: { "channels": ChannelConfig }

POST /api/hubs/:hubId/onboard/sub-account
Permission: hubs:configure
Body: { "masterConfigId": string }
Response: { "subAccountId": string }
```

### 4.55 Hub-Scoped Routes

The following groups are served under a `/api/hubs/:hubId/` prefix, which scopes them to a specific hub.

Hub-only — there is no unscoped `/api/<group>` mount; a request outside `/hubs/:hubId` answers `404`:

```
/api/hubs/:hubId/shifts/*
/api/hubs/:hubId/notes/*
/api/hubs/:hubId/calls/*
/api/hubs/:hubId/audit/*
/api/hubs/:hubId/conversations/*
/api/hubs/:hubId/reports/*
/api/hubs/:hubId/contacts/*
/api/hubs/:hubId/records/*
/api/hubs/:hubId/records/:id/evidence, /api/hubs/:hubId/evidence/*
/api/hubs/:hubId/events/*
/api/hubs/:hubId/mls/*
/api/hubs/:hubId/onboard/*
/api/hubs/:hubId/ring-groups/*
/api/hubs/:hubId/teams/*
/api/hubs/:hubId/tags/*
```

Also mounted unscoped at `/api/<group>/*`:

```
/api/hubs/:hubId/bans/*
/api/hubs/:hubId/blasts/*
/api/hubs/:hubId/directory/*
/api/hubs/:hubId/settings/cms/*
/api/hubs/:hubId/analytics/*
/api/hubs/:hubId/messaging/signal/*
/api/hubs/:hubId/provider-setup/*
/api/hubs/:hubId/retention/*
/api/hubs/:hubId/firehose/*
```

When using hub-scoped routes, the `hubContext` middleware resolves hub-specific permissions for the user and scopes all queries to the specified hub.

