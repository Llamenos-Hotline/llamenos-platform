# Case Management API Reference

All CMS endpoints are authenticated. Include the session token in the `Authorization: Bearer <token>` header.

Base path for settings endpoints: `/api/settings/cms`
Base path for record endpoints: `/api/records`
Base path for contact directory: `/api/directory`

## CMS Feature Toggle

### Get Case Management Status

```
GET /api/settings/cms/case-management
```

**Response:**
```json
{ "enabled": true }
```

### Enable/Disable Case Management

```
PUT /api/settings/cms/case-management
```

**Permission:** `settings:manage`

**Request:**
```json
{ "enabled": true }
```

**Response:**
```json
{ "enabled": true }
```

## Entity Types

### List Entity Types

```
GET /api/settings/cms/entity-types
```

**Permission:** `settings:read` or `cases:read-own` or `cases:read-assigned` or `cases:create`

**Response:**
```json
{
  "entityTypes": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "arrest_case",
      "label": "Arrest Case",
      "labelPlural": "Arrest Cases",
      "description": "Track an individual through the arrest process",
      "icon": "handcuffs",
      "color": "#ef4444",
      "category": "case",
      "fields": [ ... ],
      "statuses": [ ... ],
      "defaultStatus": "reported",
      "closedStatuses": ["case_closed"],
      "severities": [ ... ],
      "contactRoles": [ ... ],
      "isArchived": false,
      "createdAt": "2026-03-10T12:00:00Z",
      "updatedAt": "2026-03-10T12:00:00Z"
    }
  ]
}
```

### Create Entity Type

```
POST /api/settings/cms/entity-types
```

**Permission:** `cases:manage-types`

**Request:**
```json
{
  "name": "arrest_case",
  "label": "Arrest Case",
  "labelPlural": "Arrest Cases",
  "description": "Track arrests",
  "icon": "handcuffs",
  "color": "#ef4444",
  "category": "case",
  "fields": [
    {
      "name": "arrest_location",
      "label": "Arrest Location",
      "type": "text",
      "required": true,
      "section": "arrest_details",
      "order": 1,
      "accessLevel": "all"
    }
  ],
  "statuses": [
    { "value": "open", "label": "Open", "color": "#3b82f6", "order": 0 },
    { "value": "closed", "label": "Closed", "color": "#6b7280", "order": 1, "isClosed": true }
  ],
  "defaultStatus": "open",
  "closedStatuses": ["closed"]
}
```

**Response (201):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "arrest_case",
  ...
}
```

### Update Entity Type

```
PATCH /api/settings/cms/entity-types/:id
```

**Permission:** `cases:manage-types`

All fields are optional. Only provided fields are updated. The `name` field is immutable.

**Request:**
```json
{
  "label": "Updated Label",
  "fields": [ ... ],
  "statuses": [ ... ]
}
```

**Response:**
```json
{ "id": "...", "name": "arrest_case", "label": "Updated Label", ... }
```

### Delete Entity Type

```
DELETE /api/settings/cms/entity-types/:id
```

**Permission:** `cases:manage-types`

**Response:**
```json
{ "ok": true }
```

## Templates

### List Templates

```
GET /api/settings/cms/templates
```

**Permission:** `settings:read`

**Response:**
```json
{
  "templates": [
    {
      "id": "jail-support",
      "version": "1.2.0",
      "name": "Jail Support",
      "description": "Mass arrest intake...",
      "tags": ["legal", "protest"],
      "entityTypeCount": 2,
      "reportTypeCount": 2,
      "totalFieldCount": 28,
      "suggestedRoleCount": 4
    }
  ],
  "appliedTemplateIds": ["jail-support"]
}
```

### Get Template Details

```
GET /api/settings/cms/templates/:id
```

**Permission:** `settings:read`

Returns the full template JSON including entity types, fields, relationship types, report types, and suggested roles.

### Apply Template

```
POST /api/settings/cms/templates/apply
```

**Permission:** `cases:manage-types`

**Request:**
```json
{ "templateId": "jail-support" }
```

**Response (201):**
```json
{
  "applied": true,
  "entityTypes": 2,
  "relationshipTypes": 2,
  "reportTypes": 2,
  "suggestedRoles": [
    {
      "name": "Hotline Coordinator",
      "slug": "hotline-coordinator",
      "description": "Manages the hotline during actions",
      "permissions": ["cases:*", "contacts:*"]
    }
  ]
}
```

Applying a template:
- Creates or updates entity types (matched by `name`)
- Creates relationship types
- Creates CMS report types
- Enables case management automatically
- Records the applied template version for update detection

### Check Template Updates

```
GET /api/settings/cms/templates/updates
```

**Permission:** `settings:read`

**Response:**
```json
{
  "updates": [
    {
      "templateId": "jail-support",
      "appliedVersion": "1.0.0",
      "availableVersion": "1.2.0"
    }
  ]
}
```

## Records (Cases)

### List Records

```
GET /api/records?page=1&limit=50&entityTypeId=<id>&assignedTo=<pubkey>
```

**Permission:** `cases:read-own`, `cases:read-assigned`, or `cases:read-all`

Query parameters:
- `page` (number, default: 1)
- `limit` (number, default: 50)
- `entityTypeId` (string, optional): Filter by entity type
- `assignedTo` (string, optional): Filter by assignment (admin only)
- `parentRecordId` (string, optional): Filter sub-records

The list schema is **strict**: a query carrying `statusHash`, `severityHash` or any other key it does not declare is refused with `400`. There is no server-side status or severity filter; those live only in the sealed summary, and a client that filters by them opens the summaries it fetched (see "Triage state is sealed" in `docs/protocol/rest/records-events-evidence.md` §4.31).

Non-admin users automatically see only records assigned to or created by them.

**Response:**
```json
{
  "records": [
    {
      "id": "abc-123",
      "entityTypeId": "550e8400-...",
      "caseNumber": "JS-0001",
      "assignedTo": ["pubkey1", "pubkey2"],
      "createdBy": "pubkey1",
      "contactCount": 3,
      "encryptedFields": { ... },
      "createdAt": "2026-03-10T12:00:00Z",
      "updatedAt": "2026-03-10T14:30:00Z"
    }
  ],
  "total": 142
}
```

### Get Single Record

```
GET /api/records/:id
```

**Response:** Single record object (same shape as list items).

### Lookup by Case Number

```
GET /api/records/by-number/:number
```

**Response:** Single record object.

### Create Record

```
POST /api/records
```

**Permission:** `cases:create`

**Request:**
```json
{
  "entityTypeId": "550e8400-...",
  "encryptedSummary": "<base64>",  // carries the title, description, status and severity — sealed
  "summaryEnvelopes": [
    { "pubkey": "...", "encryptedKey": "<base64>" }
  ],
  "encryptedFields": "<base64>",
  "fieldEnvelopes": [ ... ],
  "encryptedPii": "<base64>",
  "piiEnvelopes": [ ... ]
}
```

**Response (201):** Created record with auto-generated `id` and `caseNumber`.

### Update Record

```
PATCH /api/records/:id
```

**Permission:** `cases:update` or `cases:update-own` (for assigned records)

**Request:**
```json
{
  "encryptedSummary": "<hex>",          // the re-sealed summary, carrying the new status value
  "summaryEnvelopes": [ ... ],
  "statusChangeTypeHash": "status_change",
  "statusChangeContent": "<hex>",       // sealed {text, previousStatus, newStatus}
  "statusChangeEnvelopes": [ ... ]
}
```

All fields optional, and the body is strict (an undeclared key is `400`). The server never sees a status: a status change re-seals the summary, and `statusChangeTypeHash` is how the client says one happened. The server then files a `status_change` entry on the timeline whose content is the sealed transition.

### Delete Record

```
DELETE /api/records/:id
```

**Permission:** `cases:delete`

### Assign Volunteers

```
POST /api/records/:id/assign
```

**Permission:** `cases:assign`

**Request:**
```json
{ "pubkeys": ["pubkey1", "pubkey2"] }
```

**Response:**
```json
{ "assignedTo": ["pubkey1", "pubkey2", "pubkey3"] }
```

### Unassign Volunteer

```
POST /api/records/:id/unassign
```

**Permission:** `cases:assign`

**Request:**
```json
{ "pubkey": "pubkey2" }
```

### Get Assignment Suggestions

```
GET /api/records/:id/suggest-assignees?language=es
```

**Permission:** `cases:assign`

Returns ranked volunteer suggestions based on workload, language match, and specializations.

**Response:**
```json
{
  "suggestions": [
    {
      "pubkey": "...",
      "score": 85,
      "reasons": ["On shift", "3/20 cases", "Speaks es"],
      "activeCaseCount": 3,
      "maxCases": 20
    }
  ]
}
```

## Interactions (Timeline)

### List Interactions

```
GET /api/records/:id/interactions?page=1&limit=200
```

Query parameters:
- `page`, `limit`: Pagination
- `interactionTypeHash`: Filter by type (blind index)
- `after`, `before`: ISO date range

**Response:**
```json
{
  "interactions": [
    {
      "id": "int-001",
      "recordId": "abc-123",
      "interactionType": "comment",
      "interactionTypeHash": "...",
      "authorPubkey": "...",
      "encryptedContent": "<base64>",
      "contentEnvelopes": [ ... ],
      "metadata": {},
      "createdAt": "2026-03-10T15:00:00Z"
    }
  ],
  "total": 47
}
```

### Create Interaction

```
POST /api/records/:id/interactions
```

**Permission:** `cases:update` or `cases:update-own`

**Request:**
```json
{
  "interactionType": "comment",
  "encryptedContent": "<base64>",
  "contentEnvelopes": [
    { "pubkey": "...", "encryptedKey": "<base64>" }
  ],
  "interactionTypeHash": "..."
}
```

Supported `interactionType` values: `note`, `call`, `status_change`, `comment`, `file_upload`, `message`, `referral`, `assessment`.

**Response (201):** Created interaction object.

### Delete Interaction

```
DELETE /api/records/:id/interactions/:interactionId
```

**Permission:** `cases:update`

## Evidence

### Upload Evidence

```
POST /api/records/:id/evidence
```

**Permission:** `evidence:upload`

**Request:**
```json
{
  "fileId": "file-abc",
  "filename": "arrest-photo-001.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 2458000,
  "classification": "photo",
  "integrityHash": "sha256:a1b2c3...",
  "source": "mobile_upload",
  "encryptedDescription": "<base64>",
  "descriptionEnvelopes": [ ... ]
}
```

Classification values: `photo`, `video`, `document`, `audio`, `other`.

**Response (201):** Evidence metadata with custody chain entry.

### List Evidence

```
GET /api/records/:id/evidence?classification=photo&limit=100
```

**Response:**
```json
{
  "evidence": [
    {
      "id": "ev-001",
      "fileId": "file-abc",
      "filename": "arrest-photo-001.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 2458000,
      "classification": "photo",
      "integrityHash": "sha256:a1b2c3...",
      "uploadedBy": "pubkey1",
      "uploadedAt": "2026-03-10T16:00:00Z"
    }
  ]
}
```

## Record Contacts

### Link Contact to Record

```
POST /api/records/:id/contacts
```

**Permission:** `cases:link`

**Request:**
```json
{
  "contactId": "contact-abc",
  "role": "arrestee"
}
```

### List Record Contacts

```
GET /api/records/:id/contacts
```

**Response:**
```json
{
  "contacts": [
    {
      "recordId": "abc-123",
      "contactId": "contact-abc",
      "role": "arrestee",
      "addedBy": "pubkey1",
      "addedAt": "2026-03-10T12:30:00Z"
    }
  ]
}
```

### Unlink Contact

```
DELETE /api/records/:id/contacts/:contactId
```

**Permission:** `cases:link`

## Contact Directory

### List Contacts

```
GET /api/directory?page=1&limit=50
```

**Permission:** `contacts:view`

Query parameters:
- `page`, `limit`: Pagination
- `nameToken`: Blind-index name search token

### Search Contacts

```
GET /api/directory/search?nameToken=<blind-index-token>
```

**Permission:** `contacts:view`

Search works via blind indexes. The client computes HMAC tokens from the search query and sends them to the server. The server matches tokens against stored indexes without seeing plaintext.

### Create Contact

```
POST /api/directory
```

**Permission:** `contacts:create`

**Request:**
```json
{
  "encryptedProfile": "<base64>",
  "profileEnvelopes": [ ... ],
  "blindIndexes": {
    "nameToken": "...",
    "phoneToken": "..."
  }
}
```

## Envelope Recipients

Before creating or updating encrypted records, the client must know which pubkeys to encrypt for at each tier.

### For New Records

```
GET /api/records/envelope-recipients?entityTypeId=<id>
```

### For Existing Records

```
GET /api/records/:id/envelope-recipients
```

**Response:**
```json
{
  "summary": ["pubkey1", "pubkey2", "pubkey3"],
  "fields": ["pubkey1", "pubkey2"],
  "pii": ["pubkey1"]
}
```

The `summary` tier includes all members with `cases:read-*` permissions. The `fields` tier includes assigned volunteers and admins. The `pii` tier includes only admins with `contacts:view-pii`.

## Auto-Assignment

### Get Auto-Assignment Status

```
GET /api/settings/cms/auto-assignment
```

**Response:**
```json
{ "enabled": false }
```

### Toggle Auto-Assignment

```
PUT /api/settings/cms/auto-assignment
```

**Permission:** `cases:manage`

**Request:**
```json
{ "enabled": true }
```

## Report-Case Links

### Link Report to Case

```
POST /api/records/:id/reports
```

**Permission:** `cases:link`

**Request:**
```json
{ "reportId": "report-abc" }
```

### List Linked Reports

```
GET /api/records/:id/reports
```

### Unlink Report

```
DELETE /api/records/:id/reports/:reportId
```

**Permission:** `cases:link`
